import {
  boundaryRings,
  countDisjointRoutes,
  findSafeRoute,
  generateMinefieldMap,
  hopDistances,
  makeRng,
  MapCell,
  MapGenOptions,
  MAX_WALLS,
  MinefieldMapData,
  Hazard,
  Wall,
} from "./minefieldMap";

// ------------------------------------------------------------------------------------------
// Hand-built fields.  The generator makes fields nobody can predict, which is the point of
// it - so the analysis functions are pinned against tiny graphs whose right answer can be
// worked out on paper instead.
// ------------------------------------------------------------------------------------------
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
    poly: [
      { x: id * 10, y: 0 },
      { x: id * 10 + 10, y: 0 },
      { x: id * 10 + 10, y: 10 },
      { x: id * 10, y: 10 },
    ],
    center: { x: id * 10 + 5, y: 5 },
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

describe("makeRng", () => {
  it("is deterministic for a seed, so a bad map is always reproducible", () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const runA = [a(), a(), a()];
    const runB = [b(), b(), b()];
    expect(runA).toEqual(runB);
    expect(runA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("gives different streams for different seeds", () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
  });
});

describe("boundaryRings", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
  ];

  it("traces a single quad as its own four corners", () => {
    const rings = boundaryRings([[0, 1, 4, 3]], points);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it("merges two adjacent quads into one six-sided ring, dropping the shared edge", () => {
    const rings = boundaryRings(
      [
        [0, 1, 4, 3],
        [1, 2, 5, 4],
      ],
      points,
    );
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(6);
    // The internal edge's midpoint vertices survive as corners, but the edge itself is gone:
    // a six-sided ring around two squares is exactly what "no internal edge" looks like.
    expect(rings[0]).toContainEqual({ x: 1, y: 0 });
    expect(rings[0]).toContainEqual({ x: 1, y: 1 });
  });

  it("returns separate rings for disconnected pieces, longest first", () => {
    const far = points.concat([
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 11, y: 11 },
      { x: 10, y: 11 },
    ]);
    const rings = boundaryRings(
      [
        [0, 1, 4, 3],
        [1, 2, 5, 4],
        [6, 7, 8, 9],
      ],
      far,
    );
    expect(rings).toHaveLength(2);
    expect(rings[0].length).toBeGreaterThanOrEqual(rings[1].length);
  });
});

describe("hopDistances", () => {
  it("counts hops and marks unreachable cells with -1", () => {
    const map = graphMap(4, [
      [0, 1],
      [1, 2],
    ]);
    expect(hopDistances(map.cells, 0)).toEqual([0, 1, 2, -1]);
  });
});

describe("countDisjointRoutes", () => {
  it("finds a single route through a corridor", () => {
    const map = line(4);
    expect(countDisjointRoutes(map.cells, new Set(), 0, 3)).toBe(1);
  });

  it("finds both arms of a diamond", () => {
    const map = graphMap(4, [
      [0, 1],
      [1, 3],
      [0, 2],
      [2, 3],
    ]);
    expect(countDisjointRoutes(map.cells, new Set(), 0, 3)).toBe(2);
  });

  it("drops to one route when an arm of the diamond is mined", () => {
    const map = graphMap(4, [
      [0, 1],
      [1, 3],
      [0, 2],
      [2, 3],
    ]);
    expect(countDisjointRoutes(map.cells, new Set([1]), 0, 3)).toBe(1);
  });

  it("reports zero when the field is cut in two", () => {
    const map = line(4);
    expect(countDisjointRoutes(map.cells, new Set([2]), 0, 3)).toBe(0);
  });

  it("reports zero when start or goal is itself blocked", () => {
    const map = line(4);
    expect(countDisjointRoutes(map.cells, new Set([0]), 0, 3)).toBe(0);
    expect(countDisjointRoutes(map.cells, new Set([3]), 0, 3)).toBe(0);
  });
});

describe("findSafeRoute", () => {
  it("walks a clear corridor", () => {
    expect(findSafeRoute(line(4))).toEqual([0, 1, 2, 3]);
  });

  it("refuses a corridor plugged by a standard mine", () => {
    expect(findSafeRoute(line(4, { hazards: [mine(0, "standard", 2)] }))).toBeNull();
  });

  it("refuses a route that would require stepping on a mine nobody can see", () => {
    // An invisible mine is unwarnable, so a field whose only solution runs through one is an
    // unfair field - this is the check that stops the generator shipping it.
    expect(findSafeRoute(line(4, { hazards: [mine(0, "invisible", 2)] }))).toBeNull();
  });

  it("refuses a route that would require spending a multi-step mine's last step", () => {
    expect(findSafeRoute(line(4, { hazards: [mine(0, "multistep", 2, 3)] }))).toBeNull();
  });

  it("routes the long way round to throw a switch before crossing its wall", () => {
    // 0-1 and 1-2 (goal), plus a detour 0-3-1.  The wall on 1-2 is opened by the switch at 3,
    // so the only living route deliberately walks AWAY from the goal first.
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
    expect(findSafeRoute(map)).toEqual([0, 3, 1, 2]);
  });

  it("refuses a wall whose switch is only reachable through the wall itself", () => {
    const map = line(4, { walls: [{ id: 0, a: 1, b: 2, switchCell: 3 } as Wall] });
    expect(findSafeRoute(map)).toBeNull();
  });

  it("arms a motion mine, backs off, lets it blow, then walks through the crater", () => {
    // Mine at 3 covers {2,3,4}.  Stepping onto 2 arms it; the only survivable play is to
    // retreat to 0 so the blast lands behind you, after which the field is inert.
    const map = line(6, { hazards: [mine(0, "motion", 3)] });
    const route = findSafeRoute(map);
    expect(route).not.toBeNull();
    expect(route![0]).toBe(0);
    expect(route![route!.length - 1]).toBe(5);
    // It must actually detour rather than sprint: a straight run is 6 cells.
    expect(route!.length).toBeGreaterThan(6);
  });

  it("refuses a motion mine there is no room to escape", () => {
    // Blast covers the whole corridor, and the explorer starts inside it.
    expect(findSafeRoute(line(3, { hazards: [mine(0, "motion", 1)] }))).toBeNull();
  });

  it("walks past a freeze mine, which costs time but never a life", () => {
    expect(findSafeRoute(line(4, { hazards: [mine(0, "freeze", 2)] }))).toEqual([0, 1, 2, 3]);
  });
});

describe("generateMinefieldMap", () => {
  const options = (over: Partial<MapGenOptions> = {}): MapGenOptions => ({
    seed: 42,
    mineCount: 14,
    mineKinds: 5,
    holeCount: 3,
    wallCount: 2,
    viablePaths: 2,
    ...over,
  });

  it("is deterministic for a seed", () => {
    const a = generateMinefieldMap(options());
    const b = generateMinefieldMap(options());
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("builds an irregular mosaic, not a grid", () => {
    const map = generateMinefieldMap(options());
    expect(map.cells.length).toBeGreaterThan(12);
    // A pure jittered grid would be all quads; merging is what makes it a mosaic.
    const sides = new Set(map.cells.map((c) => c.poly.length));
    expect(sides.size).toBeGreaterThan(1);
    expect(Math.max(...Array.from(sides))).toBeGreaterThan(4);
  });

  it("keeps every cell inside the coordinate space", () => {
    const map = generateMinefieldMap(options());
    for (const cell of map.cells) {
      for (const p of cell.poly) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(map.size);
        expect(p.y).toBeLessThanOrEqual(map.size);
      }
    }
  });

  it("produces a symmetric adjacency graph with no self-links", () => {
    const map = generateMinefieldMap(options());
    for (const cell of map.cells) {
      expect(cell.neighbors).not.toContain(cell.id);
      expect(new Set(cell.neighbors).size).toBe(cell.neighbors.length);
      for (const n of cell.neighbors) {
        expect(map.cells[n].neighbors).toContain(cell.id);
      }
    }
  });

  it("leaves the whole field connected, so carving never strands a region", () => {
    const map = generateMinefieldMap(options());
    expect(hopDistances(map.cells, 0).every((d) => d >= 0)).toBe(true);
  });

  it("puts the goal a real distance from the start", () => {
    const map = generateMinefieldMap(options());
    expect(map.startCell).not.toEqual(map.goalCell);
    expect(hopDistances(map.cells, map.startCell)[map.goalCell]).toBeGreaterThan(2);
  });

  it("always ships a field that can actually be crossed", () => {
    // The headline promise of the generator, checked across many seeds and both extremes of
    // the difficulty range - a party does not get to discover an unwinnable map.
    for (let seed = 0; seed < 25; seed++) {
      const easy = generateMinefieldMap(
        options({ seed, mineCount: 6, mineKinds: 1, wallCount: 0 }),
      );
      const hard = generateMinefieldMap(
        options({ seed, mineCount: 26, mineKinds: 5, wallCount: 3, viablePaths: 1 }),
      );
      expect(findSafeRoute(easy)).not.toBeNull();
      expect(findSafeRoute(hard)).not.toBeNull();
    }
  });

  it("keeps the opening move safe: nothing on the start cell or next to it", () => {
    for (let seed = 0; seed < 15; seed++) {
      const map = generateMinefieldMap(options({ seed, mineCount: 26 }));
      const forbidden = new Set([map.startCell, ...map.cells[map.startCell].neighbors]);
      for (const hazard of map.hazards) {
        expect(forbidden.has(hazard.cellId)).toBe(false);
      }
      expect(map.hazards.some((h) => h.cellId === map.goalCell)).toBe(false);
    }
  });

  it("never puts two hazards in the same cell", () => {
    const map = generateMinefieldMap(options({ mineCount: 26 }));
    const cells = map.hazards.map((h) => h.cellId);
    expect(new Set(cells).size).toBe(cells.length);
  });

  it("honours the variety knob", () => {
    const plain = generateMinefieldMap(options({ mineKinds: 1 }));
    expect(new Set(plain.hazards.map((h) => h.kind))).toEqual(new Set(["standard"]));

    const varied = generateMinefieldMap(options({ mineKinds: 5, mineCount: 26 }));
    expect(new Set(varied.hazards.map((h) => h.kind)).size).toBeGreaterThan(2);
  });

  it("gives every multi-step mine a total between 2 and 5", () => {
    const map = generateMinefieldMap(options({ mineKinds: 5, mineCount: 26 }));
    for (const hazard of map.hazards.filter((h) => h.kind === "multistep")) {
      expect(hazard.steps).toBeGreaterThanOrEqual(2);
      expect(hazard.steps).toBeLessThanOrEqual(5);
    }
  });

  it("rations invisible mines rather than dealing them evenly", () => {
    const map = generateMinefieldMap(options({ mineKinds: 5, mineCount: 20 }));
    const invisible = map.hazards.filter((h) => h.kind === "invisible").length;
    expect(invisible).toBeLessThanOrEqual(Math.round(20 * 0.2));
  });

  it("caps walls, and gives each one a switch somewhere else on the field", () => {
    const map = generateMinefieldMap(options({ wallCount: 9 }));
    expect(map.walls.length).toBeLessThanOrEqual(MAX_WALLS);
    for (const wall of map.walls) {
      expect(map.cells[wall.a].neighbors).toContain(wall.b);
      expect(wall.switchCell).not.toEqual(wall.a);
      expect(wall.switchCell).not.toEqual(wall.b);
      expect(wall.switchCell).not.toEqual(map.startCell);
      expect(map.hazards.some((h) => h.cellId === wall.switchCell)).toBe(false);
    }
  });

  it("places no walls at all when the difficulty asks for none", () => {
    expect(generateMinefieldMap(options({ wallCount: 0 })).walls).toHaveLength(0);
  });
});
