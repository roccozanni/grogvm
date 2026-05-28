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
 * Fill one quadrilateral by scan-line. Walks each y in the box's
 * bounding rows; at each row, computes the leftmost and rightmost
 * x covered by the box's edges. Edges are clamped to the framebuffer.
 *
 * For convex quads the "row coverage" is simply the min/max x over
 * the four edges' intersections with the row. We iterate edges
 * (UL→UR, UR→LR, LR→LL, LL→UL) and for each row that an edge crosses,
 * compute the edge's x at that y and update the running min/max.
 */
function fillBox(
  mask: Uint8Array,
  width: number,
  height: number,
  box: WalkBox,
): void {
  const xs = [box.ulx, box.urx, box.lrx, box.llx];
  const ys = [box.uly, box.ury, box.lry, box.lly];
  let yMin = Math.max(0, Math.min(ys[0]!, ys[1]!, ys[2]!, ys[3]!));
  let yMax = Math.min(height - 1, Math.max(ys[0]!, ys[1]!, ys[2]!, ys[3]!));
  if (yMax < yMin) return;

  // Pre-compute the four edges as (x0, y0) → (x1, y1).
  const edges: Array<[number, number, number, number]> = [
    [xs[0]!, ys[0]!, xs[1]!, ys[1]!], // UL → UR
    [xs[1]!, ys[1]!, xs[2]!, ys[2]!], // UR → LR
    [xs[2]!, ys[2]!, xs[3]!, ys[3]!], // LR → LL
    [xs[3]!, ys[3]!, xs[0]!, ys[0]!], // LL → UL
  ];

  for (let y = yMin; y <= yMax; y++) {
    let xLo = Number.POSITIVE_INFINITY;
    let xHi = Number.NEGATIVE_INFINITY;
    for (const [x0, y0, x1, y1] of edges) {
      // Skip edges that don't cross this scan row (including
      // horizontal edges at y0==y1: their endpoints already
      // contribute as the previous/next edge starts/ends).
      if ((y < Math.min(y0, y1)) || (y > Math.max(y0, y1))) continue;
      if (y0 === y1) {
        // Horizontal edge — both endpoints lie on this row, so the
        // segment itself bounds the row's coverage.
        xLo = Math.min(xLo, x0, x1);
        xHi = Math.max(xHi, x0, x1);
        continue;
      }
      // Linear interpolation: x at this y.
      const t = (y - y0) / (y1 - y0);
      const x = x0 + (x1 - x0) * t;
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
    if (!Number.isFinite(xLo) || !Number.isFinite(xHi)) continue;
    const left = Math.max(0, Math.ceil(xLo));
    const right = Math.min(width - 1, Math.floor(xHi));
    if (right < left) continue;
    const rowBase = y * width;
    for (let x = left; x <= right; x++) mask[rowBase + x] = 1;
  }
}
