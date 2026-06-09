/** Actor slots and the fixed-size actor table (ids 1..N; 0 = "no actor"). */

import type { AnimState } from '../graphics/costume-anim';

export type Facing = 'N' | 'E' | 'S' | 'W';

export type { AnimState } from '../graphics/costume-anim';

export interface Actor {
  readonly id: number;
  /** Owning room id. `0` = dormant / not in any room. */
  room: number;
  x: number;
  y: number;
  /** Y-offset added to `y` when compositing (used for floating objects). */
  elevation: number;
  /** Costume id; `0` = no costume assigned, actor skipped by the compositor. */
  costume: number;
  facing: Facing;
  visible: boolean;
  /** CLUT index used when the actor speaks. */
  talkColor: number;
  /**
   * Display name from `actorOps setActorName`; `''` = never named.
   * `getObjOrActorName` resolves a low id (< actor table size) to this.
   */
  name: string;
  /** Per-actor scale, 0..255 where 255 = 100%. */
  scale: number;
  /**
   * SCUMM's `_width`: a stored field set by `actorOps` — NOT the live
   * costume-frame width and NOT {@link drawBounds}. Read by `getActorWidth`
   * for the script-side interaction-proximity gate.
   */
  width: number;
  /** When true, the actor walks in straight lines ignoring walk boxes. */
  ignoreBoxes: boolean;
  /**
   * SCUMM's `_walkbox`: maintained as walk state during movement/placement,
   * NOT re-derived from pixel position at draw time. `-1` = unassigned;
   * retained as-is while `ignoreBoxes` is set.
   */
  walkBox: number;
  /**
   * SCUMM's `_forceClip`. Only `k>0` forces a fixed z-plane; `0` (cleared by
   * `neverZclip`) and `-1` (never set) both mean "not forced" — the compositor
   * derives the depth itself. See resolveActorZ in render/compositor.ts.
   */
  forceClip: number;
  /** Pixels per engine tick during a walk. */
  walkSpeedX: number;
  walkSpeedY: number;
  /** Final target of the active walk; `null` when not walking. */
  walkTarget: { x: number; y: number } | null;
  walkPath: ReadonlyArray<{ x: number; y: number }>;
  /** Index into `walkPath` of the *next* waypoint to head toward. */
  walkPathIdx: number;
  isMoving: boolean;
  /** Chore frames; anim record = frame*4 + dir. See pages/docs/scumm/costume-anim.md. */
  walkFrame: number;
  standFrame: number;
  initFrame: number;
  talkStartFrame: number;
  talkStopFrame: number;
  anim: AnimState;
  /**
   * Room-space box the compositor last drew this actor into (right/bottom
   * exclusive); `null` if not drawn last frame. Transient render output —
   * `actorFromPos` hit-tests clicks against it.
   */
  drawBounds: { left: number; top: number; right: number; bottom: number } | null;
}

const EMPTY_ANIM_STATE: AnimState = {
  animId: 0,
  stopped: 0,
  limbs: new Array(16).fill({
    active: false,
    start: 0,
    length: 0,
    noLoop: false,
    cursor: 0,
    finished: false,
  }),
};

// SCUMM defaults: 8 px/tick horizontal, 2 vertical.
export const DEFAULT_WALK_SPEED_X = 8;
export const DEFAULT_WALK_SPEED_Y = 2;
export const DEFAULT_SCALE = 0xff;
// 24 = the width MI1 assigns to ego and normal-size NPCs via actorOps.
export const DEFAULT_ACTOR_WIDTH = 24;

// SCUMM's initActor chore-frame defaults.
export const DEFAULT_INIT_FRAME = 1;
export const DEFAULT_WALK_FRAME = 2;
export const DEFAULT_STAND_FRAME = 3;
export const DEFAULT_TALK_START_FRAME = 4;
export const DEFAULT_TALK_STOP_FRAME = 5;

export function createActor(id: number): Actor {
  return {
    id,
    room: 0,
    x: 0,
    y: 0,
    elevation: 0,
    costume: 0,
    facing: 'S',
    visible: true,
    talkColor: 0,
    name: '',
    scale: DEFAULT_SCALE,
    width: DEFAULT_ACTOR_WIDTH,
    ignoreBoxes: false,
    walkBox: -1,
    forceClip: -1,
    walkSpeedX: DEFAULT_WALK_SPEED_X,
    walkSpeedY: DEFAULT_WALK_SPEED_Y,
    walkTarget: null,
    walkPath: [],
    walkPathIdx: 0,
    isMoving: false,
    walkFrame: DEFAULT_WALK_FRAME,
    standFrame: DEFAULT_STAND_FRAME,
    initFrame: DEFAULT_INIT_FRAME,
    talkStartFrame: DEFAULT_TALK_START_FRAME,
    talkStopFrame: DEFAULT_TALK_STOP_FRAME,
    anim: EMPTY_ANIM_STATE,
    drawBounds: null,
  };
}

/** Position/room only — does not change costume, facing, or anim; cancels any in-flight walk. */
export function putActor(actor: Actor, x: number, y: number, room: number): void {
  actor.x = x | 0;
  actor.y = y | 0;
  actor.room = room | 0;
  actor.walkTarget = null;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.isMoving = false;
}

/** Resets anim state so the new costume doesn't reuse the old costume's frame indices. */
export function setActorCostume(actor: Actor, costumeId: number): void {
  actor.costume = costumeId | 0;
  actor.anim = EMPTY_ANIM_STATE;
}

/** Slot 0 is the "no actor" sentinel; reading it throws. */
export class ActorTable {
  private readonly slots: Actor[];

  constructor(public readonly capacity: number) {
    if (capacity < 1) throw new Error(`actor table capacity must be ≥ 1`);
    this.slots = [];
    for (let i = 0; i <= capacity; i++) this.slots.push(createActor(i));
  }

  get(id: number): Actor {
    if (id <= 0 || id > this.capacity) {
      throw new Error(`actor id ${id} out of range (1..${this.capacity})`);
    }
    return this.slots[id]!;
  }

  /** Includes dormant (room=0) slots — caller filters. */
  *all(): IterableIterator<Actor> {
    for (let i = 1; i <= this.capacity; i++) yield this.slots[i]!;
  }

  /** Visible actors in the room, in id order. */
  inRoom(roomId: number): Actor[] {
    const out: Actor[] = [];
    for (let i = 1; i <= this.capacity; i++) {
      const a = this.slots[i]!;
      if (a.room === roomId && a.visible) out.push(a);
    }
    return out;
  }

  reset(): void {
    for (let i = 0; i <= this.capacity; i++) {
      this.slots[i] = createActor(i);
    }
  }
}

/** Matches MI1 — the .000 MAXS block doesn't carry an actor count. */
export const DEFAULT_ACTOR_COUNT = 13;
