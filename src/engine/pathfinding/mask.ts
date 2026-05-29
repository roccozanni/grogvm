/**
 * Rasterize walk boxes into a 1-byte-per-pixel walkable mask.
 *
 * Each SCUMM v5 walk box is a convex quadrilateral defined by four
 * corners (UL, UR, LR, LL). For pathfinding we flatten the union of
 * all *visible* boxes into a `width × height` byte mask: 1 = walkable,
 * 0 = blocked. Invisible boxes (flags bit 0x80) are excluded.
 *
 * # Why a mask
 *
 * The original SCUMM engine pathfinds over the box *graph* via BOXM's
 * adjacency table. Phase 6 ships with a simpler grid A* over this
 * rasterized mask — works on every room without parsing BOXM,
 * handles boxes that touch but aren't directly connected (the mask
 * just unions them), and is easy to visualise in the inspector.
 * The box-graph approach can replace the mask later without changing
 * the `findPath` call site.
 *
 * # Scan-line fill
 *
 * Walk boxes in MI1/MI2 are always convex (the wiki's prose insists,
 * and every MI1 room we've sampled obeys it). That means we can fill
 * via the trapezoid decomposition: split the quad along the y-axis,
 * scan from top to bottom, and at each row interpolate the left/right
 * intersection x. Cheaper than a general polygon fill, no edge
 * cases.
 *
 * The corners are listed UL → UR → LR → LL — we walk that loop to
 * find the left and right edges at each y. Boxes with degenerate
 * shapes (a corner repeated, or all corners collinear like room 10's
 * sentinel `[0x83, …]` box) produce zero coverage, which is fine.
 */

import { isInvisibleBox, type WalkBox } from './boxes';

/**
 * Build a `width × height` walkable mask from the room's walk boxes.
 * Each pixel is 1 if any visible box covers it, 0 otherwise.
 *
 * Pixels outside the box union (and any pixel outside [0, width) /
 * [0, height)) are left 0 — actors should never step onto them.
 */
export function buildWalkableMask(
  boxes: ReadonlyArray<WalkBox>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    fillBox(mask, width, height, box);
  }
  return mask;
}

/**
 * Fill one quadrilateral into the mask. We scan along BOTH axes and
 * union the result:
 *
 *   - by rows (interpolate the x-span at each y), and
 *   - by columns (interpolate the y-span at each x).
 *
 * A single-axis scan loses connectivity for boxes thinner than a pixel
 * along that axis. MI1 room 33's staircase boxes 2–6 are degenerate
 * (UL==UR, LR==LL) — i.e. diagonal *lines*. A steep line keeps its
 * pixels 8-connected under a row scan but not a column scan; a shallow
 * line is the reverse. Scanning both axes connects either orientation,
 * and is idempotent for ordinary (filled) convex quads.
 */
function fillBox(
  mask: Uint8Array,
  width: number,
  height: number,
  box: WalkBox,
): void {
  const xs = [box.ulx, box.urx, box.lrx, box.llx];
  const ys = [box.uly, box.ury, box.lry, box.lly];
  // Rows: primary axis = y (clamped to height), span axis = x (width).
  scanAxis(ys, xs, height, width, (y, lo, hi) => {
    const base = y * width;
    for (let x = lo; x <= hi; x++) mask[base + x] = 1;
  });
  // Columns: primary axis = x (clamped to width), span axis = y (height).
  scanAxis(xs, ys, width, height, (x, lo, hi) => {
    for (let y = lo; y <= hi; y++) mask[y * width + x] = 1;
  });
}

/**
 * Scan a convex quad along one axis. `primary` holds the four corner
 * coordinates on the scan axis (length `primaryMax`), `span` the four
 * on the other axis (length `spanMax`). For each integer line along the
 * primary axis it computes the covered `[lo, hi]` span and calls
 * `plot(line, lo, hi)`. Sub-pixel-thin spans keep one centre pixel so
 * thin/diagonal boxes stay connected.
 */
function scanAxis(
  primary: number[],
  span: number[],
  primaryMax: number,
  spanMax: number,
  plot: (line: number, lo: number, hi: number) => void,
): void {
  const pMin = Math.max(0, Math.min(primary[0]!, primary[1]!, primary[2]!, primary[3]!));
  const pMax = Math.min(primaryMax - 1, Math.max(primary[0]!, primary[1]!, primary[2]!, primary[3]!));
  if (pMax < pMin) return;
  const edges: ReadonlyArray<[number, number]> = [
    [0, 1], // UL → UR
    [1, 2], // UR → LR
    [2, 3], // LR → LL
    [3, 0], // LL → UL
  ];
  for (let a = pMin; a <= pMax; a++) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const [i, j] of edges) {
      const p0 = primary[i]!;
      const p1 = primary[j]!;
      const s0 = span[i]!;
      const s1 = span[j]!;
      if (a < Math.min(p0, p1) || a > Math.max(p0, p1)) continue;
      if (p0 === p1) {
        // Edge runs along the scan line — both endpoints bound the span.
        lo = Math.min(lo, s0, s1);
        hi = Math.max(hi, s0, s1);
        continue;
      }
      const t = (a - p0) / (p1 - p0);
      const s = s0 + (s1 - s0) * t;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    let left = Math.ceil(lo);
    let right = Math.floor(hi);
    // Span thinner than a pixel → keep one centre pixel so the box
    // doesn't drop the line entirely (breaks connectivity).
    if (right < left) left = right = Math.round((lo + hi) / 2);
    left = Math.max(0, left);
    right = Math.min(spanMax - 1, right);
    if (right < left) continue;
    plot(a, left, right);
  }
}
