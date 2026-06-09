/**
 * Faithful player-action vocabulary — thin sugar over the genuine input path
 * (hover poller → active-object global → `doSentence`); never inject a
 * sentence directly, or playthroughs stop guarding the real input machinery.
 * Helpers settle the game before acting but do NOT wait for the outcome —
 * the caller drives until its own assertion holds. See
 * pages/docs/engine/harness.md.
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
 * poller must see. Tracks the live draw position, not the static CDHD box: a
 * runtime SO_AT reposition (the forest-maze path tiles) moves the hit-test,
 * so it must move this. Throws when the object isn't in the loaded room.
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
 * Center of actor `actorId`'s on-screen sprite box — the actor analog of
 * {@link objectPoint} (Talk-to / Give-to-actor target actors, not CDHD
 * objects). Throws if the actor isn't on screen.
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
 * Drive until any line in progress clears. A printing sentence blocks the
 * next command — a walk issued mid-speech paths ego to the door but the room
 * never changes.
 */
export function waitIdle(vm: Vm, maxTicks = 6000): void {
  driveUntil(vm, (v) => v.activeDialog === null, { maxTicks });
}

/**
 * Drive until the next input can land: control back, no line printing, no
 * cutscene, ego stopped. Every action helper waits on this first, so beats
 * need no guessed `driveTicks` pauses. Best-effort (no throw).
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
 * Drive until ego owns `obj` (a Pick up / Give landed it in the inventory).
 * Returns whether it happened in budget.
 */
export function waitPickedUp(vm: Vm, obj: number, maxTicks = 6000): boolean {
  const ego = vm.vars.readGlobal(VAR_EGO);
  return driveUntil(vm, (v) => v.getObjectOwner(obj) === ego, { maxTicks });
}

/**
 * Drive until story global `varId` equals `value` — assert the mechanic, not
 * localized text. Returns whether it reached the value in budget.
 */
export function waitGlobal(vm: Vm, varId: number, value: number, maxTicks = 6000): boolean {
  return driveUntil(vm, (v) => v.vars.readGlobal(varId) === value, { maxTicks });
}

/**
 * Drive until the player has the controls back: control returned, no line
 * printing, AND some verb armed — unlike {@link waitReady}, which doesn't
 * require a live verb bar. Returns whether it became playable in budget.
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
 * A bare click with NO verb armed, so the engine runs the DEFAULT action:
 * a floor point walks ego there; an object (door, arch, map node) commits its
 * default-verb sentence — in v5 "Walk to" is the default, not a button.
 */
export function walkTo(vm: Vm, target: Target, settle = VERB_ARM_TICKS): void {
  waitReady(vm);
  const { x, y } = pointOf(vm, target);
  hover(vm, x, y);
  vm.handleSceneClick(1);
  driveTicks(vm, settle);
}

/**
 * The one-object sentence ("Open X"): arm `verb`, hover the target, scene
 * click to commit `doSentence`.
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
 * Map a carried item's object id to its live inventory verb-slot — items
 * render as verb slots `invBase`+ in owning order (200 is the v5 inventory
 * slot base). Throws if the item isn't carried.
 */
function inventorySlot(vm: Vm, item: number, invBase: number): number {
  const ego = vm.vars.readGlobal(VAR_EGO);
  for (let i = 1, n = vm.inventoryCount(ego); i <= n; i++) {
    if (vm.findInventory(ego, i) === item) return invBase + (i - 1);
  }
  throw new Error(`inventorySlot: item ${item} is not in ego's inventory`);
}

/**
 * The two-object Give sentence: arm the verb, click the item's inventory slot
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
  vm.handleVerbClick(slot, 1); // object A
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = actorPoint(vm, actorId); // object B
  hover(vm, x, y);
  vm.handleSceneClick(1);
}

/**
 * The two-object Use sentence ("Use X with Y") — the {@link give} sibling
 * whose second object is a scene object instead of an actor.
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
  vm.handleVerbClick(slot, 1); // object A
  driveTicks(vm, VERB_ARM_TICKS);
  const { x, y } = objectPoint(vm, target); // object B
  hover(vm, x, y);
  vm.handleSceneClick(1);
}

/** Pick a dialog answer — answers are live verbs whose `name` is the localized line. */
export function pickAnswer(vm: Vm, answerVerb: number): void {
  vm.handleVerbClick(answerVerb, 1);
}

/**
 * Walk one step of a conversation tree: wait for `answerVerb` to arm (throws
 * if it never does), pick it, then wait for it to LEAVE the menu — answer ids
 * recur across consecutive menus, so returning early would let the next pick
 * match a stale menu. Returns the picked option's label so callers assert it
 * without hardcoding a translation.
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
