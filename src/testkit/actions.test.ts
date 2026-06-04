/**
 * Tests for the parts of the action vocabulary that are pure / synthetic-
 * testable: `objectPoint` (CDHD-box-center geometry + the loud throw) and
 * `waitIdle`'s already-idle short-circuit. The input-composing helpers
 * (`use`/`walkTo`/`pickAnswer`) drive real verb/scene-click scripts, so they
 * need a booted game and are exercised by the integration walkthrough — the
 * same split `drive.ts` (synthetic) vs the loaders (integration) already use.
 */
import { describe, expect, it } from 'vitest';
import { Vm } from '../engine/vm/vm';
import { objectPoint, waitIdle } from './actions';

const makeVm = (): Vm =>
  new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map() });

/** Fake a single-object loaded room with the given CDHD box (8-px units). */
function withObject(vm: Vm, objId: number, cdhd: { x: number; y: number; width: number; height: number }): void {
  (vm as unknown as { loadedRoom: unknown }).loadedRoom = {
    objects: new Map([[objId, { cdhd }]]),
  };
}

describe('objectPoint', () => {
  it('returns the CDHD box center in room pixels (8-px units → px, +half-extent)', () => {
    const vm = makeVm();
    withObject(vm, 428, { x: 87, y: 10, width: 5, height: 7 });
    // x: 87*8 + 5*8/2 = 696 + 20 = 716 ; y: 10*8 + 7*8/2 = 80 + 28 = 108
    expect(objectPoint(vm, 428)).toEqual({ x: 716, y: 108 });
  });

  it('throws (loudly, naming room + id) when the object is not in the loaded room', () => {
    const vm = makeVm();
    vm.currentRoom = 33;
    expect(() => objectPoint(vm, 999)).toThrow(/object 999 is not in loaded room 33/);
  });
});

describe('waitIdle', () => {
  it('returns immediately when no line is in progress (no ticks burned)', () => {
    const vm = makeVm();
    const before = vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER);
    waitIdle(vm); // activeDialog is null on a fresh VM
    expect(vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER)).toBe(before);
  });
});
