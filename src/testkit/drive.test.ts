/**
 * Tests for the game-agnostic VM drivers. No game data needed — they run
 * against a synthetic VM, so unlike the MI1 loaders these always run
 * (including CI). The `tick` count is observed via `VAR_MUSIC_TIMER`, which
 * `beginTick` auto-increments once per jiffy.
 */
import { describe, expect, it } from 'vitest';
import { Vm } from '../engine/vm/vm';
import { VAR_MOUSE_X, VAR_MOUSE_Y, VAR_VIRT_MOUSE_X, VAR_VIRT_MOUSE_Y } from '../engine/vm/vars';
import { driveTicks, driveToRoom, driveUntil, hover, setMouse } from './drive';

/** A bare VM with no scripts — enough vars to cover the named mouse/timer slots. */
function makeVm(): Vm {
  return new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map() });
}

const ticksRun = (vm: Vm): number => vm.vars.readGlobal(Vm.VAR_MUSIC_TIMER);

describe('VM drivers (synthetic)', () => {
  it('setMouse mirrors the position into the virtual + screen mouse vars', () => {
    const vm = makeVm();
    setMouse(vm, 72, 124);
    expect([vm.mouseRoomX, vm.mouseRoomY]).toEqual([72, 124]);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_X)).toBe(72);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_Y)).toBe(124);
    expect(vm.vars.readGlobal(VAR_MOUSE_X)).toBe(72);
    expect(vm.vars.readGlobal(VAR_MOUSE_Y)).toBe(124);
  });

  it('driveTicks advances exactly n jiffies', () => {
    const vm = makeVm();
    driveTicks(vm, 7);
    expect(ticksRun(vm)).toBe(7);
  });

  it('driveUntil short-circuits without ticking when the predicate is already true', () => {
    const vm = makeVm();
    expect(driveUntil(vm, () => true, { maxTicks: 50 })).toBe(true);
    expect(ticksRun(vm)).toBe(0); // never entered the loop
  });

  it('driveUntil returns true once the predicate holds, ticking until then', () => {
    const vm = makeVm();
    let calls = 0;
    // false on the pre-check (calls→1), true after the 5th tick (calls→6).
    expect(driveUntil(vm, () => ++calls > 5, { maxTicks: 50 })).toBe(true);
    expect(ticksRun(vm)).toBe(5);
  });

  it('driveUntil gives up after maxTicks when the predicate never holds', () => {
    const vm = makeVm();
    expect(driveUntil(vm, () => false, { maxTicks: 10 })).toBe(false);
    expect(ticksRun(vm)).toBe(10);
  });

  it('driveToRoom is true immediately when already there, false when unreachable', () => {
    const here = makeVm();
    here.currentRoom = 42;
    expect(driveToRoom(here, 42, { maxTicks: 1 })).toBe(true);

    const stuck = makeVm();
    expect(driveToRoom(stuck, 42, { maxTicks: 5 })).toBe(false);
    expect(stuck.currentRoom).not.toBe(42);
  });

  it('hover sets the cursor and then advances the requested jiffies', () => {
    const vm = makeVm();
    hover(vm, 268, 104, 6);
    expect([vm.mouseRoomX, vm.mouseRoomY]).toEqual([268, 104]);
    expect(ticksRun(vm)).toBe(6);
  });
});
