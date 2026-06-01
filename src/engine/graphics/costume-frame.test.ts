import { describe, it, expect } from 'vitest';
import { decodeCostumeFrame, COSTUME_FRAME_TRANSPARENT } from './costume-frame';

function i16le(n: number): number[] {
  const v = n & 0xffff;
  return [v & 0xff, (v >>> 8) & 0xff];
}

/**
 * Builds a payload with a frame header at byte 0 and RLE following it.
 * The "frame pointer" the decoder expects is at byte +6 of the header
 * (the `y` field).
 *
 * Header layout: width (u8), unknown (u8), height (u8), unknown (u8),
 * x (i16 LE), y (i16 LE), xinc (i16 LE), yinc (i16 LE).
 */
function frame(
  width: number,
  height: number,
  redirX: number,
  redirY: number,
  rle: number[],
  xinc = 0,
  yinc = 0,
): { payload: Uint8Array; framePtr: number } {
  const header = [
    width & 0xff,
    0,
    height & 0xff,
    0,
    ...i16le(redirX),
    ...i16le(redirY),
    ...i16le(xinc),
    ...i16le(yinc),
  ];
  const payload = new Uint8Array([...header, ...rle]);
  return { payload, framePtr: 6 };
}

describe('decodeCostumeFrame', () => {
  it('decodes a flat single-color frame', () => {
    // 2×2, all pixels color 1. Encoded as one run of length 4: byte = 0x14.
    const { payload, framePtr } = frame(2, 2, 0, 0, [0x14]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.width).toBe(2);
    expect(f.height).toBe(2);
    expect(f.redirX).toBe(0);
    expect(f.redirY).toBe(0);
    expect(Array.from(f.pixels)).toEqual([1, 1, 1, 1]);
    expect(f.rleByteCount).toBe(1);
  });

  it('decodes signed displacements', () => {
    const { payload, framePtr } = frame(1, 1, -3, -4, [0x21]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.redirX).toBe(-3);
    expect(f.redirY).toBe(-4);
    expect(Array.from(f.pixels)).toEqual([2]);
  });

  it('emits column-major: runs straddle column boundaries', () => {
    // 2×2, sequence in column-major order: c1,c1,c2,c2 (col 0 = 1s, col 1 = 2s).
    // Encoded as 0x12, 0x22.
    const { payload, framePtr } = frame(2, 2, 0, 0, [0x12, 0x22]);
    const f = decodeCostumeFrame(payload, framePtr);
    // Row-major output:
    //   row 0: col 0 = 1, col 1 = 2
    //   row 1: col 0 = 1, col 1 = 2
    expect(Array.from(f.pixels)).toEqual([1, 2, 1, 2]);
  });

  it('substitutes transparent for costume index 0 by default', () => {
    // 2×1, run of 2 transparent (color 0). Byte: 0x02.
    const { payload, framePtr } = frame(2, 1, 0, 0, [0x02]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(Array.from(f.pixels)).toEqual([COSTUME_FRAME_TRANSPARENT, COSTUME_FRAME_TRANSPARENT]);
  });

  it('keeps 0 as 0 when transparentIsZero is false', () => {
    const { payload, framePtr } = frame(2, 1, 0, 0, [0x02]);
    const f = decodeCostumeFrame(payload, framePtr, { transparentIsZero: false });
    expect(Array.from(f.pixels)).toEqual([0, 0]);
  });

  it('reads an extended length byte when the length nibble is 0', () => {
    // 4×4 = 16 pixels of color 3, encoded as 0x30 (color 3, len 0 →
    // extended) followed by 0x10 (the real length).
    const { payload, framePtr } = frame(4, 4, 0, 0, [0x30, 0x10]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.pixels).toHaveLength(16);
    expect(Array.from(f.pixels).every((v) => v === 3)).toBe(true);
    expect(f.rleByteCount).toBe(2);
  });

  it('handles extended length > 16 (the whole point of the escape)', () => {
    // 1×30 = 30 pixels of color 2, encoded as 0x20 (color 2, len 0 →
    // extended) + 0x1e (length 30).
    const { payload, framePtr } = frame(1, 30, 0, 0, [0x20, 0x1e]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.pixels).toHaveLength(30);
    expect(Array.from(f.pixels).every((v) => v === 2)).toBe(true);
  });

  it('exposes xinc and yinc from the header', () => {
    const { payload, framePtr } = frame(1, 1, 0, 0, [0x21], 7, -3);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.xinc).toBe(7);
    expect(f.yinc).toBe(-3);
  });

  it('decodes a 4×6 shape matching the MI1 limb-0 frame-0 RLE bytes', () => {
    // 11 bytes: 02 52 02 62 11 63 02 42 04 52 02
    const { payload, framePtr } = frame(4, 6, 0, -4, [
      0x02, 0x52, 0x02, 0x62, 0x11, 0x63, 0x02, 0x42, 0x04, 0x52, 0x02,
    ]);
    const f = decodeCostumeFrame(payload, framePtr);
    expect(f.width).toBe(4);
    expect(f.height).toBe(6);
    expect(f.rleByteCount).toBe(11);
    const T = COSTUME_FRAME_TRANSPARENT;
    // Column-major sequence (24): T,T,5,5,T,T, 6,6,1,6,6,6, T,T,4,4,T,T, T,T,5,5,T,T
    // → row-major 4×6:
    expect(Array.from(f.pixels)).toEqual([
      T, 6, T, T,
      T, 6, T, T,
      5, 1, 4, 5,
      5, 6, 4, 5,
      T, 6, T, T,
      T, 6, T, T,
    ]);
  });

  it('throws on a zero-dimension header', () => {
    const { payload, framePtr } = frame(0, 5, 0, 0, [0x11]);
    expect(() => decodeCostumeFrame(payload, framePtr)).toThrow(/zero dimension/);
  });

  it('throws when the RLE stream is too short', () => {
    // Claims a 4×4 frame but provides only one byte of RLE.
    const { payload, framePtr } = frame(4, 4, 0, 0, [0x11]);
    expect(() => decodeCostumeFrame(payload, framePtr)).toThrow(/ran out of RLE bytes/);
  });

  it('rejects a framePtr without room for a full header', () => {
    const payload = new Uint8Array(8);
    expect(() => decodeCostumeFrame(payload, 4)).toThrow(/cannot fit a 12-byte header/);
  });

  // 32-color costumes (format bit 0 set, e.g. MI1 costume 24 — the
  // SCUMM-Bar important pirates) pack the run byte 5 bits colour / 3 bits
  // length instead of 4/4. Decoding one as 16-color splits the nibbles on
  // the wrong boundary and renders vertical-streak garbage.
  describe('32-color mode (paletteSize: 32)', () => {
    it('splits the run byte 5 bits colour / 3 bits length', () => {
      // 2×2, all colour 1. Length 4. byte = (1 << 3) | 4 = 0x0c.
      const { payload, framePtr } = frame(2, 2, 0, 0, [0x0c]);
      const f = decodeCostumeFrame(payload, framePtr, { paletteSize: 32 });
      expect(Array.from(f.pixels)).toEqual([1, 1, 1, 1]);
      expect(f.rleByteCount).toBe(1);
    });

    it('reaches colour indices above 15 (impossible in 16-color)', () => {
      // 1×1 of colour 17, length 1. byte = (17 << 3) | 1 = 0x89.
      const { payload, framePtr } = frame(1, 1, 0, 0, [0x89]);
      const f32 = decodeCostumeFrame(payload, framePtr, { paletteSize: 32 });
      expect(Array.from(f32.pixels)).toEqual([17]);
      // The same byte decoded as 16-color lands on the wrong boundary:
      // colour 8 (0x89 >> 4), length 9 — i.e. garbage. Documents why the
      // mode must match the costume's format byte.
      const f16 = decodeCostumeFrame(payload, framePtr, { paletteSize: 16 });
      expect(f16.pixels[0]).toBe(8);
    });

    it('reads an extended length byte when the 3-bit length is 0', () => {
      // 1×20 of colour 2. byte = (2 << 3) | 0 = 0x10, then length 0x14 (20).
      const { payload, framePtr } = frame(1, 20, 0, 0, [0x10, 0x14]);
      const f = decodeCostumeFrame(payload, framePtr, { paletteSize: 32 });
      expect(f.pixels).toHaveLength(20);
      expect(Array.from(f.pixels).every((v) => v === 2)).toBe(true);
      expect(f.rleByteCount).toBe(2);
    });

    it('still treats colour index 0 as transparent', () => {
      // 2×1 of colour 0, length 2. byte = (0 << 3) | 2 = 0x02.
      const { payload, framePtr } = frame(2, 1, 0, 0, [0x02]);
      const f = decodeCostumeFrame(payload, framePtr, { paletteSize: 32 });
      expect(Array.from(f.pixels)).toEqual([
        COSTUME_FRAME_TRANSPARENT,
        COSTUME_FRAME_TRANSPARENT,
      ]);
    });
  });
});
