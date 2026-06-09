/**
 * Frame compositor — assembles one rendered frame from the VM's
 * current state (loaded room + actors) into an indexed framebuffer.
 *
 * The caller owns the framebuffer (typically one buffer per frame,
 * allocated by the main loop). We mutate it in place to avoid a per-
 * frame allocation. Callers that want to keep the room background
 * pristine can pass a separate buffer or copy after.
 *
 * # Layers
 *
 *   1. Background — copy `room.indexed` into the framebuffer.
 *   2. Actors — for each visible actor in the room, decode the
 *      current frame of each populated limb (via `currentLimbFrame`
 *      from the costume-anim stub) and composite it through the
 *      costume's local palette, honouring Z-plane occlusion and
 *      TRNS transparency. Order: by actor id ascending — SCUMM
 *      relies on this for predictable layering when actors overlap.
 *   3. (Future) Object overlays — drawObject's queue feeds in here.
 *
 * # Empty rooms
 *
 * When `room` is `null` (e.g. the script just called `loadRoom 0`,
 * the "no room" sentinel), we fill the framebuffer with palette
 * index 0. The renderer's transparent-index setup decides whether
 * that reads as "black" or "transparent" to the user.
 *
 * # Dimension mismatch
 *
 * Throws if `framebuffer.length` is smaller than `room.width *
 * room.height`. Extra space at the end is allowed (and left
 * untouched) so callers can share a single max-sized buffer across
 * rooms of different sizes.
 *
 * # Decode failures
 *
 * Per-limb decode (`decodeCostumeFrame`) can throw if the RLE stream
 * is malformed or the frame pointer is bogus. We catch those at the
 * limb level and skip just that limb — the rest of the actor (and
 * the other actors) still render. The reason goes into
 * `result.skippedLimbs` so the inspector can surface why something
 * didn't draw.
 */

import type { Actor } from '../actor/actor';
import { compositeActor, prepareActorDraw } from '../graphics/composite';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { LoadedObject } from '../object/loader';
import type { LoadedRoom } from '../room/loader';
import type { DecodedZPlane } from '../graphics/zplane';
import { type WalkBox } from '../pathfinding/boxes';

export class ComposeError extends Error {
  constructor(detail: string) {
    super(`composeFrame: ${detail}`);
    this.name = 'ComposeError';
  }
}

/** Reason a single limb didn't render — surfaced for diagnostics. */
export interface SkippedLimb {
  readonly actorId: number;
  readonly limbIdx: number;
  readonly reason: string;
}

export interface ComposeFrameInput {
  /** Currently-loaded room, or `null` for "no room" (clear to index 0). */
  readonly room: LoadedRoom | null;
  /** Output framebuffer — `room.width × room.height` indexed bytes minimum. Mutated in place. */
  readonly framebuffer: Uint8Array;
  /**
   * Actors to composite on top of the background. Caller filters by
   * `actor.room === room.id` and visibility — compositor draws every
   * passed actor. Pass an empty array (or omit) to draw only the bg.
   */
  readonly actors?: ReadonlyArray<Actor>;
  /**
   * Resolves an actor's costume id → its loaded payload + header.
   * Return `null` to skip that actor (costume not loadable). Typical
   * implementation: `(id) => vm.getCostume(id)`.
   */
  readonly getCostume?: (costumeId: number) => LoadedCostume | null;
  /**
   * Object ids the script has queued for drawing this frame. The
   * compositor draws each one's current-state image (from
   * `room.objects[id]`) at its IMHD-recorded position, between the
   * background and the actors. Typically:
   *   `objectDrawQueue: vm.objectDrawQueue,`
   *   `getObjectState: (id) => vm.objectStates.get(id) ?? 0,`
   */
  readonly objectDrawQueue?: Iterable<number>;
  /**
   * State for each object — drives which IMxx image variant gets
   * drawn. State 0 = invisible (skipped). State N = `images.get(N)`.
   * Defaults to "treat absent as state 1" so callers that don't
   * track state explicitly still see something drawn.
   */
  readonly getObjectState?: (objectId: number) => number;
  /**
   * Runtime draw position for an object set by `drawObject … at x,y` (SO_AT),
   * or `undefined` to fall back to the object's IMHD position. Drives both the
   * blit position and the object's z-plane placement. Typically:
   *   `getObjectPosition: (id) => vm.objectDrawPositions.get(id),`
   */
  readonly getObjectPosition?: (objectId: number) => { x: number; y: number } | undefined;
  /**
   * Whether an actor is in SCUMM's **NeverClip** object class (class 20,
   * bit 19) — set by `setClass`. Such actors always draw in front of every
   * z-plane regardless of the walk box they stand in, matching SCUMM's
   * `zbuf = _forceClip ? _forceClip : (neverClip ? 0 : maskFromBox(_walkbox))`
   * precedence. Only consulted for the box-default path (forceClip ≤ 0);
   * an explicit `alwaysZclip` (forceClip > 0) still wins. Typically:
   *   `isNeverClip: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 19)) !== 0`
   * Defaults to "no actor is NeverClip".
   */
  readonly isNeverClip?: (actorId: number) => boolean;
  /**
   * Rectangles painted by the `drawBox` opcode (vm.drawnBoxes), applied over
   * the background before objects/actors, in order. Coords are inclusive
   * screen pixels; `color` is a CLUT index. Clamped to the framebuffer.
   */
  readonly drawnBoxes?: ReadonlyArray<{
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly color: number;
  }>;
  /**
   * Framebuffer dimensions for the box fill when `room` is null (no room
   * loaded — e.g. the credits screen). Ignored when a room is present (its
   * width/height are used). Without these, boxes are skipped on a null room.
   */
  readonly screenWidth?: number;
  readonly screenHeight?: number;
}

/** Reason an entire actor didn't draw — surfaced for diagnostics. */
export interface SkippedActor {
  readonly actorId: number;
  readonly reason: string;
}

/** Reason an object in the draw queue didn't render. */
export interface SkippedObject {
  readonly objectId: number;
  readonly reason: string;
}

export interface ComposeFrameResult {
  /** Actors that were drawn (at least one limb composited successfully). */
  readonly actorsDrawn: number;
  /** Actors skipped before limb iteration — costume not loadable, etc. */
  readonly skippedActors: ReadonlyArray<SkippedActor>;
  /** Per-limb skips with reasons — populated for diagnostics. */
  readonly skippedLimbs: ReadonlyArray<SkippedLimb>;
  /** Objects from the draw queue that successfully composited. */
  readonly objectsDrawn: number;
  /** Objects skipped from the draw queue, with reasons. */
  readonly skippedObjects: ReadonlyArray<SkippedObject>;
}

/** Fill an inclusive rectangle in the framebuffer with `color`, clamped to
 *  the [0,w) × [0,h) bounds. SCUMM's drawBox fills x..x2 / y..y2 inclusive. */
function fillBox(
  framebuffer: Uint8Array,
  w: number,
  h: number,
  box: { left: number; top: number; right: number; bottom: number; color: number },
): void {
  const x0 = Math.max(0, Math.min(box.left, box.right));
  const x1 = Math.min(w - 1, Math.max(box.left, box.right));
  const y0 = Math.max(0, Math.min(box.top, box.bottom));
  const y1 = Math.min(h - 1, Math.max(box.top, box.bottom));
  for (let y = y0; y <= y1; y++) {
    framebuffer.fill(box.color & 0xff, y * w + x0, y * w + x1 + 1);
  }
}

export function composeFrame(input: ComposeFrameInput): ComposeFrameResult {
  const { room, framebuffer, actors, getCostume, objectDrawQueue, getObjectState, getObjectPosition, isNeverClip, drawnBoxes, screenWidth, screenHeight } = input;
  const skippedActors: SkippedActor[] = [];
  const skippedLimbs: SkippedLimb[] = [];
  const skippedObjects: SkippedObject[] = [];
  let actorsDrawn = 0;
  let objectsDrawn = 0;

  if (!room) {
    framebuffer.fill(0);
    // No room → the credits/win screen. drawBox fills land on the blank
    // screen at the dims the caller supplies (boxes skipped without them).
    if (drawnBoxes?.length && screenWidth && screenHeight) {
      for (const box of drawnBoxes) fillBox(framebuffer, screenWidth, screenHeight, box);
    }
    return {
      actorsDrawn: 0,
      skippedActors,
      skippedLimbs,
      objectsDrawn: 0,
      skippedObjects,
    };
  }
  const need = room.width * room.height;
  if (framebuffer.length < need) {
    throw new ComposeError(
      `framebuffer ${framebuffer.length} B < room ${room.width}×${room.height} = ${need} B`,
    );
  }
  if (room.indexed.length !== need) {
    throw new ComposeError(
      `room.indexed ${room.indexed.length} B ≠ ${room.width}×${room.height} = ${need} B`,
    );
  }
  // Background.
  framebuffer.set(room.indexed);

  // drawBox fills — painted over the background, before objects/actors
  // (SCUMM writes them to the virtual screen behind everything drawn after).
  if (drawnBoxes?.length) {
    for (const box of drawnBoxes) fillBox(framebuffer, room.width, room.height, box);
  }

  // Objects — drawn between bg and actors. SCUMM uses TRNS-indexed
  // transparency on object SMAPs (same convention as the room bg).
  // A drawn object's own z-planes (if any) make it a foreground that occludes
  // actors behind it (the trunks/foliage in room 58, the title logo, the
  // general-store wall items). The plane collection itself is shared with the
  // debug overlay via collectForegroundPlanes/mergeForeground; here the loop
  // also paints the object images and records draw skips.
  if (objectDrawQueue) {
    for (const objId of objectDrawQueue) {
      const obj = room.objects.get(objId);
      if (!obj) {
        skippedObjects.push({
          objectId: objId,
          reason: `not present in room ${room.id}`,
        });
        continue;
      }
      const state = getObjectState ? getObjectState(objId) : 1;
      if (state <= 0) {
        skippedObjects.push({ objectId: objId, reason: `state ${state} (hidden)` });
        continue;
      }
      const image = obj.images.get(state);
      if (!image) {
        skippedObjects.push({
          objectId: objId,
          reason: `no image for state ${state} (have: ${[...obj.images.keys()].join(',') || 'none'})`,
        });
        continue;
      }
      const pos = getObjectPosition?.(objId);
      const left = pos?.x ?? obj.imhd.x;
      const top = pos?.y ?? obj.imhd.y;
      drawObjectImage(framebuffer, room.width, room.height, obj, image.indexed, room.transparentIndex, left, top);
      objectsDrawn++;
    }
  }

  if (!actors || actors.length === 0 || !getCostume) {
    return { actorsDrawn, skippedActors, skippedLimbs, objectsDrawn, skippedObjects };
  }

  // The merged actor-occlusion stack: room z-planes OR'd with every drawn
  // object's z-plane at its runtime position. Same helpers the Z-planes debug
  // overlay uses, so what masks an actor and what the overlay paints can't drift.
  const actorZPlanes = actorOcclusionPlanes(room, {
    objectDrawQueue,
    getObjectState,
    getObjectPosition,
  });

  // Render actors back-to-front by room y (SCUMM's actor sort): an actor
  // lower on screen (greater y) is nearer the camera, so it paints last and
  // occludes those behind. Id breaks ties for stable layering. This is what
  // puts Guybrush (front, greater y) over the seated SCUMM-Bar pirates
  // (behind the table, lesser y) instead of the id-order reverse.
  const sorted = [...actors].sort((a, b) => a.y - b.y || a.id - b.id);
  for (const actor of sorted) {
    // Clear last frame's hit-test bounds up front; only a successful
    // composite re-establishes them (so a skipped / undrawn actor reads
    // as "not on screen" for actorFromPos).
    actor.drawBounds = null;
    if (!actor.visible) {
      skippedActors.push({ actorId: actor.id, reason: 'visible=false' });
      continue;
    }
    if (actor.costume <= 0) {
      skippedActors.push({ actorId: actor.id, reason: 'costume=0 (no costume assigned)' });
      continue;
    }
    const costume = getCostume(actor.costume);
    if (!costume) {
      skippedActors.push({
        actorId: actor.id,
        reason: `getCostume(${actor.costume}) returned null — costume not loaded / resolver missing`,
      });
      continue;
    }

    // Resolve the drawable limbs + sprite box from actor + costume state.
    // The SAME function backs `actorFromPos` hit-testing, so what the player
    // can click on and what gets painted can never drift apart. SCUMM picks
    // the anim-driven picture per active limb (or frame 0 in the no-anim init
    // pose); decode failures on active limbs surface to the inspector.
    const prep = prepareActorDraw(actor, costume);
    const limbSkipsBefore = skippedLimbs.length;
    for (const s of prep.skippedLimbs) {
      skippedLimbs.push({ actorId: actor.id, limbIdx: s.limbIdx, reason: s.reason });
    }
    // Z-clip level is per-actor (not per-limb). SCUMM's `_forceClip`
    // (actorOps neverZclip / alwaysZclip) decides the single z-plane that
    // masks this actor: alwaysZclip k → ZP0k alone; not-forced → the
    // NeverClip class (→ 0, in front) or the actor's walk-box mask. This is
    // why the room-33 ego (mask-1 dock box) passes behind the houses while
    // the room-38 ego (mask-0 box) stays in front of the wall. clipPlane 0 =
    // in front of every plane; a merged drawn-object foreground (OR'd into
    // plane 1) only occludes clipPlane-1 actors.
    const clipPlane = resolveClipPlane(
      actor,
      room.walkBoxes,
      isNeverClip ? isNeverClip(actor.id) : false,
    );
    for (const { limbIdx, frame, accX, accY } of prep.limbs) {
      try {
        compositeActor({
          framebuffer,
          fbWidth: room.width,
          fbHeight: room.height,
          frame,
          costPalette: costume.header.palette,
          actorX: actor.x,
          actorY: actor.y,
          mirror: prep.mirror,
          clipPlane,
          zPlanes: actorZPlanes,
          // Actor scale (0..255, 255 = full); SCUMM scales actors by depth.
          scale: prep.scale,
          // Running _xmove/_ymove for this limb (sum of earlier limbs' xinc).
          accX,
          accY,
        });
      } catch (err) {
        skippedLimbs.push({
          actorId: actor.id,
          limbIdx,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (prep.bounds) {
      actorsDrawn++;
      actor.drawBounds = prep.bounds;
    } else if (skippedLimbs.length === limbSkipsBefore) {
      // Iterated every limb, nothing drew and nothing was logged as a skip —
      // every limb must have hit a sentinel framePtr (or a tableOffset of 0,
      // "unused limb"). Surface it so the user knows the actor was a no-op.
      skippedActors.push({
        actorId: actor.id,
        reason: 'all limbs had no frame data (unused / sentinel framePtr)',
      });
    }
  }

  return { actorsDrawn, skippedActors, skippedLimbs, objectsDrawn, skippedObjects };
}

/**
 * Resolve an actor's z-clip level — the 1-based z-plane (`ZP0k`) that
 * masks it, SCUMM's `_zbuf`. 0 = in front of every plane (no masking).
 * Mirrors SCUMM's `zbuf = _forceClip ? _forceClip : (neverClipClass ? 0
 * : maskFromBox(_walkbox))`:
 *
 *   - `alwaysZclip k` (forceClip > 0) → clipPlane = k: the actor is
 *     masked by ZP0k alone. An explicit script-set clip always wins.
 *   - **not forced** — `neverZclip` (forceClip == 0, the opcode that
 *     *clears* the forced clip) or unset (forceClip < 0):
 *       · NeverClip class → 0 (in front of every plane).
 *       · otherwise → the `mask` of the actor's stored `_walkbox`
 *         (`actor.walkBox`): mask 0 = in front, mask N (>0) = masked by
 *         ZP0N. An actor with no assigned box (`walkBox < 0` — never placed,
 *         or just init'd) defaults to in front.
 *
 * NB: `forceClip == 0` is NOT "always in front" — it's SCUMM's *unset*
 * sentinel, so neverZclip and the never-set default behave identically
 * (front-via-class or via box mask). What keeps the Mêlée sparkles in
 * front is the NeverClip *class*, not forceClip; the clouds use an
 * explicit `alwaysZclip 1` (forceClip > 0). The box is the one maintained
 * as walk state (see `rescaleActorForPosition`), resolved from position with
 * the nearest-box fallback as the actor moves — so MI1's thin dock/cliff line
 * boxes (which strictly contain no interior point) still yield the mask the
 * actor walks on (room-33 ego on box 4, a diagonal line) — never re-derived
 * here at draw time. An `ignoreBoxes` actor keeps its last box.
 *
 * Single-plane (not cumulative) masking is what lets MI1 room 30 render:
 * its `ZP02 ⊇ ZP01` (ZP01 = the foreground barrels, ZP02 also covers the
 * loft railing/stairs), so a floor actor at clipPlane 1 must be masked by
 * ZP01 alone and walk *in front* of the stairs. See pages/docs/scumm/zplane.md.
 */
function resolveClipPlane(
  actor: Actor,
  walkBoxes: ReadonlyArray<WalkBox>,
  neverClipClass: boolean,
): number {
  if (actor.forceClip > 0) return actor.forceClip;
  if (neverClipClass) return 0;
  // Use the actor's stored _walkbox (maintained during movement/placement,
  // retained while ignoreBoxes) rather than re-deriving the box from pixel
  // position here — SCUMM tracks the box as walk state and never recomputes it
  // at draw time. An airborne/off-grid ignoreBoxes actor keeps the mask of the
  // box it last stood in (init clears it to -1 → front), instead of being
  // snapped to the nearest box every frame; that's why there's no longer an
  // `if (actor.ignoreBoxes) return 0` escape hatch here.
  const box = actor.walkBox >= 0 ? walkBoxes.find((b) => b.id === actor.walkBox) : undefined;
  return box ? box.mask : 0;
}

/** A drawn object's z-plane placed for actor occlusion: `plane` (its `ZP0k`)
 *  targets plane index `planeIndex` (= k-1) at room position (`x`,`y`). */
export interface ForegroundPlane {
  readonly x: number;
  readonly y: number;
  readonly planeIndex: number;
  readonly plane: DecodedZPlane;
}

/** Options selecting which objects contribute foreground z-planes — the same
 *  draw-queue / state / position accessors {@link composeFrame} consumes. */
export interface ForegroundPlaneOptions {
  readonly objectDrawQueue?: Iterable<number>;
  readonly getObjectState?: (objectId: number) => number;
  readonly getObjectPosition?: (objectId: number) => { x: number; y: number } | undefined;
}

/**
 * Collect every drawn object's z-planes as {@link ForegroundPlane}s at their
 * runtime positions — the foreground inputs to {@link mergeForeground}. Skips
 * objects not in the room, hidden (state ≤ 0), or imageless; those draw-skip
 * reasons are surfaced by {@link composeFrame}'s own pass, not duplicated here.
 * Each `ZP0k` targets plane k alone (the single-plane rule): the title logo's
 * ZP01 hides the clip-1 clouds; the store sword's ZP02 hides only the clip-2
 * shopkeeper. Solid-fill planes were already dropped by the loader (forest
 * path trunks), so they never appear here.
 */
export function collectForegroundPlanes(
  room: LoadedRoom,
  opts: ForegroundPlaneOptions,
): ForegroundPlane[] {
  const fgPlanes: ForegroundPlane[] = [];
  if (!opts.objectDrawQueue) return fgPlanes;
  for (const objId of opts.objectDrawQueue) {
    const obj = room.objects.get(objId);
    if (!obj) continue;
    const state = opts.getObjectState ? opts.getObjectState(objId) : 1;
    if (state <= 0) continue;
    const image = obj.images.get(state);
    if (!image) continue;
    const pos = opts.getObjectPosition?.(objId);
    const left = pos?.x ?? obj.imhd.x;
    const top = pos?.y ?? obj.imhd.y;
    image.zPlanes.forEach((plane, planeIndex) => {
      if (plane) fgPlanes.push({ x: left, y: top, planeIndex, plane });
    });
  }
  return fgPlanes;
}

/**
 * The effective z-plane stack that masks actors this frame: room z-planes
 * merged with every drawn object's z-plane. The single entry point for "what
 * occludes an actor" — used by {@link composeFrame} for clipping and by the
 * Z-planes debug overlay for visualisation, so the two can't drift.
 */
export function actorOcclusionPlanes(
  room: LoadedRoom,
  opts: ForegroundPlaneOptions,
): readonly DecodedZPlane[] {
  return mergeForeground(room, collectForegroundPlanes(room, opts));
}

/**
 * OR each drawn object's z-plane into the room plane it *targets* — `ZP0k`
 * into plane `k` (`planeIndex` k-1) at the object's runtime position —
 * returning the effective plane stack for actor occlusion. This mirrors the
 * room planes' own `ZP0k → plane k` mapping, so the single-plane rule holds for
 * drawn objects too: a clip-`k` actor is masked by the room foreground PLUS the
 * drawn foreground *of plane k alone*. If an object targets a plane the room
 * doesn't have, the stack is extended so a clip-`k` actor has a `planes[k-1]`
 * to test (the general-store sword's `ZP02` occludes the clip-2 shopkeeper even
 * where the room defines no plane 2). With no foreground planes it returns the
 * room's own stack unchanged.
 */
function mergeForeground(
  room: LoadedRoom,
  fgPlanes: ReadonlyArray<ForegroundPlane>,
): readonly DecodedZPlane[] {
  if (fgPlanes.length === 0) return room.zPlanes;
  const w = room.width, h = room.height;
  const maxIdx = Math.max(room.zPlanes.length - 1, ...fgPlanes.map((p) => p.planeIndex));
  // One mutable mask per plane index, seeded from the room's plane (or empty).
  const masks: Uint8Array[] = [];
  for (let i = 0; i <= maxIdx; i++) masks[i] = room.zPlanes[i] ? room.zPlanes[i]!.mask.slice() : new Uint8Array(w * h);
  for (const { x, y, planeIndex, plane } of fgPlanes) {
    const mask = masks[planeIndex]!;
    for (let py = 0; py < plane.height; py++) {
      const fy = y + py;
      if (fy < 0 || fy >= h) continue;
      for (let px = 0; px < plane.width; px++) {
        if (!plane.mask[py * plane.width + px]) continue;
        const fx = x + px;
        if (fx < 0 || fx >= w) continue;
        mask[fy * w + fx] = 1;
      }
    }
  }
  return masks.map((mask) => ({ width: w, height: h, mask }));
}

/**
 * Blit one object image into the framebuffer at its IMHD-recorded
 * position, honouring the room's TRNS transparent index. Clipping
 * keeps us inside the framebuffer for objects that overhang the
 * room (rare but legal).
 */
function drawObjectImage(
  framebuffer: Uint8Array,
  fbWidth: number,
  fbHeight: number,
  obj: LoadedObject,
  indexed: Uint8Array,
  transparentIndex: number | null,
  left: number,
  top: number,
): void {
  const w = obj.imhd.width;
  const h = obj.imhd.height;
  if (w === 0 || h === 0) return;
  if (indexed.length !== w * h) {
    // Decoded image size doesn't match IMHD — defensive bail-out
    // rather than read past end. The image was skipped at decode
    // time too, so this is mostly belt-and-braces.
    return;
  }
  const startX = Math.max(0, -left);
  const endX = Math.min(w, fbWidth - left);
  const startY = Math.max(0, -top);
  const endY = Math.min(h, fbHeight - top);
  for (let py = startY; py < endY; py++) {
    const fbRow = (top + py) * fbWidth;
    const imgRow = py * w;
    for (let px = startX; px < endX; px++) {
      const idx = indexed[imgRow + px]!;
      if (transparentIndex !== null && idx === transparentIndex) continue;
      framebuffer[fbRow + left + px] = idx;
    }
  }
}
