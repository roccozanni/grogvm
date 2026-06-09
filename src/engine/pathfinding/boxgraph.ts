/** Box-graph routing over BOXM. Model and rationale: pages/docs/engine/pathfinding.md. */

import {
  findBoxAtOrNearest,
  getNextBox,
  isInvisibleBox,
  pointInBox,
  type BoxMatrix,
  type WalkBox,
} from './boxes';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PathResult {
  /** Ordered gate waypoints from the first box transition to the target. */
  readonly waypoints: ReadonlyArray<Point>;
  /** True iff the box chain actually reached the target's box. */
  readonly reachedGoal: boolean;
}

/**
 * `boxes` must already carry any runtime flag overrides. Waypoints exclude the
 * actor's current position; on a sealed route `reachedGoal` is false and the
 * partial waypoints are still walkable.
 */
export function routeThroughBoxes(
  boxes: ReadonlyArray<WalkBox>,
  matrix: BoxMatrix,
  start: Point,
  goal: Point,
): PathResult {
  const startBox = findBoxAtOrNearest(boxes, start.x, start.y);
  const destBox = findBoxAtOrNearest(boxes, goal.x, goal.y);
  if (!startBox || !destBox) {
    return { waypoints: [{ x: goal.x, y: goal.y }], reachedGoal: false };
  }
  const dest = closestPointInBox(destBox, goal.x, goal.y);
  if (startBox.id === destBox.id) {
    return { waypoints: [dest], reachedGoal: true };
  }

  // Bounded by box count so a malformed matrix (cycle) can't spin forever.
  const seq: WalkBox[] = [startBox];
  let cur = startBox.id;
  let reachedGoal = false;
  for (let guard = 0; guard <= boxes.length; guard++) {
    if (cur === destBox.id) { reachedGoal = true; break; }
    const next = getNextBox(matrix, cur, destBox.id);
    if (next < 0 || next === cur) break; // unreachable / dead end
    const nextBox = boxes[next];
    if (!nextBox || isInvisibleBox(nextBox)) break; // locked box is impassable
    seq.push(nextBox);
    cur = next;
  }

  // On a sealed route, clamp the final point into the furthest *reachable*
  // box so the actor stops at the boundary, not inside the locked region.
  const lastBox = seq[seq.length - 1]!;
  const finalPoint = reachedGoal ? dest : closestPointInBox(lastBox, goal.x, goal.y);
  const waypoints: Point[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    waypoints.push(gateBetween(seq[i]!, seq[i + 1]!, finalPoint));
  }
  waypoints.push(finalPoint);
  return { waypoints, reachedGoal };
}

/** Corners of a box as a closed 4-point loop (UL → UR → LR → LL). */
function corners(b: WalkBox): Point[] {
  return [
    { x: b.ulx, y: b.uly },
    { x: b.urx, y: b.ury },
    { x: b.lrx, y: b.lry },
    { x: b.llx, y: b.lly },
  ];
}

/**
 * The point an actor crosses from box `a` into adjacent box `b`.
 * Gate-point model: pages/docs/engine/pathfinding.md §4.
 */
export function gateBetween(a: WalkBox, b: WalkBox, dest: Point): Point {
  const ca = corners(a);
  const cb = corners(b);
  let best: Point | null = null;
  let bestOverlap = -1;

  for (let i = 0; i < 4; i++) {
    const a0 = ca[i]!, a1 = ca[(i + 1) % 4]!;
    for (let j = 0; j < 4; j++) {
      const b0 = cb[j]!, b1 = cb[(j + 1) % 4]!;
      // Vertical shared edge: both edges have constant, equal x.
      if (a0.x === a1.x && b0.x === b1.x && a0.x === b0.x) {
        const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
        if (hi >= lo && hi - lo > bestOverlap) {
          bestOverlap = hi - lo;
          best = { x: a0.x, y: clamp(dest.y, lo, hi) };
        }
      }
      // Horizontal shared edge: both edges have constant, equal y.
      if (a0.y === a1.y && b0.y === b1.y && a0.y === b0.y) {
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        if (hi >= lo && hi - lo > bestOverlap) {
          bestOverlap = hi - lo;
          best = { x: clamp(dest.x, lo, hi), y: a0.y };
        }
      }
    }
  }
  if (best) return best;

  // No collinear edge (diagonal/corner-touching boxes): midpoint of the
  // closest pair of points between the two outlines.
  let bestDist = Infinity;
  let mid: Point = { x: cb[0]!.x, y: cb[0]!.y };
  for (let i = 0; i < 4; i++) {
    const a0 = ca[i]!, a1 = ca[(i + 1) % 4]!;
    for (let j = 0; j < 4; j++) {
      const b0 = cb[j]!, b1 = cb[(j + 1) % 4]!;
      const [pa, pb] = closestSeg(a0, a1, b0, b1);
      const d = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        mid = { x: Math.round((pa.x + pb.x) / 2), y: Math.round((pa.y + pb.y) / 2) };
      }
    }
  }
  return mid;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** SCUMM `adjustXYToBeInBox`: the point of box `b` closest to `(x, y)`, in integer pixels. */
export function closestPointInBox(b: WalkBox, x: number, y: number): Point {
  if (pointInBox(b, x, y)) return { x, y };
  const c = corners(b);
  const p: Point = { x, y };
  let best: Point = c[0]!;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const [, q] = closestSeg(p, p, c[i]!, c[(i + 1) % 4]!);
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bestDist) { bestDist = d; best = q; }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/**
 * Closest pair of points between segments p1p2 and p3p4 (Ericson, Real-Time
 * Collision Detection, ClosestPtSegmentSegment). Handles degenerate
 * point/line segments — MI1's "line" boxes collapse to a segment or a point.
 */
function closestSeg(p1: Point, p2: Point, p3: Point, p4: Point): [Point, Point] {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const rx = p1.x - p3.x, ry = p1.y - p3.y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const bdot = d1x * d2x + d1y * d2y;
      const denom = a * e - bdot * bdot;
      s = denom > 1e-9 ? clamp((bdot * f - c * e) / denom, 0, 1) : 0;
      t = (bdot * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((bdot - c) / a, 0, 1); }
    }
  }
  return [
    { x: p1.x + d1x * s, y: p1.y + d1y * s },
    { x: p3.x + d2x * t, y: p3.y + d2y * t },
  ];
}
