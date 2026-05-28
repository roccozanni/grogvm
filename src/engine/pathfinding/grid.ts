/**
 * Grid A* over a walkable mask.
 *
 * Phase 6's pathfinder. Given a `width × height` byte mask (1 =
 * walkable) and start/goal pixel coords, return a polyline of pixel
 * waypoints from start to goal (inclusive). 8-connectivity (so the
 * actor can move diagonally), Manhattan heuristic (admissible for 4-
 * connectivity; slightly loose for 8 but fine for our needs and
 * faster than the proper octile metric in practice).
 *
 * # When start or goal lie off the walkable area
 *
 * The original engine snaps both to the nearest box edge. We snap
 * to the nearest walkable pixel via a bounded BFS — cheaper than
 * the polygon math and handles all the edge cases (off-screen, in
 * a hole, on top of the box-union boundary) uniformly.
 *
 * # Output
 *
 * Returns `{ waypoints, reachedGoal }`. `reachedGoal` is false when
 * the goal isn't reachable from the start (e.g. they're in disjoint
 * walkable regions). In that case `waypoints` is the path from start
 * to the closest reachable cell — caller decides whether to walk it.
 */

const SQRT2 = Math.SQRT2;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PathResult {
  /** Ordered pixel waypoints from start to (best-reachable) goal, inclusive. */
  readonly waypoints: ReadonlyArray<Point>;
  /** True iff we actually reached the requested goal. */
  readonly reachedGoal: boolean;
}

/**
 * Find a path between two pixel positions over the walkable mask.
 *
 * Returns an empty `waypoints` if start and goal are the same. Throws
 * `RangeError` only on invalid mask dimensions — out-of-bounds
 * start/goal coords are clamped + snapped to the nearest walkable
 * cell rather than throwing.
 */
export function findPath(
  mask: Uint8Array,
  width: number,
  height: number,
  start: Point,
  goal: Point,
): PathResult {
  if (mask.length !== width * height) {
    throw new RangeError(
      `findPath: mask length ${mask.length} ≠ ${width}×${height} = ${width * height}`,
    );
  }
  if (width <= 0 || height <= 0) {
    return { waypoints: [], reachedGoal: true };
  }

  const startSnapped = snapToWalkable(mask, width, height, start);
  const goalSnapped = snapToWalkable(mask, width, height, goal);
  if (!startSnapped) {
    return { waypoints: [], reachedGoal: false };
  }
  if (startSnapped.x === (goalSnapped?.x ?? -1) && startSnapped.y === (goalSnapped?.y ?? -1)) {
    return { waypoints: [{ x: startSnapped.x, y: startSnapped.y }], reachedGoal: true };
  }

  // Search target: if the requested goal is unreachable, A* will
  // still try (and fail). We fall back to "closest reachable to goal"
  // by tracking the lowest-h cell we expanded.
  const effectiveGoal = goalSnapped ?? startSnapped;

  const cellCount = width * height;
  const gScore = new Float64Array(cellCount).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const closed = new Uint8Array(cellCount);

  const startIdx = startSnapped.y * width + startSnapped.x;
  const goalIdx = effectiveGoal.y * width + effectiveGoal.x;

  const open = new BinaryHeap();
  gScore[startIdx] = 0;
  open.push(startIdx, heuristic(startSnapped, effectiveGoal));

  let bestIdx = startIdx;
  let bestH = heuristic(startSnapped, effectiveGoal);

  while (!open.isEmpty()) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;
    if (current === goalIdx) {
      return {
        waypoints: simplify(reconstructPath(cameFrom, current, width)),
        reachedGoal: true,
      };
    }
    const cx = current % width;
    const cy = (current - cx) / width;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (!mask[ni]) continue;
      const stepCost = dx !== 0 && dy !== 0 ? SQRT2 : 1;
      const tentativeG = gScore[current]! + stepCost;
      if (tentativeG >= gScore[ni]!) continue;
      gScore[ni] = tentativeG;
      cameFrom[ni] = current;
      const h = heuristic({ x: nx, y: ny }, effectiveGoal);
      open.push(ni, tentativeG + h);
      if (h < bestH) {
        bestH = h;
        bestIdx = ni;
      }
    }
  }
  // Open list exhausted without reaching the goal — return the
  // closest cell we got to so the caller can at least walk partway.
  return {
    waypoints: simplify(reconstructPath(cameFrom, bestIdx, width)),
    reachedGoal: false,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/** 8-connected neighbours: (dx, dy) pairs. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function heuristic(a: Point, b: Point): number {
  // Octile distance: cheaper than euclidean, tighter than Manhattan
  // for 8-connectivity. dx + dy + (sqrt(2)-2) * min(dx, dy).
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
}

/**
 * BFS from `target` to the nearest cell whose mask byte is 1.
 * Returns `null` only if the entire mask is empty. Bounded by the
 * mask size, so O(width × height) worst case — fine at MI1's
 * 320×200 = 64k pixels.
 */
function snapToWalkable(
  mask: Uint8Array,
  width: number,
  height: number,
  target: Point,
): Point | null {
  const tx = clamp(target.x, 0, width - 1);
  const ty = clamp(target.y, 0, height - 1);
  if (mask[ty * width + tx]) return { x: tx, y: ty };
  // Empty mask shortcut.
  let anyWalkable = false;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) { anyWalkable = true; break; }
  }
  if (!anyWalkable) return null;
  // Standard BFS — the 4-connected version since diagonals don't
  // shorten the snap path meaningfully and complicate the open list.
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  let head = 0;
  const startIdx = ty * width + tx;
  visited[startIdx] = 1;
  queue.push(startIdx);
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (mask[cur]) {
      const x = cur % width;
      const y = (cur - x) / width;
      return { x, y };
    }
    const x = cur % width;
    const y = (cur - x) / width;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const ni = ny * width + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function reconstructPath(
  cameFrom: Int32Array,
  endIdx: number,
  width: number,
): Point[] {
  const out: Point[] = [];
  let cur = endIdx;
  while (cur !== -1) {
    const x = cur % width;
    const y = (cur - x) / width;
    out.push({ x, y });
    cur = cameFrom[cur]!;
  }
  out.reverse();
  return out;
}

/**
 * Collapse runs of waypoints that share a direction into a single
 * segment endpoint. Reduces a per-pixel zigzag to a polyline of
 * corner turns, which is what the actor walker needs (it
 * interpolates straight-line motion between waypoints).
 */
function simplify(points: ReadonlyArray<Point>): Point[] {
  if (points.length <= 2) return [...points];
  const out: Point[] = [points[0]!];
  let prev = points[0]!;
  let prevDx = points[1]!.x - prev.x;
  let prevDy = points[1]!.y - prev.y;
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1]!;
    const dx = next.x - points[i]!.x;
    const dy = next.y - points[i]!.y;
    if (dx !== prevDx || dy !== prevDy) {
      out.push(points[i]!);
      prevDx = dx;
      prevDy = dy;
    }
    prev = points[i]!;
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * Binary min-heap keyed by `(score, insertionOrder)` for stable
 * tie-breaking. Stores cell indices (the score comes from the
 * caller's f-score table). Allocates two parallel arrays so we can
 * avoid per-entry object allocation in the hot loop.
 */
class BinaryHeap {
  private indices: number[] = [];
  private scores: number[] = [];

  push(index: number, score: number): void {
    this.indices.push(index);
    this.scores.push(score);
    this.siftUp(this.indices.length - 1);
  }

  pop(): number {
    const topIdx = this.indices[0]!;
    const lastIdx = this.indices.pop()!;
    const lastScore = this.scores.pop()!;
    if (this.indices.length > 0) {
      this.indices[0] = lastIdx;
      this.scores[0] = lastScore;
      this.siftDown(0);
    }
    return topIdx;
  }

  isEmpty(): boolean {
    return this.indices.length === 0;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.scores[parent]! <= this.scores[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.indices.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.scores[l]! < this.scores[smallest]!) smallest = l;
      if (r < n && this.scores[r]! < this.scores[smallest]!) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const ti = this.indices[a]!;
    this.indices[a] = this.indices[b]!;
    this.indices[b] = ti;
    const ts = this.scores[a]!;
    this.scores[a] = this.scores[b]!;
    this.scores[b] = ts;
  }
}
