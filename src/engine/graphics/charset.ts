/**
 * SCUMM v5 CHAR (character set / bitmap font) decoder.
 *
 * Block layout (after the 8-byte block header `'CHAR' + size BE`):
 *
 *   off  size   field
 *    0    u32   size       — redundant; equals (block_size − 23)
 *    4    u16   magic      — observed value 0x0363, identical across all
 *                            MI1/MI2 charsets (presumably "version 3").
 *    6    15B   colorMap   — table indexed 1..15: maps a glyph bit
 *                            pattern (1..15) → CLUT index. For 1-bpp
 *                            charsets only `colorMap[1]` is used; for
 *                            2-bpp, `colorMap[1..3]`. (Costume-style
 *                            mapping: 0 always means transparent.)
 *   21    u8    bpp        — 1 or 2 bits per glyph pixel.
 *   22    u8    fontHeight — declared font height in pixels. Individual
 *                            glyphs can be shorter and offset within
 *                            this band.
 *   23    u16   numChars   — number of entries in the offset table
 *                            below. 251 or 256 in MI1.
 *   25    u32×N glyphOffsets — N = numChars; each entry points to one
 *                            glyph's per-glyph header.
 *
 * ⚠️ Glyph offsets are payload-byte positions measured **relative to
 * byte 21** (the bpp byte), not from byte 0. So glyph data for char
 * `c` lives at `payload[21 + glyphOffsets[c]]`. An offset value of 0
 * is the "no glyph for this char code" sentinel.
 *
 * Per-glyph header (4 bytes, then the bitmap):
 *
 *   off  size  field
 *    0    u8   width
 *    1    u8   height
 *    2    i8   xOffset
 *    3    i8   yOffset
 *    4..  bits packed: width × height pixels at `bpp` bits each,
 *         row-major, MSB-first within each byte.
 *
 * The bitmap byte count is `ceil(width × height × bpp / 8)`. Rows do
 * not pad to a byte boundary — bits flow contiguously across rows.
 */

import { payloadOf, type ResourceFile } from '../resources/tree';
import type { Block } from '../resources/block';
import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';

export interface CharsetEntry {
  readonly lflfIndex: number;
  readonly indexInLflf: number;
  readonly lflfBlock: Block;
  readonly charBlock: Block;
}

export function walkCharsets(file: ResourceFile): CharsetEntry[] {
  const lecf = file.tree.find((b) => b.tag === 'LECF');
  if (!lecf?.children) return [];

  const result: CharsetEntry[] = [];
  let lflfIndex = 0;
  for (const lflf of lecf.children) {
    if (lflf.tag === 'LFLF') {
      let indexInLflf = 0;
      for (const inner of lflf.children ?? []) {
        if (inner.tag === 'CHAR') {
          result.push({ lflfIndex, indexInLflf, lflfBlock: lflf, charBlock: inner });
          indexInLflf++;
        }
      }
      lflfIndex++;
    }
  }
  return result;
}

export function charsetPayload(file: ResourceFile, entry: CharsetEntry): Uint8Array {
  return payloadOf(file, entry.charBlock);
}

/**
 * Resolve a charset by its **SCUMM charset id** — the number scripts
 * pass to `initCharset` — via the index's `DCHR` directory, NOT walk
 * order. This matters: `walkCharsets` returns CHAR blocks in file order,
 * but the script's id space (from `DCHR`) is different — in MI1 it
 * includes built-in null entries (ids 0 and 5) and is otherwise offset
 * from walk order, so `walkCharsets()[id]` gives the WRONG font (e.g.
 * the thin 1-bpp charset where talk wants the bold 2-bpp one).
 *
 * `DCHR[id]` gives `{room, offset}`; the absolute file offset is
 * `loff(room) + offset`, which equals the CHAR block's offset — we match
 * it against the walked blocks to recover the block size, then slice the
 * payload (skipping the 8-byte block header) and parse the header.
 *
 * Returns `null` for the built-in null charsets (room 0 / offset 0, e.g.
 * ids 0 and 5) and when the id / room / block can't be resolved — the
 * caller falls back to a default font.
 */
export function resolveCharsetById(
  file: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  id: number,
): { header: CharsetHeader; payload: Uint8Array } | null {
  const dir = index.charsets[id];
  if (!dir || (dir.room === 0 && dir.offset === 0)) return null;
  const base = loff.get(dir.room);
  if (base === undefined) return null;
  const abs = base + dir.offset;
  const entry = walkCharsets(file).find((e) => e.charBlock.offset === abs);
  if (!entry) return null;
  const payload = file.bytes.subarray(
    entry.charBlock.offset + 8,
    entry.charBlock.offset + entry.charBlock.size,
  );
  try {
    return { header: parseCharHeader(payload), payload };
  } catch {
    return null;
  }
}

/** Sentinel value for "this character is transparent / not drawn". */
export const CHARSET_TRANSPARENT = 0xff;

export interface CharsetHeader {
  /** Total CHAR data size from byte 15 of the payload onwards. Mostly informational. */
  readonly size: number;
  /** Format magic; observed `0x0363` across every MI1/MI2 charset. */
  readonly magic: number;
  /**
   * 15-byte palette mapping: `colorMap[k]` is the CLUT index that
   * non-zero glyph bit-pattern `k` (`k ∈ 1..15`) renders as. Index 0
   * always means transparent; the byte at `colorMap[0]` is therefore
   * effectively unused.
   */
  readonly colorMap: Uint8Array;
  /** 1 or 2 bits per pixel. */
  readonly bpp: 1 | 2;
  /** Declared font height in pixels. */
  readonly fontHeight: number;
  /** Number of entries in the offset table. */
  readonly numChars: number;
  /**
   * Per-char glyph offsets. Each value is a byte position **relative to
   * byte 21 of the payload** — not from byte 0. The absolute position
   * is `21 + glyphOffsets[c]`. A value of `0` means "no glyph for this
   * char code" (table entry is a sentinel).
   */
  readonly glyphOffsets: Uint32Array;
  /**
   * Whether this charset's glyph bitmap data is stored with the
   * entire bitstream **reversed** — equivalent to a 180° rotation of
   * each glyph's pixel grid versus the standard top-to-bottom,
   * left-to-right MSB-first reading. Detected empirically by
   * {@link detectReversedBits} during {@link parseCharHeader}.
   *
   * Some MI1 releases (observed: Italian release, LFLF #9 charset
   * index 2) ship one charset with this property. The block header
   * carries no flag distinguishing it from the standard charsets, so
   * we detect via pixel-distribution heuristic over a handful of
   * known-asymmetric Latin letters.
   */
  readonly reversedBits: boolean;
}

export function parseCharHeader(payload: Uint8Array): CharsetHeader {
  if (payload.length < 25) {
    throw new Error(`CHAR payload too short for a header (length ${payload.length}).`);
  }
  const size = readU32LE(payload, 0);
  const magic = readU16LE(payload, 4);
  const colorMap = new Uint8Array(payload.subarray(6, 21));
  const bppRaw = payload[21]!;
  if (bppRaw !== 1 && bppRaw !== 2) {
    throw new Error(`CHAR: unsupported bpp value 0x${bppRaw.toString(16)} (expected 1 or 2).`);
  }
  const bpp = bppRaw as 1 | 2;
  const fontHeight = payload[22]!;
  const numChars = readU16LE(payload, 23);
  if (numChars === 0) {
    throw new Error(`CHAR: numChars = 0 (likely a misparsed header).`);
  }

  const tableStart = 25;
  const tableEnd = tableStart + numChars * 4;
  if (tableEnd > payload.length) {
    throw new Error(
      `CHAR: offset table (${numChars} × u32 from byte ${tableStart}) overruns payload (length ${payload.length}).`,
    );
  }
  const glyphOffsets = new Uint32Array(numChars);
  for (let i = 0; i < numChars; i++) {
    glyphOffsets[i] = readU32LE(payload, tableStart + i * 4);
  }

  const baseHeader: CharsetHeader = {
    size,
    magic,
    colorMap,
    bpp,
    fontHeight,
    numChars,
    glyphOffsets,
    reversedBits: false,
  };
  const reversedBits = detectReversedBits(payload, baseHeader);
  return { ...baseHeader, reversedBits };
}

/**
 * Empirically classify a charset as "bits-reversed" by looking at
 * letters where the *densest row* is unambiguously near the baseline:
 * `L` and `J`. In every Latin font, the horizontal stroke of `L` and
 * the bottom curve of `J` live in the lower portion of the glyph
 * box. If the standard decoder places that row near the top, the
 * bitstream is stored 180°-rotated — and we'll flip in
 * {@link decodeGlyph}.
 *
 * Why not look at a header flag? There isn't one. Two MI1 charsets
 * with identical 25-byte metadata can have different bitstream
 * orientations (observed in the Italian release). The original engine
 * presumably hard-coded the difference per charset id; we detect it
 * from data so we don't need a per-release table.
 *
 * Why not aggregate over many letters? Tried — letters like `T`, `E`,
 * `F` are *normally* top-heavy (bars near the top), so they pollute a
 * naive top-vs-bottom sum. `L` and `J` are the cleanest discriminators.
 */
function detectReversedBits(payload: Uint8Array, header: CharsetHeader): boolean {
  // The densest row of `L` is its baseline bar; for `J`, the bottom
  // curve. Both should live in the lower half when decoded correctly.
  const samples = [0x4c, 0x4a]; // L, J
  let bottomDenseVotes = 0;
  let topDenseVotes = 0;
  for (const code of samples) {
    const off = glyphPayloadOffset(header, code);
    if (off === null) continue;
    let g: DecodedGlyph;
    try {
      // Force standard (non-reversed) decode so detection isn't
      // self-referential.
      g = decodeGlyphInternal(payload, off, header.bpp, false);
    } catch {
      continue;
    }
    if (g.height < 4 || g.width < 2) continue;
    // Per-row pixel count.
    let maxRow = -1;
    let maxRowCount = 0;
    for (let y = 0; y < g.height; y++) {
      let count = 0;
      for (let x = 0; x < g.width; x++) {
        if (g.pixels[y * g.width + x]) count++;
      }
      if (count > maxRowCount) {
        maxRowCount = count;
        maxRow = y;
      }
    }
    if (maxRow < 0) continue;
    if (maxRow >= g.height / 2) bottomDenseVotes++;
    else topDenseVotes++;
  }
  return topDenseVotes > bottomDenseVotes;
}

/** Resolve a glyph-offset table entry to an absolute payload byte position, or `null` if the entry is the "no glyph" sentinel. */
export function glyphPayloadOffset(header: CharsetHeader, charCode: number): number | null {
  if (charCode < 0 || charCode >= header.numChars) return null;
  const v = header.glyphOffsets[charCode]!;
  if (v === 0) return null;
  return 21 + v;
}

export interface DecodedGlyph {
  readonly width: number;
  readonly height: number;
  /** Signed x offset added to the cursor before drawing. */
  readonly xOffset: number;
  /** Signed y offset added to the baseline before drawing. */
  readonly yOffset: number;
  /**
   * `width × height` pixels in row-major order: index 0 = top-left.
   * Each value is a *glyph-local* bit pattern (0..2^bpp − 1) — the
   * compositor maps non-zero values through `colorMap` to get a CLUT
   * index. A value of 0 is transparent at composite time.
   */
  readonly pixels: Uint8Array;
}

/**
 * Decode the glyph at `glyphAbsOffset` (the value `glyphPayloadOffset`
 * returns — already includes the +21 adjustment).
 *
 * Pass `reversedBits = true` for charsets where {@link parseCharHeader}
 * detected a 180°-rotated bitstream — the pixel array is post-processed
 * back to the standard top-down, left-right orientation.
 */
export function decodeGlyph(
  payload: Uint8Array,
  glyphAbsOffset: number,
  bpp: 1 | 2,
  reversedBits: boolean = false,
): DecodedGlyph {
  return decodeGlyphInternal(payload, glyphAbsOffset, bpp, reversedBits);
}

function decodeGlyphInternal(
  payload: Uint8Array,
  glyphAbsOffset: number,
  bpp: 1 | 2,
  reversedBits: boolean,
): DecodedGlyph {
  if (glyphAbsOffset < 0 || glyphAbsOffset + 4 > payload.length) {
    throw new Error(
      `decodeGlyph: header position ${glyphAbsOffset} out of payload (length ${payload.length}).`,
    );
  }
  const width = payload[glyphAbsOffset]!;
  const height = payload[glyphAbsOffset + 1]!;
  const xOffset = readI8(payload, glyphAbsOffset + 2);
  const yOffset = readI8(payload, glyphAbsOffset + 3);
  if (width === 0 || height === 0) {
    // Some "glyphs" (e.g. ASCII control codes) are present but blank.
    // Return an empty bitmap rather than throwing.
    return { width, height, xOffset, yOffset, pixels: new Uint8Array(0) };
  }

  const totalPixels = width * height;
  const pixels = new Uint8Array(totalPixels);
  let bitPos = (glyphAbsOffset + 4) * 8;

  // Pixels run row-major; bits are MSB-first within each source byte.
  // Bit streams flow contiguously across row boundaries — there is no
  // per-row padding. We read bit-by-bit so the bpp=2 straddle-byte
  // case is handled naturally.
  for (let p = 0; p < totalPixels; p++) {
    let v = 0;
    for (let b = 0; b < bpp; b++) {
      const byteIdx = (bitPos + b) >>> 3;
      if (byteIdx >= payload.length) {
        throw new Error(
          `decodeGlyph: glyph bitstream at byte ${byteIdx} overruns payload (length ${payload.length}).`,
        );
      }
      const bitInByte = 7 - ((bitPos + b) & 7);
      v = (v << 1) | ((payload[byteIdx]! >>> bitInByte) & 1);
    }
    pixels[p] = v;
    bitPos += bpp;
  }

  if (reversedBits) {
    // Charset shipped with a 180°-rotated bitstream. Equivalently:
    // mirror the pixel grid through its centre. Cheaper than
    // re-decoding from the reversed bitstream — same end result.
    const flipped = new Uint8Array(totalPixels);
    for (let p = 0; p < totalPixels; p++) {
      flipped[totalPixels - 1 - p] = pixels[p]!;
    }
    return { width, height, xOffset, yOffset, pixels: flipped };
  }
  return { width, height, xOffset, yOffset, pixels };
}

function readU32LE(b: Uint8Array, off: number): number {
  return (
    ((b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0)
  );
}
function readU16LE(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function readI8(b: Uint8Array, off: number): number {
  const v = b[off]!;
  return v >= 0x80 ? v - 0x100 : v;
}
