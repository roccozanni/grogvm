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

import type { Actor } from './actor';
import type { Vm } from '../vm/vm';
import { findPath } from '../pathfinding/grid';

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
  actor.walkPath = path.waypoints.slice(1);
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

  // Facing follows the dominant component of this tick's step.
  if (Math.abs(stepX) >= Math.abs(stepY) && stepX !== 0) {
    actor.facing = stepX > 0 ? 'E' : 'W';
  } else if (stepY !== 0) {
    actor.facing = stepY > 0 ? 'S' : 'N';
  }

  actor.x += stepX;
  actor.y += stepY;

  // Reached the waypoint? Advance (or finish).
  if (actor.x === aim.x && actor.y === aim.y) {
    if (!advanceWaypoint(actor)) finishWalk(actor);
  }
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
export function stepAllActorWalks(vm: Vm): void {
  for (const actor of vm.actors.all()) {
    stepWalk(actor);
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
