/**
 * Game-agnostic VM drivers — advance the engine and feed it input. Nothing
 * here is MI1-specific: every function operates on a bare {@link Vm}, so it
 * works for any SCUMM-v5 game the engine boots (MI2 and beyond reuse it
 * unchanged). The MI1-specific load/boot/save glue lives in `mi1.ts`, which
 * re-exports these for convenience.
 *
 * Because there's no game data involved, these are unit-testable against a
 * synthetic VM (see `drive.test.ts`) — those tests run everywhere, including
 * CI without the game files.
 */
import {
  VAR_MOUSE_X,
  VAR_MOUSE_Y,
  VAR_VIRT_MOUSE_X,
  VAR_VIRT_MOUSE_Y,
} from '../engine/vm/vars';
import type { Vm } from '../engine/vm/vm';

/**
 * Point the virtual mouse at a room coordinate. Writes both the virtual
 * (g20/g21) and screen (g44/g45) mouse vars plus `mouseRoomX/Y`, exactly as
 * the shell's input layer does, so a hover poller sees a consistent position.
 */
export function setMouse(vm: Vm, x: number, y: number): void {
  vm.mouseRoomX = x;
  vm.mouseRoomY = y;
  vm.vars.writeGlobal(VAR_VIRT_MOUSE_X, x);
  vm.vars.writeGlobal(VAR_VIRT_MOUSE_Y, y);
  vm.vars.writeGlobal(VAR_MOUSE_X, x);
  vm.vars.writeGlobal(VAR_MOUSE_Y, y);
}

/** Advance `n` jiffies via the canonical engine driver, stopping early on halt. */
export function driveTicks(vm: Vm, n: number): void {
  for (let t = 0; t < n && !vm.haltInfo; t++) vm.tick();
}

/** Options shared by the conditional drivers. */
export interface DriveOptions {
  /** Max jiffies to spin before giving up (default 60000 ≈ a full intro). */
  maxTicks?: number;
}

/**
 * Tick until `pred(vm)` is true (checked after each jiffy) or the budget /
 * a halt stops us. Returns whether the predicate was met.
 */
export function driveUntil(
  vm: Vm,
  pred: (vm: Vm) => boolean,
  { maxTicks = 60000 }: DriveOptions = {},
): boolean {
  if (pred(vm)) return true;
  for (let t = 0; t < maxTicks && !vm.haltInfo; t++) {
    vm.tick();
    if (pred(vm)) return true;
  }
  return false;
}

/** Drive until the engine lands in `room`. Returns whether it got there. */
export function driveToRoom(vm: Vm, room: number, opts?: DriveOptions): boolean {
  return driveUntil(vm, (v) => v.currentRoom === room, opts);
}

/**
 * Move the cursor to `(x, y)` and let the per-frame hover poller run a few
 * frames so it hit-tests the object under the cursor (the faithful way the
 * click flow learns what's there). `ticks` is jiffies — the default 24 ≈ 4
 * game frames at MI1's pacing, enough for the poller to fire.
 */
export function hover(vm: Vm, x: number, y: number, ticks = 24): void {
  setMouse(vm, x, y);
  driveTicks(vm, ticks);
}
