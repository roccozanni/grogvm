import { describe, expect, it } from 'vitest';
import { ActorTable, createActor, DEFAULT_WALK_SPEED_X, DEFAULT_WALK_SPEED_Y } from './actor';
import { stepAllActorWalks, stepWalk } from './walk';

function walkingActor(opts: {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  speedX?: number;
  speedY?: number;
}): ReturnType<typeof createActor> {
  const a = createActor(1);
  a.x = opts.x;
  a.y = opts.y;
  a.walkTarget = { x: opts.targetX, y: opts.targetY };
  a.isMoving = true;
  if (opts.speedX !== undefined) a.walkSpeedX = opts.speedX;
  if (opts.speedY !== undefined) a.walkSpeedY = opts.speedY;
  return a;
}

describe('stepWalk', () => {
  it('moves toward the target by walkSpeed in one tick', () => {
    const a = walkingActor({ x: 0, y: 0, targetX: 100, targetY: 50 });
    stepWalk(a);
    // Default speeds: 8 horizontal, 2 vertical.
    expect(a.x).toBe(DEFAULT_WALK_SPEED_X);
    expect(a.y).toBe(DEFAULT_WALK_SPEED_Y);
    expect(a.isMoving).toBe(true);
  });

  it('clamps the step to the remaining distance so we land exactly on target', () => {
    const a = walkingActor({ x: 0, y: 0, targetX: 3, targetY: 1 });
    stepWalk(a);
    // Distance < walkSpeed in both axes → step exactly to target.
    expect(a.x).toBe(3);
    expect(a.y).toBe(1);
    expect(a.walkTarget).toBeNull();
    expect(a.isMoving).toBe(false);
  });

  it('arrives in the expected number of ticks for a clean diagonal', () => {
    // 24 px X (= 3 × speedX=8), 6 px Y (= 3 × speedY=2). 3 ticks → arrived.
    const a = walkingActor({ x: 0, y: 0, targetX: 24, targetY: 6 });
    stepWalk(a); expect(a.x).toBe(8); expect(a.y).toBe(2);
    stepWalk(a); expect(a.x).toBe(16); expect(a.y).toBe(4);
    stepWalk(a); expect(a.x).toBe(24); expect(a.y).toBe(6);
    expect(a.isMoving).toBe(false);
    expect(a.walkTarget).toBeNull();
  });

  it('handles negative deltas (walking left / up)', () => {
    const a = walkingActor({ x: 100, y: 50, targetX: 80, targetY: 44 });
    stepWalk(a);
    expect(a.x).toBe(100 - DEFAULT_WALK_SPEED_X);
    expect(a.y).toBe(50 - DEFAULT_WALK_SPEED_Y);
    expect(a.facing).toBe('W');
  });

  it('faces east when moving right, west when moving left', () => {
    const right = walkingActor({ x: 0, y: 0, targetX: 100, targetY: 0 });
    stepWalk(right);
    expect(right.facing).toBe('E');

    const left = walkingActor({ x: 100, y: 0, targetX: 0, targetY: 0 });
    stepWalk(left);
    expect(left.facing).toBe('W');
  });

  it('faces south or north when vertical movement dominates this tick', () => {
    // Pure vertical: should face S/N.
    const down = walkingActor({ x: 0, y: 0, targetX: 0, targetY: 50 });
    stepWalk(down);
    expect(down.facing).toBe('S');

    const up = walkingActor({ x: 0, y: 50, targetX: 0, targetY: 0 });
    stepWalk(up);
    expect(up.facing).toBe('N');
  });

  it('prefers horizontal facing when the X step is at least as large as Y', () => {
    // walkSpeedX = walkSpeedY = 4 → equal step → choose E/W.
    const a = walkingActor({ x: 0, y: 0, targetX: 40, targetY: 40, speedX: 4, speedY: 4 });
    stepWalk(a);
    expect(a.x).toBe(4);
    expect(a.y).toBe(4);
    expect(a.facing).toBe('E');
  });

  it('is a no-op when isMoving is false', () => {
    const a = createActor(1);
    a.x = 10;
    a.y = 10;
    a.walkTarget = { x: 100, y: 100 };
    a.isMoving = false;
    stepWalk(a);
    expect(a.x).toBe(10);
    expect(a.y).toBe(10);
  });

  it('is a no-op when walkTarget is null', () => {
    const a = createActor(1);
    a.x = 10;
    a.y = 10;
    a.walkTarget = null;
    a.isMoving = true;
    stepWalk(a);
    expect(a.x).toBe(10);
    expect(a.y).toBe(10);
    expect(a.isMoving).toBe(true); // we only flip on arrival
  });

  it('cleans up state when called at the target', () => {
    const a = walkingActor({ x: 50, y: 50, targetX: 50, targetY: 50 });
    stepWalk(a);
    expect(a.isMoving).toBe(false);
    expect(a.walkTarget).toBeNull();
    expect(a.walkPath).toHaveLength(0);
  });
});

describe('stepAllActorWalks', () => {
  it('ticks every actor in the table independently', () => {
    const vm = { actors: new ActorTable(3) } as unknown as Parameters<typeof stepAllActorWalks>[0];
    const a1 = vm.actors.get(1);
    const a2 = vm.actors.get(2);
    const a3 = vm.actors.get(3);

    a1.x = 0; a1.y = 0; a1.walkTarget = { x: 16, y: 0 }; a1.isMoving = true;
    a2.x = 50; a2.y = 50; // not moving
    a3.x = 100; a3.y = 100; a3.walkTarget = { x: 100, y: 100 }; a3.isMoving = true; // at target

    stepAllActorWalks(vm);

    expect(a1.x).toBe(DEFAULT_WALK_SPEED_X);
    expect(a1.isMoving).toBe(true);
    expect(a2.x).toBe(50); // unchanged
    expect(a3.isMoving).toBe(false); // arrived
    expect(a3.walkTarget).toBeNull();
  });
});
