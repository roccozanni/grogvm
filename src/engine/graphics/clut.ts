/**
 * CLUT — room palette, 256 × (R, G, B) = 768 bytes. Values are used as-is
 * (0–255): public docs disagree on a VGA DAC 0–63 range, but MI1 CD /
 * MI2 DOS VGA data is full-range. Returns an own buffer so callers can mutate.
 */
export function parseClut(payload: Uint8Array): Uint8Array {
  if (payload.length < 768) {
    throw new Error(`CLUT payload too short: ${payload.length} bytes (need ≥ 768)`);
  }
  return payload.slice(0, 768);
}
