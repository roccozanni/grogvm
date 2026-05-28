import { describe, expect, it } from 'vitest';
import type { CostumeHeader } from './costume';
import {
  createAnimState,
  currentAnimCmd,
  currentLimbFrame,
  startAnim,
  stepAnim,
} from './costume-anim';

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Build a synthetic costume header that points an anim id to a given
 * byte offset in the payload. We only fill in the fields the anim
 * decoder actually reads (animOffsets), so palette and limbOffsets
 * stay defaults.
 */
function makeHeader(animOffsets: ReadonlyArray<number>): CostumeHeader {
  return {
    numAnim: animOffsets.length,
    format: 0x58,
    paletteSize: 16,
    palette: new Uint8Array(16),
    animCmdOffset: 0,
    limbOffsets: new Array(16).fill(0),
    animOffsets: [...animOffsets],
    mirrorFlag: false,
  };
}

/**
 * Pack one anim definition into a Uint8Array. Each `limb` entry maps
 * a bit position (0..15, low → high; per the wiki bit `b` = limb
 * `15 - b`) to either `{ disabled: true }` or `{ start, length,
 * noLoop }`.
 */
function packAnim(limbs: Record<number, { disabled?: boolean; start?: number; length?: number; noLoop?: boolean }>): Uint8Array {
  const bits = Object.keys(limbs).map(Number).sort((a, b) => b - a); // MSB → LSB
  let mask = 0;
  for (const bit of bits) mask |= 1 << bit;
  const out: number[] = [mask & 0xff, (mask >>> 8) & 0xff];
  for (const bit of bits) {
    const def = limbs[bit]!;
    if (def.disabled) {
      out.push(0xff, 0xff);
    } else {
      const start = def.start ?? 0;
      out.push(start & 0xff, (start >>> 8) & 0xff);
      const len = ((def.length ?? 1) - 1) & 0x7f;
      const flag = def.noLoop ? 0x80 : 0;
      out.push(len | flag);
    }
  }
  return new Uint8Array(out);
}

// ─── tests ────────────────────────────────────────────────────────────

describe('createAnimState', () => {
  it('initialises every limb as inactive', () => {
    const s = createAnimState(makeHeader([]));
    expect(s.limbs).toHaveLength(16);
    for (const limb of s.limbs) expect(limb.active).toBe(false);
    expect(s.animId).toBe(0);
  });
});

describe('startAnim', () => {
  it('decodes a single-limb anim and marks the right limb active', () => {
    // bit 0 set → limb 15. Start at offset 5, length 4 (= end_offset 3), looping.
    const animBytes = packAnim({ 0: { start: 5, length: 4 } });
    // Place the anim record at offset 10 in the payload, prefixed by junk.
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);

    const initial = createAnimState(header);
    const next = startAnim(initial, 0, header, payload);
    expect(next.animId).toBe(0);
    expect(next.limbs[15]!.active).toBe(true);
    expect(next.limbs[15]!.start).toBe(5);
    expect(next.limbs[15]!.length).toBe(4);
    expect(next.limbs[15]!.noLoop).toBe(false);
    expect(next.limbs[15]!.cursor).toBe(0);
    // Other limbs stay inactive.
    expect(next.limbs[0]!.active).toBe(false);
  });

  it('reads the no-loop flag from the length byte\'s high bit', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 8, noLoop: true } });
    // Real costume anim offsets are never 0 (offsets table itself
    // lives at byte ~22+) — the decoder treats 0 as a sentinel for
    // "no definition", so we shift to a non-zero offset.
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[15]!.noLoop).toBe(true);
    expect(s.limbs[15]!.length).toBe(8);
  });

  it('treats a 0xFFFF start as the disabled-limb marker (no length byte follows)', () => {
    // Two limbs in the mask: bit 0 (limb 15) disabled, bit 1 (limb 14) active.
    // Manually pack since `packAnim` doesn't mix disabled + active.
    const payload = new Uint8Array(64);
    payload.set([
      0x03, 0x00,        // mask = 0x0003 (bits 0+1 → limbs 15 + 14)
      // bit 1 (limb 14) first in MSB→LSB order
      0x07, 0x00, 0x02,  // active: start=7, length=3
      // bit 0 (limb 15) disabled
      0xff, 0xff,
    ], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[14]!.active).toBe(true);
    expect(s.limbs[14]!.start).toBe(7);
    expect(s.limbs[14]!.length).toBe(3);
    expect(s.limbs[15]!.active).toBe(false);
  });

  it('handles an anim with no limbs (mask == 0) — every limb inactive', () => {
    const payload = new Uint8Array(16);
    payload.set([0x00, 0x00], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    for (const limb of s.limbs) expect(limb.active).toBe(false);
  });

  it('keeps prior limb state when the requested anim id has no definition (sentinel 0)', () => {
    const header = makeHeader([0]);
    const seeded = createAnimState(header);
    const next = startAnim(seeded, 0, header, new Uint8Array(0));
    expect(next.animId).toBe(0);
    expect(next.limbs).toEqual(seeded.limbs);
  });

  it('keeps prior limb state when the anim offset is 0xFFFF', () => {
    const header = makeHeader([0xffff]);
    const seeded = createAnimState(header);
    const next = startAnim(seeded, 0, header, new Uint8Array(0));
    expect(next.limbs).toEqual(seeded.limbs);
  });

  it('returns inactive state if animOffset points past the payload', () => {
    const header = makeHeader([100]);
    const s = startAnim(createAnimState(header), 0, header, new Uint8Array(10));
    for (const limb of s.limbs) expect(limb.active).toBe(false);
  });
});

describe('stepAnim', () => {
  it('advances cursor by 1 per tick for an active limb', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 4 } });
    const payload = new Uint8Array(32);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[15]!.cursor).toBe(0);
    s = stepAnim(s);
    expect(s.limbs[15]!.cursor).toBe(1);
    s = stepAnim(s);
    expect(s.limbs[15]!.cursor).toBe(2);
  });

  it('loops back to 0 on a default (looping) anim', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 3 } });
    const payload = new Uint8Array(32);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    s = stepAnim(s); // 1
    s = stepAnim(s); // 2
    s = stepAnim(s); // wrap → 0
    expect(s.limbs[15]!.cursor).toBe(0);
    expect(s.limbs[15]!.finished).toBe(false);
  });

  it('sticks on the last byte for a no-loop anim and flips `finished` true', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 3, noLoop: true } });
    const payload = new Uint8Array(32);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    s = stepAnim(s); // 1
    s = stepAnim(s); // 2 (last)
    s = stepAnim(s); // would wrap, but stick at 2 + finished=true
    expect(s.limbs[15]!.cursor).toBe(2);
    expect(s.limbs[15]!.finished).toBe(true);
  });

  it('is a no-op when every limb is inactive', () => {
    const s = createAnimState(makeHeader([]));
    const next = stepAnim(s);
    // Same reference is fine — nothing to advance.
    expect(next).toBe(s);
  });
});

describe('currentLimbFrame', () => {
  it('returns the limb\'s cursor for active limbs and 0 for inactive', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 4 } });
    const payload = new Uint8Array(32);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    expect(currentLimbFrame(s, 15)).toBe(0); // active, cursor 0
    s = stepAnim(s);
    expect(currentLimbFrame(s, 15)).toBe(1);
    expect(currentLimbFrame(s, 14)).toBe(0); // inactive
    expect(currentLimbFrame(s, 99)).toBe(0); // out-of-range
  });
});

describe('currentAnimCmd', () => {
  it('reads from payload at start + cursor for an active limb', () => {
    const animBytes = packAnim({ 0: { start: 30, length: 4 } });
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    // Seed cmd bytes at the anim's `start` offset.
    payload[30] = 0x10;
    payload[31] = 0x11;
    payload[32] = 0x12;
    payload[33] = 0x13;
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    expect(currentAnimCmd(s, 15, payload)).toBe(0x10);
    s = stepAnim(s);
    expect(currentAnimCmd(s, 15, payload)).toBe(0x11);
  });

  it('returns 0 when the limb is inactive', () => {
    const s = createAnimState(makeHeader([]));
    expect(currentAnimCmd(s, 5, new Uint8Array(0))).toBe(0);
  });
});
