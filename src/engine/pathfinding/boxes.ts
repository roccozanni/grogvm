/**
 * SCUMM v5 walk-box (BOXD) + box-matrix (BOXM) parsers.
 *
 * BOXD lists the room's walkable regions as quadrilaterals — each box
 * has four corner points (UL, UR, LL, LR), a mask byte (the z-plane an
 * actor standing in the box clips against — its default `actorZ`; see
 * docs/SCUMM-V5-ZPLANE.md §"box-mask"), a flags byte (bit 0x80 =
 * ignore-in-pathfinding "invisible" box), and a scale slot into SCAL.
 *
 * Layout (post 8-byte block header):
 *
 *   u16 LE  count
 *   count × {
 *     i16 LE  ul_x, ul_y      // upper-left
 *     i16 LE  ur_x, ur_y      // upper-right
 *     i16 LE  lr_x, lr_y      // lower-right
 *     i16 LE  ll_x, ll_y      // lower-left
 *     u8      mask            // z-plane clip level (0 = front; N = behind plane N)
 *     u8      flags           // 0x80 = invisible/non-walkable
 *     u8      scaleSlot       // index into SCAL, 0 = no scale
 *     u8      _padding        // typically 0
 *   } = 20 bytes per box
 *
 * Empirically verified against MI1 rooms 10, 30, 32 — all match the
 * `2 + 20 × count` formula.
 *
 * BOXM is a per-box "next hop on the shortest path" lookup table used
 * by the original engine's box-graph pathfinder. Phase 6 uses
 * rasterized A* over the union of all walkable boxes, so BOXM is
 * captured but not consumed (yet). We expose the raw payload so the
 * box-graph pathfinder can decode it on its own schedule.
 */

export class WalkBoxParseError extends Error {
  constructor(detail: string) {
    super(`Walk-box parse error: ${detail}`);
    this.name = 'WalkBoxParseError';
  }
}

/** One walk-box quadrilateral plus its meta. */
export interface WalkBox {
  /** 0-based index into the BOXD list. Useful for cross-referencing BOXM. */
  readonly id: number;
  /** Upper-left corner. */
  readonly ulx: number;
  readonly uly: number;
  /** Upper-right corner. */
  readonly urx: number;
  readonly ury: number;
  /** Lower-right corner. */
  readonly lrx: number;
  readonly lry: number;
  /** Lower-left corner. */
  readonly llx: number;
  readonly lly: number;
  /**
   * Z-plane clip level for an actor standing in this box. `0` = in front
   * of every plane; `N` (>0) = behind plane `N` and above. The
   * compositor maps it to `actorZ` (same as `alwaysZclip k`) when the
   * actor has no explicit `forceClip`. See docs/SCUMM-V5-ZPLANE.md.
   */
  readonly mask: number;
  /** Flags byte. Bit 0x80 set → invisible box (excluded from pathfinding). */
  readonly flags: number;
  /**
   * Per-box scale field (u16). `0` = no per-box scaling; bit `0x8000` set =
   * a `SCAL`-slot reference (slot index = `scale & 0x7FFF`, interpolated by
   * the actor's y); otherwise a direct fixed scale (1..255). See
   * `pathfinding/scale.ts` (`resolveScale`).
   */
  readonly scale: number;
}

/** True when this box should not be considered for walking. */
export function isInvisibleBox(box: WalkBox): boolean {
  return (box.flags & 0x80) !== 0;
}

/**
 * Point-in-box test for a convex walk-box quadrilateral.
 *
 * The four corners are listed UL → UR → LR → LL (a closed convex loop;
 * winding may be CW or CCW depending on the room). A point is inside
 * when it lies on the same side of every directed edge — i.e. all four
 * edge cross-products share a sign. Points exactly on an edge (cross =
 * 0) count as inside, so boxes that share a border both claim the seam.
 *
 * Degenerate boxes need care:
 *   - A box collapsed to a single point — notably SCUMM's reserved
 *     invalid "box 0", whose corners are all (-32000, -32000) — must
 *     match *nothing*. A naive sign test reads every cross-product as 0
 *     and would wrongly claim every point.
 *   - A genuine zero-area *line* box (e.g. MI1 room 38 box 1, a
 *     horizontal segment with UL==LL / UR==LR, or room 33's diagonal
 *     staircase boxes) must still match a point that lies on the
 *     segment, since actors do stand on them.
 * Both fall out of the "no edge gave a sign" branch, where we decide by
 * the corners' bounding box: a real on-segment point is inside it, the
 * (-32000) sentinel point is far outside any room coordinate.
 */
export function pointInBox(box: WalkBox, x: number, y: number): boolean {
  const px = [box.ulx, box.urx, box.lrx, box.llx];
  const py = [box.uly, box.ury, box.lry, box.lly];
  let sawPos = false;
  let sawNeg = false;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    // Cross product of the edge (i→j) with the vector (i→point).
    const cross =
      (px[j]! - px[i]!) * (y - py[i]!) - (py[j]! - py[i]!) * (x - px[i]!);
    if (cross > 0) sawPos = true;
    else if (cross < 0) sawNeg = true;
    if (sawPos && sawNeg) return false;
  }
  if (!sawPos && !sawNeg) {
    // Degenerate (point or line) box — collinear with the test point.
    // Inside iff the point is within the corners' bounding box, which
    // restricts a line box to its segment and rejects the (-32000)
    // single-point sentinel for any real room coordinate.
    return (
      x >= Math.min(...px) && x <= Math.max(...px) &&
      y >= Math.min(...py) && y <= Math.max(...py)
    );
  }
  return true;
}

/**
 * Find the visible walk box a room-space point falls in, or `null` if
 * none. Invisible boxes (flags bit 0x80) are skipped — an actor never
 * stands on one. When boxes overlap (rare; they may share a seam) the
 * lowest-index match wins. Used by the compositor to derive an actor's
 * default z-clip from the box's `mask` when no explicit `forceClip` is
 * set. See docs/SCUMM-V5-ZPLANE.md §"box-mask".
 */
export function findBoxAt(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): WalkBox | null {
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    if (pointInBox(box, x, y)) return box;
  }
  return null;
}

/**
 * Like {@link findBoxAt}, but when no box strictly contains the point, return
 * the *nearest* visible box (by distance to its bounding rect) instead of
 * `null`. The walkable mask is rasterised leniently and MI1's cliff boxes are
 * thin/degenerate, so an actor on a valid floor pixel often sits in no box
 * strictly — which would otherwise leave its perspective scale stale. Used for
 * actor scaling (a stale box there means a stuck scale); kept separate from
 * `findBoxAt` so z-clip behaviour is unchanged.
 */
export function findBoxAtOrNearest(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): WalkBox | null {
  const strict = findBoxAt(boxes, x, y);
  if (strict) return strict;
  let best: WalkBox | null = null;
  let bestDist = Infinity;
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    const minX = Math.min(box.ulx, box.urx, box.lrx, box.llx);
    const maxX = Math.max(box.ulx, box.urx, box.lrx, box.llx);
    const minY = Math.min(box.uly, box.ury, box.lry, box.lly);
    const maxY = Math.max(box.uly, box.ury, box.lry, box.lly);
    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = box;
    }
  }
  return best;
}

export function parseWalkBoxes(payload: Uint8Array): WalkBox[] {
  if (payload.length < 2) {
    throw new WalkBoxParseError(`payload too short: ${payload.length} B (need ≥ 2 for count)`);
  }
  const count = payload[0]! | (payload[1]! << 8);
  const expected = 2 + 20 * count;
  if (payload.length !== expected) {
    throw new WalkBoxParseError(
      `payload size ${payload.length} doesn't match count=${count} (expected ${expected})`,
    );
  }
  const out: WalkBox[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i,
      ulx: readI16LE(payload, off + 0),
      uly: readI16LE(payload, off + 2),
      urx: readI16LE(payload, off + 4),
      ury: readI16LE(payload, off + 6),
      lrx: readI16LE(payload, off + 8),
      lry: readI16LE(payload, off + 10),
      llx: readI16LE(payload, off + 12),
      lly: readI16LE(payload, off + 14),
      mask: payload[off + 16]!,
      flags: payload[off + 17]!,
      // u16: the high bit (0x8000) flags a SCAL-slot reference, so this must
      // be read as 16 bits — not just the low byte.
      scale: payload[off + 18]! | (payload[off + 19]! << 8),
    });
    off += 20;
  }
  return out;
}

function readI16LE(buf: Uint8Array, off: number): number {
  const v = buf[off]! | (buf[off + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}
