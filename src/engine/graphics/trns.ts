/**
 * TRNS — Transparent color index for a room.
 *
 * Payload: 16-bit little-endian palette index. Pixels of that color in
 * the room's SMAP background are treated as transparent: in-game, the
 * compositor draws actors and object images (OBIM) over them, so the
 * background acts as a "punch-out" stencil for everything that moves.
 *
 * When viewing a raw SMAP without object compositing (Phase 2 of
 * GrogVM), the transparent index is what shows through in the spots
 * an OBIM would normally cover.
 */
export function parseTrns(payload: Uint8Array): number {
  if (payload.length < 2) {
    throw new Error(`TRNS payload too short: ${payload.length} bytes (need ≥ 2)`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint16(0, true);
}
