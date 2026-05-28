/**
 * SCUMM v5 walk-box (BOXD) + box-matrix (BOXM) parsers.
 *
 * BOXD lists the room's walkable regions as quadrilaterals — each box
 * has four corner points (UL, UR, LL, LR), a Y-mask byte (used by
 * SCAL for per-box scaling), a flags byte (bit 0x80 = ignore-in-
 * pathfinding "invisible" box), and a scale slot pointing into SCAL.
 *
 * Layout (post 8-byte block header):
 *
 *   u16 LE  count
 *   count × {
 *     i16 LE  ul_x, ul_y      // upper-left
 *     i16 LE  ur_x, ur_y      // upper-right
 *     i16 LE  lr_x, lr_y      // lower-right
 *     i16 LE  ll_x, ll_y      // lower-left
 *     u8      mask            // y-mask (0x83 = "no mask"; sentinel)
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
  /** Y-mask byte; 0x83 in MI1 is the "no special mask" sentinel. */
  readonly mask: number;
  /** Flags byte. Bit 0x80 set → invisible box (excluded from pathfinding). */
  readonly flags: number;
  /** SCAL slot, 0 = no per-box actor scaling. */
  readonly scaleSlot: number;
}

/** True when this box should not be considered for walking. */
export function isInvisibleBox(box: WalkBox): boolean {
  return (box.flags & 0x80) !== 0;
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
      scaleSlot: payload[off + 18]!,
      // payload[off + 19] = padding
    });
    off += 20;
  }
  return out;
}

function readI16LE(buf: Uint8Array, off: number): number {
  const v = buf[off]! | (buf[off + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}
