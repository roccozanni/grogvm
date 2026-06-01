import { describe, it, expect } from 'vitest';
import { CHARSET_TRANSPARENT, parseCharHeader, type CharsetHeader } from './charset';
import { measureText, renderText, wrapText } from './text';

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function makeCharPayload(opts: {
  bpp: 1 | 2;
  fontHeight: number;
  glyphs: ReadonlyArray<{ width: number; height: number; xOffset: number; yOffset: number; bitmap: number[] } | null>;
}): Uint8Array {
  const numChars = opts.glyphs.length;
  const header: number[] = [];
  header.push(...u32le(0)); // placeholder size
  header.push(...u16le(0x0363));
  header.push(0, 0xf, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // 15-byte colorMap
  header.push(opts.bpp, opts.fontHeight);
  header.push(...u16le(numChars));
  const tableSize = numChars * 4;
  let cursor = 25 + tableSize;
  const offsets: number[] = [];
  for (const g of opts.glyphs) {
    if (g === null) {
      offsets.push(0);
    } else {
      offsets.push(cursor - 21);
      cursor += 4 + g.bitmap.length;
    }
  }
  for (const o of offsets) header.push(...u32le(o));
  const out = [...header];
  for (const g of opts.glyphs) {
    if (g === null) continue;
    out.push(g.width, g.height, g.xOffset & 0xff, g.yOffset & 0xff);
    out.push(...g.bitmap);
  }
  return new Uint8Array(out);
}

/** Builds a 1-bpp charset with glyphs slotted at ASCII codes 32..127. */
function makeAsciiCharset(
  fontHeight: number,
  width: number,
  glyphs: Record<string, number[]>,
): { payload: Uint8Array; header: CharsetHeader } {
  const numChars = 128;
  const glyphSlots: ReadonlyArray<{ width: number; height: number; xOffset: number; yOffset: number; bitmap: number[] } | null> =
    Array.from({ length: numChars }, (_, i) => {
      const ch = String.fromCharCode(i);
      const bm = glyphs[ch];
      if (!bm) return null;
      return { width, height: fontHeight, xOffset: 0, yOffset: 0, bitmap: bm };
    });
  const payload = makeCharPayload({ bpp: 1, fontHeight, glyphs: glyphSlots });
  const header = parseCharHeader(payload);
  return { payload, header };
}

describe('measureText', () => {
  it('returns 0×0 for empty string', () => {
    const { payload, header } = makeAsciiCharset(8, 4, {});
    expect(measureText(payload, header, '')).toEqual({ width: 0, height: 0 });
  });

  it('measures a single glyph by its width and the fontHeight', () => {
    const { payload, header } = makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
    });
    expect(measureText(payload, header, 'A')).toEqual({ width: 4, height: 8 });
  });

  it('advances the cursor by glyph width across a string', () => {
    const { payload, header } = makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
      B: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
      C: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
    });
    expect(measureText(payload, header, 'ABC')).toEqual({ width: 12, height: 8 });
  });

  it('handles newlines by resetting X and advancing Y', () => {
    const { payload, header } = makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
    });
    // "A\nAA" → first line 4 wide, second line 8 wide, total height = 16.
    expect(measureText(payload, header, 'A\nAA')).toEqual({ width: 8, height: 16 });
  });

  it('skips characters with no glyph (sentinel offset 0)', () => {
    const { payload, header } = makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
    });
    // 'X' is missing; should be skipped → 'A' alone.
    expect(measureText(payload, header, 'AX')).toEqual({ width: 4, height: 8 });
  });

  it("skips the '@' name-padding char even when the font carries a glyph for it", () => {
    // MI1's sentence/dialogue charsets (id 1, 2) ship a real '@' glyph, so we
    // can't lean on a missing glyph — '@' must be skipped unconditionally.
    const { payload, header } = makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
      '@': [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    });
    // "A@@@" → padding contributes no width: same as "A" alone.
    expect(measureText(payload, header, 'A@@@')).toEqual({ width: 4, height: 8 });
  });
});

describe('renderText', () => {
  it('renders a single 1×1 ink pixel through the colorMap', () => {
    const { payload, header } = makeAsciiCharset(1, 1, { A: [0x80] });
    const colorMap = new Uint8Array([0, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r = renderText(payload, header, 'A', colorMap);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
    expect(Array.from(r.pixels)).toEqual([0x55]);
  });

  it('emits CHARSET_TRANSPARENT for off-pixels', () => {
    // 2-wide glyph, only left pixel on: 0x80 = 0b10000000 → row of [1, 0].
    const { payload, header } = makeAsciiCharset(1, 2, { A: [0x80] });
    const colorMap = new Uint8Array([0, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r = renderText(payload, header, 'A', colorMap);
    expect(Array.from(r.pixels)).toEqual([0x55, CHARSET_TRANSPARENT]);
  });

  it('lays out two glyphs side by side and respects ink color', () => {
    // Two 2×2 glyphs side by side, each filling all 4 pixels.
    // bitmap 0xf0 = 0b11110000 (4 ON bits → fills 2×2 = 4 pixels).
    const { payload, header } = makeAsciiCharset(2, 2, { A: [0xf0], B: [0xf0] });
    const colorMap = new Uint8Array([0, 0x77, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r = renderText(payload, header, 'AB', colorMap);
    expect(r.width).toBe(4);
    expect(r.height).toBe(2);
    expect(Array.from(r.pixels)).toEqual([0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77]);
  });

  it('applies per-glyph xOffset/yOffset when stamping', () => {
    // Build a 2x1 glyph (single ON pixel each cell, but xOffset = 1 pushes right):
    const payload = makeCharPayload({
      bpp: 1,
      fontHeight: 1,
      glyphs: [
        null,
        { width: 1, height: 1, xOffset: 0, yOffset: 0, bitmap: [0x80] }, // 'A'
        { width: 1, height: 1, xOffset: 2, yOffset: 0, bitmap: [0x80] }, // 'B' shifted right by 2
      ],
    });
    const header = parseCharHeader(payload);
    const colorMap = new Uint8Array([0, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // 'A' at x=0 (width 1) advances cursor to 1; 'B' stamps at x = 1 + xOffset(2) = 3.
    // Bounding box: width should be 1 (A) + 1 (B at x=3, extends to 4) = 4.
    const r = renderText(payload, header, '\x01\x02', colorMap);
    expect(r.width).toBe(4);
    expect(Array.from(r.pixels)).toEqual([0x33, CHARSET_TRANSPARENT, CHARSET_TRANSPARENT, 0x33]);
  });

  it('handles newlines by stacking lines', () => {
    const { payload, header } = makeAsciiCharset(2, 1, { A: [0xc0] }); // 0b11 → 2-pixel column
    const colorMap = new Uint8Array([0, 0x22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Two lines of "A". Each line is 1 wide × 2 tall, total 1 × 4.
    const r = renderText(payload, header, 'A\nA', colorMap);
    expect(r.width).toBe(1);
    expect(r.height).toBe(4);
    expect(Array.from(r.pixels)).toEqual([0x22, 0x22, 0x22, 0x22]);
  });

  it('handles 2-bpp glyphs via the colorMap', () => {
    // 2×1 glyph: pixels [3, 1] from byte 0b1101_0000 = 0xD0 (pad with 0s).
    // Actually we need 2 px × 2 bits = 4 bits, so byte 0xD0 = 0b11_01_0000.
    // Bit-by-bit MSB-first: bits 7..6 = 11 = 3; bits 5..4 = 01 = 1.
    const payload = makeCharPayload({
      bpp: 2,
      fontHeight: 1,
      glyphs: [null, { width: 2, height: 1, xOffset: 0, yOffset: 0, bitmap: [0xd0] }],
    });
    const header = parseCharHeader(payload);
    const colorMap = new Uint8Array([0, 0x11, 0x22, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const r = renderText(payload, header, '\x01', colorMap);
    expect(Array.from(r.pixels)).toEqual([0x33, 0x11]);
  });

  it('throws when colorMap is shorter than 2^bpp', () => {
    const { payload, header } = makeAsciiCharset(1, 1, { A: [0x80] });
    expect(() => renderText(payload, header, 'A', new Uint8Array(1))).toThrow(/colorMap length/);
  });
});

describe('wrapText', () => {
  // Charset where 'A' and space are both 4px wide, fontHeight 8.
  const cs = () =>
    makeAsciiCharset(8, 4, {
      A: [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
      ' ': [0, 0, 0, 0, 0, 0, 0, 0],
    });

  it('greedily packs words up to the max width', () => {
    const { payload, header } = cs();
    // widths: "AA"=8, "AA AA"=20, "AA AA AA"=32. maxWidth 20 fits two.
    expect(wrapText(payload, header, 'AA AA AA', 20)).toBe('AA AA\nAA');
  });

  it('puts one word per line when the width is tight', () => {
    const { payload, header } = cs();
    expect(wrapText(payload, header, 'AA AA AA', 8)).toBe('AA\nAA\nAA');
  });

  it('keeps a single over-long word whole (overflow, no mid-word break)', () => {
    const { payload, header } = cs();
    expect(wrapText(payload, header, 'AAA', 4)).toBe('AAA');
  });

  it('preserves explicit newlines, wrapping each paragraph independently', () => {
    const { payload, header } = cs();
    expect(wrapText(payload, header, 'AA\nAA AA', 20)).toBe('AA\nAA AA');
  });

  it('is a no-op when the whole string fits', () => {
    const { payload, header } = cs();
    expect(wrapText(payload, header, 'AA AA', 100)).toBe('AA AA');
  });
});
