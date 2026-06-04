/**
 * Actor model for SCUMM v5 — the in-memory representation of every
 * walking character the VM can manipulate (Guybrush, NPCs, …).
 *
 * SCUMM addresses actors by a small integer id (1..N; 0 is the
 * "no actor" sentinel). The engine holds a fixed-size table of slots
 * allocated at boot. Most actor opcodes target an actor by id and
 * read or mutate the slot.
 *
 * # Lifecycle
 *
 * An actor "exists" when its `room` is non-zero. Scripts call
 * `putActor(id, x, y, room)` to place an actor in a room, and the
 * compositor only renders actors whose `room === currentRoom`. A
 * `room = 0` slot is dormant but its other fields persist (costume,
 * facing, etc.), so re-placing the actor restores its appearance.
 *
 * # What's not here yet
 *
 * - **Anim state** — Phase 6.2 lands per-limb playback. We carry an
 *   `anim` field now so call sites compile, but `compositor.ts`
 *   reads the costume's frame index directly for Phase 6.4 and
 *   `walk.ts` (Phase 6.6) updates `anim` to the walk anim id when
 *   the actor starts moving.
 * - **Walk path / pathfinding integration** — slots for the planned
 *   path live on the actor (`walkPath`, `walkPathIdx`, `isMoving`,
 *   `walkTarget`) but stepping them is Phase 6.6.
 */

import type { AnimState } from '../graphics/costume-anim';

export type Facing = 'N' | 'E' | 'S' | 'W';

/** Re-export so callers can name actor.anim's type without two imports. */
export type { AnimState } from '../graphics/costume-anim';

export interface Actor {
  /** Stable actor id (matches the table index for direct lookup). */
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
   * Display name from `actorOps setActorName` (subop 0x0d), control
   * sequences stripped. `''` = never named. SCUMM's `getObjOrActorName`
   * resolves a low id (< actor table size) to the actor's name, so the
   * look-at / sentence line shows this for a script-renamed actor (e.g.
   * "Fratelli Fettucini"). Persists across rooms and saves, like SCUMM's
   * `_actors[id].name`.
   */
  name: string;
  /** Per-actor scale, 0..255 where 255 = 100%. SCUMM scales actors as they walk away. */
  scale: number;
  /** When true, the actor walks in straight lines ignoring walk boxes. */
  ignoreBoxes: boolean;
  /**
   * Z-plane clip control, from `actorOps` `neverZclip` (0x12) /
   * `alwaysZclip` (0x13). Mirrors SCUMM's `_forceClip`:
   *   - `k>0` = `alwaysZclip k` — clipped behind z-plane `k` (and above).
   *   - `0`   = `neverZclip` — *clears* the forced clip ("not forced").
   *   - `-1`  = never set (also "not forced"; our extra sentinel).
   * `0` and `-1` are equivalent: the compositor derives the depth from the
   * NeverClip class (→ front) or the walk-box mask. Only `k>0` forces a
   * fixed plane. See resolveActorZ in render/compositor.ts.
   */
  forceClip: number;
  /** Pixels per engine tick during a walk. */
  walkSpeedX: number;
  walkSpeedY: number;
  /** Final target of the active walk; `null` when not walking. */
  walkTarget: { x: number; y: number } | null;
  /** Planned path (waypoints, in order). Empty when idle. */
  walkPath: ReadonlyArray<{ x: number; y: number }>;
  /** Index into `walkPath` of the *next* waypoint to head toward. */
  walkPathIdx: number;
  isMoving: boolean;
  /**
   * Animation "chore" frames — the costume anim record for an action is
   * `frame * 4 + dir` (dir = `newDirToOldDir(facing)`: W=0, E=1, S=2,
   * N=3). Set by `actorOps`; defaults match SCUMM's `Actor::initActor`.
   * The engine plays `walkFrame` while moving and `standFrame` on
   * arrival, and seeds `initFrame` when the costume first appears.
   */
  walkFrame: number;
  standFrame: number;
  initFrame: number;
  talkStartFrame: number;
  talkStopFrame: number;
  /** Anim playback state — populated by `startAnim`, advanced by `stepAnim`. */
  anim: AnimState;
  /**
   * Room-space bounding box the compositor last drew this actor into
   * (the union of its limb frame extents; right/bottom exclusive), or
   * `null` if the actor wasn't drawn on the last frame. This is the
   * engine's stand-in for SCUMM's per-actor gfx-usage bits — `actorFromPos`
   * hit-tests clicks against it. Transient render output, not game state.
   */
  drawBounds: { left: number; top: number; right: number; bottom: number } | null;
}

/** Default empty AnimState — every limb inactive. */
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

/** Default per-actor walk speed (8 pixels horizontally, 2 vertically per tick) — SCUMM convention. */
export const DEFAULT_WALK_SPEED_X = 8;
export const DEFAULT_WALK_SPEED_Y = 2;
export const DEFAULT_SCALE = 0xff;

// SCUMM `Actor::initActor` chore-frame defaults. Record = frame*4 + dir.
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
    ignoreBoxes: false,
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

/**
 * Place an actor at `(x, y)` in `room`. Does not change costume,
 * facing, or anim — just position. Mirrors the SCUMM `putActor`
 * opcode's behaviour.
 */
export function putActor(actor: Actor, x: number, y: number, room: number): void {
  actor.x = x | 0;
  actor.y = y | 0;
  actor.room = room | 0;
  // Placing also cancels any in-flight walk.
  actor.walkTarget = null;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.isMoving = false;
}

/**
 * Assign a costume to the actor. Resets per-limb anim state so the
 * new costume's anims start clean rather than reusing the old
 * costume's frame indices.
 */
export function setActorCostume(actor: Actor, costumeId: number): void {
  actor.costume = costumeId | 0;
  actor.anim = EMPTY_ANIM_STATE;
}

/**
 * Bounded N-slot actor table. SCUMM v5 historically uses 13 slots
 * (1..12 + slot 0 as the "no actor" sentinel). We expose
 * `actors[id]` for direct lookup; reading `actors[0]` is a
 * programming error and throws.
 */
export class ActorTable {
  /** Array of slots. `actors[id]` is the actor with id `id`. Index 0 is a hole. */
  private readonly slots: Actor[];

  constructor(public readonly capacity: number) {
    if (capacity < 1) throw new Error(`actor table capacity must be ≥ 1`);
    this.slots = [];
    // Slot 0 is the sentinel "no actor".
    for (let i = 0; i <= capacity; i++) this.slots.push(createActor(i));
  }

  /** Returns the actor with the given id. Throws on id 0 or out-of-range. */
  get(id: number): Actor {
    if (id <= 0 || id > this.capacity) {
      throw new Error(`actor id ${id} out of range (1..${this.capacity})`);
    }
    return this.slots[id]!;
  }

  /** Iterate every populated actor (id ≥ 1). Includes dormant slots — caller decides. */
  *all(): IterableIterator<Actor> {
    for (let i = 1; i <= this.capacity; i++) yield this.slots[i]!;
  }

  /** Actors currently placed in the given room id, in id order. */
  inRoom(roomId: number): Actor[] {
    const out: Actor[] = [];
    for (let i = 1; i <= this.capacity; i++) {
      const a = this.slots[i]!;
      if (a.room === roomId && a.visible) out.push(a);
    }
    return out;
  }

  /** Wipe every slot back to its initial dormant state. Used by `Vm.reset`. */
  reset(): void {
    for (let i = 0; i <= this.capacity; i++) {
      this.slots[i] = createActor(i);
    }
  }
}

/** SCUMM v5 default actor count (matches MI1; MAXS doesn't carry it explicitly). */
export const DEFAULT_ACTOR_COUNT = 13;
