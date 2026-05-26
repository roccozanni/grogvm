/**
 * SCUMM v5 costume frame ("Image") decoder.
 *
 * Image header layout (12 bytes), per Luddes's format notes (1999-2001):
 *
 *   off  size  field
 *    0    u8   width
 *    1    u8   (unknown — possibly width high byte for later games)
 *    2    u8   height
 *    3    u8   (unknown — possibly height high byte)
 *    4    i16  x        (signed X offset at composite time)
 *    6    i16  y        (signed Y offset)                   ◀── ptr lands here
 *    8    i16  xinc     (post-draw displacement of relPos.x)
 *   10    i16  yinc     (post-draw displacement of relPos.y; relPos.y -= yinc)
 *   12+   ...  rawImage (RLE bytes)
 *
 * The frame pointer in an ImageTable points to byte +6 of the header
 * (the `y` field). The decoder reads the header by going backwards
 * from that anchor.
 *
 * RLE encoding (16-color mode, format & 0x7f == 0x58):
 *
 *   byte = (color << 4) | length
 *   if length == 0: read one more byte as the actual length (u8, 1..255)
 *
 * Pixels are emitted in **column-major** order — fill column 0
 * top-to-bottom, then column 1, etc. Runs may straddle column
 * boundaries.
 *
 * 32-color mode (format & 0x7f == 0x59) uses 5 bits color / 3 bits
 * length with the same length-0 extension rule. Not implemented here
 * yet — every MI1/MI2 costume observed so far is 16-color.
 *
 * Costume palette index 0 is the transparent slot: we emit a sentinel
 * (`0xFF`) the compositor recognises and skips. Costume indices only
 * range 0..31, so `0xFF` is unambiguous in this namespace.
 */

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
   * `true` (default) treats costume palette index 0 as transparent,
   * substituting `COSTUME_FRAME_TRANSPARENT`. Set `false` to keep the
   * raw 0 — useful when debugging the RLE stream directly.
   */
  readonly transparentIsZero?: boolean;
}

export function decodeCostumeFrame(
  payload: Uint8Array,
  framePtr: number,
  options: DecodeCostumeFrameOptions = {},
): DecodedCostumeFrame {
  const transparentIsZero = options.transparentIsZero ?? true;
  const headerStart = framePtr - 6;
  if (headerStart < 0 || framePtr + 6 > payload.length) {
    throw new Error(
      `decodeCostumeFrame: framePtr 0x${framePtr.toString(16)} cannot fit a 12-byte ` +
        `header (payload length ${payload.length}).`,
    );
  }
  // width and height are u8 (each followed by an "unknown" filler byte
  // that's zero in MI1/MI2). x, y, xinc, yinc are i16 LE.
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

  // Column-major emit: for each column 0..width-1, fill height pixels
  // top-to-bottom. Runs straddle columns.
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
    const color = (byte >>> 4) & 0x0f;
    let len = byte & 0x0f;
    if (len === 0) {
      // 16-color mode: length nibble 0 means the next byte is the
      // actual length (u8, 1..255).
      if (rlePos >= payload.length) {
        throw new Error(
          `decodeCostumeFrame: truncated extended-length byte at 0x${(rlePos - 1).toString(16)}.`,
        );
      }
      len = payload[rlePos++]!;
    }
    const emit = transparentIsZero && color === 0 ? COSTUME_FRAME_TRANSPARENT : color;
    for (let k = 0; k < len && written < totalPixels; k++) {
      // Row-major output index: row * width + col.
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
