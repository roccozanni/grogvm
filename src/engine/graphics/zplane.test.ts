import { describe, it, expect } from 'vitest';
import { decodeZPlane, parseRmihPlaneCount, zplaneBit } from './zplane';

function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

/**
 * Build a ZP## payload from per-strip body byte arrays. The offset
 * table is computed assuming the standard "header-inclusive" convention
 * the decoder undoes (so the encoder writes `8 + tableSize + ...`).
 */
function makeZplanePayload(strips: ReadonlyArray<number[] | null>): Uint8Array {
  const tableSize = strips.length * 2;
  const offsets: number[] = [];
  let cursor = tableSize;
  for (const s of strips) {
    if (s === null) {
      offsets.push(0); // sentinel: implicit all-zero strip
    } else {
      offsets.push(cursor + 8); // header-inclusive
      cursor += s.length;
    }
  }
  const out: number[] = [];
  for (const o of offsets) out.push(...u16le(o));
  for (const s of strips) {
    if (s !== null) out.push(...s);
  }
  return new Uint8Array(out);
}

describe('parseRmihPlaneCount', () => {
  it('reads a u16 LE count', () => {
    expect(parseRmihPlaneCount(new Uint8Array([3, 0]))).toBe(3);
    expect(parseRmihPlaneCount(new Uint8Array([0x80, 0]))).toBe(128);
  });

  it('throws on truncated payload', () => {
    expect(() => parseRmihPlaneCount(new Uint8Array([1]))).toThrow(/too short/);
  });
});

describe('decodeZPlane', () => {
  it('decodes a single literal byte covering one row of 8 pixels', () => {
    // 8×1: one strip, one row. Literal-op 0x01 + byte 0xFF.
    const payload = makeZplanePayload([[0x01, 0xff]]);
    const plane = decodeZPlane(payload, 8, 1);
    expect(Array.from(plane.mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('lays out bits within a byte MSB-first (bit 7 = leftmost pixel)', () => {
    // Byte 0b10000001 = 0x81 → leftmost and rightmost pixels set, middle clear.
    const payload = makeZplanePayload([[0x01, 0x81]]);
    const plane = decodeZPlane(payload, 8, 1);
    expect(Array.from(plane.mask)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('expands a run-op (high bit set) of N copies of one byte', () => {
    // 8×4: one strip, 4 rows, all 0xff via a single run op.
    // Run: 0x84 (high bit + count 4), data 0xff.
    const payload = makeZplanePayload([[0x84, 0xff]]);
    const plane = decodeZPlane(payload, 8, 4);
    expect(plane.mask).toHaveLength(32);
    expect(Array.from(plane.mask).every((b) => b === 1)).toBe(true);
  });

  it('handles literal then run in sequence', () => {
    // 8×4: row 0 = 0xf0 (left half on), rows 1-3 = 0x0f (right half on).
    // Literal 0x01 0xf0, then run 0x83 0x0f.
    const payload = makeZplanePayload([[0x01, 0xf0, 0x83, 0x0f]]);
    const plane = decodeZPlane(payload, 8, 4);
    // Row 0: 1,1,1,1,0,0,0,0 ; rows 1-3: 0,0,0,0,1,1,1,1
    expect(Array.from(plane.mask.subarray(0, 8))).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(Array.from(plane.mask.subarray(8, 16))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(Array.from(plane.mask.subarray(16, 24))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(Array.from(plane.mask.subarray(24, 32))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('writes each strip into its own 8-column block side by side', () => {
    // 16×2: two strips, each one row of 0xff then one row of 0x00 (via runs).
    // Strip 0: run 0x81 0xff, run 0x81 0x00.
    // Strip 1: run 0x81 0x0f, run 0x81 0xf0.
    const payload = makeZplanePayload([
      [0x81, 0xff, 0x81, 0x00],
      [0x81, 0x0f, 0x81, 0xf0],
    ]);
    const plane = decodeZPlane(payload, 16, 2);
    // Row 0: strip 0 = all on, strip 1 = right half on
    expect(Array.from(plane.mask.subarray(0, 16))).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1,
    ]);
    // Row 1: strip 0 = all off, strip 1 = left half on
    expect(Array.from(plane.mask.subarray(16, 32))).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0,
    ]);
  });

  it('treats offset-0 as a sentinel for an implicit all-zero strip', () => {
    // 16×2: strip 0 has a body (one row 0xff, then run of 0x00), strip 1 is the sentinel.
    const payload = makeZplanePayload([
      [0x81, 0xff, 0x81, 0x00],
      null, // sentinel
    ]);
    const plane = decodeZPlane(payload, 16, 2);
    // Strip 0 row 0 = all on; strip 1 (cols 8-15) = all zero (sentinel).
    expect(Array.from(plane.mask.subarray(0, 16))).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from(plane.mask.subarray(16, 32))).toEqual(
      new Array(16).fill(0),
    );
  });

  it('throws when width is not a positive multiple of 8', () => {
    expect(() => decodeZPlane(new Uint8Array([0, 0]), 0, 1)).toThrow(/multiple of 8/);
    expect(() => decodeZPlane(new Uint8Array([0, 0]), 7, 1)).toThrow(/multiple of 8/);
  });

  it('throws when payload is too short for the strip table', () => {
    expect(() => decodeZPlane(new Uint8Array([0]), 8, 1)).toThrow(/payload too short/);
  });

  it('throws if a strip runs out of RLE bytes before filling the column', () => {
    // 8×4 frame, but only one row's worth of data.
    const payload = makeZplanePayload([[0x01, 0xff]]);
    expect(() => decodeZPlane(payload, 8, 4)).toThrow(/ran out of/);
  });
});

describe('zplaneBit', () => {
  const plane = {
    width: 4,
    height: 2,
    mask: new Uint8Array([0, 1, 0, 1, 1, 0, 1, 0]),
  };

  it('returns the bit at (x, y)', () => {
    expect(zplaneBit(plane, 0, 0)).toBe(0);
    expect(zplaneBit(plane, 1, 0)).toBe(1);
    expect(zplaneBit(plane, 3, 1)).toBe(0);
    expect(zplaneBit(plane, 2, 1)).toBe(1);
  });

  it('returns 0 for out-of-bounds reads', () => {
    expect(zplaneBit(plane, -1, 0)).toBe(0);
    expect(zplaneBit(plane, 0, -1)).toBe(0);
    expect(zplaneBit(plane, 4, 0)).toBe(0);
    expect(zplaneBit(plane, 0, 2)).toBe(0);
  });
});
