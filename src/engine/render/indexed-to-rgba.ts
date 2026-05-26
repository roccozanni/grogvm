/**
 * Convert an indexed-color framebuffer + 256-color RGB palette into the
 * RGBA bytes expected by `ImageData`. Pixels matching `transparentIndex`
 * (if given) are emitted as fully transparent (alpha = 0). All other
 * pixels are opaque (alpha = 255).
 *
 * Pure function — the load-bearing piece of any renderer. Canvas2D and
 * a hypothetical WebGL impl both consume the output of this directly.
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
