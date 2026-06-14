import { describe, expect, it } from 'vitest';
import { ActorTable, createActor } from './actor';
import { applyStandPose, startWalk, stepAllActorWalks, stepWalk, rescaleActorForPosition } from './walk';
import { currentLimbPicture } from '../graphics/costume-anim';
import type { CostumeHeader } from '../graphics/costume';

describe('startWalk — off-screen box targets', () => {
  // A floor box that extends off the left screen edge (x -25..120), like
  // MI1 room 78's exit box. Box id 0 (== array index) so the matrix is moot.
  const box = {
    id: 0, ulx: -25, uly: 90, urx: 120, ury: 90, lrx: 120, lry: 99, llx: -25, lly: 99,
    mask: 1, flags: 0, scale: 0,
  };
  function vm(): Parameters<typeof startWalk>[0] {
    return {
      actors: new ActorTable(3),
      boxFlagOverrides: new Map(),
      loadedRoom: { id: 78, width: 120, height: 100, walkBoxes: [box], boxMatrix: [[]], scaleSlots: [] },
    } as unknown as Parameters<typeof startWalk>[0];
  }

  it('walks all the way to an off-screen target inside a visible box', () => {
    // Regression (MI1 room 78 "can't exit"): the exit walk-to point sits at
    // x=-25, off-screen. The box-graph router walks in box space, so a target
    // inside a visible box is reached exactly (clamped into the box, which is
    // a no-op here since it's already inside) — 25px past the screen edge, so
    // the exit's 16px proximity gate fires.
    const v = vm();
    const a = v.actors.get(1);
    a.x = 60; a.y = 95;
    startWalk(v as never, a, { x: -25, y: 95 });
    const last = a.walkPath[a.walkPath.length - 1];
    expect(last).toEqual({ x: -25, y: 95 });
  });

  it('clamps a target that lies outside every visible box into the dest box', () => {
    const v = vm();
    const a = v.actors.get(1);
    a.x = 60; a.y = 95;
    // (-25, 5) is outside the box (box is y 90..99) → SCUMM clamps it to the
    // nearest in-box point (-25, 90), not the raw request.
    startWalk(v as never, a, { x: -25, y: 5 });
    const last = a.walkPath[a.walkPath.length - 1];
    expect(last).toEqual({ x: -25, y: 90 });
  });

  it('does not flag movement when the target is the actor’s own spot (SCUMM startWalkActor early-out)', () => {
    // Regression (MI1 LeChuck finale): walking to an object you’re already
    // standing on (the root beer at ego’s feet) must NOT register as movement,
    // or a "fire the moment ego moves" gate (punch trigger #125) reads the
    // one-frame phantom and pre-empts the action. Scripts run before the walk
    // step each frame, so the actor must already read as at-rest here.
    const v = vm();
    const a = v.actors.get(1);
    a.x = 60; a.y = 95; a.isMoving = false;
    startWalk(v as never, a, { x: 60, y: 95 });
    expect(a.isMoving).toBe(false);
    expect(a.walkTarget).toBeNull();
    expect(a.walkPath).toEqual([]);
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
  it('moves along the line toward the target in one tick', () => {
    const a = walkingActor({ x: 0, y: 0, targetX: 100, targetY: 50 });
    stepWalk(a);
    // The line is Y-dominant (slope 1/2 > speedY/speedX = 2/8): Y runs at
    // full speed 2, X proportionally at 4 — NOT at its full speed 8, which
    // would leave the line.
    expect(a.x).toBe(4);
    expect(a.y).toBe(2);
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
    // Y-dominant line (6 down-left per 20 across): Y at full speed 2,
    // X at 20/6 · 2 ≈ 6.67 px/tick — 93.33, floored to 93.
    expect(a.x).toBe(93);
    expect(a.y).toBe(48);
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
    // Tick 2: reach (16, 0), advance to the next waypoint.
    stepWalk(a);
    expect(a.x).toBe(16); expect(a.y).toBe(0);
    expect(a.walkPathIdx).toBe(1);
    // Ticks 3-4: down toward (16, 4) at 2 px/tick.
    stepWalk(a);
    expect(a.x).toBe(16); expect(a.y).toBe(2);
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

describe('stepWalk — line following (calcMovementFactor)', () => {
  it('stays ON a thin near-horizontal diagonal, never drifting off the line', () => {
    // The room-52 bridge shape: a degenerate connector line from (0,100) to
    // (80,90). Independent X/Y stepping spends the 10px of Y in 5 ticks and
    // then walks level at y=90 — up to 5px off the line, so the box assigned
    // from the position leaves the connector. Line-following holds the actor
    // on the line every tick: X clamps to full speed 8, Y follows at 1.
    const a = walkingActor({ x: 0, y: 100, targetX: 80, targetY: 90 });
    for (let i = 0; i < 20 && a.isMoving; i++) {
      stepWalk(a);
      const lineY = 100 - a.x / 8;
      expect(Math.abs(a.y - lineY)).toBeLessThanOrEqual(1);
    }
    expect(a.isMoving).toBe(false);
    expect(a.x).toBe(80);
    expect(a.y).toBe(90);
  });

  it('accumulates sub-pixel remainders and lands exactly on the target', () => {
    // (0,0)→(100,30): X moves at 100/30 · 2 ≈ 6.67 px/tick — not a whole
    // pixel, so the fraction must carry tick to tick (6, then 13, …) and the
    // final overshoot pin lands the actor exactly on the waypoint.
    const a = walkingActor({ x: 0, y: 0, targetX: 100, targetY: 30 });
    stepWalk(a);
    expect(a.x).toBe(6);
    stepWalk(a);
    expect(a.x).toBe(13);
    for (let i = 0; i < 20 && a.isMoving; i++) stepWalk(a);
    expect(a.isMoving).toBe(false);
    expect(a.x).toBe(100);
    expect(a.y).toBe(30);
  });

  it('re-derives the leg per waypoint, so each segment follows its own line', () => {
    // Two legs with opposite dominance: a long horizontal run, then a long
    // vertical drop. The first leg must not inherit the second's slope.
    const a = createActor(1);
    a.x = 0; a.y = 0;
    a.walkPath = [
      { x: 32, y: 4 },  // X-dominant: steps (8, 1)
      { x: 32, y: 24 }, // pure vertical: steps (0, 2)
    ];
    a.walkPathIdx = 0;
    a.isMoving = true;
    stepWalk(a);
    expect(a.x).toBe(8); expect(a.y).toBe(1);
    for (let i = 0; i < 8 && a.walkPathIdx === 0; i++) stepWalk(a);
    expect(a.x).toBe(32); expect(a.y).toBe(4);
    stepWalk(a);
    expect(a.x).toBe(32); expect(a.y).toBe(6);
  });

  it('throttles the step by the actor scale (a far-away actor walks slower)', () => {
    // Scale 64 ≈ drawn at 1/4 size → the nominal 8 px/tick horizontal step
    // becomes 8 × 64/255 ≈ 2 px/tick. This is what keeps ego from racing
    // across far-view rooms like the store street (room 34, box scales
    // 33..75).
    const a = walkingActor({ x: 0, y: 0, targetX: 80, targetY: 0 });
    a.scale = 64;
    stepWalk(a);
    expect(a.x).toBe(2);
    for (let i = 0; i < 9; i++) stepWalk(a);
    expect(a.x).toBe(20); // 10 ticks × 2 px — a full-size actor would be at ~79
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

    expect(a1.x).toBe(8);
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

describe('rescaleActorForPosition — placement rescale', () => {
  function vmInRoom(boxScale: number): Parameters<typeof rescaleActorForPosition>[0] {
    const box = {
      id: 0, ulx: 0, uly: 0, urx: 100, ury: 0, lrx: 100, lry: 100, llx: 0, lly: 100,
      mask: 0, flags: 0, scale: boxScale,
    };
    return {
      currentRoom: 1,
      loadedRoom: { walkBoxes: [box], scaleSlots: [] },
    } as unknown as Parameters<typeof rescaleActorForPosition>[0];
  }

  it('rescales a STANDING actor at placement (the room-change "big ego" bug)', () => {
    // The bug: ego placed in a far-view room renders at a stale full-size
    // scale until it starts walking. Placement must rescale immediately,
    // without isMoving ever being set.
    const vm = vmInRoom(210);
    const a = createActor(1);
    a.room = 1; a.x = 50; a.y = 50; a.scale = 255; a.isMoving = false;
    rescaleActorForPosition(vm, a);
    expect(a.scale).toBe(210);
  });

  it('is a no-op when the actor is not in the loaded room', () => {
    const vm = vmInRoom(210);
    const a = createActor(1);
    a.room = 2; a.x = 50; a.y = 50; a.scale = 137; // a different room
    rescaleActorForPosition(vm, a);
    expect(a.scale).toBe(137); // untouched — wrong room's boxes don't apply
  });

  it('leaves an ignoreBoxes actor at its script-set scale (cannon-flight dot)', () => {
    // The flight actor (room 51 actor 11) is `ignoreBoxes; scale 255,255` and
    // arcs to the top of the room, where the box scale slot interpolates tiny.
    // An off-grid actor must NOT be position-rescaled or it shrinks to a dot.
    const vm = vmInRoom(20); // a box scale that would otherwise shrink it
    const a = createActor(1);
    a.room = 1; a.x = 50; a.y = 50; a.scale = 255; a.ignoreBoxes = true;
    rescaleActorForPosition(vm, a);
    expect(a.scale).toBe(255); // unchanged — ignoreBoxes keeps the set scale
  });
});

describe('applyStandPose — rest head tracks facing', () => {
  // Regression (was confirmed end-to-end on the real ego costume, now
  // synthetic): the head limb must re-point to the current facing AT REST.
  // The stand/walk chores only stop/un-stop the head — only the INIT pose
  // carries the head's per-direction frame — so a stand must re-seed the head
  // via init (applyStandPose runs init *then* stand). Before the fix a turned
  // actor kept a stale head (e.g. a front-facing head while facing west).
  //
  // Fixture: a costume whose init pose (chore 1) points the head limb (1) at a
  // DISTINCT frame per direction; the stand pose (chore 3) has no record (a
  // no-op here). The cmd stream sits at payload[0], so a limb's `start` equals
  // its frame index. (Layout mirrors costume-anim.test.ts's packAnim/makeHeader.)
  const HEAD_FRAME = { W: 8, E: 10, S: 12, N: 14 } as const; // distinct per dir
  function headCostume(): { header: CostumeHeader; payload: Uint8Array } {
    const payload = new Uint8Array(80);
    // A picture byte at each head frame (avoid the cmd bytes 0x79/0x7a).
    payload[HEAD_FRAME.W] = 0x21; payload[HEAD_FRAME.E] = 0x22;
    payload[HEAD_FRAME.S] = 0x23; payload[HEAD_FRAME.N] = 0x24;
    // An anim record naming limb 1 (mask bit 1<<14 → LE 00 40) at frame `fi`, length 2.
    const rec = (fi: number): number[] => [0x00, 0x40, fi & 0xff, (fi >> 8) & 0xff, 0x01];
    const POS = { W: 30, E: 40, S: 50, N: 60 } as const;
    payload.set(rec(HEAD_FRAME.W), POS.W); payload.set(rec(HEAD_FRAME.E), POS.E);
    payload.set(rec(HEAD_FRAME.S), POS.S); payload.set(rec(HEAD_FRAME.N), POS.N);
    // animOffsets store position+6 (decoder applies COSTUME_OFFSET_ADJUST = -6).
    // init pose = chore 1 → animIds 4..7 (chore*4 + dir; dir W0 E1 S2 N3).
    const animOffsets = new Array(16).fill(0);
    animOffsets[4] = POS.W + 6; animOffsets[5] = POS.E + 6;
    animOffsets[6] = POS.S + 6; animOffsets[7] = POS.N + 6;
    const header: CostumeHeader = {
      numAnim: 16, format: 0x58, paletteSize: 16, palette: new Uint8Array(16),
      animCmdOffset: 6, // cmdBase = 6 + (-6) = 0 → a limb's start == its frame index
      limbOffsets: new Array(16).fill(0), animOffsets, mirrorFlag: false,
    };
    return { header, payload };
  }

  it('re-points the head limb to a distinct frame for each facing', () => {
    const cost = headCostume();
    const vm = {
      actors: new ActorTable(3),
      getCostume: () => cost,
    } as unknown as Parameters<typeof applyStandPose>[0];
    const a = vm.actors.get(1);
    a.costume = 1;

    const headAt = (facing: 'W' | 'E' | 'S' | 'N') => {
      a.facing = facing;
      applyStandPose(vm, a);
      const l1 = a.anim.limbs[1]!;
      return {
        start: l1.start,
        active: l1.active,
        stopped: ((a.anim.stopped >> 1) & 1) === 1,
        pic: currentLimbPicture(a.anim, 1, cost.payload),
      };
    };

    const w = headAt('W'), e = headAt('E'), s = headAt('S'), n = headAt('N');

    // The head is drawn (active, un-stopped, a real picture) in every facing.
    for (const h of [w, e, s, n]) {
      expect(h.active).toBe(true);
      expect(h.stopped).toBe(false);
      expect(h.pic).toBeGreaterThanOrEqual(0);
    }
    // The crux: front/side/back are DISTINCT head frames — before the fix a
    // turned actor kept whatever frame the previous facing left.
    expect(s.start).not.toBe(w.start);
    expect(n.start).not.toBe(w.start);
    expect(n.start).not.toBe(s.start);
  });
});
