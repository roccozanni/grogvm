/**
 * SCUMM v5 CHAR (character set / bitmap font) decoder.
 * Format reference: pages/docs/scumm/char.md.
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
 * Resolve a charset by SCUMM charset id via the DCHR directory — NOT walk
 * order, whose indices disagree with the id space (null entries shift it;
 * see pages/docs/scumm/char.md §1). Returns `null` for null/unresolvable
 * ids — the caller falls back to a default font.
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
  readonly size: number;
  readonly magic: number;
  /** `colorMap[k]` = CLUT index for glyph bit-pattern `k` (1..15); pattern 0 is always transparent. */
  readonly colorMap: Uint8Array;
  /** 1 or 2 bits per pixel. */
  readonly bpp: 1 | 2;
  /** Declared font height in pixels. */
  readonly fontHeight: number;
  readonly numChars: number;
  /** Byte positions relative to byte 21 of the payload (not byte 0); 0 = "no glyph" sentinel. See char.md §3. */
  readonly glyphOffsets: Uint32Array;
  /**
   * Bitstream stored 180°-rotated (observed: MI1 Italian release, LFLF #9
   * charset index 2). No header flag distinguishes it — detected
   * empirically by {@link detectReversedBits}.
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
 * Classify a charset as "bits-reversed": if `L`/`J`'s densest row (their
 * baseline stroke) decodes near the top, the bitstream is 180°-rotated.
 * No header flag exists for this, so detection is data-driven. Only L and
 * J discriminate cleanly — T/E/F are normally top-heavy and pollute a
 * broader aggregate.
 */
function detectReversedBits(payload: Uint8Array, header: CharsetHeader): boolean {
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
   * `width × height` row-major pixels of glyph-local bit patterns
   * (0..2^bpp − 1), mapped through `colorMap` at composite time; 0 = transparent.
   */
  readonly pixels: Uint8Array;
}

/**
 * Decode the glyph at `glyphAbsOffset` (a `glyphPayloadOffset` result —
 * the +21 anchor is already applied).
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
    // Present-but-blank glyphs (ASCII control codes) are legal — don't throw.
    return { width, height, xOffset, yOffset, pixels: new Uint8Array(0) };
  }

  const totalPixels = width * height;
  const pixels = new Uint8Array(totalPixels);
  let bitPos = (glyphAbsOffset + 4) * 8;

  // No per-row padding — bits flow contiguously across row boundaries
  // (char.md §4), so read bit-by-bit rather than per row.
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
    // 180°-rotated bitstream: mirroring the decoded grid through its
    // centre equals re-decoding the reversed stream, and is cheaper.
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
