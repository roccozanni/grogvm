/**
 * Game-agnostic VM drivers — advance a bare {@link Vm} and feed it input;
 * any v5 game reuses them. See pages/docs/engine/harness.md.
 */
import {
  VAR_MOUSE_X,
  VAR_MOUSE_Y,
  VAR_VIRT_MOUSE_X,
  VAR_VIRT_MOUSE_Y,
} from '../engine/vm/vars';
import type { Vm } from '../engine/vm/vm';

/**
 * Point the virtual mouse at a room coordinate. Writes the virtual AND screen
 * mouse vars plus `mouseRoomX/Y`, like the shell's input layer — a partial
 * write leaves the hover poller seeing an inconsistent position.
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
 * Move the cursor to `(x, y)` and drive a few jiffies so the per-frame hover
 * poller hit-tests what's under it (default 24 ≈ 4 game frames, enough for
 * the poller to fire).
 */
export function hover(vm: Vm, x: number, y: number, ticks = 24): void {
  setMouse(vm, x, y);
  driveTicks(vm, ticks);
}
