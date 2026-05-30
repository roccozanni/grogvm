import { describe, expect, it } from 'vitest';
import type { CostumeHeader } from './costume';
import {
  createAnimState,
  currentAnimCmd,
  currentLimbFrame,
  currentLimbPicture,
  freezeAnim,
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
 * Pack one anim definition into a Uint8Array in the confirmed v5
 * single-limb record format: `u8 mask` + per set bit `{u16 LE
 * frameIndex, u8 lenFlags}`. Keys are LIMB indices (0..7); the mask
 * bit for limb `n` is bit `7 - n` (MSB = limb 0). With `animCmdOffset
 * = 0` (see makeHeader) the resulting `limb.start` equals the
 * `start`/frameIndex value passed here.
 */
function packAnim(limbs: Record<number, { disabled?: boolean; start?: number; length?: number; noLoop?: boolean }>): Uint8Array {
  const limbIdxs = Object.keys(limbs).map(Number).sort((a, b) => a - b); // limb 0 first = MSB first
  let mask = 0;
  for (const limb of limbIdxs) mask |= 1 << (7 - limb);
  const out: number[] = [mask & 0xff]; // one-byte mask
  for (const limb of limbIdxs) {
    const def = limbs[limb]!;
    if (def.disabled) {
      out.push(0xff, 0xff); // 0xFFFF frameIndex marker — no length byte
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
    // mask 0x80 (bit 7) → limb 0. Start at offset 5, length 4, looping.
    const animBytes = packAnim({ 0: { start: 5, length: 4 } });
    // Place the anim record at offset 10 in the payload, prefixed by junk.
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);

    const initial = createAnimState(header);
    const next = startAnim(initial, 0, header, payload);
    expect(next.animId).toBe(0);
    expect(next.limbs[0]!.active).toBe(true);
    expect(next.limbs[0]!.start).toBe(5);
    expect(next.limbs[0]!.length).toBe(4);
    expect(next.limbs[0]!.noLoop).toBe(false);
    expect(next.limbs[0]!.cursor).toBe(0);
    // Other limbs stay inactive.
    expect(next.limbs[1]!.active).toBe(false);
  });

  it('maps mask bit 6 to limb 1 (bit 7-n convention)', () => {
    const animBytes = packAnim({ 1: { start: 9, length: 2 } });
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[1]!.active).toBe(true);
    expect(s.limbs[1]!.start).toBe(9);
    expect(s.limbs[0]!.active).toBe(false);
  });

  it('adds animCmdOffset to frameIndex to get the playback start', () => {
    const animBytes = packAnim({ 0: { start: 4, length: 3 } }); // frameIndex 4
    const payload = new Uint8Array(64);
    payload.set(animBytes, 10);
    const header = { ...makeHeader([10]), animCmdOffset: 0x20 };
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.start).toBe(0x20 + 4);
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
    expect(s.limbs[0]!.noLoop).toBe(true);
    expect(s.limbs[0]!.length).toBe(8);
  });

  it('treats a 0xFFFF frameIndex as the disabled-limb marker (no length byte follows)', () => {
    // Two limbs: limb 0 (bit 7) active, limb 1 (bit 6) disabled.
    const payload = new Uint8Array(64);
    payload.set([
      0xc0,              // mask = bits 7+6 → limbs 0 + 1
      0x07, 0x00, 0x02,  // limb 0 active: start=7, length=3
      0xff, 0xff,        // limb 1 disabled
    ], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.active).toBe(true);
    expect(s.limbs[0]!.start).toBe(7);
    expect(s.limbs[0]!.length).toBe(3);
    expect(s.limbs[1]!.active).toBe(false);
  });

  it('handles an anim with no limbs (mask == 0) — every limb inactive', () => {
    const payload = new Uint8Array(16);
    payload.set([0x00, 0x00], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    for (const limb of s.limbs) expect(limb.active).toBe(false);
  });

  it('decodes the extended form (3-byte 00 00 00 prefix, then mask + mods)', () => {
    // Guybrush's walk anims look like `00 00 00 c0 <mods…>`: a 3-byte
    // zero prefix, then mask 0xc0 (limbs 0+1), then two modifiers.
    const payload = new Uint8Array(64);
    payload.set([
      0x00, 0x00, 0x00,  // extended-form prefix
      0xc0,              // mask = bits 7+6 → limbs 0 + 1
      0x05, 0x00, 0x05,  // limb 0: frameIndex 5, length 6
      0x0b, 0x00, 0x00,  // limb 1: frameIndex 11, length 1
    ], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.active).toBe(true);
    expect(s.limbs[0]!.start).toBe(5);
    expect(s.limbs[0]!.length).toBe(6);
    expect(s.limbs[1]!.active).toBe(true);
    expect(s.limbs[1]!.start).toBe(11);
    expect(s.limbs[1]!.length).toBe(1);
    // Limbs the mask didn't name stay inactive.
    expect(s.limbs[2]!.active).toBe(false);
  });

  it('does NOT mistake a 00 00 <non-zero> record for the extended form', () => {
    // Only the first TWO bytes are zero — the third is non-zero, so this
    // is the compact path: mask = byte 0 = 0x00 → sentinel → all static.
    // (Mirrors MI1's `00 00 ff …` talk-pose oddballs.)
    const payload = new Uint8Array(32);
    payload.set([0x00, 0x00, 0xff, 0xff, 0x00, 0x48], 10);
    const header = makeHeader([10]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    for (const limb of s.limbs) expect(limb.active).toBe(false);
  });

  it('treats mask == 0xFF as a sentinel (multi-limb form we do not decode) — inactive', () => {
    const payload = new Uint8Array(32);
    // mask 0xFF then plausible-looking bytes that must NOT be activated.
    payload.set([0xff, 0x00, 0x00, 0x02, 0x00, 0x00, 0x02], 10);
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

  it('trims leading command bytes (0x71-0x7C) from the loop window', () => {
    // animCmdOffset=0; the cmd stream starts with a 0x79 loop marker
    // (like MI1's walk). frameIndex 0 → start 0 → must skip past 0x79.
    const payload = new Uint8Array(32);
    payload.set([0x79, 0x02, 0x03, 0x04, 0x05, 0x06], 0); // cmd stream
    payload.set([0x80, 0x00, 0x00, 0x05], 10); // mask 0x80, frameIndex 0, len 6
    const header = makeHeader([10]); // animCmdOffset defaults to 0
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.active).toBe(true);
    expect(s.limbs[0]!.start).toBe(1); // advanced past the 0x79
    expect(s.limbs[0]!.length).toBe(5); // 6 - 1 trimmed
  });
});

describe('currentLimbPicture', () => {
  function activeLimbState(start: number, length: number, cursor: number) {
    const s = createAnimState(makeHeader([]));
    const limbs = [...s.limbs];
    limbs[0] = { active: true, start, length, noLoop: false, cursor, finished: false };
    return { ...s, limbs };
  }

  it('returns the picture byte directly when the cursor is on a picture', () => {
    const payload = new Uint8Array([0x02, 0x03, 0x04, 0x05]);
    expect(currentLimbPicture(activeLimbState(0, 4, 1), 0, payload)).toBe(0x03);
  });

  it('skips a mid-window command byte and returns the next picture', () => {
    const payload = new Uint8Array([0x02, 0x79, 0x03, 0x04]);
    // cursor 1 lands on 0x79 (command) → advance to 0x03.
    expect(currentLimbPicture(activeLimbState(0, 4, 1), 0, payload)).toBe(0x03);
  });

  it('returns -1 when the whole window is command bytes', () => {
    const payload = new Uint8Array([0x79, 0x7a, 0x7b]);
    expect(currentLimbPicture(activeLimbState(0, 3, 0), 0, payload)).toBe(-1);
  });

  it('returns -1 for an inactive limb', () => {
    const s = createAnimState(makeHeader([]));
    expect(currentLimbPicture(s, 0, new Uint8Array([0x02]))).toBe(-1);
  });
});

describe('freezeAnim', () => {
  it('holds the current frame and stops advancing', () => {
    const animBytes = packAnim({ 0: { start: 10, length: 5 } });
    const payload = new Uint8Array(64);
    payload.set(animBytes, 20);
    const header = { ...makeHeader([20]), animCmdOffset: 0 };
    let s = startAnim(createAnimState(header), 0, header, payload);
    s = stepAnim(s); // cursor → 1
    s = stepAnim(s); // cursor → 2
    const frozen = freezeAnim(s);
    expect(frozen.limbs[0]!.start).toBe(12); // 10 + cursor 2 baked in
    expect(frozen.limbs[0]!.cursor).toBe(0);
    expect(frozen.limbs[0]!.length).toBe(1);
    // Further ticks do not move it.
    const after = stepAnim(frozen);
    expect(after.limbs[0]!.cursor).toBe(0);
    expect(after.limbs[0]!.start).toBe(12);
  });

  it('is a no-op when no limb is active', () => {
    const s = createAnimState(makeHeader([]));
    expect(freezeAnim(s)).toBe(s);
  });
});

describe('stepAnim', () => {
  it('advances cursor by 1 per tick for an active limb', () => {
    const animBytes = packAnim({ 0: { start: 0, length: 4 } });
    const payload = new Uint8Array(32);
    payload.set(animBytes, 10);
    const header = makeHeader([10]);
    let s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.cursor).toBe(0);
    s = stepAnim(s);
    expect(s.limbs[0]!.cursor).toBe(1);
    s = stepAnim(s);
    expect(s.limbs[0]!.cursor).toBe(2);
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
    expect(s.limbs[0]!.cursor).toBe(0);
    expect(s.limbs[0]!.finished).toBe(false);
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
    expect(s.limbs[0]!.cursor).toBe(2);
    expect(s.limbs[0]!.finished).toBe(true);
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
    expect(currentLimbFrame(s, 0)).toBe(0); // active, cursor 0
    s = stepAnim(s);
    expect(currentLimbFrame(s, 0)).toBe(1);
    expect(currentLimbFrame(s, 1)).toBe(0); // inactive
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
    expect(currentAnimCmd(s, 0, payload)).toBe(0x10);
    s = stepAnim(s);
    expect(currentAnimCmd(s, 0, payload)).toBe(0x11);
  });

  it('returns 0 when the limb is inactive', () => {
    const s = createAnimState(makeHeader([]));
    expect(currentAnimCmd(s, 5, new Uint8Array(0))).toBe(0);
  });
});
