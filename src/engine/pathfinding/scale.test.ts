import { describe, it, expect } from 'vitest';
import { parseScal, resolveScale, type ScaleSlot } from './scale';

/** Build a SCAL payload from quads (scale1, y1, scale2, y2), u16 LE. */
function scal(...quads: ReadonlyArray<readonly [number, number, number, number]>): Uint8Array {
  const bytes: number[] = [];
  for (const [s1, y1, s2, y2] of quads) {
    for (const v of [s1, y1, s2, y2]) bytes.push(v & 0xff, (v >>> 8) & 0xff);
  }
  return new Uint8Array(bytes);
}

describe('parseScal', () => {
  it('parses 4 slots of (scale1, y1, scale2, y2) — real MI1 room 33 SCAL', () => {
    const slots = parseScal(scal([32, 76, 210, 131], [190, 112, 210, 131], [0, 0, 0, 0], [0, 0, 0, 0]));
    expect(slots.length).toBe(4);
    expect(slots[0]).toEqual({ scale1: 32, y1: 76, scale2: 210, y2: 131 });
    expect(slots[1]).toEqual({ scale1: 190, y1: 112, scale2: 210, y2: 131 });
  });
});

describe('resolveScale', () => {
  const slots: ScaleSlot[] = parseScal(scal([32, 76, 210, 131], [190, 112, 210, 131]));

  it('returns null for box scale 0 (no per-box scaling)', () => {
    expect(resolveScale(0, slots, 100)).toBeNull();
  });

  it('returns a direct fixed scale when 0x8000 is clear', () => {
    expect(resolveScale(210, slots, 999)).toBe(210); // y ignored for direct
    expect(resolveScale(300, slots, 0)).toBe(255); // clamped to 255
  });

  it('interpolates a SCAL slot by y when 0x8000 is set', () => {
    // 0x8000 → slot 0 = (32@76 → 210@131).
    expect(resolveScale(0x8000, slots, 76)).toBe(32);
    expect(resolveScale(0x8000, slots, 131)).toBe(210);
    // midpoint-ish: 32 + 178*(103-76)/55 ≈ 119
    expect(resolveScale(0x8000, slots, 103)).toBe(119);
    // 0x8001 → slot 1 = (190@112 → 210@131).
    expect(resolveScale(0x8001, slots, 112)).toBe(190);
  });

  it('clamps the interpolated scale to 1..255 beyond the gradient', () => {
    expect(resolveScale(0x8000, slots, 200)).toBe(255); // far below the dock → clamped
    expect(resolveScale(0x8000, slots, 0)).toBe(1); // far above the clifftop → clamped
  });

  it('returns null for an unpopulated or out-of-range slot reference', () => {
    expect(resolveScale(0x8002, slots, 100)).toBeNull(); // slot 2 is all-zero
    expect(resolveScale(0x8005, slots, 100)).toBeNull(); // no slot 5
  });
});
