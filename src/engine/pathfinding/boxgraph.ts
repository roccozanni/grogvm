/**
 * SCUMM box-graph pathfinding.
 *
 * The faithful replacement for grid-A*-over-a-mask. The original engine
 * never rasterizes the floor — it routes over the **graph of walk boxes**:
 *
 *   1. Find the box the actor stands in (`startBox`) and the box the target
 *      sits in (`destBox`).
 *   2. Walk the BOXM matrix one hop at a time: `next = getNextBox(cur, dest)`
 *      until `cur === destBox`. That yields the exact box *sequence* the
 *      original walks — the thing grid-A* got wrong, because the rasterized
 *      mask unions every box and A* then hugs whatever pixels are shortest
 *      (e.g. a degenerate "line" box's single row), ignoring BOXM's intent.
 *   3. For each box→box transition, pick a **gate point** on the shared
 *      boundary (see {@link gateBetween}); string them together, ending at
 *      the true target.
 *
 * Each straight segment of the resulting polyline lies inside one convex box
 * (start→gate inside box A, gate→nextgate inside box B), so the walker can
 * interpolate it directly — no per-pixel path, no mask. This is why box-graph
 * paths "stride through the middle" of a room instead of hugging walls.
 *
 * Locked boxes (a closed door's `0x80` flag, applied as a runtime override)
 * are excluded by the caller: it passes a box list with overrides already
 * folded into `flags`, and {@link isInvisibleBox} drops them from both
 * endpoint-snapping and the hop chain — so you can't route through a sealed
 * corridor, the same effect the old mask got by deleting those pixels.
 */

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
 * Route from `start` to `goal` over the room's walk-box graph.
 *
 * `boxes` must already have any runtime flag overrides folded in (locked
 * boxes carry `0x80`), so invisible boxes are excluded uniformly. Returns
 * the gate waypoints (the actor's current position is NOT included — the
 * walker starts from where the actor already is) ending at the exact `goal`.
 * `reachedGoal` is false when the box chain can't reach the goal's box (a
 * sealed route); the partial waypoints are still walkable.
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
    // No usable boxes at all — straight line to the target.
    return { waypoints: [{ x: goal.x, y: goal.y }], reachedGoal: false };
  }
  // SCUMM clamps the requested point into the destination box before walking
  // (adjustXYToBeInBox): a click off the floor walks to the nearest floor
  // point, and an off-screen exit target inside an extended box is reached
  // exactly. A point already inside is unchanged.
  const dest = closestPointInBox(destBox, goal.x, goal.y);
  if (startBox.id === destBox.id) {
    return { waypoints: [dest], reachedGoal: true };
  }

  // Build the box sequence by following BOXM. Bounded by box count so a
  // malformed matrix (cycle / self-loop) can't spin forever.
  const seq: WalkBox[] = [startBox];
  let cur = startBox.id;
  let reachedGoal = false;
  for (let guard = 0; guard <= boxes.length; guard++) {
    if (cur === destBox.id) { reachedGoal = true; break; }
    const next = getNextBox(matrix, cur, destBox.id);
    if (next < 0 || next === cur) break; // unreachable / dead end
    const nextBox = boxes[next];
    // A hop into a locked (invisible) box is impassable — the route stops
    // short, exactly as the old mask refused those pixels.
    if (!nextBox || isInvisibleBox(nextBox)) break;
    seq.push(nextBox);
    cur = next;
  }

  // Gate point per transition, then the final point. Bias each gate toward the
  // target so the actor cuts naturally toward where it's heading. When the
  // route is sealed (chain stopped before the dest box), the final point is
  // clamped into the furthest *reachable* box, so the actor stops at the
  // sealed boundary instead of walking straight through the locked region.
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
 * The point an actor crosses from box `a` into the adjacent box `b`.
 *
 * SCUMM transitions between boxes at their shared boundary. We find that
 * boundary as a **collinear, overlapping edge pair** — a's edge and b's edge
 * lying on the same vertical (shared x) or horizontal (shared y) line, with
 * an overlapping span. The gate is the point on that overlap closest to the
 * destination (clamped to the span), so the actor heads toward its goal as it
 * crosses. The widest shared edge wins when several qualify.
 *
 * Boxes that only touch at a corner or run diagonally (MI1's staircase / cliff
 * "line" boxes share an endpoint, not an axis-aligned edge) have no collinear
 * edge — there we fall back to the midpoint of the closest pair of points
 * between the two outlines, which resolves to the shared corner.
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

  // No collinear edge — diagonal/corner-touching boxes. Use the midpoint of
  // the closest pair of points between the two outlines (the shared corner).
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

/**
 * SCUMM `adjustXYToBeInBox`: the point of box `b` closest to `(x, y)`. A point
 * already inside is returned unchanged; otherwise it's the nearest point on
 * the box outline (rounded to integer pixels, since actors live on the pixel
 * grid). Degenerate "line" boxes collapse to their segment.
 */
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
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y; // direction of seg 1
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y; // direction of seg 2
  const rx = p1.x - p3.x, ry = p1.y - p3.y;
  const a = d1x * d1x + d1y * d1y; // squared length seg 1
  const e = d2x * d2x + d2y * d2y; // squared length seg 2
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
