/**
 * SCUMM v5 costume frame ("Image") decoder — 12-byte picture header +
 * column-major RLE pixels. Format reference: pages/docs/scumm/cost.md.
 */

/** Sentinel substituted for costume colour 0 (the transparent slot) — see
 *  pages/docs/engine/costumes.md. Costume indices only range 0..31, so 0xFF
 *  is unambiguous. */
export const COSTUME_FRAME_TRANSPARENT = 0xff;

export interface DecodedCostumeFrame {
  readonly width: number;
  readonly height: number;
  /** Signed X offset applied at composite time. */
  readonly redirX: number;
  /** Signed Y offset applied at composite time. */
  readonly redirY: number;
  /** Post-draw increment to actor's relX (for walking-frame chains). */
  readonly xinc: number;
  /** Post-draw increment to actor's relY (typically subtracted). */
  readonly yinc: number;
  /**
   * `width × height` pixels in row-major order: index 0 = top-left,
   * width-1 = top-right of row 0, etc. Each value is either a
   * **costume-local palette index** in 0..(paletteSize-1) or
   * `COSTUME_FRAME_TRANSPARENT` for "do not draw".
   */
  readonly pixels: Uint8Array;
  /** Number of RLE bytes consumed. Lets the caller find the next frame. */
  readonly rleByteCount: number;
}

export interface DecodeCostumeFrameOptions {
  /**
   * `true` (default) substitutes `COSTUME_FRAME_TRANSPARENT` for colour 0.
   * Set `false` to keep the raw 0 when debugging the RLE stream directly.
   */
  readonly transparentIsZero?: boolean;
  /**
   * Colour depth deciding the run-byte split (16 → 4+4 bits, 32 → 5+3);
   * pass `costume.header.paletteSize` — a mismatch decodes to garbage.
   */
  readonly paletteSize?: 16 | 32;
}

export function decodeCostumeFrame(
  payload: Uint8Array,
  framePtr: number,
  options: DecodeCostumeFrameOptions = {},
): DecodedCostumeFrame {
  const transparentIsZero = options.transparentIsZero ?? true;
  const paletteSize = options.paletteSize ?? 16;
  const lenShift = paletteSize === 32 ? 3 : 4;
  const lenMask = paletteSize === 32 ? 0x07 : 0x0f;
  const colorMask = paletteSize - 1; // 0x0f or 0x1f
  // The image-table pointer lands 6 bytes INTO the 12-byte picture header
  // (at its `y` field) — see pages/docs/scumm/cost.md §4.
  const headerStart = framePtr - 6;
  if (headerStart < 0 || framePtr + 6 > payload.length) {
    throw new Error(
      `decodeCostumeFrame: framePtr 0x${framePtr.toString(16)} cannot fit a 12-byte ` +
        `header (payload length ${payload.length}).`,
    );
  }
  // width/height are u8, each followed by a filler byte (zero in MI1/MI2).
  const width = payload[headerStart]!;
  const height = payload[headerStart + 2]!;
  const redirX = i16LE(payload, headerStart + 4);
  const redirY = i16LE(payload, headerStart + 6);
  const xinc = i16LE(payload, headerStart + 8);
  const yinc = i16LE(payload, headerStart + 10);

  if (width === 0 || height === 0) {
    throw new Error(
      `decodeCostumeFrame: zero dimension at framePtr 0x${framePtr.toString(16)} ` +
        `(width=${width}, height=${height}).`,
    );
  }

  const totalPixels = width * height;
  const pixels = new Uint8Array(totalPixels);
  const rleStart = framePtr + 6;
  let rlePos = rleStart;
  let written = 0;

  // RLE emit order is column-major (runs straddle columns); the output
  // buffer stays row-major.
  let col = 0;
  let row = 0;
  while (written < totalPixels) {
    if (rlePos >= payload.length) {
      throw new Error(
        `decodeCostumeFrame: ran out of RLE bytes while decoding frame at 0x${framePtr.toString(16)} ` +
          `(emitted ${written}/${totalPixels} pixels).`,
      );
    }
    const byte = payload[rlePos++]!;
    const color = (byte >>> lenShift) & colorMask;
    let len = byte & lenMask;
    if (len === 0) {
      // Length 0 escapes to a full-byte length (1..255) in both depths.
      if (rlePos >= payload.length) {
        throw new Error(
          `decodeCostumeFrame: truncated extended-length byte at 0x${(rlePos - 1).toString(16)}.`,
        );
      }
      len = payload[rlePos++]!;
    }
    const emit = transparentIsZero && color === 0 ? COSTUME_FRAME_TRANSPARENT : color;
    for (let k = 0; k < len && written < totalPixels; k++) {
      pixels[row * width + col] = emit;
      written++;
      row++;
      if (row >= height) {
        row = 0;
        col++;
        if (col >= width) break;
      }
    }
  }

  return {
    width,
    height,
    redirX,
    redirY,
    xinc,
    yinc,
    pixels,
    rleByteCount: rlePos - rleStart,
  };
}

function i16LE(b: Uint8Array, off: number): number {
  const v = b[off]! | (b[off + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}
