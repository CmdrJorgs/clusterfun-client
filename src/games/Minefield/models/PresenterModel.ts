import { action, makeObservable, observable } from "mobx";
import {
  ClusterFunPlayer,
  ISessionHelper,
  ClusterFunGameProps,
  ClusterfunPresenterModel,
  ReconnectInfo,
  ITelemetryLogger,
  IStorage,
  ITypeHelper,
  PresenterGameState,
  GeneralGameState,
} from "libs";
import Logger from "js-logger";
import { GameOverEndpoint, InvalidateStateEndpoint } from "libs/messaging/basicEndpoints";
import {
  type MinefieldCellShape,
  type MinefieldFieldView,
  type MinefieldLocalView,
  MinefieldMoveEndpoint,
  type MinefieldMoveRequest,
  type MinefieldMoveResponse,
  MinefieldOnboardEndpoint,
  type MinefieldOnboardResponse,
  type MinefieldRole,
  type MinefieldTeamStatus,
  MinefieldTeamUpdateEndpoint,
} from "./minefieldEndpoints";
import {
  type Hazard,
  type MapPoint,
  type MinefieldMapData,
  type Wall,
  generateMinefieldMap,
  makeRng,
} from "./minefieldMap";
import {
  type TeamRunState,
  assignTeams,
  distributeIntel,
  freshRunState,
  intelKeysFor,
  neighborOptions,
  pickNextExplorer,
  rankTeams,
  redactMapForAdvisor,
  resolveStep,
  teamRoundScore,
} from "./minefieldLogic";
import {
  BRIEFING_MS,
  DEFAULT_DIFFICULTY_INDEX,
  DIFFICULTY_PRESETS,
  MAX_TEAMS,
  type MinefieldDifficulty,
  ROUNDS,
  ROUND_MS,
  ROUND_SCORE_MS,
  SCORE_RULES,
  TEAM_COLORS,
  TEAM_NAMES,
} from "./GameSettings";

// -------------------------------------------------------------------
// Domain objects
// -------------------------------------------------------------------

// One player's record.  Per-player @observable fields drive the presenter's roster and team
// panels, so this subclass MUST call makeObservable(this) - ClusterFunPlayer never does,
// which would otherwise leave these inert in MobX 6 (see the repo's player-observability
// gotcha, and FaceOffPlayer for the same fix).
export class MinefieldPlayer extends ClusterFunPlayer {
  @observable teamId = -1;

  constructor() {
    super();
    makeObservable(this);
  }
}

/**
 * One team's everything: who is walking, how their run is going, and which fragment of the
 * field each of their advisors was dealt.
 *
 * Hazard state lives HERE rather than on the map, which is what lets several teams race the
 * same field without one team's armed mine going off under another team's explorer.
 */
export class MinefieldTeam {
  @observable teamId = 0;
  @observable explorerId = "";
  /** The host chose this explorer by hand; honoured for one round, then rotation resumes. */
  @observable explorerPinned = false;
  @observable score = 0;
  @observable run: TeamRunState = {
    cell: 0,
    openedWalls: [],
    armed: [],
    spent: [],
    stepCounts: {},
    path: [],
    ghosts: [],
    deaths: 0,
    steps: 0,
    frozenUntilMs: 0,
    reachedGoal: false,
    goalTimeMs: 0,
  };
  /** playerId -> the intel keys that advisor holds this round. */
  @observable intel: Record<string, string[]> = {};
  /** playerIds who have already worn the boots, so the hot seat gets passed around. */
  @observable exploredBy: string[] = [];

  constructor() {
    makeObservable(this);
  }
}

// -------------------------------------------------------------------
// Game states - one per presenter screen. Gathering/Paused/GameOver come from the framework.
// -------------------------------------------------------------------
export enum MinefieldGameState {
  Briefing = "Briefing",
  Running = "Running",
  RoundScore = "RoundScore",
}

// -------------------------------------------------------------------
// Game events - in-process notifications the views subscribe to for sound and animation.
// -------------------------------------------------------------------
export enum MinefieldGameEvent {
  TeamStepped = "TeamStepped",
  TeamArmedMine = "TeamArmedMine",
  TeamFroze = "TeamFroze",
  TeamThrewSwitch = "TeamThrewSwitch",
  TeamDied = "TeamDied",
  TeamReachedGoal = "TeamReachedGoal",
  RoundStarted = "RoundStarted",
  WinnerAnnounced = "WinnerAnnounced",
}

const flatten = (points: MapPoint[]): number[] => {
  const out: number[] = [];
  for (const p of points) out.push(p.x, p.y);
  return out;
};

// -------------------------------------------------------------------
// Type helper for save/restore.  EVERY custom class in the model's object graph has to be
// here or the serializer silently drops it - and a dropped class here means a refreshed
// presenter loses the field mid-party.
// -------------------------------------------------------------------
export const getMinefieldPresenterTypeHelper = (
  sessionHelper: ISessionHelper,
  gameProps: ClusterFunGameProps,
): ITypeHelper => {
  return {
    rootTypeName: "MinefieldPresenterModel",
    getTypeName(o) {
      switch (o.constructor) {
        case MinefieldPresenterModel:
          return "MinefieldPresenterModel";
        case MinefieldPlayer:
          return "MinefieldPlayer";
        case MinefieldTeam:
          return "MinefieldTeam";
      }
      return undefined;
    },
    constructType(typeName: string): any {
      switch (typeName) {
        case "MinefieldPresenterModel":
          return new MinefieldPresenterModel(sessionHelper, gameProps.logger, gameProps.storage);
        case "MinefieldPlayer":
          return new MinefieldPlayer();
        case "MinefieldTeam":
          return new MinefieldTeam();
      }
      return null;
    },
    shouldStringify(typeName: string, propertyName: string, object: any): boolean {
      // The field IS worth saving: it is quantised integers, a few kilobytes, and losing it
      // on a refresh would restart the round rather than resume it.  Unlike the photo games
      // there is nothing here big enough to threaten the localStorage quota.
      return true;
    },
    reconstitute(typeName: string, propertyName: string, rehydratedObject: any) {
      if (typeName === "MinefieldPresenterModel" && propertyName === "teams") {
        return observable<MinefieldTeam>(rehydratedObject as MinefieldTeam[]);
      }
      return rehydratedObject;
    },
  };
};

// -------------------------------------------------------------------
// The presenter: the single source of truth for the field, every team's run, and every
// advisor's intel.  Phones are told only what their role is entitled to know, and that
// filtering happens HERE - a client that had the whole map and hid part of it would be one
// devtools panel away from ruining the game.
// -------------------------------------------------------------------
export class MinefieldPresenterModel extends ClusterfunPresenterModel<MinefieldPlayer> {
  @observable.ref currentMap: MinefieldMapData | null = null;
  @observable teams: MinefieldTeam[] = [];
  @observable teamCount = 1;
  @observable difficultyIndex = DEFAULT_DIFFICULTY_INDEX;
  /** A copy, not the preset itself, so the Advanced panel never edits the shared constant. */
  @observable difficulty: MinefieldDifficulty = { ...DIFFICULTY_PRESETS[DEFAULT_DIFFICULTY_INDEX] };
  /** True once a round is over and the field has been declassified for everyone. */
  @observable revealed = false;

  get rankedTeams(): MinefieldTeam[] {
    return this.teams.slice().sort((l, r) => r.score - l.score);
  }

  get winners(): MinefieldTeam[] {
    if (this.teams.length === 0) return [];
    const best = Math.max(...this.teams.map((t) => t.score));
    return this.teams.filter((t) => t.score === best);
  }

  constructor(sessionHelper: ISessionHelper, logger: ITelemetryLogger, storage: IStorage) {
    super("Minefield", sessionHelper, logger, storage);
    makeObservable(this);
    Logger.info(`Constructing MinefieldPresenterModel ${this.gameState}`);

    // A team is one explorer plus at least one advisor, so two is a real game.
    this.minPlayers = 2;
    this.maxPlayers = 16;
    this.totalRounds = ROUNDS;
    this.allowedJoinStates = [
      PresenterGameState.Gathering,
      MinefieldGameState.Briefing,
      MinefieldGameState.Running,
      MinefieldGameState.RoundScore,
    ];
    this.ensureTeams();
  }

  protected allowsLateJoin(): boolean {
    // Turning up late costs you this round's intel, not your seat.
    return true;
  }

  reconstitute() {
    super.reconstitute();
    this.listenToEndpoint(MinefieldOnboardEndpoint, this.handleOnboardClient);
    this.listenToEndpoint(MinefieldMoveEndpoint, this.handleMove);
  }

  createFreshPlayerEntry(name: string, id: string): MinefieldPlayer {
    const newPlayer = new MinefieldPlayer();
    newPlayer.playerId = id;
    newPlayer.name = name;
    return newPlayer;
  }

  // -------------------------------------------------------------------
  //  onPlayerReturned - ids are stable, so a returning explorer walks straight back into
  //  their own boots and a returning advisor still owns their own intel: nothing to migrate.
  //
  //  The one real case is an advisor who was NOT here when this round's intel was dealt -
  //  they dropped before the deal, or joined mid-round.  Handing them nothing would leave
  //  somebody staring at a blank field with no way to help, so they are dealt a fresh share
  //  at the current overlap.  It is extra copies of intel the team already holds between
  //  them, never a gap: coverage was already complete before they arrived.
  // -------------------------------------------------------------------
  protected onPlayerReturned(player: MinefieldPlayer, _info: ReconnectInfo) {
    this.dealIntelIfMissing(player);
  }

  // -------------------------------------------------------------------
  //  onPlayerDisconnected - they keep their seat and their intel.  If it was the EXPLORER
  //  who vanished, the team is stuck until they return or the host reassigns the boots, and
  //  the presenter says so rather than quietly handing the job to somebody else: being made
  //  the explorer without noticing is worse than waiting a moment for a phone to come back.
  // -------------------------------------------------------------------
  protected onPlayerDisconnected(_player: MinefieldPlayer) {}

  // -------------------------------------------------------------------
  //  Host controls (presenter-side UI, no messages involved)
  // -------------------------------------------------------------------
  setDifficultyIndex = (index: number) => {
    action(() => {
      this.difficultyIndex = Math.max(0, Math.min(DIFFICULTY_PRESETS.length - 1, index));
      this.difficulty = { ...DIFFICULTY_PRESETS[this.difficultyIndex] };
    })();
    this.saveCheckpoint();
  };

  /** The Advanced panel. Editing any knob leaves the preset name behind - it is custom now. */
  updateDifficulty = (patch: Partial<MinefieldDifficulty>) => {
    action(() => {
      this.difficulty = { ...this.difficulty, ...patch, name: "Custom", blurb: "Your own mix." };
      this.difficultyIndex = -1;
    })();
    this.saveCheckpoint();
  };

  setTeamCount = (count: number) => {
    action(() => {
      this.teamCount = Math.max(1, Math.min(MAX_TEAMS, count));
      this.ensureTeams();
      this.players.forEach((p) => (p.teamId = -1));
      assignTeams(this.players, this.teamCount);
    })();
    this.saveCheckpoint();
  };

  setExplorer = (teamId: number, playerId: string) => {
    const team = this.teamById(teamId);
    if (!team) return;
    action(() => {
      team.explorerId = playerId;
      team.explorerPinned = true;
      if (playerId && !team.exploredBy.includes(playerId)) team.exploredBy.push(playerId);
    })();
    this.dealIntelForTeam(team);
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  randomizeExplorer = (teamId: number) => {
    const team = this.teamById(teamId);
    if (!team) return;
    action(() => {
      team.explorerPinned = false;
      this.chooseExplorer(team);
    })();
    this.dealIntelForTeam(team);
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  randomizeAllExplorers = () => {
    this.teams.forEach((team) =>
      action(() => {
        team.explorerPinned = false;
        this.chooseExplorer(team);
      })(),
    );
    this.teams.forEach((team) => this.dealIntelForTeam(team));
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  /** Cut a round short - the host's escape hatch when a team is hopelessly stuck. */
  skipRound = () => {
    if (this.gameState === MinefieldGameState.Running) this.finishRound();
  };

  // -------------------------------------------------------------------
  //  Round lifecycle
  // -------------------------------------------------------------------
  prepareFreshGame = () => {
    action(() => {
      this.gameState = PresenterGameState.Gathering;
      this.currentRound = 0;
      this.currentMap = null;
      this.revealed = false;
      this.ensureTeams();
      this.teams.forEach((team) => {
        team.score = 0;
        team.exploredBy = [];
        team.explorerId = "";
        team.explorerPinned = false;
      });
      this.players.forEach((p) => (p.teamId = -1));
      assignTeams(this.players, this.teamCount);
    })();
  };

  prepareFreshRound = () => {
    const map = generateMinefieldMap({
      seed: this.randomInt(1 << 30),
      mineCount: this.difficulty.mineCount,
      mineKinds: this.difficulty.mineKinds,
      holeCount: this.difficulty.holeCount,
      wallCount: this.difficulty.wallCount,
      viablePaths: this.difficulty.viablePaths,
    });

    action(() => {
      this.currentMap = map;
      this.revealed = false;
      this.ensureTeams();
      assignTeams(this.players, this.teamCount);
      this.teams.forEach((team) => {
        // A host pin lasts exactly one round; after that the boots go back to rotating, so
        // nobody gets stuck being the explorer (or stuck never being it) for a whole game.
        if (!team.explorerPinned || !this.isSeatedOn(team, team.explorerId)) {
          this.chooseExplorer(team);
        }
        team.explorerPinned = false;
        team.run = freshRunState(map);
      });
    })();

    this.teams.forEach((team) => this.dealIntelForTeam(team));
  };

  startNextRound = () => {
    action(() => {
      this.currentRound++;
      this.gameState = MinefieldGameState.Briefing;
      this.setStageEndTime(BRIEFING_MS);
    })();
    this.invokeEvent(MinefieldGameEvent.RoundStarted, this.currentRound);
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  };

  handleTick() {
    if (this.gameState === MinefieldGameState.Running) {
      // Everybody home is the happy way for a round to end, and waiting out the clock after
      // it would just be dead air on the big screen.
      if (this.teams.length > 0 && this.teams.every((t) => t.run.reachedGoal)) {
        this.finishRound();
        return;
      }
    }
    if (!this.isStageOver) return;

    switch (this.gameState) {
      case MinefieldGameState.Briefing:
        this.beginRunning();
        break;
      case MinefieldGameState.Running:
        this.finishRound();
        break;
      case MinefieldGameState.RoundScore:
        if (this.currentRound >= this.totalRounds) {
          this.finishGame();
        } else {
          this.prepareFreshRound();
          this.startNextRound();
        }
        break;
    }
  }

  private beginRunning() {
    action(() => {
      this.gameState = MinefieldGameState.Running;
      this.setStageEndTime(ROUND_MS);
    })();
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  private finishRound() {
    action(() => {
      // The field is declassified: a team finally gets to see what it kept walking into.
      this.revealed = true;
      this.gameState = MinefieldGameState.RoundScore;
      this.setStageEndTime(ROUND_SCORE_MS);
    })();
    for (const team of this.teams) {
      this.analytics.track("minefield_round", {
        round: this.currentRound,
        reached_goal: team.run.reachedGoal,
        deaths: team.run.deaths,
        steps: team.run.steps,
        difficulty: this.difficulty.name,
      });
    }
    this.sendToEveryone(InvalidateStateEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  private finishGame() {
    action(() => {
      this.gameState = GeneralGameState.GameOver;
    })();
    this.invokeEvent(MinefieldGameEvent.WinnerAnnounced, this.winners);
    this.requestEveryone(GameOverEndpoint, () => ({}));
    this.saveCheckpoint();
  }

  // -------------------------------------------------------------------
  //  Teams, explorers and intel
  // -------------------------------------------------------------------
  teamById(teamId: number): MinefieldTeam | undefined {
    return this.teams.find((t) => t.teamId === teamId);
  }

  teamMembers(teamId: number): MinefieldPlayer[] {
    return this.players.filter((p) => p.teamId === teamId);
  }

  advisorsOf(team: MinefieldTeam): MinefieldPlayer[] {
    return this.teamMembers(team.teamId).filter((p) => p.playerId !== team.explorerId);
  }

  explorerOf(team: MinefieldTeam): MinefieldPlayer | undefined {
    return this.players.find((p) => p.playerId === team.explorerId);
  }

  private isSeatedOn(team: MinefieldTeam, playerId: string): boolean {
    const player = this.players.find((p) => p.playerId === playerId);
    return !!player && player.teamId === team.teamId;
  }

  private ensureTeams() {
    while (this.teams.length < this.teamCount) {
      const team = new MinefieldTeam();
      team.teamId = this.teams.length;
      this.teams.push(team);
    }
    if (this.teams.length > this.teamCount) this.teams.splice(this.teamCount);
  }

  private chooseExplorer(team: MinefieldTeam) {
    const members = this.teamMembers(team.teamId);
    const picked = pickNextExplorer(members, team.exploredBy, makeRng(this.randomInt(1 << 30)));
    team.explorerId = picked ? picked.playerId : "";
    if (picked && !team.exploredBy.includes(picked.playerId)) {
      team.exploredBy.push(picked.playerId);
    }
  }

  private dealIntelForTeam(team: MinefieldTeam) {
    const map = this.currentMap;
    if (!map) return;
    const advisors = this.advisorsOf(team);
    const share = distributeIntel(
      intelKeysFor(map),
      advisors.length,
      this.difficulty.intelOverlap,
      makeRng(this.randomInt(1 << 30)),
    );
    action(() => {
      const dealt: Record<string, string[]> = {};
      advisors.forEach((advisor, index) => (dealt[advisor.playerId] = share[index] ?? []));
      team.intel = dealt;
    })();
  }

  /** Give a late arrival a share, so nobody is ever left staring at an empty field. */
  private dealIntelIfMissing(player: MinefieldPlayer) {
    const map = this.currentMap;
    const team = this.teamById(player.teamId);
    if (!map || !team || team.explorerId === player.playerId) return;
    if (team.intel[player.playerId]) return;
    const share = distributeIntel(
      intelKeysFor(map),
      1,
      this.difficulty.intelOverlap,
      makeRng(this.randomInt(1 << 30)),
    );
    action(() => {
      team.intel = { ...team.intel, [player.playerId]: share[0] ?? [] };
    })();
  }

  roleOf(player: MinefieldPlayer): MinefieldRole {
    const team = this.teamById(player.teamId);
    if (!team || !this.currentMap) return "waiting";
    return team.explorerId === player.playerId ? "explorer" : "advisor";
  }

  // -------------------------------------------------------------------
  //  Building the role-shaped views a phone is allowed to see
  // -------------------------------------------------------------------
  private shapeOf(map: MinefieldMapData, cellId: number): MinefieldCellShape {
    const cell = map.cells[cellId];
    return { id: cellId, poly: flatten(cell.poly), cx: cell.center.x, cy: cell.center.y };
  }

  private buildFieldView(
    map: MinefieldMapData,
    hazards: Hazard[],
    walls: Wall[],
  ): MinefieldFieldView {
    return {
      size: map.size,
      cells: map.cells.map((c) => this.shapeOf(map, c.id)),
      outline: map.outline.map(flatten),
      startCell: map.startCell,
      goalCell: map.goalCell,
      hazards: hazards.map((h) => ({ id: h.id, kind: h.kind, cellId: h.cellId, steps: h.steps })),
      walls: walls.map((w) => ({ id: w.id, a: w.a, b: w.b, switchCell: w.switchCell })),
    };
  }

  private buildLocalView(map: MinefieldMapData, run: TeamRunState): MinefieldLocalView {
    return {
      here: this.shapeOf(map, run.cell),
      options: neighborOptions(map, run).map((option) => ({
        ...this.shapeOf(map, option.cellId),
        walled: option.walled,
        visited: option.visited,
      })),
      onStart: run.cell === map.startCell,
      onGoal: run.cell === map.goalCell,
    };
  }

  buildStatus(team: MinefieldTeam): MinefieldTeamStatus {
    const map = this.currentMap;
    return {
      teamId: team.teamId,
      cell: team.run.cell,
      path: team.run.path.slice(),
      ghosts: team.run.ghosts.map((g) => g.slice()),
      deaths: team.run.deaths,
      steps: team.run.steps,
      reachedGoal: team.run.reachedGoal,
      frozenMsLeft: Math.max(0, team.run.frozenUntilMs - this.gameTime_ms),
      armedCount: team.run.armed.length,
      options: map ? neighborOptions(map, team.run).map((o) => o.cellId) : [],
    };
  }

  // -------------------------------------------------------------------
  //  handleOnboardClient - the phone's one-stop rebuild.  Request/response, so throwing
  //  here rejects the client's request with an error it can show.
  // -------------------------------------------------------------------
  handleOnboardClient = (sender: string): MinefieldOnboardResponse => {
    this.telemetryLogger.logEvent("Presenter", "Onboard Client");
    const player = this.players.find((p) => p.playerId === sender);
    const team = player ? this.teamById(player.teamId) : undefined;
    const role = player ? this.roleOf(player) : "waiting";
    const map = this.currentMap;

    const response: MinefieldOnboardResponse = {
      gameState: this.gameState,
      round: this.currentRound,
      totalRounds: this.totalRounds,
      role,
      teamId: team ? team.teamId : -1,
      teamName: team ? (TEAM_NAMES[team.teamId] ?? `Team ${team.teamId + 1}`) : "",
      teamColor: team ? (TEAM_COLORS[team.teamId] ?? "#ffffff") : "#ffffff",
      explorerName: team ? (this.explorerOf(team)?.name ?? "") : "",
      advisorCount: team ? this.advisorsOf(team).length : 0,
      secondsLeft: this.secondsLeftInStage,
      revealed: this.revealed,
      standings: this.teams.map((t) => ({
        teamId: t.teamId,
        teamName: TEAM_NAMES[t.teamId] ?? `Team ${t.teamId + 1}`,
        teamColor: TEAM_COLORS[t.teamId] ?? "#ffffff",
        score: t.score,
      })),
    };

    if (map && team) {
      response.status = this.buildStatus(team);
      if (role === "explorer") {
        response.local = this.buildLocalView(map, team.run);
      } else if (role === "advisor") {
        // The redaction that makes this game work: an advisor is SENT their fragment and
        // nothing else, right up until the round ends and the field is declassified.
        const visible = this.revealed
          ? { hazards: map.hazards, walls: map.walls }
          : redactMapForAdvisor(map, team.intel[sender] ?? []);
        response.field = this.buildFieldView(map, visible.hazards, visible.walls);
      }
    }
    return response;
  };

  // -------------------------------------------------------------------
  //  handleMove - the explorer's one input, and the only message that changes the game.
  // -------------------------------------------------------------------
  handleMove = (sender: string, message: MinefieldMoveRequest): MinefieldMoveResponse => {
    const player = this.players.find((p) => p.playerId === sender);
    const team = player ? this.teamById(player.teamId) : undefined;
    const map = this.currentMap;

    if (!player || !team || !map || team.explorerId !== sender) {
      return { accepted: false, outcome: "blocked" };
    }
    if (this.gameState !== MinefieldGameState.Running) {
      return { accepted: false, outcome: "blocked" };
    }

    // A retry of a move that already landed arrives with a stale serial.  On this game's
    // rules walking the same step twice is the difference between life and death, so the
    // duplicate is answered with current state instead of being replayed.
    if (message.stepSerial < team.run.steps) {
      return {
        accepted: true,
        outcome: team.run.reachedGoal ? "goal" : "moved",
        local: this.buildLocalView(map, team.run),
        status: this.buildStatus(team),
      };
    }

    const result = resolveStep(map, team.run, message.toCellId, this.gameTime_ms);
    if (result.outcome === "blocked" || result.outcome === "frozen") {
      return {
        accepted: false,
        outcome: result.outcome,
        local: this.buildLocalView(map, team.run),
        status: this.buildStatus(team),
      };
    }

    action(() => {
      team.run = result.state;
      if (result.outcome === "goal") {
        team.score += teamRoundScore(
          {
            reachedGoal: true,
            secondsLeft: this.secondsLeftInStage,
            deaths: result.state.deaths,
          },
          SCORE_RULES,
        );
      }
    })();

    if (result.events.includes("freeze")) this.invokeEvent(MinefieldGameEvent.TeamFroze, team);
    if (result.events.includes("switch"))
      this.invokeEvent(MinefieldGameEvent.TeamThrewSwitch, team);
    if (result.events.includes("armed")) this.invokeEvent(MinefieldGameEvent.TeamArmedMine, team);
    if (result.outcome === "dead") this.invokeEvent(MinefieldGameEvent.TeamDied, team);
    else if (result.outcome === "goal") this.invokeEvent(MinefieldGameEvent.TeamReachedGoal, team);
    else this.invokeEvent(MinefieldGameEvent.TeamStepped, team);

    // Advisors on this team watch their explorer move in real time; other teams see each
    // other only on the big screen, which is where a rival's death is meant to be read from.
    const status = this.buildStatus(team);
    const event = result.outcome === "moved" ? (result.events[0] ?? "step") : result.outcome;
    this.sendToEveryone(MinefieldTeamUpdateEndpoint, (p) =>
      p.teamId === team.teamId && p.playerId !== sender ? { status, event } : undefined,
    );

    this.saveCheckpoint();
    return {
      accepted: true,
      outcome: result.outcome,
      killedBy: result.killedBy,
      local: this.buildLocalView(map, result.state),
      status,
    };
  };
}
