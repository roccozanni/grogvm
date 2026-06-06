/**
 * Tests for the parts of the action vocabulary that are pure / synthetic-
 * testable: `objectPoint` (CDHD-box-center geometry + the loud throw) and the
 * condition-waiters (`waitIdle` / `waitReady` / `waitPickedUp` / `waitGlobal` /
 * `waitPlayable`) against synthetic VM state — their short-circuit and
 * out-of-budget paths. The input-composing helpers (`use`/`walkTo`/`give`/
 * `pickAnswer`) drive real verb/scene-click scripts, so they need a booted game
 * and are exercised by the integration walkthrough — the same split `drive.ts`
 * (synthetic) vs the loaders (integration) already use.
 */
import { describe, expect, it } from 'vitest';
import { Vm, type VerbSlot } from '../engine/vm/vm';
import { VAR_EGO } from '../engine/vm/vars';
import { objectPoint, waitGlobal, waitIdle, waitPickedUp, waitPlayable, waitReady } from './actions';

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

describe('waitReady', () => {
  it('returns immediately when the game is ready (control up, idle, no cutscene)', () => {
    const vm = makeVm();
    vm.cursor.userput = 1; // control returned; fresh VM has no dialog/cutscene, ego unset
    const before = vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER);
    waitReady(vm);
    expect(vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER)).toBe(before);
  });

  it('does not short-circuit while control is withheld (drives up to the budget)', () => {
    const vm = makeVm();
    // userput stays 0 (a cutscene-style hold), so it never reads ready and
    // drives the whole (small) budget instead of returning at once.
    const before = vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER);
    waitReady(vm, 5);
    expect(vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER)).not.toBe(before);
  });
});

describe('waitPickedUp', () => {
  it('returns at once (no ticks) once ego owns the object', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(VAR_EGO, 1);
    vm.objectOwners.set(566, 1);
    const before = vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER);
    expect(waitPickedUp(vm, 566)).toBe(true);
    expect(vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER)).toBe(before);
  });

  it('returns false within budget when ego never owns it', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(VAR_EGO, 1); // object 566 has no owner entry
    expect(waitPickedUp(vm, 566, 5)).toBe(false);
  });
});

describe('waitGlobal', () => {
  it('returns at once when the global already equals the value', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(50, 478);
    expect(waitGlobal(vm, 50, 478)).toBe(true);
  });

  it('returns false within budget when it never reaches the value', () => {
    const vm = makeVm();
    expect(waitGlobal(vm, 50, 478, 5)).toBe(false);
  });
});

describe('waitPlayable', () => {
  it('returns at once when control is back, no line printing, and a verb armed', () => {
    const vm = makeVm();
    vm.cursor.userput = 1; // fresh VM: activeDialog already null
    vm.verbs.set(8, { id: 8, state: 'on' } as unknown as VerbSlot);
    expect(waitPlayable(vm)).toBe(true);
  });

  it('returns false while no verb is armed (control alone is not playable)', () => {
    const vm = makeVm();
    vm.cursor.userput = 1; // control up, but the verb bar is empty
    expect(waitPlayable(vm, 5)).toBe(false);
  });
});
