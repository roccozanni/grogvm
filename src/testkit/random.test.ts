/**
 * Tests for the seeded-RNG seam. No game data — runs everywhere. Covers
 * the generator (reproducible, in-range) and the `Vm.randomInt` path that
 * the `getRandomNumber` opcode consumes, proving an injected source makes
 * the VM's randomness deterministic (the basis of a non-flaky playthrough).
 */
import { describe, expect, it } from 'vitest';
import { Vm } from '../engine/vm/vm';
import { makeSeededRandom } from './random';

describe('makeSeededRandom', () => {
  it('is reproducible: same seed → same stream', () => {
    const a = makeSeededRandom(1234);
    const b = makeSeededRandom(1234);
    const seq = (r: () => number) => Array.from({ length: 8 }, () => r());
    expect(seq(a)).toEqual(seq(b));
  });

  it('differs across seeds and stays in [0, 1)', () => {
    const a = makeSeededRandom(1);
    const b = makeSeededRandom(2);
    const first = Array.from({ length: 64 }, () => a());
    for (const v of first) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
    expect(first).not.toEqual(Array.from({ length: 64 }, () => b()));
  });
});

describe('Vm.randomInt', () => {
  const makeVm = (random?: () => number) =>
    new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map(), random });

  it('returns integers in [0, max] inclusive', () => {
    const vm = makeVm(makeSeededRandom(7));
    for (let i = 0; i < 200; i++) {
      const v = vm.randomInt(5);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('is deterministic when seeded — two VMs draw the same sequence', () => {
    const a = makeVm(makeSeededRandom(99));
    const b = makeVm(makeSeededRandom(99));
    const draw = (vm: Vm) => Array.from({ length: 10 }, () => vm.randomInt(1000));
    expect(draw(a)).toEqual(draw(b));
  });

  it('defaults to Math.random when no source is injected', () => {
    const vm = makeVm();
    // Can't assert a value, only that the default wiring produces a valid draw.
    expect(vm.randomInt(0)).toBe(0);
  });
});
