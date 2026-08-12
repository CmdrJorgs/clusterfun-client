// ==========================================================================================
// Pure drawing helpers shared by the advisor's map and the explorer's local view.
//
// Both screens work from the same wire format (flat [x0,y0,x1,y1,...] polygons) and both must
// draw the field in the SAME orientation - "up" is up everywhere.  That is the one thing the
// game hands the players for free; every other way of referring to a cell is theirs to
// invent (see DESIGN.md).  So there is no rotation anywhere in here, only fit-to-box.
// ==========================================================================================

export interface Pt {
  x: number;
  y: number;
}

export function unflatten(flat: number[]): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] });
  return points;
}

/** An SVG `points` attribute for a flat polygon. */
export function polyPoints(flat: number[]): string {
  return unflatten(flat)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(polys: number[][]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const flat of polys) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      minX = Math.min(minX, flat[i]);
      maxX = Math.max(maxX, flat[i]);
      minY = Math.min(minY, flat[i + 1]);
      maxY = Math.max(maxY, flat[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/**
 * An SVG viewBox around these polygons with a margin, padded out to `aspect` (width/height)
 * so the drawing keeps its proportions instead of being stretched to the element.
 */
export function viewBoxFor(polys: number[][], margin: number, aspect: number): string {
  const box = boundsOf(polys);
  let x = box.minX - margin;
  let y = box.minY - margin;
  let width = box.maxX - box.minX + margin * 2;
  let height = box.maxY - box.minY + margin * 2;

  if (width / height < aspect) {
    const wanted = height * aspect;
    x -= (wanted - width) / 2;
    width = wanted;
  } else {
    const wanted = width / aspect;
    y -= (wanted - height) / 2;
    height = wanted;
  }
  return `${x} ${y} ${width} ${height}`;
}

function edgeKey(p: Pt, q: Pt): string {
  const first = p.x < q.x || (p.x === q.x && p.y <= q.y) ? p : q;
  const second = first === p ? q : p;
  return `${first.x},${first.y}|${second.x},${second.y}`;
}

/**
 * The border segment(s) two neighbouring cells have in common - where a wall gets drawn.
 *
 * The cells came out of a shared lattice, so their corner coordinates match exactly and this
 * is a key lookup rather than a floating-point proximity test.  Merged cells can touch along
 * more than one segment, so this returns all of them and the caller draws the lot; a wall
 * with a gap in it would read as a doorway.
 */
export function sharedEdges(a: number[], b: number[]): [Pt, Pt][] {
  const inA = new Map<string, [Pt, Pt]>();
  const pointsA = unflatten(a);
  for (let i = 0; i < pointsA.length; i++) {
    const p = pointsA[i];
    const q = pointsA[(i + 1) % pointsA.length];
    inA.set(edgeKey(p, q), [p, q]);
  }

  const found: [Pt, Pt][] = [];
  const pointsB = unflatten(b);
  for (let i = 0; i < pointsB.length; i++) {
    const p = pointsB[i];
    const q = pointsB[(i + 1) % pointsB.length];
    const match = inA.get(edgeKey(p, q));
    if (match) found.push(match);
  }
  return found;
}

/** A polyline through the centres of a run of cells - an explorer's trail. */
export function trailPoints(centers: Map<number, Pt>, path: number[]): string {
  return path
    .map((id) => centers.get(id))
    .filter((p): p is Pt => !!p)
    .map((p) => `${p.x},${p.y}`)
    .join(" ");
}
