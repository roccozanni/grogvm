/**
 * Convert an indexed framebuffer + 768-byte RGB palette to `ImageData`
 * RGBA bytes; pixels matching `transparentIndex` get alpha 0, all others 255.
 */
export function indexedToRgba(
  indexed: Uint8Array,
  palette: Uint8Array,
  transparentIndex: number | null = null,
): Uint8ClampedArray<ArrayBuffer> {
  if (palette.length < 768) {
    throw new Error(`palette too short: ${palette.length} bytes (need ≥ 768)`);
  }
  const out = new Uint8ClampedArray(indexed.length * 4);
  for (let i = 0; i < indexed.length; i++) {
    const idx = indexed[i]!;
    if (idx === transparentIndex) {
      // out[i*4..i*4+3] left at 0 — RGBA (0,0,0,0) = fully transparent.
      continue;
    }
    const palOffset = idx * 3;
    out[i * 4] = palette[palOffset]!;
    out[i * 4 + 1] = palette[palOffset + 1]!;
    out[i * 4 + 2] = palette[palOffset + 2]!;
    out[i * 4 + 3] = 255;
  }
  return out;
}
