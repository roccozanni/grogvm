/** Box-graph routing over BOXM. Model and rationale: pages/docs/engine/pathfinding.md. */

import {
  clamp,
  closestPointInBox,
  closestSeg,
  corners,
  findBoxAtOrNearest,
  getNextBox,
  isInvisibleBox,
  pointInBox,
  type BoxMatrix,
  type BoxMatrixRow,
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

/**
 * Whether two boxes are box-graph neighbors. Derived empirically from MI1's
 * own disk BOXMs (every direct hop classified against the pair's geometry):
 *
 *  1. Collinear axis-aligned edges overlapping over a positive span — the
 *     ordinary abutting-floor case.
 *  2. A collapsed (zero-length) edge vertex of one box touching the other
 *     box's outline — how the staircase/cliff "line" boxes (both endpoints
 *     collapsed) and sliver triangles chain together.
 *
 * Rectangle corners touching point-to-point do NOT connect (room 40 routes
 * 1→2 via a third box), and neither do two line boxes crossing mid-span
 * (room 58's forest verticals cross the ground line unlinked).
 */
export function areBoxesNeighbors(a: WalkBox, b: WalkBox): boolean {
  const ca = corners(a);
  const cb = corners(b);
  for (let i = 0; i < 4; i++) {
    const a0 = ca[i]!, a1 = ca[(i + 1) % 4]!;
    for (let j = 0; j < 4; j++) {
      const b0 = cb[j]!, b1 = cb[(j + 1) % 4]!;
      // Vertical shared edge with positive overlap.
      if (a0.x === a1.x && b0.x === b1.x && a0.x === b0.x) {
        const lo = Math.max(Math.min(a0.y, a1.y), Math.min(b0.y, b1.y));
        const hi = Math.min(Math.max(a0.y, a1.y), Math.max(b0.y, b1.y));
        if (hi - lo > 0) return true;
      }
      // Horizontal shared edge with positive overlap.
      if (a0.y === a1.y && b0.y === b1.y && a0.y === b0.y) {
        const lo = Math.max(Math.min(a0.x, a1.x), Math.min(b0.x, b1.x));
        const hi = Math.min(Math.max(a0.x, a1.x), Math.max(b0.x, b1.x));
        if (hi - lo > 0) return true;
      }
    }
  }
  return collapsedVertexTouches(ca, cb) || collapsedVertexTouches(cb, ca);
}

/** Whether a zero-length edge vertex of outline `ca` lies on outline `cb`. */
function collapsedVertexTouches(ca: Point[], cb: Point[]): boolean {
  for (let i = 0; i < 4; i++) {
    const a0 = ca[i]!, a1 = ca[(i + 1) % 4]!;
    if (a0.x !== a1.x || a0.y !== a1.y) continue; // not collapsed
    for (let j = 0; j < 4; j++) {
      const [pa, pb] = closestSeg(a0, a0, cb[j]!, cb[(j + 1) % 4]!);
      if ((pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2 < 1e-9) return true;
    }
  }
  return false;
}

/**
 * SCUMM `createBoxMatrix`: recompute the next-hop matrix from the CURRENT
 * boxes — invisible (locked) boxes drop out of the graph entirely, so a walk
 * detours around a region a script just sealed (room 7's dragged chest locks
 * box 11; the rebuilt matrix routes 2→10→9→1 around it). BFS per source box
 * gives shortest hop chains, the same metric the disk BOXM encodes.
 */
export function buildBoxMatrix(boxes: ReadonlyArray<WalkBox>): BoxMatrix {
  const n = boxes.length;
  const visible = boxes.map((b) => !isInvisibleBox(b));
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    if (!visible[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!visible[j] || !areBoxesNeighbors(boxes[i]!, boxes[j]!)) continue;
      neighbors[i]!.push(j);
      neighbors[j]!.push(i);
    }
  }

  const rows: BoxMatrixRow[] = [];
  for (let s = 0; s < n; s++) {
    const row: Array<{ from: number; to: number; next: number }> = [];
    if (visible[s]) {
      // BFS from `s`; firstHop[v] = the neighbor of `s` the shortest chain
      // toward `v` enters first.
      const firstHop = new Array<number>(n).fill(-1);
      const queue = [s];
      const seen = new Array<boolean>(n).fill(false);
      seen[s] = true;
      for (let q = 0; q < queue.length; q++) {
        const cur = queue[q]!;
        for (const nb of neighbors[cur]!) {
          if (seen[nb]) continue;
          seen[nb] = true;
          firstHop[nb] = cur === s ? nb : firstHop[cur]!;
          queue.push(nb);
        }
      }
      for (let dest = 0; dest < n; dest++) {
        if (dest === s || firstHop[dest]! < 0) continue;
        const prev = row[row.length - 1];
        if (prev && prev.to === dest - 1 && prev.next === firstHop[dest]) prev.to = dest;
        else row.push({ from: dest, to: dest, next: firstHop[dest]! });
      }
    }
    rows.push(row);
  }
  return rows;
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

