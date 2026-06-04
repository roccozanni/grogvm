/**
 * Faithful player-action vocabulary — game-agnostic input composition for
 * the harness. Like the drivers in `drive.ts`, nothing here is MI1-specific:
 * every helper operates on a bare {@link Vm} using only SCUMM-v5 structural
 * facts (CDHD hit-box geometry, the hover-poller → active-object-global →
 * `doSentence` click flow, actor speech), so any v5 game reuses it. The
 * *callers* (a per-game playthrough under `integration/<game>/`) supply the
 * game's numeric verb/object ids; this module bakes in none.
 *
 * These are "sugar over the real mouse path": move the cursor so the engine's
 * hover poller hit-tests what's under it (→ the active-object global, g108 in
 * MI1), click a verb, then a scene click commits `doSentence` via the
 * verb-input script (`VAR_VERB_SCRIPT`; MI1's #4). Nothing injects a sentence
 * directly — a playthrough built on these exercises (and regression-guards)
 * the genuine input machinery, not a shortcut.
 *
 * Each helper performs the input and runs a short *settle* so the poller /
 * sentence commit fires, then returns; it does NOT wait for the outcome — the
 * caller drives until its own assertion holds (`driveUntil`), keeping "what I
 * did" and "what I expect" separate.
 *
 * Split from `drive.ts` (not folded in) because those drivers are pure and
 * synthetic-testable, whereas these compose real input that needs a booted VM
 * with scripts — so the input-composing helpers are exercised by the
 * integration playthrough, while the pure geometry (`objectPoint`) is unit-
 * tested here.
 */
import { driveTicks, driveUntil, hover } from './drive';
import type { Vm } from '../engine/vm/vm';

/** A room-pixel point, or an object id whose hit-box center we hover. */
export type Target = number | { x: number; y: number };

/** Jiffies to let a freshly-clicked verb arm before the scene click. */
const VERB_ARM_TICKS = 24;

/**
 * Center of object `objId`'s CDHD hit-box, in room pixels — the point the
 * hover poller must see for `findObject` to load it into the active-object
 * global (hit-test is against the CDHD box, in 8-pixel units; see
 * `object/hittest.ts`). Throws if the object isn't in the currently loaded
 * room, so a mistargeted action fails loudly rather than silently hovering
 * empty floor.
 */
export function objectPoint(vm: Vm, objId: number): { x: number; y: number } {
  const o = vm.loadedRoom?.objects.get(objId);
  if (!o) {
    throw new Error(`objectPoint: object ${objId} is not in loaded room ${vm.currentRoom}`);
  }
  const { x, y, width, height } = o.cdhd;
  return { x: x * 8 + (width * 8) / 2, y: y * 8 + (height * 8) / 2 };
}

/** Resolve a {@link Target} to a room-pixel point. */
const pointOf = (vm: Vm, t: Target): { x: number; y: number } =>
  typeof t === 'number' ? objectPoint(vm, t) : t;

/**
 * Drive until ego has finished any line currently in progress. A sentence
 * that prints (e.g. "Look at X") blocks on its message; the *next* command
 * has no effect until it clears — verified: a walk-to-door issued
 * mid-speech paths ego to the door but the room won't change. So this is
 * the faithful "wait for ego to stop talking" a player does between
 * actions. Returns immediately when already idle.
 */
export function waitIdle(vm: Vm, maxTicks = 6000): void {
  driveUntil(vm, (v) => v.activeDialog === null, { maxTicks });
}

/**
 * Walk ego toward a floor point (or an object's hit-box center). A bare
 * scene click carries no object id, so the engine's default walk verb
 * paths ego to the cursor — the faithful "click the floor to move" flow.
 * Settles a few jiffies so the click commits; the caller drives until ego
 * actually arrives / the room changes.
 */
export function walkTo(vm: Vm, target: Target, settle = VERB_ARM_TICKS): void {
  waitIdle(vm);
  const { x, y } = pointOf(vm, target);
  hover(vm, x, y);
  vm.handleSceneClick(1);
  driveTicks(vm, settle);
}

/**
 * Apply `verb` to `target`: click the verb, hover the target so the poller
 * loads it into the active-object global, then a scene click commits
 * `doSentence`. This is the one-object sentence ("Look at X", "Open X",
 * "Pick up X").
 */
export function use(vm: Vm, verb: number, target: Target): void {
  waitIdle(vm);
  vm.handleVerbClick(verb, 1);
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = pointOf(vm, target);
  hover(vm, x, y);
  vm.handleSceneClick(1);
}

/**
 * Pick a dialog answer — the answer is a live verb (its `name` is the
 * localized line). Clicking it runs the conversation script that makes ego
 * speak the selected line. The caller drives until `activeDialog` appears
 * and (build-agnostically) checks it equals the answer's own `name`.
 */
export function pickAnswer(vm: Vm, answerVerb: number): void {
  vm.handleVerbClick(answerVerb, 1);
}
