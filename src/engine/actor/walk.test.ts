import { describe, expect, it } from 'vitest';
import { ActorTable, createActor, DEFAULT_WALK_SPEED_X, DEFAULT_WALK_SPEED_Y } from './actor';
import { startWalk, stepAllActorWalks, stepWalk } from './walk';
import { buildWalkableMask } from '../pathfinding/mask';

describe('startWalk — off-mask box targets', () => {
  // A floor box that extends off the left screen edge (x -25..120), like
  // MI1 room 78's exit box. The walkable mask only covers [0,width).
  const W = 120, H = 100;
  const box = {
    id: 1, ulx: -25, uly: 90, urx: 120, ury: 90, lrx: 120, lry: 99, llx: -25, lly: 99,
    mask: 1, flags: 0, scale: 0,
  };
  function vm(): Parameters<typeof startWalk>[0] {
    const mask = buildWalkableMask([box], W, H);
    return {
      actors: new ActorTable(3),
      loadedRoom: { id: 78, width: W, height: H, walkBoxes: [box], walkableMask: mask, scaleSlots: [] },
    } as unknown as Parameters<typeof startWalk>[0];
  }

  it('walks all the way to an off-mask target inside a visible box', () => {
    // Regression (MI1 room 78 "can't exit"): the exit walk-to point sits at
    // x=-25, off the rasterized mask. Without extending the path the ego
    // stops at the screen edge (x=0), 25px short of the 16px proximity gate
    // → "non riesco ad arrivarci". The true target must be appended.
    const v = vm();
    const a = v.actors.get(1);
    a.x = 60; a.y = 95;
    startWalk(v as never, a, { x: -25, y: 95 });
    const last = a.walkPath[a.walkPath.length - 1];
    expect(last).toEqual({ x: -25, y: 95 });
  });

  it('does NOT append a target that lies outside every visible box', () => {
    const v = vm();
    const a = v.actors.get(1);
    a.x = 60; a.y = 95;
    // (-25, 5) is off-mask AND outside the box (box is y 90..99) → no append.
    startWalk(v as never, a, { x: -25, y: 5 });
    const last = a.walkPath[a.walkPath.length - 1];
    expect(last).not.toEqual({ x: -25, y: 5 });
  });
});

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

  it('faces the local path direction (lookahead), not the far-off final target', () => {
    // Path goes straight DOWN, then turns RIGHT — like room 33's cliff → dock.
    // Aiming at the final target (40,40) is a down-right tie → would face E the
    // whole descent; the lookahead aims at the next waypoint (0,40) → S.
    const a = createActor(1);
    a.x = 0;
    a.y = 0;
    a.walkPath = [
      { x: 0, y: 40 }, // descend
      { x: 40, y: 40 }, // then east along the "dock"
    ];
    a.walkPathIdx = 0;
    a.walkTarget = { x: 40, y: 40 };
    a.isMoving = true;
    a.walkSpeedX = 2;
    a.walkSpeedY = 2;

    stepWalk(a);
    expect(a.facing).toBe('S'); // descending — faces south, not the eastern target

    // Walk down to the corner, then one step along the horizontal leg.
    for (let i = 0; i < 40 && a.walkPathIdx === 0; i++) stepWalk(a);
    stepWalk(a);
    expect(a.facing).toBe('E'); // now heading east along the dock leg
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

  it('stops the actor when isMoving=true but neither walkPath nor walkTarget is set', () => {
    const a = createActor(1);
    a.x = 10;
    a.y = 10;
    a.walkTarget = null;
    a.walkPath = [];
    a.isMoving = true;
    stepWalk(a);
    expect(a.x).toBe(10);
    expect(a.y).toBe(10);
    expect(a.isMoving).toBe(false); // nothing to aim at → stop cleanly
  });

  it('cleans up state when called at the target', () => {
    const a = walkingActor({ x: 50, y: 50, targetX: 50, targetY: 50 });
    stepWalk(a);
    expect(a.isMoving).toBe(false);
    expect(a.walkTarget).toBeNull();
    expect(a.walkPath).toHaveLength(0);
  });
});

describe('stepWalk — path following', () => {
  it('walks each waypoint of walkPath in order', () => {
    const a = createActor(1);
    a.x = 0; a.y = 0;
    a.walkPath = [
      { x: 16, y: 0 },  // first waypoint
      { x: 16, y: 4 },  // second
    ];
    a.walkPathIdx = 0;
    a.isMoving = true;
    // Tick 1: from (0, 0) toward (16, 0) — step is (8, 0).
    stepWalk(a);
    expect(a.x).toBe(8); expect(a.y).toBe(0);
    expect(a.walkPathIdx).toBe(0);
    // Tick 2: reach (16, 0), advance to next waypoint immediately.
    stepWalk(a);
    expect(a.x).toBe(16); expect(a.y).toBe(0);
    expect(a.walkPathIdx).toBe(1);
    // Tick 3: from (16, 0) toward (16, 4) — step is (0, 2).
    stepWalk(a);
    expect(a.x).toBe(16); expect(a.y).toBe(2);
    // Tick 4: reach (16, 4), path done.
    stepWalk(a);
    expect(a.x).toBe(16); expect(a.y).toBe(4);
    expect(a.isMoving).toBe(false);
    expect(a.walkPath).toHaveLength(0);
  });

  it('falls back to walkTarget when walkPath is empty (straight-line walk)', () => {
    const a = createActor(1);
    a.x = 0; a.y = 0;
    a.walkPath = [];
    a.walkTarget = { x: 24, y: 0 };
    a.isMoving = true;
    stepWalk(a);
    expect(a.x).toBe(8);
    stepWalk(a);
    expect(a.x).toBe(16);
    stepWalk(a);
    expect(a.x).toBe(24);
    expect(a.isMoving).toBe(false);
  });

  it('handles a single-waypoint path (just walk to it and stop)', () => {
    const a = createActor(1);
    a.x = 0; a.y = 0;
    a.walkPath = [{ x: 8, y: 0 }];
    a.walkPathIdx = 0;
    a.isMoving = true;
    stepWalk(a);
    expect(a.x).toBe(8); expect(a.y).toBe(0);
    expect(a.isMoving).toBe(false);
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

  // ── walk/stand chore trigger ──────────────────────────────────────
  // A stub costume whose anim offsets are all 0 is enough: startAnim
  // records the requested animId (= chore*4 + dir) even when it finds no
  // record, so we can assert the mapping without decoding real frames.
  const stubCostume = {
    header: {
      numAnim: 32, format: 0x58, paletteSize: 16 as const, palette: new Uint8Array(16),
      animCmdOffset: 0, limbOffsets: new Array(16).fill(0), animOffsets: new Array(32).fill(0),
      mirrorFlag: false,
    },
    payload: new Uint8Array(0),
  };
  function vmWithCostume(): Parameters<typeof stepAllActorWalks>[0] {
    return { actors: new ActorTable(3), getCostume: () => stubCostume } as unknown as Parameters<typeof stepAllActorWalks>[0];
  }

  it('drives the walk chore (walkFrame*4 + dir) while moving', () => {
    const vm = vmWithCostume();
    const a = vm.actors.get(1);
    a.costume = 1; a.x = 0; a.y = 0; a.walkTarget = { x: 200, y: 0 }; a.isMoving = true;
    stepAllActorWalks(vm);
    expect(a.facing).toBe('E');
    expect(a.anim.animId).toBe(9); // walkFrame 2 * 4 + dir E(1)
  });

  it('switches to the stand chore on arrival', () => {
    const vm = vmWithCostume();
    const a = vm.actors.get(1);
    a.costume = 1; a.x = 0; a.y = 0; a.walkTarget = { x: 0, y: -1 }; a.isMoving = true;
    stepAllActorWalks(vm); // steps north and arrives this tick
    expect(a.isMoving).toBe(false);
    expect(a.facing).toBe('N');
    expect(a.anim.animId).toBe(15); // standFrame 3 * 4 + dir N(3)
  });

  it('seeds the init pose once for an idle actor with a costume', () => {
    const vm = vmWithCostume();
    const a = vm.actors.get(1);
    a.costume = 1; a.x = 10; a.y = 10; // idle, never animated (animId 0)
    stepAllActorWalks(vm);
    expect(a.anim.animId).toBe(6); // initFrame 1 * 4 + dir S(2) (default facing S)
  });

  it('does not clobber a script-driven anim on an idle FX actor', () => {
    const vm = vmWithCostume();
    const a = vm.actors.get(1);
    a.costume = 1; a.x = 10; a.y = 10;
    a.anim = { ...a.anim, animId: 2 }; // a sparkle anim set via animateActor
    stepAllActorWalks(vm);
    expect(a.anim.animId).toBe(2); // untouched (already non-zero, not moving)
  });
});

describe('stepAllActorWalks — perspective scale', () => {
  function vmInRoom(boxScale: number): Parameters<typeof stepAllActorWalks>[0] {
    const box = {
      id: 0, ulx: 0, uly: 0, urx: 100, ury: 0, lrx: 100, lry: 100, llx: 0, lly: 100,
      mask: 0, flags: 0, scale: boxScale,
    };
    return {
      actors: new ActorTable(3),
      currentRoom: 1,
      loadedRoom: { walkBoxes: [box], scaleSlots: [] },
    } as unknown as Parameters<typeof stepAllActorWalks>[0];
  }

  it('sets a moving actor to the box direct scale', () => {
    const vm = vmInRoom(210);
    const a = vm.actors.get(1);
    a.room = 1; a.x = 50; a.y = 50; a.scale = 255;
    a.walkTarget = { x: 60, y: 50 }; a.isMoving = true; a.walkSpeedX = 2;
    stepAllActorWalks(vm);
    expect(a.scale).toBe(210);
  });

  it('RESETS a moving actor to full size in a non-scaled box (no stuck scale)', () => {
    const vm = vmInRoom(0); // box specifies no scaling
    const a = vm.actors.get(1);
    a.room = 1; a.x = 50; a.y = 50; a.scale = 100; // stuck small from a prior room
    a.walkTarget = { x: 60, y: 50 }; a.isMoving = true; a.walkSpeedX = 2;
    stepAllActorWalks(vm);
    expect(a.scale).toBe(255); // reset to DEFAULT_SCALE, not left at 100
  });
});
