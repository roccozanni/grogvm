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
 * Each helper first waits for the game to settle ({@link waitReady} — control
 * back, ego stopped, no line/cutscene in flight) so it can't fire into a
 * half-loaded room or a still-walking ego; it then performs the input and runs
 * a short settle so the poller / sentence commit fires, and returns. It does
 * NOT wait for the *outcome* — the caller drives until its own assertion holds
 * (`driveUntil`), keeping "what I did" and "what I expect" separate. Because the
 * wait is built in, beats read as a plain sequence of actions, with no guessed
 * `driveTicks` pauses between them.
 *
 * Split from `drive.ts` (not folded in) because those drivers are pure and
 * synthetic-testable, whereas these compose real input that needs a booted VM
 * with scripts — so the input-composing helpers are exercised by the
 * integration playthrough, while the pure geometry (`objectPoint`) is unit-
 * tested here.
 */
import { driveTicks, driveUntil, hover } from './drive';
import { objectHitBox } from '../engine/object/hittest';
import { VAR_EGO } from '../engine/vm/vars';
import type { Vm } from '../engine/vm/vm';

/** A room-pixel point, or an object id whose hit-box center we hover. */
export type Target = number | { x: number; y: number };

/** Jiffies to let a freshly-clicked verb arm before the scene click. */
const VERB_ARM_TICKS = 24;

/**
 * Center of object `objId`'s hit-box, in room pixels — the point the hover
 * poller must see for `findObject` to load it into the active-object global.
 * Computed via {@link objectHitBox}, so it tracks a runtime SO_AT reposition
 * (`drawObject … at`): the forest-maze path tiles share a design origin but
 * are repositioned per screen, so the static CDHD box would point at the wrong
 * spot — the hit-test moves with the draw position and so must this. Throws if
 * the object isn't in the currently loaded room, so a mistargeted action fails
 * loudly rather than silently hovering empty floor.
 */
export function objectPoint(vm: Vm, objId: number): { x: number; y: number } {
  const o = vm.loadedRoom?.objects.get(objId);
  if (!o) {
    throw new Error(`objectPoint: object ${objId} is not in loaded room ${vm.currentRoom}`);
  }
  const { left, top, right, bottom } = objectHitBox(o, vm.objectDrawPositions.get(objId));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

/**
 * Center of actor `actorId`'s on-screen sprite box, in room pixels — the
 * point to hover so the click flow's `actorFromPos` hit-tests this actor
 * (the actor analog of {@link objectPoint}; rooms target actors, not CDHD
 * objects, for Talk-to / Give-to-actor). Reads the same box the hit-test
 * uses, so a hover here is guaranteed to land on the actor. Throws if the
 * actor isn't on screen (no costume / not in the room / nothing drawn), so
 * a mistargeted action fails loudly.
 */
export function actorPoint(vm: Vm, actorId: number): { x: number; y: number } {
  const b = vm.actorHitBounds(actorId);
  if (!b) {
    throw new Error(`actorPoint: actor ${actorId} is not on screen in room ${vm.currentRoom}`);
  }
  return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
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
 * Drive until the VM is ready for the next player input: control is back
 * (`userput > 0`), no line is printing, no cutscene is running, and ego has
 * finished walking. This is the faithful "let the game settle before I click
 * again" that a player does without thinking — and it's the ONE condition the
 * scattered `driveTicks(<guess>)` pauses were all approximating: the lag after
 * a room change (the entry script hands control back), after `open` (ego walks
 * to the door and it swings open), and after any walk (ego arrives). {@link use}
 * and {@link walkTo} wait on it before acting, so beats don't pad with magic
 * tick counts. Best-effort like {@link waitIdle} (no throw); the caller's
 * assertion is what proves the outcome. Returns at once when already ready.
 */
export function waitReady(vm: Vm, maxTicks = 6000): void {
  driveUntil(
    vm,
    (v) => {
      const ego = v.vars.readGlobal(VAR_EGO);
      return (
        v.cursor.userput > 0 &&
        v.activeDialog === null &&
        v.cutsceneStack.length === 0 &&
        (ego <= 0 || !v.actors.get(ego).isMoving)
      );
    },
    { maxTicks },
  );
}

/**
 * Drive until ego owns `obj` — i.e. a Pick up / Give has landed it in the
 * inventory. Returns whether it happened in budget, so it reads as a one-line
 * assertion: `expect(waitPickedUp(vm, ROOMS.kitchen.meat)).toBe(true)`. The
 * inventory/ownership sibling of {@link driveToRoom}.
 */
export function waitPickedUp(vm: Vm, obj: number, maxTicks = 6000): boolean {
  const ego = vm.vars.readGlobal(VAR_EGO);
  return driveUntil(vm, (v) => v.getObjectOwner(obj) === ego, { maxTicks });
}

/**
 * Drive until story global `varId` equals `value` — a puzzle flag flipping or a
 * counter settling (e.g. the money total after a payout, the trials-learned
 * stage). Returns whether it reached the value in budget. Assert the *mechanic*
 * with this, not localized text.
 */
export function waitGlobal(vm: Vm, varId: number, value: number, maxTicks = 6000): boolean {
  return driveUntil(vm, (v) => v.vars.readGlobal(varId) === value, { maxTicks });
}

/**
 * Drive until the player can act again: control is back (`userput > 0`), no line
 * is printing, and the verb bar is live (some verb armed). The "a cutscene has
 * released / a conversation has ended and the game handed control back" check a
 * beat makes after such a transition. Returns whether it became playable in
 * budget. Unlike {@link waitReady} (the internal pre-action settle, which also
 * wants ego stopped + no cutscene but does NOT require an armed verb), this
 * asserts the verb bar specifically — that the player has regained the controls.
 */
export function waitPlayable(vm: Vm, maxTicks = 6000): boolean {
  return driveUntil(
    vm,
    (v) =>
      v.cursor.userput > 0 &&
      v.activeDialog === null &&
      [...v.verbs.values()].some((verb) => verb.state === 'on'),
    { maxTicks },
  );
}

/**
 * A bare click — hover the target, then a scene click with NO verb armed, so
 * the engine runs its DEFAULT action. This is the faithful "just click where
 * you want to go" input, which covers both senses of moving:
 *   • a floor point → ego walks to the cursor;
 *   • an object (door, arch, map node) → the poller picks it up and the click
 *     commits its default-verb sentence — i.e. how a player walks through a
 *     door (enter if open, stop in front if closed) without ever arming a
 *     "Walk to" verb (in SCUMM v5 "Walk to" is the default, not a button).
 * Waits for the game to settle first ({@link waitReady}), so a walk issued
 * right after a room change / an `open` doesn't fire early; settles a few
 * jiffies so the click commits, then the caller drives until ego arrives /
 * the room changes.
 */
export function walkTo(vm: Vm, target: Target, settle = VERB_ARM_TICKS): void {
  waitReady(vm);
  const { x, y } = pointOf(vm, target);
  hover(vm, x, y);
  vm.handleSceneClick(1);
  driveTicks(vm, settle);
}

/**
 * Apply `verb` to `target`: click the verb, hover the target so the poller
 * loads it into the active-object global, then a scene click commits
 * `doSentence`. This is the one-object sentence ("Look at X", "Open X",
 * "Pick up X"). Waits for the game to settle first ({@link waitReady}) so it
 * doesn't fire into a not-yet-ready room / a still-walking ego.
 */
export function use(vm: Vm, verb: number, target: Target): void {
  waitReady(vm);
  vm.handleVerbClick(verb, 1);
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = pointOf(vm, target);
  hover(vm, x, y);
  vm.handleSceneClick(1);
}

/**
 * Resolve a carried item's inventory verb-slot. Carried items render as verb
 * slots `invBase`+ in owning order (200 is the SCUMM v5 inventory verb-slot
 * base), so a two-object sentence selects object A by clicking that slot. The
 * caller passes the item's *object id*; we map it to its live panel slot,
 * throwing if it isn't carried so a mistargeted give/use fails loudly.
 */
function inventorySlot(vm: Vm, item: number, invBase: number): number {
  const ego = vm.vars.readGlobal(VAR_EGO);
  for (let i = 1, n = vm.inventoryCount(ego); i <= n; i++) {
    if (vm.findInventory(ego, i) === item) return invBase + (i - 1);
  }
  throw new Error(`inventorySlot: item ${item} is not in ego's inventory`);
}

/**
 * Give a carried item to an actor — the two-object "Dai X a ⟨actor⟩" sentence.
 * Faithful flow: arm the Give verb, click the item in the inventory panel
 * (object A), then click the actor (object B).
 */
export function give(
  vm: Vm,
  giveVerb: number,
  item: number,
  actorId: number,
  invBase = 200,
): void {
  waitReady(vm);
  const slot = inventorySlot(vm, item, invBase);
  vm.handleVerbClick(giveVerb, 1);
  driveTicks(vm, VERB_ARM_TICKS);
  vm.handleVerbClick(slot, 1); // select the item (object A) from the inventory panel
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = actorPoint(vm, actorId); // hover the actor (object B)
  hover(vm, x, y);
  vm.handleSceneClick(1);
}

/**
 * Use a carried item on a scene object — the two-object "Usa X con Y" sentence
 * where Y is an object (the {@link give} sibling, whose second object is an
 * actor). Faithful flow: arm the Use verb, click the item in the inventory
 * panel (object A), then click the target object (object B), committing
 * doSentence(use, item, target). The item's slot is resolved from ego's live
 * inventory; the target is hovered at its {@link objectPoint}.
 */
export function useWith(
  vm: Vm,
  useVerb: number,
  item: number,
  target: number,
  invBase = 200,
): void {
  waitReady(vm);
  const slot = inventorySlot(vm, item, invBase);
  vm.handleVerbClick(useVerb, 1);
  driveTicks(vm, VERB_ARM_TICKS);
  vm.handleVerbClick(slot, 1); // select the item (object A) from the inventory panel
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = objectPoint(vm, target); // hover the target object (object B)
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

/**
 * Follow a dialog by picking one answer, the way a player walks a conversation
 * tree: wait for the answer verb to arm, pick it, then wait for the menu to
 * dismiss before returning.
 *
 * Dialog options are live verbs whose `name` is the localized line. This:
 *   1. waits out any line in progress, then for `answerVerb` to arm (`state ===
 *      'on'`) within `armTicks` — throwing if it never does, so a mis-sequenced
 *      dialog fails loudly (like {@link objectPoint} on a bad target);
 *   2. picks it;
 *   3. drives until the verb leaves the menu, so a verb id that **recurs across
 *      consecutive menus** (conversation trees reuse ids) can't match this now-
 *      stale menu on the caller's next pick.
 *
 * Returns the picked option's label (this build's language), so the caller can
 * assert *what* was selected/said without hardcoding a translation. Game-
 * agnostic: the caller supplies the answer verb id.
 */
export function pickDialogAnswer(
  vm: Vm,
  answerVerb: number,
  { armTicks = 12000, settleTicks = 3000 }: { armTicks?: number; settleTicks?: number } = {},
): string {
  waitIdle(vm);
  if (!driveUntil(vm, (v) => v.verbs.get(answerVerb)?.state === 'on', { maxTicks: armTicks })) {
    throw new Error(`pickDialogAnswer: dialog option verb ${answerVerb} did not arm within ${armTicks} ticks`);
  }
  const name = vm.verbs.get(answerVerb)?.name ?? '';
  pickAnswer(vm, answerVerb);
  driveUntil(vm, (v) => v.verbs.get(answerVerb)?.state !== 'on', { maxTicks: settleTicks });
  return name;
}
