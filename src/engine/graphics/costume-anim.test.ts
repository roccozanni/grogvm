import { describe, expect, it } from 'vitest';
import {
  createAnimState,
  currentLimbFrame,
  startAnim,
  stepAnim,
} from './costume-anim';
import type { CostumeHeader } from './costume';

function header(limbCount: number): CostumeHeader {
  return {
    numAnim: 8,
    format: 0x58,
    paletteSize: 16,
    palette: new Uint8Array(16),
    animCmdOffset: 0,
    limbOffsets: new Array(limbCount).fill(0),
    animOffsets: [],
    mirrorFlag: false,
  };
}

describe('AnimState — Phase 6 stub', () => {
  it('createAnimState allocates per-limb arrays sized to header', () => {
    const s = createAnimState(header(16));
    expect(s.perLimbFrame).toHaveLength(16);
    expect(s.perLimbTick).toHaveLength(16);
    expect(s.animId).toBe(0);
    for (const f of s.perLimbFrame) expect(f).toBe(0);
  });

  it('currentLimbFrame returns 0 by default (init pose)', () => {
    const s = createAnimState(header(4));
    expect(currentLimbFrame(s, 0)).toBe(0);
    expect(currentLimbFrame(s, 3)).toBe(0);
  });

  it('currentLimbFrame returns 0 for out-of-range limbs', () => {
    const s = createAnimState(header(4));
    expect(currentLimbFrame(s, 99)).toBe(0);
  });

  it('stepAnim is a no-op for now', () => {
    const s = createAnimState(header(2));
    const next = stepAnim(s);
    expect(next.perLimbFrame).toEqual([0, 0]);
    expect(next.perLimbTick).toEqual([0, 0]);
  });

  it('startAnim records the new animId and zeroes frame state', () => {
    const seeded = {
      animId: 7,
      perLimbFrame: [1, 2, 3],
      perLimbTick: [10, 20, 30],
    };
    const next = startAnim(seeded, 5);
    expect(next.animId).toBe(5);
    expect(next.perLimbFrame).toEqual([0, 0, 0]);
    expect(next.perLimbTick).toEqual([0, 0, 0]);
  });
});
