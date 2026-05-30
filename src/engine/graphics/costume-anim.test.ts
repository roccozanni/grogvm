import { describe, expect, it } from 'vitest';
import type { CostumeHeader } from './costume';
import {
  type AnimState,
  COSTUME_OFFSET_ADJUST,
  createAnimState,
  currentAnimCmd,
  currentLimbPicture,
  startAnim,
  stepAnim,
} from './costume-anim';

// ─── helpers ──────────────────────────────────────────────────────────
//
// Every stored offset is read with the v5 base correction
// (COSTUME_OFFSET_ADJUST = -6): the record lives at `animOffset - 6`,
// the cmd stream at `animCmdOffset - 6`. The helpers below hide that by
// taking the *payload positions* you want and adding 6 to the stored
// offsets so the decoder lands where you put the bytes.

const ADJ = -COSTUME_OFFSET_ADJUST; // +6

/**
 * Header whose anim records live at the given PAYLOAD positions and
 * whose cmd stream lives at payload position `cmdPos` (default 0).
 */
function makeHeader(recordPositions: ReadonlyArray<number>, cmdPos = 0): CostumeHeader {
  return {
    numAnim: recordPositions.length,
    format: 0x58,
    paletteSize: 16,
    palette: new Uint8Array(16),
    animCmdOffset: cmdPos + ADJ,
    limbOffsets: new Array(16).fill(0),
    animOffsets: recordPositions.map((p) => (p === 0 ? 0 : p + ADJ)),
    mirrorFlag: false,
  };
}

interface LimbSpec {
  disabled?: boolean;
  frameIndex?: number;
  length?: number;
  noLoop?: boolean;
}

/**
 * Pack a v5 anim record: `u16 LE mask` (limb `i` = bit `15-i`) + per set
 * bit `{u16 LE frameIndex, u8 extra}` (extra low7 = length-1, bit7 =
 * no-loop). Disabled limbs emit `0xFFFF` and no extra byte.
 */
function packAnim(limbs: Record<number, LimbSpec>): Uint8Array {
  const idxs = Object.keys(limbs).map(Number).sort((a, b) => a - b); // limb 0 first = highest bit
  let mask = 0;
  for (const i of idxs) mask |= 1 << (15 - i);
  const out: number[] = [mask & 0xff, (mask >> 8) & 0xff];
  for (const i of idxs) {
    const d = limbs[i]!;
    if (d.disabled) {
      out.push(0xff, 0xff);
    } else {
      const fi = d.frameIndex ?? 0;
      out.push(fi & 0xff, (fi >> 8) & 0xff);
      const len = ((d.length ?? 1) - 1) & 0x7f;
      out.push(len | (d.noLoop ? 0x80 : 0));
    }
  }
  return new Uint8Array(out);
}

// ─── tests ────────────────────────────────────────────────────────────

describe('createAnimState', () => {
  it('initialises every limb inactive with no stopped bits', () => {
    const s = createAnimState(makeHeader([]));
    expect(s.limbs).toHaveLength(16);
    for (const limb of s.limbs) expect(limb.active).toBe(false);
    expect(s.animId).toBe(0);
    expect(s.stopped).toBe(0);
  });
});

describe('startAnim', () => {
  it('decodes a single-limb anim and marks the right limb active', () => {
    const payload = new Uint8Array(64);
    payload[5] = 0x03; // a picture byte at the limb's start so it plays
    payload.set(packAnim({ 0: { frameIndex: 5, length: 4 } }), 20);
    const header = makeHeader([20]); // cmd stream at payload[0]
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.active).toBe(true);
    expect(s.limbs[0]!.start).toBe(5); // animCmdOffset-6 (=0) + frameIndex 5
    expect(s.limbs[0]!.length).toBe(4);
    expect(s.limbs[0]!.noLoop).toBe(false);
    expect(s.limbs[1]!.active).toBe(false);
  });

  it('maps the mask MSB to limb 0 and bit 14 to limb 1', () => {
    const payload = new Uint8Array(64);
    payload[9] = 0x05;
    payload.set(packAnim({ 1: { frameIndex: 9, length: 2 } }), 20);
    const header = makeHeader([20]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[1]!.active).toBe(true);
    expect(s.limbs[1]!.start).toBe(9);
    expect(s.limbs[0]!.active).toBe(false);
  });

  it('adds animCmdOffset to frameIndex (with the -6 base) for the start', () => {
    const payload = new Uint8Array(80);
    payload[0x20 + 4] = 0x02; // picture at cmd position 0x20+4
    payload.set(packAnim({ 0: { frameIndex: 4, length: 3 } }), 40);
    const header = makeHeader([40], 0x20); // cmd stream at payload[0x20]
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.start).toBe(0x20 + 4);
  });

  it('reads the no-loop flag from the extra byte high bit', () => {
    const payload = new Uint8Array(64);
    payload[3] = 0x04;
    payload.set(packAnim({ 0: { frameIndex: 3, length: 8, noLoop: true } }), 20);
    const header = makeHeader([20]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.noLoop).toBe(true);
    expect(s.limbs[0]!.length).toBe(8);
  });

  it('treats a 0xFFFF frameIndex as the disabled-limb marker', () => {
    const payload = new Uint8Array(64);
    payload[7] = 0x02;
    // limb 0 active, limb 1 disabled.
    payload.set(packAnim({ 0: { frameIndex: 7, length: 3 }, 1: { disabled: true } }), 20);
    const header = makeHeader([20]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.limbs[0]!.active).toBe(true);
    expect(s.limbs[0]!.start).toBe(7);
    expect(s.limbs[1]!.active).toBe(false);
  });

  it('sets the stopped bit when the start cmd byte is 0x79', () => {
    const payload = new Uint8Array(64);
    payload[5] = 0x79; // STOP command at limb 0's start
    payload.set(packAnim({ 0: { frameIndex: 5, length: 1 } }), 20);
    const header = makeHeader([20]);
    const s = startAnim(createAnimState(header), 0, header, payload);
    expect(s.stopped & 1).toBe(1); // limb 0 stopped
  });

  it('clears the stopped bit when the start cmd byte is 0x7A', () => {
    const payload = new Uint8Array(64);
    payload[5] = 0x7a; // UN-STOP command
    payload.set(packAnim({ 0: { frameIndex: 5, length: 1 } }), 20);
    const header = makeHeader([20]);
    const seeded = { ...createAnimState(header), stopped: 0b1 }; // limb 0 was stopped
    const s = startAnim(seeded, 0, header, payload);
    expect(s.stopped & 1).toBe(0); // limb 0 resumed
  });

  it('leaves limbs not named by the mask untouched (talk drives head, body holds)', () => {
    const payload = new Uint8Array(64);
    payload[5] = 0x02;
    payload.set(packAnim({ 1: { frameIndex: 5, length: 2 } }), 20); // touches limb 1 only
    const header = makeHeader([20]);
    // Seed limb 0 as an active body pose.
    const seeded = createAnimState(header);
    const body = { active: true, start: 3, length: 1, noLoop: false, cursor: 0, finished: false };
    const withBody = { ...seeded, limbs: seeded.limbs.map((l, i) => (i === 0 ? body : l)) };
    const s = startAnim(withBody, 0, header, payload);
    expect(s.limbs[0]).toEqual(body); // body preserved
    expect(s.limbs[1]!.active).toBe(true); // head updated
  });

  it('keeps prior state when the anim id has no definition (sentinel 0)', () => {
    const header = makeHeader([0]);
    const seeded = createAnimState(header);
    const next = startAnim(seeded, 0, header, new Uint8Array(0));
    expect(next.animId).toBe(0);
    expect(next.limbs).toEqual(seeded.limbs);
  });
});

describe('currentLimbPicture', () => {
  function withLimb(start: number, length: number, cursor: number, stopped = 0): AnimState {
    const s = createAnimState(makeHeader([]));
    const limbs = [...s.limbs];
    limbs[0] = { active: true, start, length, noLoop: false, cursor, finished: false };
    return { ...s, limbs, stopped };
  }

  it('returns the picture byte when the cursor is on a picture', () => {
    const payload = new Uint8Array([0x02, 0x03, 0x04, 0x05]);
    expect(currentLimbPicture(withLimb(0, 4, 1), 0, payload)).toBe(0x03);
  });

  it('skips a mid-window command byte to the next picture', () => {
    const payload = new Uint8Array([0x02, 0x79, 0x03, 0x04]);
    expect(currentLimbPicture(withLimb(0, 4, 1), 0, payload)).toBe(0x03);
  });

  it('returns -1 for a stopped limb', () => {
    const payload = new Uint8Array([0x02, 0x03]);
    expect(currentLimbPicture(withLimb(0, 2, 0, 0b1), 0, payload)).toBe(-1);
  });

  it('returns -1 when the whole window is command bytes', () => {
    const payload = new Uint8Array([0x79, 0x7a, 0x7b]);
    expect(currentLimbPicture(withLimb(0, 3, 0), 0, payload)).toBe(-1);
  });

  it('returns -1 for an inactive limb', () => {
    const s = createAnimState(makeHeader([]));
    expect(currentLimbPicture(s, 0, new Uint8Array([0x02]))).toBe(-1);
  });
});

describe('stepAnim', () => {
  function playing(start: number, length: number, noLoop = false, stopped = 0): AnimState {
    const s = createAnimState(makeHeader([]));
    const limbs = [...s.limbs];
    limbs[0] = { active: true, start, length, noLoop, cursor: 0, finished: false };
    return { ...s, limbs, stopped };
  }

  it('advances the cursor by 1 per tick', () => {
    let s = playing(0, 4);
    s = stepAnim(s);
    expect(s.limbs[0]!.cursor).toBe(1);
    s = stepAnim(s);
    expect(s.limbs[0]!.cursor).toBe(2);
  });

  it('loops back to 0 on a default anim', () => {
    let s = playing(0, 3);
    s = stepAnim(s); // 1
    s = stepAnim(s); // 2
    s = stepAnim(s); // wrap → 0
    expect(s.limbs[0]!.cursor).toBe(0);
  });

  it('sticks on the last frame for a no-loop anim and flips finished', () => {
    let s = playing(0, 3, true);
    s = stepAnim(s); // 1
    s = stepAnim(s); // 2 (last)
    s = stepAnim(s); // stick
    expect(s.limbs[0]!.cursor).toBe(2);
    expect(s.limbs[0]!.finished).toBe(true);
  });

  it('does not advance a stopped limb', () => {
    let s = playing(0, 4, false, 0b1);
    s = stepAnim(s);
    expect(s.limbs[0]!.cursor).toBe(0);
  });

  it('is a no-op when nothing is advancing', () => {
    const s = createAnimState(makeHeader([]));
    expect(stepAnim(s)).toBe(s);
  });
});

describe('currentAnimCmd', () => {
  it('reads from payload at start + cursor for an active limb', () => {
    const s = createAnimState(makeHeader([]));
    const limbs = [...s.limbs];
    limbs[0] = { active: true, start: 30, length: 4, noLoop: false, cursor: 0, finished: false };
    const state = { ...s, limbs };
    const payload = new Uint8Array(64);
    payload[30] = 0x10;
    payload[31] = 0x11;
    expect(currentAnimCmd(state, 0, payload)).toBe(0x10);
    expect(currentAnimCmd(stepAnim(state), 0, payload)).toBe(0x11);
  });

  it('returns 0 when the limb is inactive', () => {
    const s = createAnimState(makeHeader([]));
    expect(currentAnimCmd(s, 5, new Uint8Array(0))).toBe(0);
  });
});
