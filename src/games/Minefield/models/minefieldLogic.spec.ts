import { Hazard, MapCell, MinefieldMapData, Wall, makeRng } from "./minefieldMap";
import {
  TeamRunState,
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
import { FREEZE_MS, SCORE_RULES } from "./GameSettings";

function graphMap(
  cellCount: number,
  edges: [number, number][],
  overrides: Partial<MinefieldMapData> = {},
): MinefieldMapData {
  const neighbors: number[][] = Array.from({ length: cellCount }, () => []);
  for (const [a, b] of edges) {
    if (!neighbors[a].includes(b)) neighbors[a].push(b);
    if (!neighbors[b].includes(a)) neighbors[b].push(a);
  }
  const cells: MapCell[] = neighbors.map((n, id) => ({
    id,
    poly: [{ x: id, y: 0 }],
    center: { x: id * 10, y: 5 },
    neighbors: n.sort((l, r) => l - r),
  }));
  return {
    seed: 1,
    size: 1000,
    cells,
    outline: [],
    startCell: 0,
    goalCell: cellCount - 1,
    hazards: [],
    walls: [],
    ...overrides,
  };
}

function line(cellCount: number, overrides: Partial<MinefieldMapData> = {}): MinefieldMapData {
  const edges: [number, number][] = [];
  for (let i = 0; i + 1 < cellCount; i++) edges.push([i, i + 1]);
  return graphMap(cellCount, edges, overrides);
}

const mine = (id: number, kind: Hazard["kind"], cellId: number, steps = 0): Hazard => ({
  id,
  kind,
  cellId,
  steps,
});

/** Walk a sequence of cells, returning every step's result. Time advances a second a step. */
function walk(map: MinefieldMapData, cells: number[], from?: TeamRunState) {
  let state = from ?? freshRunState(map);
  const results = [];
  for (let i = 0; i < cells.length; i++) {
    const result = resolveStep(map, state, cells[i], (i + 1) * 1000);
    results.push(result);
    state = result.state;
  }
  return { results, state, last: results[results.length - 1] };
}

describe("freshRunState", () => {
  it("starts on the start cell with the field pristine", () => {
    const state = freshRunState(line(4));
    expect(state.cell).toBe(0);
    expect(state.path).toEqual([0]);
    expect(state.deaths).toBe(0);
    expect(state.armed).toEqual([]);
    expect(state.reachedGoal).toBe(false);
  });
});

describe("neighborOptions", () => {
  it("offers exactly the adjacent cells, and remembers where you have stood", () => {
    const map = line(4);
    const { state } = walk(map, [1]);
    const options = neighborOptions(map, state);
    expect(options.map((o) => o.cellId).sort()).toEqual([0, 2]);
    expect(options.find((o) => o.cellId === 0)!.visited).toBe(true);
    expect(options.find((o) => o.cellId === 2)!.visited).toBe(false);
  });

  it("marks an option walled while its switch is unthrown", () => {
    const map = line(4, { walls: [{ id: 0, a: 1, b: 2, switchCell: 3 } as Wall] });
    const { state } = walk(map, [1]);
    expect(neighborOptions(map, state).find((o) => o.cellId === 2)!.walled).toBe(true);
  });
});

describe("resolveStep - legality", () => {
  it("refuses a cell that is not adjacent", () => {
    const map = line(4);
    const result = resolveStep(map, freshRunState(map), 3, 0);
    expect(result.outcome).toBe("blocked");
    expect(result.state.cell).toBe(0);
  });

  it("refuses to cross a wall, and allows it once the switch is thrown", () => {
    // 0-1, 1-2(goal), plus a detour 0-3-1. The switch on 3 opens the wall on 1-2.
    const map = graphMap(
      4,
      [
        [0, 1],
        [1, 2],
        [0, 3],
        [3, 1],
      ],
      { goalCell: 2, walls: [{ id: 0, a: 1, b: 2, switchCell: 3 } as Wall] },
    );
    expect(walk(map, [1, 2]).results[1].outcome).toBe("blocked");

    const detour = walk(map, [3, 1, 2]);
    expect(detour.results[0].events).toContain("switch");
    expect(detour.state.openedWalls).toEqual([0]);
    expect(detour.last.outcome).toBe("goal");
  });

  it("stops accepting moves once the goal is reached", () => {
    const map = line(3);
    const done = walk(map, [1, 2]);
    expect(done.last.outcome).toBe("goal");
    expect(resolveStep(map, done.state, 1, 9999).outcome).toBe("blocked");
  });

  it("never mutates the state it was given", () => {
    const map = line(4);
    const before = freshRunState(map);
    const snapshot = JSON.stringify(before);
    resolveStep(map, before, 1, 0);
    expect(JSON.stringify(before)).toEqual(snapshot);
  });
});

describe("resolveStep - standard mines", () => {
  it("kills on contact and resets the run to the start", () => {
    const map = line(4, { hazards: [mine(0, "standard", 2)] });
    const { last, state } = walk(map, [1, 2]);
    expect(last.outcome).toBe("dead");
    expect(last.killedBy).toBe("standard");
    expect(state.cell).toBe(0);
    expect(state.path).toEqual([0]);
    expect(state.deaths).toBe(1);
  });

  it("keeps the failed run as a ghost trail for the big screen", () => {
    const map = line(4, { hazards: [mine(0, "standard", 2)] });
    const { state } = walk(map, [1, 2]);
    expect(state.ghosts).toEqual([[0, 1, 2]]);
  });

  it("counts every step taken, including the fatal one", () => {
    const map = line(4, { hazards: [mine(0, "standard", 2)] });
    expect(walk(map, [1, 2]).state.steps).toBe(2);
  });
});

describe("resolveStep - multi-step mines", () => {
  it("survives until its total is spent, then kills", () => {
    const map = line(4, { hazards: [mine(0, "multistep", 1, 3)] });
    const first = walk(map, [1]);
    expect(first.last.outcome).toBe("moved");
    const second = walk(map, [0, 1], first.state);
    expect(second.last.outcome).toBe("moved");
    const third = walk(map, [0, 1], second.state);
    expect(third.last.outcome).toBe("dead");
    expect(third.last.killedBy).toBe("multistep");
  });

  it("resets its count on death, so a fresh run really is fresh", () => {
    const map = line(4, { hazards: [mine(0, "multistep", 1, 2), mine(1, "standard", 2)] });
    const stepped = walk(map, [1]);
    expect(stepped.state.stepCounts["0"]).toBe(1);
    const died = walk(map, [2], stepped.state);
    expect(died.last.outcome).toBe("dead");
    expect(died.state.stepCounts).toEqual({});
  });
});

describe("resolveStep - freeze mines", () => {
  it("pins the explorer for ten seconds, then lets them go", () => {
    const map = line(4, { hazards: [mine(0, "freeze", 1)] });
    const stepped = resolveStep(map, freshRunState(map), 1, 1000);
    expect(stepped.outcome).toBe("moved");
    expect(stepped.events).toContain("freeze");
    expect(stepped.state.frozenUntilMs).toBe(1000 + FREEZE_MS);

    expect(resolveStep(map, stepped.state, 2, 1000 + FREEZE_MS - 1).outcome).toBe("frozen");
    expect(resolveStep(map, stepped.state, 2, 1000 + FREEZE_MS).outcome).toBe("moved");
  });

  it("costs time but never a life", () => {
    const map = line(4, { hazards: [mine(0, "freeze", 1)] });
    expect(walk(map, [1]).state.deaths).toBe(0);
  });
});

describe("resolveStep - motion mines", () => {
  // A mine at cell 3 of a corridor covers cells 2, 3 and 4.
  const map = line(6, { hazards: [mine(0, "motion", 3)] });

  it("arms when approached, not when trodden on", () => {
    const approach = walk(map, [1, 2]);
    expect(approach.results[0].events).not.toContain("armed");
    expect(approach.results[1].events).toContain("armed");
    expect(approach.state.armed).toEqual([{ hazardId: 0, fuse: 2 }]);
  });

  it("kills two movements later if you are still in the blast", () => {
    const run = walk(map, [1, 2, 3, 4]);
    expect(run.results[2].outcome).toBe("moved");
    expect(run.last.outcome).toBe("dead");
    expect(run.last.killedBy).toBe("motion");
  });

  it("lets you back out of the blast and detonate it harmlessly", () => {
    const escape = walk(map, [1, 2, 1, 0]);
    expect(escape.last.outcome).toBe("moved");
    expect(escape.state.deaths).toBe(0);
    expect(escape.state.spent).toEqual([0]);
    expect(escape.state.armed).toEqual([]);
  });

  it("is inert once spent, so the crater is a safe way through", () => {
    const escape = walk(map, [1, 2, 1, 0]);
    const through = walk(map, [1, 2, 3, 4, 5], escape.state);
    expect(through.last.outcome).toBe("goal");
    expect(through.state.deaths).toBe(0);
  });
});

describe("resolveStep - invisible mines", () => {
  const map = line(6, { hazards: [mine(0, "invisible", 3)] });

  it("ignores you walking past next door - it only wakes when stepped on", () => {
    const approach = walk(map, [1, 2]);
    expect(approach.state.armed).toEqual([]);
    const onIt = walk(map, [3], approach.state);
    expect(onIt.last.events).toContain("armed");
    expect(onIt.state.armed).toEqual([{ hazardId: 0, fuse: 2 }]);
  });

  it("can be outrun by two clean movements", () => {
    const run = walk(map, [1, 2, 3, 4, 5]);
    expect(run.last.outcome).toBe("goal");
    expect(run.state.deaths).toBe(0);
  });

  it("kills anyone still beside it when the fuse runs out", () => {
    const run = walk(map, [1, 2, 3, 4, 3]);
    expect(run.last.outcome).toBe("dead");
    expect(run.last.killedBy).toBe("invisible");
  });

  it("is never handed to an advisor as intel", () => {
    expect(intelKeysFor(map)).toEqual([]);
    expect(redactMapForAdvisor(map, ["h:0"]).hazards).toEqual([]);
  });
});

describe("intel distribution", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `h:${i}`);

  it("covers the whole field however thin the overlap", () => {
    for (const overlap of [0, 0.25, 0.5, 1]) {
      for (let advisors = 1; advisors <= 5; advisors++) {
        const share = distributeIntel(keys, advisors, overlap, makeRng(advisors * 31 + overlap));
        expect(new Set(share.flat()).size).toBe(keys.length);
      }
    }
  });

  it("gives a lone advisor the whole picture, whatever the overlap says", () => {
    expect(distributeIntel(keys, 1, 0, makeRng(1))[0].sort()).toEqual(keys.slice().sort());
  });

  it("at zero overlap every item has exactly one owner", () => {
    const share = distributeIntel(keys, 4, 0, makeRng(7));
    expect(share.flat()).toHaveLength(keys.length);
  });

  it("at full overlap every advisor holds everything", () => {
    const share = distributeIntel(keys, 4, 1, makeRng(7));
    for (const advisor of share) expect(advisor).toHaveLength(keys.length);
  });

  it("puts partial overlap between those two extremes", () => {
    const total = distributeIntel(keys, 4, 0.5, makeRng(7)).flat().length;
    expect(total).toBeGreaterThan(keys.length);
    expect(total).toBeLessThan(keys.length * 4);
  });

  it("deals walls as intel alongside visible hazards", () => {
    const map = line(4, {
      hazards: [mine(0, "standard", 1), mine(1, "invisible", 2)],
      walls: [{ id: 0, a: 2, b: 3, switchCell: 1 } as Wall],
    });
    expect(intelKeysFor(map).sort()).toEqual(["h:0", "w:0"]);
  });

  it("hands an advisor only what they own", () => {
    const map = line(5, {
      hazards: [mine(0, "standard", 1), mine(1, "freeze", 2)],
      walls: [{ id: 0, a: 2, b: 3, switchCell: 4 } as Wall],
    });
    const redacted = redactMapForAdvisor(map, ["h:1"]);
    expect(redacted.hazards.map((h) => h.id)).toEqual([1]);
    expect(redacted.walls).toEqual([]);
  });

  it("copes with an empty field and with nobody to tell", () => {
    expect(distributeIntel([], 3, 1, makeRng(1))).toEqual([[], [], []]);
    expect(distributeIntel(keys, 0, 1, makeRng(1))).toEqual([]);
  });
});

describe("scoring", () => {
  it("pays for the goal plus the time left, less every death", () => {
    expect(teamRoundScore({ reachedGoal: true, secondsLeft: 60, deaths: 0 }, SCORE_RULES)).toBe(
      1000 + 300,
    );
    expect(teamRoundScore({ reachedGoal: true, secondsLeft: 60, deaths: 2 }, SCORE_RULES)).toBe(
      1000 + 300 - 300,
    );
  });

  it("pays nothing for a round that never reached the goal", () => {
    expect(teamRoundScore({ reachedGoal: false, secondsLeft: 200, deaths: 0 }, SCORE_RULES)).toBe(0);
  });

  it("never goes negative, however catastrophic the round", () => {
    expect(teamRoundScore({ reachedGoal: true, secondsLeft: 0, deaths: 99 }, SCORE_RULES)).toBe(0);
  });

  it("ranks by arrival, then deaths, then steps, then the clock", () => {
    const teams = [
      { name: "slow", reachedGoal: true, deaths: 0, steps: 40, goalTimeMs: 900 },
      { name: "dnf", reachedGoal: false, deaths: 0, steps: 5, goalTimeMs: 0 },
      { name: "clumsy", reachedGoal: true, deaths: 3, steps: 10, goalTimeMs: 100 },
      { name: "clean", reachedGoal: true, deaths: 0, steps: 20, goalTimeMs: 800 },
    ];
    expect(rankTeams(teams).map((t) => t.name)).toEqual(["clean", "slow", "clumsy", "dnf"]);
  });
});

describe("team and explorer selection", () => {
  const member = (playerId: string, isConnected = true) => ({ playerId, isConnected });

  it("prefers somebody who has not worn the boots yet", () => {
    const members = [member("a"), member("b"), member("c")];
    const picked = pickNextExplorer(members, ["a", "b"], makeRng(5));
    expect(picked!.playerId).toBe("c");
  });

  it("comes back round once everybody has had a turn", () => {
    const members = [member("a"), member("b")];
    expect(pickNextExplorer(members, ["a", "b"], makeRng(5))).toBeDefined();
  });

  it("will not hand the boots to a phone that is not there", () => {
    const members = [member("a", false), member("b", true)];
    expect(pickNextExplorer(members, [], makeRng(3))!.playerId).toBe("b");
  });

  it("balances new players across teams without disturbing existing seats", () => {
    const players = [
      { playerId: "a", teamId: 0 },
      { playerId: "b", teamId: 0 },
      { playerId: "c", teamId: -1 },
      { playerId: "d", teamId: -1 },
    ];
    assignTeams(players, 2);
    expect(players[0].teamId).toBe(0);
    expect(players[1].teamId).toBe(0);
    expect(players[2].teamId).toBe(1);
    expect(players[3].teamId).toBe(1);
  });
});
