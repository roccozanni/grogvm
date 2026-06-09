/**
 * TRNS — the room's transparent palette index (u16 LE).
 * See pages/docs/scumm/room.md §4.
 */
export function parseTrns(payload: Uint8Array): number {
  if (payload.length < 2) {
    throw new Error(`TRNS payload too short: ${payload.length} bytes (need ≥ 2)`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getUint16(0, true);
}
