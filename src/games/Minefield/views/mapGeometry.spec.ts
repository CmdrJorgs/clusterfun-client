import { generateMinefieldMap } from "../models/minefieldMap";
import {
  boundsOf,
  polyPoints,
  sharedEdges,
  trailPoints,
  unflatten,
  viewBoxFor,
} from "./mapGeometry";

// Two unit squares side by side, sharing the edge x=1.
const left = [0, 0, 1, 0, 1, 1, 0, 1];
const right = [1, 0, 2, 0, 2, 1, 1, 1];
const detached = [5, 5, 6, 5, 6, 6, 5, 6];

describe("unflatten / polyPoints", () => {
  it("reads a flat wire polygon back into points", () => {
    expect(unflatten(left)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  });

  it("ignores a trailing half-point rather than emitting a NaN corner", () => {
    expect(unflatten([0, 0, 1, 1, 2])).toHaveLength(2);
  });

  it("formats an SVG points attribute", () => {
    expect(polyPoints(left)).toBe("0,0 1,0 1,1 0,1");
  });
});

describe("boundsOf", () => {
  it("covers every polygon it is given", () => {
    expect(boundsOf([left, right])).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 1 });
  });

  it("falls back to a unit box rather than infinities when there is nothing to draw", () => {
    expect(boundsOf([])).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });
});

describe("viewBoxFor", () => {
  it("pads the short axis so the field keeps its proportions", () => {
    // Content is 2x1; asking for a square box must grow the HEIGHT, not squash the width.
    const [x, y, w, h] = viewBoxFor([left, right], 0, 1).split(" ").map(Number);
    expect(w).toBeCloseTo(2);
    expect(h).toBeCloseTo(2);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-0.5);
  });

  it("grows the width when the box is wider than the content", () => {
    const [, , w, h] = viewBoxFor([left], 0, 2).split(" ").map(Number);
    expect(w).toBeCloseTo(2);
    expect(h).toBeCloseTo(1);
  });

  it("applies the margin on all sides", () => {
    const [x, y] = viewBoxFor([left], 0.5, 1).split(" ").map(Number);
    expect(x).toBeCloseTo(-0.5);
    expect(y).toBeCloseTo(-0.5);
  });
});

describe("sharedEdges", () => {
  it("finds the border two neighbours have in common, whichever way it was wound", () => {
    const found = sharedEdges(left, right);
    expect(found).toHaveLength(1);
    const [p, q] = found[0];
    expect(new Set([p.x, q.x])).toEqual(new Set([1]));
    expect(new Set([p.y, q.y])).toEqual(new Set([0, 1]));
  });

  it("is symmetric", () => {
    expect(sharedEdges(right, left)).toHaveLength(1);
  });

  it("finds nothing between cells that do not touch", () => {
    expect(sharedEdges(left, detached)).toEqual([]);
  });

  it("returns every shared segment when merged cells touch along more than one", () => {
    // Two cells each two lattice squares tall, running alongside each other.  Drawing only
    // the first segment would leave a gap in the wall that reads as a doorway.
    const tall = [1, 0, 2, 0, 2, 2, 1, 2, 1, 1];
    const stepped = [0, 0, 1, 0, 1, 1, 1, 2, 0, 2];
    expect(sharedEdges(stepped, tall)).toHaveLength(2);
  });

  it("finds a border for every adjacent pair in a real generated field", () => {
    // Wall rendering depends on this and nothing else enforces it: merged cells keep every
    // lattice vertex (boundaryRings never simplifies collinear corners), so two neighbours
    // always describe their shared border with the SAME segments and an exact-match lookup
    // is enough.  If cell outlines ever started being simplified, walls would silently stop
    // being drawn - and an invisible wall is indistinguishable from a bug in the rules.
    const map = generateMinefieldMap({
      seed: 9,
      mineCount: 10,
      mineKinds: 3,
      holeCount: 2,
      wallCount: 3,
      viablePaths: 2,
    });
    const flat = (id: number) => map.cells[id].poly.flatMap((p) => [p.x, p.y]);
    for (const cell of map.cells) {
      for (const neighbor of cell.neighbors) {
        expect(sharedEdges(flat(cell.id), flat(neighbor)).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("trailPoints", () => {
  const centers = new Map([
    [0, { x: 0, y: 0 }],
    [1, { x: 10, y: 10 }],
    [2, { x: 20, y: 0 }],
  ]);

  it("joins the centres of the cells walked", () => {
    expect(trailPoints(centers, [0, 1, 2])).toBe("0,0 10,10 20,0");
  });

  it("skips cells it has no centre for instead of drawing through the origin", () => {
    expect(trailPoints(centers, [0, 99, 2])).toBe("0,0 20,0");
  });
});
