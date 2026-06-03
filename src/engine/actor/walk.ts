/**
 * Walk stepping for actors. Each `stepWalk(actor)` advances the actor
 * one engine tick along its current path:
 *
 * - If `walkPath` is non-empty: aim at `walkPath[walkPathIdx]`. When
 *   the waypoint is reached, bump the index. When all waypoints are
 *   exhausted, the actor is at the final target — flip `isMoving`
 *   off.
 *
 * - If `walkPath` is empty but `walkTarget` is set: walk straight
 *   toward the target (no pathfinding). This is the fallback the
 *   walkActorTo opcodes use when the room has no walk boxes.
 *
 * Step magnitude is `walkSpeedX` × `walkSpeedY` (SCUMM defaults 8/2
 * — horizontal-biased to match the original engine's perspective
 * convention), clamped so we never overshoot the active waypoint.
 *
 * Facing follows the dominant component of *this tick's* movement —
 * E/W when the X step is larger, N/S otherwise.
 */

import { DEFAULT_SCALE, type Actor, type Facing } from './actor';
import type { Vm } from '../vm/vm';
import { findPath } from '../pathfinding/grid';
import { findBoxAt, findBoxAtOrNearest } from '../pathfinding/boxes';
import { resolveScale } from '../pathfinding/scale';
import { startAnim } from '../graphics/costume-anim';

/**
 * SCUMM `newDirToOldDir`: facing → the costume's directional index
 * (0=W, 1=E, 2=S, 3=N), per ScummVM's `oldDirToNewDir` table. The anim
 * record for a chore + facing is `chore * 4 + dir`.
 */
export const OLD_DIR: Record<Facing, number> = { W: 0, E: 1, S: 2, N: 3 };

/** Inverse of {@link OLD_DIR}: directional index 0..3 → facing. */
export const FACING_FROM_OLD: readonly Facing[] = ['W', 'E', 'S', 'N'];

/** The anim-record index for a chore at the actor's current facing. */
export function choreRecord(actor: Actor, chore: number): number {
  return chore * 4 + OLD_DIR[actor.facing];
}

/**
 * (Re)start a costume chore on an actor — the anim record `chore * 4 +
 * dir(facing)`. Always restarts (resets the playback cursor); callers
 * that want to keep a running cycle advancing should guard on the
 * record themselves (see {@link applyChore}). No-op for actors without
 * a loaded costume.
 */
export function startActorChore(vm: Vm, actor: Actor, chore: number): void {
  if (actor.costume <= 0) return;
  const costume = vm.getCostume(actor.costume);
  if (!costume) return;
  actor.anim = startAnim(actor.anim, choreRecord(actor, chore), costume.header, costume.payload);
}

/**
 * Re-point the chore that's currently playing to the actor's (just-changed)
 * facing, without switching chores. The active anim record is
 * `chore * 4 + dir`, so the chore is `animId / 4`; restarting it picks up
 * the new `dir(facing)`. Used by the `animateActor` set/turn-direction
 * pseudo-anims (244-251): SCUMM re-decodes the running animation for the new
 * direction rather than changing what's playing — e.g. the SCUMM-Bar pirates
 * keep their init/drink chore while turning to face south. No-op without a
 * loaded costume.
 */
export function reapplyChoreForFacing(vm: Vm, actor: Actor): void {
  if (actor.costume <= 0) return;
  startActorChore(vm, actor, Math.floor(actor.anim.animId / 4));
}

/**
 * Drive an actor's costume animation from a chore frame: start the anim
 * record `chore * 4 + dir` for the actor's current facing. Only
 * (re)starts when the target record changes, so a running walk cycle
 * keeps advancing through `stepAnim` instead of resetting to frame 0
 * every tick. No-op for actors without a loaded costume.
 */
function applyChore(vm: Vm, actor: Actor, chore: number): void {
  if (actor.costume <= 0) return;
  if (actor.anim.animId === choreRecord(actor, chore)) return;
  startActorChore(vm, actor, chore);
}

/**
 * Put an idle actor into its stand pose for its CURRENT facing,
 * re-pointing the directional limbs — including the head.
 *
 * The costume's stand (and walk) records only **stop/un-stop** the head
 * limb; only the **init** pose carries the head's per-direction frame
 * (W/E, S=front, N=back). So we apply init for the current facing (which
 * re-points the head *and* body) then stand (which un-stops the head and
 * sets the stand body frame — identical to init's body per direction).
 * Without the init step the head keeps whatever frame init last set and
 * faces the wrong way after the actor turns. Use after a walk ends and
 * whenever a script turns the actor in place (faceActor / animateActor
 * set-direction). No-op without a loaded costume.
 */
export function applyStandPose(vm: Vm, actor: Actor): void {
  if (actor.costume <= 0) return;
  startActorChore(vm, actor, actor.initFrame);
  startActorChore(vm, actor, actor.standFrame);
}

/**
 * Set up an actor's walk: store the target, compute a waypoint path
 * through the current room's walkable mask (or straight-line fall-back
 * when there's no mask), and flip `isMoving` on. Shared by the
 * `walkActorTo` opcode family, `vm.walkActorTo`, and click-to-walk.
 *
 * The actor's `ignoreBoxes` flag bypasses pathfinding — used for
 * cutscene movement that can cross non-walkable regions.
 */
export function startWalk(
  vm: Vm,
  actor: Actor,
  target: { x: number; y: number },
): void {
  actor.walkTarget = target;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.isMoving = true;

  const mask = vm.loadedRoom?.walkableMask;
  if (!mask || mask.length === 0 || actor.ignoreBoxes) {
    // No pathfinding context — actor walks the straight line via
    // stepWalk's walkTarget fall-back.
    return;
  }
  const room = vm.loadedRoom!;
  const path = findPath(mask, room.width, room.height, { x: actor.x, y: actor.y }, target);
  if (path.waypoints.length === 0) return;
  // The first waypoint is the snapped start position — drop it so we
  // don't make the actor "teleport" to the box edge before walking.
  // Keep all the rest, including the (possibly snapped) final waypoint.
  const waypoints = path.waypoints.slice(1);

  // Off-mask box targets: SCUMM walks in box space, so a target inside a
  // visible walk box is reachable even when it lies off the rasterized
  // [0,width)×[0,height) mask — boxes legitimately extend past the screen
  // edges for room exits (MI1 room 78's exit walk-to is x=-25, inside its
  // [-25..345] floor box). findPath snaps such a goal to the nearest
  // in-bounds walkable pixel (the screen edge), leaving the ego ~25px short
  // — past the exit sentence's 16px proximity gate, so it answers "non
  // riesco ad arrivarci" and never loads the next room. When the true
  // target sits in a visible box that the snapped endpoint also belongs to,
  // the final straight segment stays inside that convex (walkable) box, so
  // append the exact target and let the ego finish the approach onto it.
  const targetBox = findBoxAt(room.walkBoxes, target.x, target.y);
  if (targetBox) {
    const end = waypoints.length > 0 ? waypoints[waypoints.length - 1]! : { x: actor.x, y: actor.y };
    const atTarget = end.x === target.x && end.y === target.y;
    if (!atTarget && findBoxAtOrNearest(room.walkBoxes, end.x, end.y)?.id === targetBox.id) {
      waypoints.push({ x: target.x, y: target.y });
    }
  }

  actor.walkPath = waypoints;
  actor.walkPathIdx = 0;
}

/**
 * Advance one actor one tick along its path. No-op when the actor is
 * not moving or has nothing to head toward.
 */
export function stepWalk(actor: Actor): void {
  if (!actor.isMoving) return;
  const aim = currentAim(actor);
  if (!aim) {
    // Nothing to walk to — clean up and stop.
    finishWalk(actor);
    return;
  }

  const dx = aim.x - actor.x;
  const dy = aim.y - actor.y;
  if (dx === 0 && dy === 0) {
    // Already on this waypoint — try to advance to the next one
    // this same tick (no point making the user wait a frame for it).
    if (advanceWaypoint(actor)) {
      stepWalk(actor);
    } else {
      finishWalk(actor);
    }
    return;
  }

  // Step by walkSpeed, clamped to the remaining distance to the
  // current waypoint so we land on it exactly.
  const stepX = clampToward(dx, actor.walkSpeedX);
  const stepY = clampToward(dy, actor.walkSpeedY);

  // Facing follows the LOCAL path direction via a short lookahead: the next
  // waypoint at least FACING_LOOKAHEAD px ahead (or the final aim near the
  // end). Looking ahead — rather than at this tick's ±1px step — avoids the
  // flip-flop on near-axis-aligned grid paths, while still turning with the
  // path's actual shape. Aiming at the *final* target instead faced the dock
  // (far east) for the whole room-33 cliff descent; the lookahead reads it as
  // S down the cliff, then E along the dock. Horizontal wins ties (SCUMM bias).
  const look = facingLookahead(actor);
  const fx = look.x - actor.x;
  const fy = look.y - actor.y;
  if (Math.abs(fx) >= Math.abs(fy) && fx !== 0) {
    actor.facing = fx > 0 ? 'E' : 'W';
  } else if (fy !== 0) {
    actor.facing = fy > 0 ? 'S' : 'N';
  }

  actor.x += stepX;
  actor.y += stepY;

  // Reached the waypoint? Advance (or finish).
  if (actor.x === aim.x && actor.y === aim.y) {
    if (!advanceWaypoint(actor)) finishWalk(actor);
  }
}

/** How far ahead (room px) facing looks along the path. Big enough to smooth
 *  the ±1px jitter of a near-axis-aligned grid path; small enough to still
 *  turn promptly at a real corner (e.g. cliff → dock). */
const FACING_LOOKAHEAD = 16;

/**
 * The point facing should aim at: the first waypoint at least
 * {@link FACING_LOOKAHEAD} px ahead of the actor, else the last waypoint, else
 * the straight-line `walkTarget`. (Distinct from {@link currentAim}, which is
 * the *next* waypoint the actor physically steps toward.)
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

/**
 * Pick the actor's current aim point — the next waypoint on the path,
 * or `walkTarget` if no path was planned. Returns `null` if neither
 * exists.
 */
function currentAim(actor: Actor): { x: number; y: number } | null {
  if (actor.walkPath.length > 0 && actor.walkPathIdx < actor.walkPath.length) {
    return actor.walkPath[actor.walkPathIdx]!;
  }
  if (actor.walkTarget) return actor.walkTarget;
  return null;
}

/** Advance to the next waypoint. Returns false when the path is done. */
function advanceWaypoint(actor: Actor): boolean {
  if (actor.walkPath.length === 0) return false;
  actor.walkPathIdx++;
  return actor.walkPathIdx < actor.walkPath.length;
}

/** Clear walk state — the actor is at rest. */
function finishWalk(actor: Actor): void {
  actor.walkTarget = null;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.isMoving = false;
}

/**
 * Tick every actor in the table. The main loop calls this once per
 * engine tick, after the VM has finished dispatching opcodes (so any
 * `walkActorTo` opcodes that fired this tick have already set up
 * `walkTarget`).
 *
 * Dormant slots (room=0) are stepped just like everyone else — the
 * caller can filter to current-room actors if desired, but
 * conceptually a walking actor walks regardless of which room they
 * happen to be in.
 */
/**
 * Recompute an actor's perspective scale from the walk box it currently
 * stands in (SCUMM scales actors by floor depth). Resets to full size when
 * the box specifies no scaling — see the in-place note in
 * {@link stepAllActorWalks}. A no-op unless the actor is in the loaded room.
 *
 * Use this for *discrete* placement events (putActor / putActorAtObject /
 * room entry): SCUMM rescales an actor the moment its position is set, so
 * it never renders one frame at a stale scale. It's deliberately NOT called
 * on every idle tick — that would clobber a script-pinned static actor
 * (e.g. the room-38 fire, set smaller than its floor scale). Placement is a
 * one-shot event, so a `setScale` opcode that runs *after* placement in the
 * same script still wins.
 */
export function rescaleActorForPosition(vm: Vm, actor: Actor): void {
  const room = vm.loadedRoom;
  if (!room || actor.room !== vm.currentRoom) return;
  const box = findBoxAtOrNearest(room.walkBoxes, actor.x, actor.y);
  const s = box ? resolveScale(box.scale, room.scaleSlots, actor.y) : null;
  actor.scale = s ?? DEFAULT_SCALE;
}

export function stepAllActorWalks(vm: Vm): void {
  for (const actor of vm.actors.all()) {
    const wasMoving = actor.isMoving;
    stepWalk(actor);

    // Perspective scale: recompute from the walk box the actor now stands in
    // (SCUMM scales actors by floor depth). Only while moving / just-arrived,
    // so a script-pinned static actor (e.g. the room-38 fire, set smaller than
    // its floor scale) keeps its scale. Placement events rescale separately,
    // via rescaleActorForPosition (see putActor) — that's what keeps an idle
    // actor from rendering one stale frame after a room change. The
    // nearest-box lookup matters: MI1's thin cliff boxes mean an actor on a
    // valid floor pixel often sits in no box strictly, which would otherwise
    // leave the scale stuck small until a wide box and pop it at the end.
    if (actor.isMoving || wasMoving) rescaleActorForPosition(vm, actor);
    // Drive the costume chore from movement state:
    //  - moving        → walk chore (body cycles; the record stops the
    //                    head limb so the body sprite carries the head)
    //  - just arrived  → stand chore (un-stops the head, body to pose)
    //  - idle, no anim → seed the init pose once, so the head limb has
    //                    playback that stand/walk can later resume/freeze
    // We touch the anim ONLY in these cases, never on a plain idle tick,
    // so script-driven FX actors (the intro sparkles run via
    // `animateActor`) are left alone.
    if (actor.isMoving) {
      applyChore(vm, actor, actor.walkFrame);
    } else if (wasMoving) {
      // Just stopped: re-point the directional limbs (esp. the head) for
      // the final facing — see applyStandPose / SCUMM-V5-COSTUME-ANIM.md
      // §"Head re-point".
      applyStandPose(vm, actor);
    } else if (actor.costume > 0 && actor.anim.animId === 0) {
      applyChore(vm, actor, actor.initFrame);
    }
  }
}

/**
 * Move `value` toward 0 by at most `magnitude`. Examples:
 *   clampToward(7, 8) → 7   (within speed, full step)
 *   clampToward(20, 8) → 8  (capped at speed)
 *   clampToward(-3, 8) → -3 (negative, within speed)
 */
function clampToward(value: number, magnitude: number): number {
  if (value > 0) return Math.min(value, magnitude);
  if (value < 0) return Math.max(value, -magnitude);
  return 0;
}
