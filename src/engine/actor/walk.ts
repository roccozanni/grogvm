/** Per-tick walk stepping and chore driving. See pages/docs/engine/pathfinding.md §6. */

import { DEFAULT_SCALE, type Actor, type Facing, type WalkLeg } from './actor';
import type { Vm } from '../vm/vm';
import { routeThroughBoxes } from '../pathfinding/boxgraph';
import { findBoxAtOrNearest, type WalkBox } from '../pathfinding/boxes';
import { resolveScale } from '../pathfinding/scale';
import { startAnim } from '../graphics/costume-anim';

/** Facing → costume directional index (SCUMM "old dir"). See pages/docs/scumm/costume-anim.md. */
export const OLD_DIR: Record<Facing, number> = { W: 0, E: 1, S: 2, N: 3 };

/** Inverse of {@link OLD_DIR}. */
export const FACING_FROM_OLD: readonly Facing[] = ['W', 'E', 'S', 'N'];

/** The anim-record index for a chore at the actor's current facing. */
export function choreRecord(actor: Actor, chore: number): number {
  return chore * 4 + OLD_DIR[actor.facing];
}

/**
 * Always restarts (resets the playback cursor) — callers that want a running
 * cycle to keep advancing should guard on the record (see {@link applyChore}).
 */
export function startActorChore(vm: Vm, actor: Actor, chore: number): void {
  if (actor.costume <= 0) return;
  const costume = vm.getCostume(actor.costume);
  if (!costume) return;
  actor.anim = startAnim(actor.anim, choreRecord(actor, chore), costume.header, costume.payload);
}

/**
 * Restart the currently playing chore (`animId / 4`) so it picks up the new
 * facing — the `animateActor` turn pseudo-anims re-decode the running chore
 * rather than switch it. See pages/docs/scumm/costume-anim.md.
 */
export function reapplyChoreForFacing(vm: Vm, actor: Actor): void {
  if (actor.costume <= 0) return;
  startActorChore(vm, actor, Math.floor(actor.anim.animId / 4));
}

/** Only (re)starts when the record changes, so a running walk cycle isn't reset every tick. */
function applyChore(vm: Vm, actor: Actor, chore: number): void {
  if (actor.costume <= 0) return;
  if (actor.anim.animId === choreRecord(actor, chore)) return;
  startActorChore(vm, actor, chore);
}

/**
 * Stand pose for the CURRENT facing. The init step is required: only init
 * carries the head's per-direction frame — stand/walk merely stop/un-stop the
 * head limb. See pages/docs/scumm/costume-anim.md §"Limb composition".
 */
export function applyStandPose(vm: Vm, actor: Actor): void {
  if (actor.costume <= 0) return;
  startActorChore(vm, actor, actor.initFrame);
  startActorChore(vm, actor, actor.standFrame);
}

/** Plan and begin a walk. Routing model: pages/docs/engine/pathfinding.md. */
export function startWalk(
  vm: Vm,
  actor: Actor,
  target: { x: number; y: number },
): void {
  actor.walkTarget = target;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.walkLeg = null;
  actor.isMoving = true;

  const room = vm.loadedRoom;
  if (!room || room.walkBoxes.length === 0 || actor.ignoreBoxes) {
    // Straight line via stepWalk's walkTarget fall-back.
    return;
  }
  const boxes = effectiveBoxes(vm, room.walkBoxes);
  const path = routeThroughBoxes(
    boxes,
    vm.boxMatrixOverride ?? room.boxMatrix,
    { x: actor.x, y: actor.y },
    target,
  );
  actor.walkPath = [...path.waypoints];
  actor.walkPathIdx = 0;
}

/** Walk boxes with runtime flag overrides folded in. See pages/docs/engine/pathfinding.md §5. */
export function effectiveBoxes(vm: Vm, walkBoxes: ReadonlyArray<WalkBox>): ReadonlyArray<WalkBox> {
  if (vm.boxFlagOverrides.size === 0) return walkBoxes;
  return walkBoxes.map((b) =>
    vm.boxFlagOverrides.has(b.id) ? { ...b, flags: vm.boxFlagOverrides.get(b.id)! } : b,
  );
}

/** Advance one actor one tick along its path. */
export function stepWalk(actor: Actor): void {
  if (!actor.isMoving) return;
  const aim = currentAim(actor);
  if (!aim) {
    finishWalk(actor);
    return;
  }

  if (actor.x === aim.x && actor.y === aim.y) {
    // Already on this waypoint — advance within the same tick.
    actor.walkLeg = null;
    if (advanceWaypoint(actor)) {
      stepWalk(actor);
    } else {
      finishWalk(actor);
    }
    return;
  }

  let leg = actor.walkLeg;
  if (!leg || leg.toX !== aim.x || leg.toY !== aim.y) {
    leg = calcMovementFactor(actor, aim);
    actor.walkLeg = leg;
  }

  // Facing follows a lookahead, not this tick's ±1px step — see facingLookahead.
  // Horizontal wins ties (SCUMM bias).
  const look = facingLookahead(actor);
  const fx = look.x - actor.x;
  const fy = look.y - actor.y;
  if (Math.abs(fx) >= Math.abs(fy) && fx !== 0) {
    actor.facing = fx > 0 ? 'E' : 'W';
  } else if (fy !== 0) {
    actor.facing = fy > 0 ? 'S' : 'N';
  }

  // Step along the line in 16.16 fixed point: the factors carry the slope,
  // the fracs the sub-pixel remainder. The advance is throttled by the
  // actor's perspective scale — apparent speed tracks apparent size (a
  // half-size actor stands twice as far away, so it covers half the screen
  // distance per tick); scale 255 = full size = exactly the nominal speeds.
  // Validated by timing walks against the original in-browser.
  const tmpX = (actor.x << 16) + leg.xfrac + Math.trunc((leg.deltaXFactor * actor.scale) / 255);
  actor.x = tmpX >> 16;
  leg.xfrac = tmpX & 0xffff;
  const tmpY = (actor.y << 16) + leg.yfrac + Math.trunc((leg.deltaYFactor * actor.scale) / 255);
  actor.y = tmpY >> 16;
  leg.yfrac = tmpY & 0xffff;

  // An axis that stepped past the waypoint pins to it (truncation makes the
  // axes finish up to a tick apart even though both follow the same line).
  if (Math.abs(actor.x - leg.fromX) > Math.abs(leg.toX - leg.fromX)) actor.x = leg.toX;
  if (Math.abs(actor.y - leg.fromY) > Math.abs(leg.toY - leg.fromY)) actor.y = leg.toY;

  if (actor.x === aim.x && actor.y === aim.y) {
    actor.walkLeg = null;
    if (!advanceWaypoint(actor)) finishWalk(actor);
  }
}

/**
 * Fix a leg's per-tick movement (SCUMM's `calcMovementFactor`): the dominant
 * axis runs at its full walk speed, the other proportionally, so the actor
 * tracks the LINE to the waypoint — stepping the axes independently instead
 * drifts off thin diagonal connector boxes.
 * See pages/docs/engine/pathfinding.md §9.
 */
function calcMovementFactor(actor: Actor, aim: { x: number; y: number }): WalkLeg {
  const diffX = aim.x - actor.x;
  const diffY = aim.y - actor.y;

  // Assume Y is the dominant axis: full vertical speed, X follows the slope.
  let deltaYFactor = actor.walkSpeedY << 16;
  if (diffY < 0) deltaYFactor = -deltaYFactor;
  let deltaXFactor = deltaYFactor * diffX;
  if (diffY !== 0) {
    deltaXFactor = Math.trunc(deltaXFactor / diffY);
  } else {
    deltaYFactor = 0;
  }

  // That overdrives X → the line is X-dominant: clamp X to full speed, Y follows.
  if (Math.abs(deltaXFactor) > actor.walkSpeedX << 16) {
    deltaXFactor = actor.walkSpeedX << 16;
    if (diffX < 0) deltaXFactor = -deltaXFactor;
    deltaYFactor = deltaXFactor * diffY;
    if (diffX !== 0) {
      deltaYFactor = Math.trunc(deltaYFactor / diffX);
    } else {
      deltaXFactor = 0;
    }
  }

  return {
    fromX: actor.x,
    fromY: actor.y,
    toX: aim.x,
    toY: aim.y,
    deltaXFactor,
    deltaYFactor,
    xfrac: 0,
    yfrac: 0,
  };
}

/** Big enough to smooth ±1px grid-path jitter; small enough to turn promptly at a corner. */
const FACING_LOOKAHEAD = 16;

/**
 * The point facing aims at: the first waypoint ≥ {@link FACING_LOOKAHEAD} px
 * ahead, else the last waypoint, else `walkTarget`. Aiming at the *step* target
 * flip-flops on near-axis-aligned paths; aiming at the *final* target turns too
 * early (distinct from {@link currentAim}, the point the actor steps toward).
 */
function facingLookahead(actor: Actor): { x: number; y: number } {
  const path = actor.walkPath;
  const look2 = FACING_LOOKAHEAD * FACING_LOOKAHEAD;
  for (let i = actor.walkPathIdx; i < path.length; i++) {
    const wp = path[i]!;
    const dx = wp.x - actor.x;
    const dy = wp.y - actor.y;
    if (dx * dx + dy * dy >= look2) return wp;
  }
  if (path.length > 0) return path[path.length - 1]!;
  return actor.walkTarget ?? { x: actor.x, y: actor.y };
}

/** Next waypoint on the path, or `walkTarget` if no path was planned. */
function currentAim(actor: Actor): { x: number; y: number } | null {
  if (actor.walkPath.length > 0 && actor.walkPathIdx < actor.walkPath.length) {
    return actor.walkPath[actor.walkPathIdx]!;
  }
  if (actor.walkTarget) return actor.walkTarget;
  return null;
}

/** Returns false when the path is done. */
function advanceWaypoint(actor: Actor): boolean {
  if (actor.walkPath.length === 0) return false;
  actor.walkPathIdx++;
  return actor.walkPathIdx < actor.walkPath.length;
}

function finishWalk(actor: Actor): void {
  actor.walkTarget = null;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.walkLeg = null;
  actor.isMoving = false;
}

/**
 * Recompute perspective scale (and `walkBox`) from the box under the actor.
 * Call on discrete placement events only — NOT every idle tick, which would
 * clobber a script-pinned scale. Timing rules and the ignoreBoxes exemption:
 * pages/docs/scumm/walk-boxes.md §"Perspective-scale recompute timing".
 */
export function rescaleActorForPosition(vm: Vm, actor: Actor): void {
  const room = vm.loadedRoom;
  if (!room || actor.room !== vm.currentRoom) return;
  // Off the walk-box grid: keep the script-set scale AND the last walkBox.
  if (actor.ignoreBoxes) return;
  const box = findBoxAtOrNearest(room.walkBoxes, actor.x, actor.y);
  actor.walkBox = box ? box.id : -1;
  const s = box ? resolveScale(box.scale, room.scaleSlots, actor.y) : null;
  actor.scale = s ?? DEFAULT_SCALE;
}

export function stepAllActorWalks(vm: Vm): void {
  for (const actor of vm.actors.all()) {
    const wasMoving = actor.isMoving;
    stepWalk(actor);

    if (actor.isMoving || wasMoving) rescaleActorForPosition(vm, actor);
    // Touch the anim ONLY in these three cases, never on a plain idle tick —
    // script-driven FX actors (run via animateActor) must be left alone.
    if (actor.isMoving) {
      applyChore(vm, actor, actor.walkFrame);
    } else if (wasMoving) {
      applyStandPose(vm, actor);
    } else if (actor.costume > 0 && actor.anim.animId === 0) {
      applyChore(vm, actor, actor.initFrame);
    }
  }
}
