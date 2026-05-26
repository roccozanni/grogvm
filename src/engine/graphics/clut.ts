/**
 * CLUT — Color lookup table for a room.
 *
 * Payload: 256 × (R, G, B) = 768 bytes.
 *
 * Public docs disagree on whether SCUMM v5 stores values in the VGA DAC
 * 0–63 range or already in 0–255. For MI1 CD VGA and MI2 DOS VGA we use
 * the bytes as-is (0–255 range). If room images come out radically dark
 * in the player, the fix is a 6→8 bit upscale here.
 *
 * Returns an own buffer (not a view) so callers can mutate freely.
 */
export function parseClut(payload: Uint8Array): Uint8Array {
  if (payload.length < 768) {
    throw new Error(`CLUT payload too short: ${payload.length} bytes (need ≥ 768)`);
  }
  return payload.slice(0, 768);
}
