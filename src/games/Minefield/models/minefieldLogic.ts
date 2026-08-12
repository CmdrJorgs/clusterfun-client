// ==========================================================================================
// PURE, framework-free minefield RULES.  No MobX, no session, no DOM - data in, data out.
//
// minefieldMap.ts builds and verifies a field; this file is what happens when somebody walks
// on it.  Every decision the presenter makes about a step - is it legal, does it arm
// anything, does it kill you, what does it score - is a function here, so the rules can be
// tested without a game running.  The presenter model only holds the state and calls in.
//
// The fuse semantics here MUST match findSafeRoute() in minefieldMap.ts: the generator uses
// that search to promise every field is survivable, and a promise made under different rules
// than the ones the game plays by is not a promise.  Both tick fuses BEFORE arming anything
// new, which is what makes "two movements to get clear" mean the same thing in both.
// ==========================================================================================

import { Hazard, HazardKind, MinefieldMapData, wallBetween } from "./minefieldMap";
import { FREEZE_MS, MAX_GHOST_TRAILS, MOTION_FUSE_STEPS } from "./GameSettings";

// ------------------------------------------------------------------------------------------
// One team's live run across the field.
//
// Hazard state is PER TEAM: teams move asynchronously, so a fuse counted in "movements" has
// no shared clock to count against, and one team arming a mine under another team's explorer
// would be a griefing mechanic nobody asked for.  Teams share the geometry, not the state.
// ------------------------------------------------------------------------------------------
export interface ArmedFuse {
  hazardId: number;
  /** Movements remaining before it goes off. */
  fuse: number;
}

export interface TeamRunState {
  cell: number;
  /** Wall ids whose switch has been thrown. Throwing a switch is permanent within a run. */
  openedWalls: number[];
  armed: ArmedFuse[];
  /** Hazards that have already gone off and cannot fire again. */
  spent: number[];
  /** Multi-step mine id (as a string key) -> steps taken on it so far. */
  stepCounts: Record<string, number>;
  /** Cells walked this run, in order, starting at the start cell. */
  path: number[];
  /** Completed runs that ended in a death - drawn faded on the big screen. */
  ghosts: number[][];
  deaths: number;
  steps: number;
  frozenUntilMs: number;
  reachedGoal: boolean;
  goalTimeMs: number;
}

export type StepOutcome = "moved" | "goal" | "blocked" | "frozen" | "dead";

export type StepEventKind = "freeze" | "switch" | "armed" | "death" | "goal";

export interface StepResult {
  outcome: StepOutcome;
  state: TeamRunState;
  events: StepEventKind[];
  killedBy?: HazardKind;
}

export function freshRunState(map: MinefieldMapData): TeamRunState {
  return {
    cell: map.startCell,
    openedWalls: [],
    armed: [],
    spent: [],
    stepCounts: {},
    path: [map.startCell],
    ghosts: [],
    deaths: 0,
    steps: 0,
    frozenUntilMs: 0,
    reachedGoal: false,
    goalTimeMs: 0,
  };
}

function hazardAt(map: MinefieldMapData, cellId: number): Hazard | undefined {
  return map.hazards.find((h) => h.cellId === cellId);
}

/** A detonation kills anything on the mine's own cell or immediately next to it. */
export function blastCovers(map: MinefieldMapData, mineCell: number, target: number): boolean {
  if (mineCell === target) return true;
  const cell = map.cells[mineCell];
  return !!cell && cell.neighbors.includes(target);
}

export interface NeighborOption {
  cellId: number;
  /** A wall stands between here and there, and its switch has not been thrown. */
  walled: boolean;
  /** Already stood on during this run. */
  visited: boolean;
}

/**
 * Exactly what the explorer may tap, and exactly what the advisors see highlighted.  Both
 * screens render this same list, so the menu of options is never in dispute - only the
 * words the players invent for the cells in it.
 */
export function neighborOptions(map: MinefieldMapData, state: TeamRunState): NeighborOption[] {
  const here = map.cells[state.cell];
  if (!here) return [];
  const visited = new Set(state.path);
  return here.neighbors.map((cellId) => {
    const wall = wallBetween(map, state.cell, cellId);
    return {
      cellId,
      walled: !!wall && !state.openedWalls.includes(wall.id),
      visited: visited.has(cellId),
    };
  });
}

// ------------------------------------------------------------------------------------------
// resolveStep - the whole game in one function.
//
// Returns a NEW state; never mutates the one passed in.  That is what lets the presenter
// assign the result straight onto an observable field and have the views re-render, and it
// is what lets the tests step a field forward without bookkeeping.
// ------------------------------------------------------------------------------------------
export function resolveStep(
  map: MinefieldMapData,
  state: TeamRunState,
  toCell: number,
  nowMs: number,
): StepResult {
  const reject = (outcome: StepOutcome): StepResult => ({ outcome, state, events: [] });

  if (state.reachedGoal) return reject("blocked");
  if (nowMs < state.frozenUntilMs) return reject("frozen");

  const here = map.cells[state.cell];
  if (!here || !here.neighbors.includes(toCell)) return reject("blocked");

  const wall = wallBetween(map, state.cell, toCell);
  if (wall && !state.openedWalls.includes(wall.id)) return reject("blocked");

  const events: StepEventKind[] = [];
  let killedBy: HazardKind | undefined;

  const openedWalls = state.openedWalls.slice();
  const spent = state.spent.slice();
  const stepCounts = { ...state.stepCounts };
  let armed = state.armed.slice();
  let frozenUntilMs = state.frozenUntilMs;

  // (a) Whatever is buried in the cell just stepped onto.
  const mine = hazardAt(map, toCell);
  if (mine) {
    if (mine.kind === "standard") {
      killedBy = "standard";
    } else if (mine.kind === "multistep") {
      const taken = (stepCounts[String(mine.id)] ?? 0) + 1;
      stepCounts[String(mine.id)] = taken;
      if (taken >= mine.steps) killedBy = "multistep";
    } else if (mine.kind === "freeze") {
      frozenUntilMs = nowMs + FREEZE_MS;
      events.push("freeze");
    }
  }

  // (b) Fuses that were ALREADY burning when this move started tick down now, so a mine
  //     armed on move N goes off at the end of move N+2 - "two movements", as promised.
  if (!killedBy) {
    const stillArmed: ArmedFuse[] = [];
    for (const fuse of armed) {
      const remaining = fuse.fuse - 1;
      if (remaining > 0) {
        stillArmed.push({ hazardId: fuse.hazardId, fuse: remaining });
        continue;
      }
      spent.push(fuse.hazardId);
      const detonating = map.hazards.find((h) => h.id === fuse.hazardId);
      if (detonating && blastCovers(map, detonating.cellId, toCell)) killedBy = detonating.kind;
    }
    armed = stillArmed;
  }

  // (c) ...and only then does this move arm anything new.  Motion mines trigger on
  //     PROXIMITY; invisible mines only when actually trodden on.
  if (!killedBy) {
    for (const hazard of map.hazards) {
      if (hazard.kind !== "motion" && hazard.kind !== "invisible") continue;
      if (spent.includes(hazard.id) || armed.some((a) => a.hazardId === hazard.id)) continue;
      const triggered =
        hazard.kind === "motion"
          ? blastCovers(map, hazard.cellId, toCell)
          : hazard.cellId === toCell;
      if (!triggered) continue;
      armed.push({ hazardId: hazard.id, fuse: MOTION_FUSE_STEPS });
      events.push("armed");
    }
  }

  // (d) Switches. Stepping on one removes its wall for the rest of the run.
  for (const w of map.walls) {
    if (w.switchCell === toCell && !openedWalls.includes(w.id)) {
      openedWalls.push(w.id);
      events.push("switch");
    }
  }

  const path = state.path.concat(toCell);

  // (e) A death resets the field to pristine for this team.  One clean mental model - "the
  //     run starts over" - beats a half-remembered board, and it keeps the advisors' own
  //     tally of multi-step mines honest instead of quietly stale.
  if (killedBy) {
    events.push("death");
    const ghosts = state.ghosts.concat([path]).slice(-MAX_GHOST_TRAILS);
    return {
      outcome: "dead",
      killedBy,
      events,
      state: {
        ...freshRunState(map),
        ghosts,
        deaths: state.deaths + 1,
        steps: state.steps + 1,
      },
    };
  }

  const reachedGoal = toCell === map.goalCell;
  if (reachedGoal) events.push("goal");

  return {
    outcome: reachedGoal ? "goal" : "moved",
    events,
    state: {
      ...state,
      cell: toCell,
      openedWalls,
      armed,
      spent,
      stepCounts,
      path,
      steps: state.steps + 1,
      frozenUntilMs,
      reachedGoal,
      goalTimeMs: reachedGoal ? nowMs : state.goalTimeMs,
    },
  };
}

// ------------------------------------------------------------------------------------------
// Intel
//
// An intel item is one thing an advisor can know about: a visible hazard, or a wall and the
// switch that opens it.  Invisible mines are absent by definition - they are the one thing
// nobody is told about.
// ------------------------------------------------------------------------------------------
export function intelKeysFor(map: MinefieldMapData): string[] {
  const hazards = map.hazards.filter((h) => h.kind !== "invisible").map((h) => `h:${h.id}`);
  const walls = map.walls.map((w) => `w:${w.id}`);
  return hazards.concat(walls);
}

/**
 * Split the field's intel across a team's advisors.
 *
 * Full coverage is guaranteed BY CONSTRUCTION, not by luck: the deal is round-robin over a
 * shuffled list, so every item has an owner before anybody gets a second copy.  `overlap`
 * then decides how many ADDITIONAL advisors each item is also revealed to - 0 means the team
 * holds disjoint fragments and must pool everything, 1 means everybody sees everything.
 *
 * A single advisor therefore sees the whole field whatever the overlap, which is the correct
 * answer rather than a special case.
 */
export function distributeIntel(
  keys: string[],
  advisorCount: number,
  overlap: number,
  rng: () => number,
): string[][] {
  if (advisorCount <= 0) return [];
  const holders: Set<string>[] = Array.from({ length: advisorCount }, () => new Set<string>());
  if (keys.length === 0) return holders.map(() => []);

  const deck = keys.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  deck.forEach((key, index) => holders[index % advisorCount].add(key));

  const extra = Math.round(Math.max(0, Math.min(1, overlap)) * (advisorCount - 1));
  if (extra > 0) {
    for (const key of deck) {
      const others = holders
        .map((set, index) => ({ set, index }))
        .filter(({ set }) => !set.has(key));
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }
      others.slice(0, extra).forEach(({ set }) => set.add(key));
    }
  }

  return holders.map((set) => Array.from(set).sort());
}

/** Narrow a map down to what one advisor is allowed to be TOLD - see the note in DESIGN.md. */
export function redactMapForAdvisor(
  map: MinefieldMapData,
  intel: string[],
): { hazards: Hazard[]; walls: MinefieldMapData["walls"] } {
  const owned = new Set(intel);
  return {
    hazards: map.hazards.filter((h) => h.kind !== "invisible" && owned.has(`h:${h.id}`)),
    walls: map.walls.filter((w) => owned.has(`w:${w.id}`)),
  };
}

// ------------------------------------------------------------------------------------------
// Scoring
// ------------------------------------------------------------------------------------------
export interface ScoreRules {
  goalPoints: number;
  timeBonusPerSecond: number;
  deathPenalty: number;
}

export interface TeamRoundResult {
  reachedGoal: boolean;
  secondsLeft: number;
  deaths: number;
}

export function teamRoundScore(result: TeamRoundResult, rules: ScoreRules): number {
  const earned = result.reachedGoal
    ? rules.goalPoints + Math.max(0, Math.floor(result.secondsLeft)) * rules.timeBonusPerSecond
    : 0;
  return Math.max(0, earned - result.deaths * rules.deathPenalty);
}

export interface RankableTeam {
  reachedGoal: boolean;
  deaths: number;
  steps: number;
  goalTimeMs: number;
}

/** Made it, then fewest deaths, then fewest steps, then whoever got there first. */
export function rankTeams<T extends RankableTeam>(teams: T[]): T[] {
  return teams.slice().sort((l, r) => {
    if (l.reachedGoal !== r.reachedGoal) return l.reachedGoal ? -1 : 1;
    if (l.deaths !== r.deaths) return l.deaths - r.deaths;
    if (l.steps !== r.steps) return l.steps - r.steps;
    return l.goalTimeMs - r.goalTimeMs;
  });
}

/**
 * Who should be handed the explorer's boots next.  Anybody who has not had a turn yet comes
 * first, so a 3-round game spreads the hot seat around instead of landing on one player.
 */
export function pickNextExplorer<T extends { playerId: string; isConnected: boolean }>(
  members: T[],
  alreadyExplored: string[],
  rng: () => number,
): T | undefined {
  const available = members.filter((m) => m.isConnected);
  const pool = available.length > 0 ? available : members;
  if (pool.length === 0) return undefined;
  const fresh = pool.filter((m) => !alreadyExplored.includes(m.playerId));
  const choices = fresh.length > 0 ? fresh : pool;
  return choices[Math.floor(rng() * choices.length)];
}

/**
 * Balance players across teams, keeping existing seats stable so a mid-game join never
 * reshuffles a team that has already started talking to each other.
 */
export function assignTeams<T extends { playerId: string; teamId: number }>(
  players: T[],
  teamCount: number,
): void {
  const counts = Array.from({ length: teamCount }, () => 0);
  for (const p of players) {
    if (p.teamId >= 0 && p.teamId < teamCount) counts[p.teamId]++;
  }
  for (const p of players) {
    if (p.teamId >= 0 && p.teamId < teamCount) continue;
    let smallest = 0;
    for (let t = 1; t < teamCount; t++) if (counts[t] < counts[smallest]) smallest = t;
    p.teamId = smallest;
    counts[smallest]++;
  }
}
