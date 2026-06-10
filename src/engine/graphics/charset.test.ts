import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../resources/block';
import {
  walkCharsets,
  parseCharHeader,
  glyphPayloadOffset,
  decodeGlyph,
  resolveCharsetById,
  charsetByWalkOrder,
} from './charset';
import type { ResourceFile } from '../resources/tree';
import type { IndexFile } from '../resources/index-file';

function block(tag: string, payload: Uint8Array | number[] = []): Uint8Array {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const size = 8 + payloadBytes.length;
  const out = new Uint8Array(size);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(payloadBytes, 8);
  return out;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function makeFile(bytes: Uint8Array): ResourceFile {
  return { bytes, tree: parseBlocks(bytes) };
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

/**
 * Build a minimal CHAR payload: size + magic + colorMap + bpp +
 * fontHeight + numChars + offsetTable + glyph data. The offset table
 * is computed from each glyph's actual stored position relative to
 * byte 21.
 */
function makeCharPayload(opts: {
  bpp: 1 | 2;
  fontHeight: number;
  colorMap?: number[];
  glyphs: ReadonlyArray<{ width: number; height: number; xOffset: number; yOffset: number; bitmap: number[] } | null>;
}): Uint8Array {
  const colorMap = opts.colorMap ?? [0, 0xf, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (colorMap.length !== 15) throw new Error('colorMap must be 15 bytes');
  const numChars = opts.glyphs.length;
  const header: number[] = [];
  // size = payload - 15 (informational; we'll patch it at the end since we don't know yet)
  header.push(...u32le(0)); // placeholder
  header.push(...u16le(0x0363)); // magic
  header.push(...colorMap);
  header.push(opts.bpp);
  header.push(opts.fontHeight);
  header.push(...u16le(numChars));

  // Compute offset table. Glyph N (if non-null) appears after all
  // previous glyphs. Offset value = absolute_payload_byte − 21.
  const tableSize = numChars * 4;
  let glyphCursor = 25 + tableSize; // absolute payload position
  const offsets: number[] = [];
  for (const g of opts.glyphs) {
    if (g === null) {
      offsets.push(0);
    } else {
      offsets.push(glyphCursor - 21);
      const bitmapBytes = 4 + g.bitmap.length;
      glyphCursor += bitmapBytes;
    }
  }
  for (const o of offsets) header.push(...u32le(o));

  const out: number[] = [...header];
  for (const g of opts.glyphs) {
    if (g === null) continue;
    out.push(g.width, g.height, g.xOffset & 0xff, g.yOffset & 0xff);
    out.push(...g.bitmap);
  }
  // Patch size field: payload - 15.
  const payloadLen = out.length;
  const size = payloadLen - 15;
  out[0] = size & 0xff;
  out[1] = (size >>> 8) & 0xff;
  out[2] = (size >>> 16) & 0xff;
  out[3] = (size >>> 24) & 0xff;
  return new Uint8Array(out);
}

describe('walkCharsets', () => {
  it('returns one entry per CHAR in each LFLF', () => {
    const lflf1 = block('LFLF', concat(block('ROOM'), block('CHAR', new Uint8Array(64)), block('CHAR', new Uint8Array(64))));
    const lflf2 = block('LFLF', concat(block('CHAR', new Uint8Array(64))));
    const lecf = block('LECF', concat(lflf1, lflf2));
    const file = makeFile(lecf);
    const cs = walkCharsets(file);
    expect(cs).toHaveLength(3);
    expect(cs[0]!.lflfIndex).toBe(0);
    expect(cs[0]!.indexInLflf).toBe(0);
    expect(cs[1]!.indexInLflf).toBe(1);
    expect(cs[2]!.lflfIndex).toBe(1);
  });

  it('returns empty array when there is no LECF', () => {
    expect(walkCharsets(makeFile(block('RNAM')))).toEqual([]);
  });
});

describe('parseCharHeader', () => {
  it('parses a 1-bpp charset with one glyph', () => {
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 8,
      glyphs: [
        null,
        { width: 4, height: 8, xOffset: 0, yOffset: 0, bitmap: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01] },
      ],
    });
    const header = parseCharHeader(payload);
    expect(header.bpp).toBe(1);
    expect(header.fontHeight).toBe(8);
    expect(header.numChars).toBe(2);
    expect(header.magic).toBe(0x0363);
    expect(header.colorMap).toHaveLength(15);
    expect(header.glyphOffsets[0]).toBe(0); // sentinel for missing glyph
    expect(header.glyphOffsets[1]).toBeGreaterThan(0);
  });

  it('parses a 2-bpp charset declaration', () => {
    const payload = makeCharPayload({
      bpp: 2,
      fontHeight: 9,
      glyphs: [null],
    });
    expect(parseCharHeader(payload).bpp).toBe(2);
  });

  it('throws on unsupported bpp', () => {
    const payload = makeCharPayload({ bpp: 1, fontHeight: 8, glyphs: [null] });
    payload[21] = 4; // pollute the bpp byte
    expect(() => parseCharHeader(payload)).toThrow(/unsupported bpp/);
  });

  it('throws on truncated header', () => {
    expect(() => parseCharHeader(new Uint8Array(10))).toThrow(/too short/);
  });

  it('throws when numChars × 4 overruns the payload', () => {
    const payload = makeCharPayload({ bpp: 1, fontHeight: 8, glyphs: [null] });
    payload[23] = 0xff;
    payload[24] = 0xff;
    expect(() => parseCharHeader(payload)).toThrow(/overruns payload/);
  });

  it('throws on numChars == 0', () => {
    const payload = makeCharPayload({ bpp: 1, fontHeight: 8, glyphs: [null] });
    payload[23] = 0;
    payload[24] = 0;
    expect(() => parseCharHeader(payload)).toThrow(/numChars = 0/);
  });
});

describe('glyphPayloadOffset', () => {
  it('resolves the +21 anchor', () => {
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 8,
      glyphs: [
        null,
        { width: 1, height: 1, xOffset: 0, yOffset: 0, bitmap: [0x80] },
      ],
    });
    const header = parseCharHeader(payload);
    expect(glyphPayloadOffset(header, 0)).toBe(null);
    const off = glyphPayloadOffset(header, 1);
    expect(off).not.toBe(null);
    // Glyph 1 should be at byte 21 + glyphOffsets[1].
    expect(off).toBe(21 + header.glyphOffsets[1]!);
    // And the byte at `off` should be the glyph's width (1).
    expect(payload[off!]).toBe(1);
  });

  it('returns null for out-of-range char codes', () => {
    const payload = makeCharPayload({ bpp: 1, fontHeight: 8, glyphs: [null] });
    const header = parseCharHeader(payload);
    expect(glyphPayloadOffset(header, -1)).toBe(null);
    expect(glyphPayloadOffset(header, 99)).toBe(null);
  });
});

describe('decodeGlyph', () => {
  it('decodes a 1-bpp glyph MSB-first row-major', () => {
    // 4×2 glyph: row 0 = 0b1010 (high nibble of byte 0), row 1 = 0b0101 (low nibble).
    // Bits flow contiguously across rows so 8 bits = 1 byte = 0b10100101 = 0xA5.
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 2,
      glyphs: [null, { width: 4, height: 2, xOffset: 0, yOffset: 0, bitmap: [0xa5] }],
    });
    const header = parseCharHeader(payload);
    const g = decodeGlyph(payload, glyphPayloadOffset(header, 1)!, 1);
    expect(g.width).toBe(4);
    expect(g.height).toBe(2);
    expect(Array.from(g.pixels)).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
  });

  it('decodes signed x/y offsets', () => {
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 4,
      glyphs: [null, { width: 1, height: 1, xOffset: -3, yOffset: -2, bitmap: [0x80] }],
    });
    const header = parseCharHeader(payload);
    const g = decodeGlyph(payload, glyphPayloadOffset(header, 1)!, 1);
    expect(g.xOffset).toBe(-3);
    expect(g.yOffset).toBe(-2);
  });

  it('decodes 2-bpp pixels including bytes that straddle 2-pixel boundaries', () => {
    // 3×2 glyph at 2 bpp = 6 pixels × 2 bits = 12 bits = 1.5 bytes.
    // Pixels: [3, 2, 1, 0, 3, 2] = 0b11_10_01_00_11_10 = 0xE3 0xCE (next 4 unused, but
    // we still need a second byte because 12 bits span 2 bytes).
    // 0b1110_0011 0b1100_1110 → 0xE3, 0xCE.
    // Bit-by-bit MSB-first read of [0xE3, 0xCE]:
    //   pixel 0 = bits 7,6 of byte 0 = 11 = 3
    //   pixel 1 = bits 5,4 of byte 0 = 10 = 2
    //   pixel 2 = bits 3,2 of byte 0 = 00 = 0   ← wait
    // Let me recompute: 0xE3 = 0b1110_0011. Bits (high→low): 1,1,1,0,0,0,1,1.
    //   pixel 0 (bits 7..6) = 11 = 3
    //   pixel 1 (bits 5..4) = 10 = 2
    //   pixel 2 (bits 3..2) = 00 = 0
    //   pixel 3 (bits 1..0) = 11 = 3
    // 0xCE = 0b1100_1110. Bits: 1,1,0,0,1,1,1,0.
    //   pixel 4 (bits 7..6) = 11 = 3
    //   pixel 5 (bits 5..4) = 00 = 0
    // So pixels = [3, 2, 0, 3, 3, 0]. (Row-major 3×2 → row 0 = [3,2,0], row 1 = [3,3,0].)
    const payload = makeCharPayload({
      bpp: 2,
      fontHeight: 2,
      glyphs: [null, { width: 3, height: 2, xOffset: 0, yOffset: 0, bitmap: [0xe3, 0xce] }],
    });
    const header = parseCharHeader(payload);
    const g = decodeGlyph(payload, glyphPayloadOffset(header, 1)!, 2);
    expect(Array.from(g.pixels)).toEqual([3, 2, 0, 3, 3, 0]);
  });

  it('returns an empty bitmap for zero-dimension glyphs', () => {
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 8,
      glyphs: [null, { width: 0, height: 0, xOffset: 0, yOffset: 0, bitmap: [] }],
    });
    const header = parseCharHeader(payload);
    const g = decodeGlyph(payload, glyphPayloadOffset(header, 1)!, 1);
    expect(g.width).toBe(0);
    expect(g.height).toBe(0);
    expect(g.pixels.length).toBe(0);
  });

  it('throws when the bitstream runs out of bytes', () => {
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 8,
      glyphs: [null, { width: 100, height: 100, xOffset: 0, yOffset: 0, bitmap: [0xff] }],
    });
    const header = parseCharHeader(payload);
    expect(() => decodeGlyph(payload, glyphPayloadOffset(header, 1)!, 1)).toThrow(/overruns payload/);
  });

  it('throws on header position out of payload', () => {
    expect(() => decodeGlyph(new Uint8Array(10), 8, 1)).toThrow(/out of payload/);
  });
});

describe('resolveCharsetById', () => {
  // Two CHAR blocks with distinct fontHeights inside one LFLF.
  const charA = (h: number) =>
    makeCharPayload({ bpp: 1, fontHeight: h, glyphs: [{ width: 1, height: 1, xOffset: 0, yOffset: 0, bitmap: [0x80] }] });

  const build = () => {
    const file = makeFile(
      block('LECF', block('LFLF', concat(block('CHAR', charA(8)), block('CHAR', charA(14))))),
    );
    const [a, b] = walkCharsets(file);
    // loff: room 5 → base 0, so abs offset == directory offset.
    const loff = new Map<number, number>([[5, 0]]);
    // DCHR ids are NOT walk order: id 0 is the built-in null entry,
    // id 1 maps to the FIRST block (walk[0]), id 2 to the SECOND (walk[1]).
    const index = {
      charsets: [
        { room: 0, offset: 0 },
        { room: 5, offset: a!.charBlock.offset },
        { room: 5, offset: b!.charBlock.offset },
      ],
    } as unknown as IndexFile;
    return { file, loff, index };
  };

  it('resolves a charset by its DCHR id (not file-walk order)', () => {
    const { file, loff, index } = build();
    expect(resolveCharsetById(file, index, loff, 1)!.header.fontHeight).toBe(8);
    expect(resolveCharsetById(file, index, loff, 2)!.header.fontHeight).toBe(14);
  });

  it('returns null for the built-in null charset (room 0 / offset 0)', () => {
    const { file, loff, index } = build();
    expect(resolveCharsetById(file, index, loff, 0)).toBeNull();
  });

  it('returns null for an out-of-range id or unknown room', () => {
    const { file, loff, index } = build();
    expect(resolveCharsetById(file, index, loff, 99)).toBeNull();
    const badRoom = { charsets: [{ room: 0, offset: 0 }, { room: 77, offset: 16 }] } as unknown as IndexFile;
    expect(resolveCharsetById(file, badRoom, loff, 1)).toBeNull();
  });
});

describe('charsetByWalkOrder', () => {
  const charA = (h: number) =>
    makeCharPayload({ bpp: 1, fontHeight: h, glyphs: [{ width: 1, height: 1, xOffset: 0, yOffset: 0, bitmap: [0x80] }] });

  it('looks up by walk order, falling back to the first for out-of-range ids', () => {
    const file = makeFile(
      block('LECF', block('LFLF', concat(block('CHAR', charA(8)), block('CHAR', charA(14))))),
    );
    expect(charsetByWalkOrder(file, 0)!.header.fontHeight).toBe(8);
    expect(charsetByWalkOrder(file, 1)!.header.fontHeight).toBe(14);
    expect(charsetByWalkOrder(file, 99)!.header.fontHeight).toBe(8);
  });

  it('returns null when the file has no charsets', () => {
    expect(charsetByWalkOrder(makeFile(block('RNAM')), 0)).toBeNull();
  });
});
