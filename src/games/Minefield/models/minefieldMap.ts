// ==========================================================================================
// PURE, framework-free minefield generation and analysis.  No MobX, no session, no DOM.
//
// This file answers three questions, and nothing else:
//
//   1. What does the field LOOK like?      generateMinefieldMap()
//   2. How forgiving is it?                countDisjointRoutes()
//   3. Can it actually be survived?        findSafeRoute()
//
// The mosaic is built from a JITTERED LATTICE that is then carved and merged, rather than
// from a Voronoi diagram.  That is a deliberate trade: a lattice hands us exact cell
// adjacency for free (two cells touch iff any of their quads were lattice-neighbours), where
// Voronoi would mean shipping a computational-geometry dependency and then recovering
// adjacency from floating-point edges.  The output still reads as an irregular hand-cut
// mosaic, and every step here is integer/float arithmetic that unit-tests without a canvas.
//
// Everything is deterministic from `seed`, so a failing map is always reproducible.
// ==========================================================================================

// ------------------------------------------------------------------------------------------
// Data model
// ------------------------------------------------------------------------------------------

/** A point in map space.  Coordinates are integers in 0..MAP_SIZE on both axes. */
export interface MapPoint {
  x: number;
  y: number;
}

export const MAP_SIZE = 1000;

export type HazardKind = "standard" | "multistep" | "freeze" | "motion" | "invisible";

/** The order hazards are introduced as the "variety" knob climbs from 1 to 5. */
export const HAZARD_ORDER: HazardKind[] = [
  "standard",
  "multistep",
  "freeze",
  "motion",
  "invisible",
];

export interface Hazard {
  id: number;
  kind: HazardKind;
  cellId: number;
  /** Multi-step mines only: total steps allowed before it kills (2..5). Zero otherwise. */
  steps: number;
}

/** A wall blocks the shared edge between two cells until its switch cell is stepped on. */
export interface Wall {
  id: number;
  a: number;
  b: number;
  switchCell: number;
}

export interface MapCell {
  id: number;
  /** Closed ring of the cell's outline, in map space. */
  poly: MapPoint[];
  center: MapPoint;
  neighbors: number[];
}

export interface MinefieldMapData {
  seed: number;
  size: number;
  cells: MapCell[];
  /** Rings of the whole field's silhouette: the outer ring first, then any holes. */
  outline: MapPoint[][];
  startCell: number;
  goalCell: number;
  hazards: Hazard[];
  walls: Wall[];
}

export interface MapGenOptions {
  seed: number;
  /** Number of mines to place. */
  mineCount: number;
  /** How many distinct hazard kinds to draw from, 1..5, taken from HAZARD_ORDER. */
  mineKinds: number;
  /** Interior cells removed outright. */
  holeCount: number;
  /** Wall + switch pairs. Capped at MAX_WALLS so the solver's state space stays small. */
  wallCount: number;
  /** Target number of vertex-disjoint safe routes: 1 is a tightrope, 3 is forgiving. */
  viablePaths: number;
}

/**
 * Walls are the one feature that expands the solver's state space multiplicatively (it has
 * to search over which switches have been thrown), so the count is capped rather than
 * trusted to the difficulty settings.  Three is 8 switch states, which is free.
 */
export const MAX_WALLS = 3;

/**
 * Motion mines multiply the solver's state space too (each is idle / fusing / spent), so
 * they get their own cap.  Five is 4^5 = 1024 fuse configurations, still cheap.
 */
export const MAX_MOTION_MINES = 5;

/** Quads merged into a single mosaic cell. Any polyomino this small is always hole-free. */
const MAX_CELL_QUADS = 3;

const LATTICE = 11; // vertices per side -> 10x10 = 100 starting quads
const JITTER = 0.34; // as a fraction of one lattice step
const MERGE_RATE = 0.55;
const EDGE_BITE = 0.34; // chance a border quad is eaten, per erosion pass
const EROSION_PASSES = 2;

// ------------------------------------------------------------------------------------------
// Deterministic RNG (mulberry32).  Small, fast, and good enough for map generation; the
// point is reproducibility from a seed, not cryptographic quality.
// ------------------------------------------------------------------------------------------
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Outline extraction.
//
// Every quad contributes its four edges in a consistent winding.  An edge INTERNAL to the
// shape is contributed twice, once in each direction, by the two quads sharing it; a
// BOUNDARY edge is contributed only once.  So cancelling out every directed edge whose
// reverse also exists leaves exactly the boundary, already consistently oriented - which
// means a ring can be walked by repeatedly following an out-edge, and a pinch point (two
// quads meeting at a single corner) resolves itself instead of forking.
//
// This one function draws both an individual merged cell and the whole field's silhouette.
// ------------------------------------------------------------------------------------------
export function boundaryRings(quads: number[][], points: MapPoint[]): MapPoint[][] {
  const directed = new Set<string>();
  for (const quad of quads) {
    for (let i = 0; i < quad.length; i++) {
      directed.add(`${quad[i]}>${quad[(i + 1) % quad.length]}`);
    }
  }

  const outEdges = new Map<number, number[]>();
  for (const edge of directed) {
    const [a, b] = edge.split(">").map(Number);
    if (directed.has(`${b}>${a}`)) continue; // internal - cancelled by its twin
    const list = outEdges.get(a);
    if (list) list.push(b);
    else outEdges.set(a, [b]);
  }

  const rings: MapPoint[][] = [];
  const starts = Array.from(outEdges.keys()).sort((l, r) => l - r);
  for (const first of starts) {
    while ((outEdges.get(first) ?? []).length > 0) {
      const ring: MapPoint[] = [];
      let current = first;
      // Walk out-edges, consuming them, until we arrive back where we started.
      for (let guard = 0; guard < directed.size + 1; guard++) {
        const options = outEdges.get(current);
        if (!options || options.length === 0) break;
        const next = options.shift()!;
        ring.push(points[current]);
        current = next;
        if (current === first) break;
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  // Longest ring first: for the whole field that is the silhouette, and the rest are holes.
  rings.sort((l, r) => r.length - l.length);
  return rings;
}

function centroid(ring: MapPoint[]): MapPoint {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  return { x: Math.round(x / ring.length), y: Math.round(y / ring.length) };
}

// ------------------------------------------------------------------------------------------
// Geometry: jittered lattice -> carve -> keep the largest piece -> merge quads into cells.
// ------------------------------------------------------------------------------------------
interface Geometry {
  cells: MapCell[];
  outline: MapPoint[][];
}

function buildGeometry(rng: () => number, holeCount: number): Geometry {
  const step = MAP_SIZE / (LATTICE - 1);
  const vertexIndex = (i: number, j: number) => j * LATTICE + i;

  // 1. Jittered vertices.  Border vertices slide only ALONG their border so the lattice
  //    stays rectangular; the irregular silhouette comes from carving, not from a ragged
  //    starting rectangle (which would leave slivers).
  const points: MapPoint[] = [];
  for (let j = 0; j < LATTICE; j++) {
    for (let i = 0; i < LATTICE; i++) {
      const onLeft = i === 0;
      const onRight = i === LATTICE - 1;
      const onTop = j === 0;
      const onBottom = j === LATTICE - 1;
      const freeX = !onLeft && !onRight;
      const freeY = !onTop && !onBottom;
      const jx = freeX ? (rng() * 2 - 1) * JITTER * step : 0;
      const jy = freeY ? (rng() * 2 - 1) * JITTER * step : 0;
      points.push({ x: Math.round(i * step + jx), y: Math.round(j * step + jy) });
    }
  }

  // 2. Quads, in a consistent winding.
  const span = LATTICE - 1;
  const quadVerts: number[][] = [];
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      quadVerts.push([
        vertexIndex(i, j),
        vertexIndex(i + 1, j),
        vertexIndex(i + 1, j + 1),
        vertexIndex(i, j + 1),
      ]);
    }
  }
  const quadAt = (i: number, j: number) =>
    i < 0 || j < 0 || i >= span || j >= span ? -1 : j * span + i;
  const quadNeighbors = (q: number): number[] => {
    const i = q % span;
    const j = Math.floor(q / span);
    return [quadAt(i - 1, j), quadAt(i + 1, j), quadAt(i, j - 1), quadAt(i, j + 1)].filter(
      (n) => n >= 0,
    );
  };

  const alive = new Set<number>(quadVerts.map((_, q) => q));

  // 3a. Erode the border so the field is not a rectangle.  Each pass re-evaluates what
  //     counts as "border", which is what produces bays and headlands rather than a
  //     uniformly nibbled rim.
  for (let pass = 0; pass < EROSION_PASSES; pass++) {
    const exposed = Array.from(alive).filter(
      (q) => quadNeighbors(q).length < 4 || quadNeighbors(q).some((n) => !alive.has(n)),
    );
    for (const q of exposed) {
      if (rng() < EDGE_BITE * (pass === 0 ? 1 : 0.5)) alive.delete(q);
    }
  }

  // 3b. Punch interior holes - the "missing cells" obstacle.
  for (let h = 0; h < holeCount; h++) {
    const interior = Array.from(alive).filter((q) =>
      quadNeighbors(q).every((n) => alive.has(n) && quadNeighbors(n).length === 4),
    );
    if (interior.length === 0) break;
    alive.delete(interior[Math.floor(rng() * interior.length)]);
  }

  // 3c. Carving can strand a peninsula.  Keep only the largest connected piece, so the
  //     field is always one walkable region and start/goal can never be picked apart.
  const seen = new Set<number>();
  let best: number[] = [];
  for (const q of alive) {
    if (seen.has(q)) continue;
    const component: number[] = [];
    const stack = [q];
    seen.add(q);
    while (stack.length) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const n of quadNeighbors(cur)) {
        if (alive.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  const kept = new Set(best);

  // 4. Merge neighbouring quads into irregular cells (groups of at most MAX_CELL_QUADS).
  const parent = new Map<number, number>();
  const groupSize = new Map<number, number>();
  for (const q of kept) {
    parent.set(q, q);
    groupSize.set(q, 1);
  }
  const find = (q: number): number => {
    let root = q;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let walk = q;
    while (parent.get(walk)! !== walk) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (const q of shuffled(Array.from(kept), rng)) {
    if (rng() > MERGE_RATE) continue;
    const mine = find(q);
    const candidates = quadNeighbors(q)
      .filter((n) => kept.has(n))
      .map(find)
      .filter((r) => r !== mine && groupSize.get(r)! + groupSize.get(mine)! <= MAX_CELL_QUADS);
    if (candidates.length === 0) continue;
    const other = candidates[Math.floor(rng() * candidates.length)];
    parent.set(other, mine);
    groupSize.set(mine, groupSize.get(mine)! + groupSize.get(other)!);
  }

  // 5. Turn each group into a cell, and recover adjacency from the lattice.
  const groups = new Map<number, number[]>();
  for (const q of kept) {
    const root = find(q);
    const list = groups.get(root);
    if (list) list.push(q);
    else groups.set(root, [q]);
  }
  const roots = Array.from(groups.keys()).sort((l, r) => l - r);
  const cellIdOfRoot = new Map<number, number>();
  roots.forEach((root, index) => cellIdOfRoot.set(root, index));

  const cells: MapCell[] = roots.map((root, index) => {
    const ring = boundaryRings(
      groups.get(root)!.map((q) => quadVerts[q]),
      points,
    )[0];
    return { id: index, poly: ring, center: centroid(ring), neighbors: [] };
  });

  const adjacency = roots.map(() => new Set<number>());
  for (const q of kept) {
    const from = cellIdOfRoot.get(find(q))!;
    for (const n of quadNeighbors(q)) {
      if (!kept.has(n)) continue;
      const to = cellIdOfRoot.get(find(n))!;
      if (to !== from) adjacency[from].add(to);
    }
  }
  cells.forEach((cell, index) => {
    cell.neighbors = Array.from(adjacency[index]).sort((l, r) => l - r);
  });

  const outline = boundaryRings(
    Array.from(kept).map((q) => quadVerts[q]),
    points,
  );

  return { cells, outline };
}

// ------------------------------------------------------------------------------------------
// Graph helpers
// ------------------------------------------------------------------------------------------

/** Hop counts from `from` to every reachable cell, ignoring hazards and walls. */
export function hopDistances(cells: MapCell[], from: number): number[] {
  const dist = cells.map(() => -1);
  dist[from] = 0;
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of cells[cur].neighbors) {
      if (dist[n] === -1) {
        dist[n] = dist[cur] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

export function wallBetween(map: MinefieldMapData, a: number, b: number): Wall | undefined {
  return map.walls.find((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
}

// ------------------------------------------------------------------------------------------
// How forgiving is this field?
//
// "Number of viable paths" is defined EXACTLY as the number of vertex-disjoint routes from
// start to goal across the statically-safe cells - by Menger's theorem that is also the size
// of the smallest set of cells whose loss would cut the field in two.  One means a tightrope
// where a single blocked cell strands you; three means there is real room to re-route.
//
// It is computed as a max-flow on the node-split graph: every cell becomes in->out with
// capacity 1 (so a route may use it once), and adjacency becomes uncapped out->in edges.
// ------------------------------------------------------------------------------------------
export function countDisjointRoutes(
  cells: MapCell[],
  blocked: Set<number>,
  start: number,
  goal: number,
): number {
  if (start === goal) return 0;
  if (blocked.has(start) || blocked.has(goal)) return 0;

  const INF = cells.length + 1;
  const nodeIn = (c: number) => c * 2;
  const nodeOut = (c: number) => c * 2 + 1;
  const cap = new Map<number, Map<number, number>>();
  const addEdge = (u: number, v: number, c: number) => {
    if (!cap.has(u)) cap.set(u, new Map());
    if (!cap.has(v)) cap.set(v, new Map());
    cap.get(u)!.set(v, (cap.get(u)!.get(v) ?? 0) + c);
    if (!cap.get(v)!.has(u)) cap.get(v)!.set(u, 0);
  };

  for (const cell of cells) {
    if (blocked.has(cell.id)) continue;
    const throughput = cell.id === start || cell.id === goal ? INF : 1;
    addEdge(nodeIn(cell.id), nodeOut(cell.id), throughput);
    for (const n of cell.neighbors) {
      if (blocked.has(n)) continue;
      addEdge(nodeOut(cell.id), nodeIn(n), INF);
    }
  }

  const source = nodeOut(start);
  const sink = nodeIn(goal);
  let flow = 0;
  for (;;) {
    const prev = new Map<number, number>([[source, -1]]);
    const queue = [source];
    let reached = false;
    for (let head = 0; head < queue.length && !reached; head++) {
      const u = queue[head];
      for (const [v, c] of cap.get(u) ?? []) {
        if (c <= 0 || prev.has(v)) continue;
        prev.set(v, u);
        if (v === sink) {
          reached = true;
          break;
        }
        queue.push(v);
      }
    }
    if (!reached) break;

    let bottleneck = Infinity;
    for (let v = sink; v !== source; v = prev.get(v)!) {
      bottleneck = Math.min(bottleneck, cap.get(prev.get(v)!)!.get(v)!);
    }
    for (let v = sink; v !== source; v = prev.get(v)!) {
      const u = prev.get(v)!;
      cap.get(u)!.set(v, cap.get(u)!.get(v)! - bottleneck);
      cap.get(v)!.set(u, (cap.get(v)!.get(u) ?? 0) + bottleneck);
    }
    flow += bottleneck;
    if (flow > cells.length) break;
  }
  return flow;
}

// ------------------------------------------------------------------------------------------
// Can this field actually be survived?
//
// countDisjointRoutes only looks at cells that are statically lethal.  Motion mines are not:
// they arm when approached and detonate two moves later, so whether a route is survivable
// depends on WHERE YOU GO NEXT, and walls depend on which switches you have already thrown.
// So the real check is a breadth-first search over the full state
//
//     (cell, walls opened, every motion mine's fuse)
//
// which is exact rather than approximate.  The two caps above are what keep it small: at
// most 3 walls (8 states) and 5 motion mines (4^5), so the whole space is a few hundred
// thousand states in the worst case and a few hundred in practice.
//
// A guaranteed route must never REQUIRE stepping on a mine no advisor can warn about, so
// standard, multi-step and invisible mines are all treated as walls here.  That is not
// conservatism for its own sake: a map whose only solution is "step on the mine nobody can
// see" is an unfair map, and this is the check that refuses to ship one.
// ------------------------------------------------------------------------------------------
export function findSafeRoute(map: MinefieldMapData, maxStates = 400000): number[] | null {
  const { cells, startCell, goalCell } = map;
  if (startCell === goalCell) return [startCell];

  const blocked = new Set<number>();
  for (const h of map.hazards) {
    if (h.kind === "standard" || h.kind === "multistep" || h.kind === "invisible") {
      blocked.add(h.cellId);
    }
  }
  if (blocked.has(startCell) || blocked.has(goalCell)) return null;

  const motion = map.hazards.filter((h) => h.kind === "motion").slice(0, MAX_MOTION_MINES);
  const inBlast = motion.map((h) => {
    const cell = cells[h.cellId];
    return new Set<number>([h.cellId, ...(cell ? cell.neighbors : [])]);
  });
  const pow4 = [1, 4, 16, 64, 256, 1024];
  const digitOf = (fuses: number, i: number) => Math.floor(fuses / pow4[i]) % 4;
  const withDigit = (fuses: number, i: number, value: number) =>
    fuses + (value - digitOf(fuses, i)) * pow4[i];

  const switchBits = new Map<number, number>();
  map.walls.forEach((w, i) => {
    switchBits.set(w.switchCell, (switchBits.get(w.switchCell) ?? 0) | (1 << i));
  });
  const wallBits = new Map<string, number>();
  map.walls.forEach((w, i) => {
    wallBits.set(`${Math.min(w.a, w.b)}:${Math.max(w.a, w.b)}`, 1 << i);
  });

  interface Node {
    cell: number;
    mask: number;
    fuses: number;
    prev: Node | null;
  }
  const startMask = switchBits.get(startCell) ?? 0;
  let startFuses = 0;
  motion.forEach((_, i) => {
    if (inBlast[i].has(startCell)) startFuses = withDigit(startFuses, i, 2);
  });

  const root: Node = { cell: startCell, mask: startMask, fuses: startFuses, prev: null };
  const seen = new Set<string>([`${root.cell}|${root.mask}|${root.fuses}`]);
  const queue: Node[] = [root];

  for (let head = 0; head < queue.length; head++) {
    if (seen.size > maxStates) return null;
    const node = queue[head];
    for (const next of cells[node.cell].neighbors) {
      if (blocked.has(next)) continue;

      const wallBit = wallBits.get(`${Math.min(node.cell, next)}:${Math.max(node.cell, next)}`);
      if (wallBit !== undefined && (node.mask & wallBit) === 0) continue;

      // Fuses tick FIRST, then this move's own proximity arms anything new - which is what
      // makes an armed mine give you exactly two moves to get clear of its blast.
      let fuses = node.fuses;
      let killed = false;
      for (let i = 0; i < motion.length && !killed; i++) {
        const digit = digitOf(fuses, i);
        if (digit === 2) fuses = withDigit(fuses, i, 1);
        else if (digit === 1) {
          if (inBlast[i].has(next)) killed = true;
          else fuses = withDigit(fuses, i, 3);
        }
      }
      if (killed) continue;
      for (let i = 0; i < motion.length; i++) {
        if (digitOf(fuses, i) === 0 && inBlast[i].has(next)) fuses = withDigit(fuses, i, 2);
      }

      const mask = node.mask | (switchBits.get(next) ?? 0);
      const key = `${next}|${mask}|${fuses}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const child: Node = { cell: next, mask, fuses, prev: node };
      if (next === goalCell) {
        const route: number[] = [];
        for (let walk: Node | null = child; walk; walk = walk.prev) route.unshift(walk.cell);
        return route;
      }
      queue.push(child);
    }
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// Hazard placement
// ------------------------------------------------------------------------------------------
function placeHazards(
  geometry: Geometry,
  startCell: number,
  goalCell: number,
  options: MapGenOptions,
  rng: () => number,
): { hazards: Hazard[]; walls: Wall[] } {
  const { cells } = geometry;
  const kinds = HAZARD_ORDER.slice(
    0,
    Math.max(1, Math.min(HAZARD_ORDER.length, options.mineKinds)),
  );

  // The opening move is always safe: nothing sits on the start, and nothing sits next to it
  // either, so a motion mine cannot be armed before anybody has said a word.
  const forbidden = new Set<number>([startCell, goalCell, ...cells[startCell].neighbors]);
  const open = shuffled(
    cells.map((c) => c.id).filter((id) => !forbidden.has(id)),
    rng,
  );

  const hazards: Hazard[] = [];
  const used = new Set<number>();
  let motionPlaced = 0;
  // Invisible mines are the only hazard no advisor can ever warn about, so they are rationed
  // rather than dealt evenly - a field that is a fifth unknowable is tense, a field that is
  // half unknowable is a coin toss.
  const invisibleCap = Math.max(1, Math.round(options.mineCount * 0.2));
  let invisiblePlaced = 0;

  for (let i = 0; i < options.mineCount && open.length > 0; i++) {
    let kind = kinds[i % kinds.length];
    if (kind === "invisible" && invisiblePlaced >= invisibleCap) kind = "standard";
    if (kind === "motion" && motionPlaced >= MAX_MOTION_MINES) kind = "standard";

    const cellId = open.pop()!;
    if (used.has(cellId)) continue;
    used.add(cellId);
    if (kind === "motion") motionPlaced++;
    if (kind === "invisible") invisiblePlaced++;
    hazards.push({
      id: hazards.length,
      kind,
      cellId,
      steps: kind === "multistep" ? 2 + Math.floor(rng() * 4) : 0,
    });
  }

  // Walls need a switch somewhere else on the field; the solver is what proves the switch is
  // reachable without first passing through the wall it opens.
  const walls: Wall[] = [];
  const switchPool = shuffled(
    cells.map((c) => c.id).filter((id) => !used.has(id) && id !== startCell && id !== goalCell),
    rng,
  );
  const edges = shuffled(
    cells.flatMap((c) => c.neighbors.filter((n) => n > c.id).map((n) => [c.id, n] as const)),
    rng,
  );
  const wallTarget = Math.min(options.wallCount, MAX_WALLS);
  for (const [a, b] of edges) {
    if (walls.length >= wallTarget || switchPool.length === 0) break;
    if (walls.some((w) => w.a === a || w.b === a || w.a === b || w.b === b)) continue;
    walls.push({ id: walls.length, a, b, switchCell: switchPool.pop()! });
  }

  return { hazards, walls };
}

function pickStartAndGoal(cells: MapCell[], rng: () => number): { start: number; goal: number } {
  const start = Math.floor(rng() * cells.length);
  const dist = hopDistances(cells, start);
  const reach = Math.max(...dist);
  const far = cells.map((c) => c.id).filter((id) => dist[id] >= reach * 0.7);
  const goal = far.length ? far[Math.floor(rng() * far.length)] : dist.indexOf(reach);
  return { start, goal };
}

// ------------------------------------------------------------------------------------------
// generateMinefieldMap - the whole pipeline, with rejection sampling.
//
// Generation is cheap and verification is exact, so rather than trying to place hazards
// cleverly we place them randomly and throw away any field that is unfair.  A map is only
// accepted when it has BOTH the requested number of disjoint routes and a proven survivable
// route.  Failing that we fall back in stages, and the last stage - a field with no hazards
// at all - is unwinnable-proof.  This function never returns a map that cannot be finished.
// ------------------------------------------------------------------------------------------
export function generateMinefieldMap(options: MapGenOptions): MinefieldMapData {
  const attempts = 60;
  let solvableFallback: MinefieldMapData | null = null;
  let anyGeometry: Geometry | null = null;
  let anyStartGoal = { start: 0, goal: 0 };

  for (let attempt = 0; attempt < attempts; attempt++) {
    const seed = (options.seed + attempt * 7919) >>> 0;
    const rng = makeRng(seed);
    const geometry = buildGeometry(rng, options.holeCount);
    if (geometry.cells.length < 12) continue;

    const { start, goal } = pickStartAndGoal(geometry.cells, rng);
    if (start === goal) continue;
    anyGeometry = geometry;
    anyStartGoal = { start, goal };

    const { hazards, walls } = placeHazards(geometry, start, goal, options, rng);
    const candidate: MinefieldMapData = {
      seed,
      size: MAP_SIZE,
      cells: geometry.cells,
      outline: geometry.outline,
      startCell: start,
      goalCell: goal,
      hazards,
      walls,
    };

    if (findSafeRoute(candidate) === null) continue;
    if (!solvableFallback) solvableFallback = candidate;

    const blocked = new Set(
      hazards
        .filter((h) => h.kind === "standard" || h.kind === "multistep" || h.kind === "invisible")
        .map((h) => h.cellId),
    );
    if (countDisjointRoutes(geometry.cells, blocked, start, goal) === options.viablePaths) {
      return candidate;
    }
  }

  // Survivable but not as forgiving (or as tight) as asked for - still a good game.
  if (solvableFallback) return solvableFallback;

  // Nothing placed cleanly. Ship the bare field rather than a field nobody can cross.
  const geometry = anyGeometry ?? buildGeometry(makeRng(options.seed), 0);
  const { start, goal } =
    anyGeometry === null
      ? pickStartAndGoal(geometry.cells, makeRng(options.seed + 1))
      : anyStartGoal;
  return {
    seed: options.seed,
    size: MAP_SIZE,
    cells: geometry.cells,
    outline: geometry.outline,
    startCell: start,
    goalCell: goal,
    hazards: [],
    walls: [],
  };
}
