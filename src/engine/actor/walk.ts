/**
 * Straight-line walk stepping for actors.
 *
 * Each `stepWalk(actor)` call advances the actor toward its current
 * `walkTarget` by the per-actor `walkSpeedX` / `walkSpeedY` (default
 * 8 horizontal, 2 vertical — the SCUMM v5 default). Clamps the step
 * to the remaining distance so we never overshoot, snaps to the exact
 * target on arrival, and clears `walkTarget` + `isMoving` so the
 * actor stops cleanly.
 *
 * Facing follows the dominant component of *this tick's* movement —
 * E/W when the X step is larger, N/S otherwise. This matches the
 * standard SCUMM rule and reads naturally for diagonal walks (the
 * actor faces sideways until the path bends).
 *
 * # Why not path-based here
 *
 * Phase 6's pathfinding sub-task will populate `actor.walkPath` with
 * intermediate waypoints, and a follow-up to this module will pop
 * the next waypoint when the current one is reached. For now (no
 * pathfinding yet) the actor walks in a straight line from current
 * position to `walkTarget`, which is what the `walkActorTo` /
 * `walkActorToActor` opcodes set up.
 */

import type { Actor } from './actor';
import type { Vm } from '../vm/vm';

/**
 * Advance one actor one tick toward `walkTarget`. No-op when the
 * actor is not moving, has no target, or is already at the target.
 */
export function stepWalk(actor: Actor): void {
  if (!actor.isMoving || !actor.walkTarget) return;

  const dx = actor.walkTarget.x - actor.x;
  const dy = actor.walkTarget.y - actor.y;

  if (dx === 0 && dy === 0) {
    // Already at the target — just clean up state.
    actor.walkTarget = null;
    actor.walkPath = [];
    actor.walkPathIdx = 0;
    actor.isMoving = false;
    return;
  }

  // Step by walkSpeed, clamped to the remaining distance so we land
  // *on* the target and don't overshoot it.
  const stepX = clampToward(dx, actor.walkSpeedX);
  const stepY = clampToward(dy, actor.walkSpeedY);

  // Facing follows the dominant component of *this tick's* step.
  // |stepX| > |stepY| → E/W; otherwise N/S. Equal → prefer E/W
  // (the SCUMM v5 convention; horizontal walks read more naturally
  // since the costume walk anims are tied to L/R-facing limbs).
  if (Math.abs(stepX) >= Math.abs(stepY) && stepX !== 0) {
    actor.facing = stepX > 0 ? 'E' : 'W';
  } else if (stepY !== 0) {
    actor.facing = stepY > 0 ? 'S' : 'N';
  }

  actor.x += stepX;
  actor.y += stepY;

  if (actor.x === actor.walkTarget.x && actor.y === actor.walkTarget.y) {
    actor.walkTarget = null;
    actor.walkPath = [];
    actor.walkPathIdx = 0;
    actor.isMoving = false;
  }
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
