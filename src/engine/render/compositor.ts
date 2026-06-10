/**
 * Frame compositor — assembles one frame (background → drawBox fills →
 * drawn objects → actors) into a caller-owned indexed framebuffer,
 * mutated in place. Per-limb decode failures skip just that limb and
 * surface in the result for the inspector.
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
   * room and visibility — the compositor draws every passed actor.
   */
  readonly actors?: ReadonlyArray<Actor>;
  /** Resolves a costume id → loaded payload + header; `null` skips that actor. */
  readonly getCostume?: (costumeId: number) => LoadedCostume | null;
  /** Object ids queued by `drawObject` this frame, drawn between background and actors. */
  readonly objectDrawQueue?: Iterable<number>;
  /**
   * State for each object — picks the IMxx image variant: 0 = invisible,
   * N = `images.get(N)`. Absent objects default to state 1.
   */
  readonly getObjectState?: (objectId: number) => number;
  /**
   * Runtime draw position from `drawObject … at x,y` (SO_AT); `undefined`
   * falls back to the object's IMHD position. Drives both the blit and the
   * object's z-plane placement.
   */
  readonly getObjectPosition?: (objectId: number) => { x: number; y: number } | undefined;
  /**
   * Whether an actor is in SCUMM's NeverClip object class (class 20) —
   * always in front of every z-plane. Only consulted on the box-default
   * path; an explicit `alwaysZclip` still wins (zplane.md §8).
   */
  readonly isNeverClip?: (actorId: number) => boolean;
  /**
   * Rectangles painted by the `drawBox` opcode, applied over the background
   * before objects/actors, in order. Coords are inclusive screen pixels;
   * `color` is a CLUT index. Clamped to the framebuffer.
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
    // No room → credits/win screen: drawBox fills still land, at the
    // caller-supplied dims (skipped without them).
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

  // drawBox fills go over the background, before objects/actors — SCUMM
  // writes them to the virtual screen behind everything drawn after.
  if (drawnBoxes?.length) {
    for (const box of drawnBoxes) fillBox(framebuffer, room.width, room.height, box);
  }

  // Objects — between bg and actors, with TRNS-indexed transparency (the
  // room-bg convention). Their z-planes feed actorOcclusionPlanes below.
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

  const actorZPlanes = actorOcclusionPlanes(room, {
    objectDrawQueue,
    getObjectState,
    getObjectPosition,
  });

  // Actors render back-to-front by room y (SCUMM's actor sort): greater y =
  // nearer the camera, paints last. Id breaks ties for stable layering.
  const sorted = [...actors].sort((a, b) => a.y - b.y || a.id - b.id);
  for (const actor of sorted) {
    // Clear last frame's hit-test bounds up front; only a successful
    // composite re-establishes them, so an undrawn actor reads as
    // "not on screen" for actorFromPos.
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

    // prepareActorDraw also backs `actorFromPos` hit-testing, so what the
    // player can click and what gets painted can never drift apart.
    const prep = prepareActorDraw(actor, costume);
    const limbSkipsBefore = skippedLimbs.length;
    for (const s of prep.skippedLimbs) {
      skippedLimbs.push({ actorId: actor.id, limbIdx: s.limbIdx, reason: s.reason });
    }
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
          scale: prep.scale,
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
 * Resolve the 1-based z-plane (`ZP0k`) that masks an actor — SCUMM's
 * `zbuf = _forceClip ? _forceClip : (neverClipClass ? 0 : maskFromBox(_walkbox))`;
 * 0 = in front of every plane. NB: `forceClip == 0` is the *unset*
 * sentinel (`neverZclip` only clears a forced clip), NOT "always in
 * front" — fronting comes from the NeverClip class or a mask-0 box.
 * Full derivation and the cases that pin it down: pages/docs/scumm/zplane.md §8.
 */
function resolveClipPlane(
  actor: Actor,
  walkBoxes: ReadonlyArray<WalkBox>,
  neverClipClass: boolean,
): number {
  if (actor.forceClip > 0) return actor.forceClip;
  if (neverClipClass) return 0;
  // The stored _walkbox is walk state — never re-derived from pixel position
  // at draw time, so an airborne ignoreBoxes actor keeps its last box
  // (init clears it to -1 → front). See zplane.md §"Box-mask".
  const box = actor.walkBox >= 0 ? walkBoxes.find((b) => b.id === actor.walkBox) : undefined;
  return box ? box.mask : 0;
}

/** Options selecting which objects contribute foreground z-planes — the same
 *  draw-queue / state / position accessors {@link composeFrame} consumes. */
export interface ForegroundPlaneOptions {
  readonly objectDrawQueue?: Iterable<number>;
  readonly getObjectState?: (objectId: number) => number;
  readonly getObjectPosition?: (objectId: number) => { x: number; y: number } | undefined;
}

/** One drawn object's mask contribution, at its runtime position. */
interface ObjectStamp {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Image pixels — the per-strip opacity test reads these. */
  readonly indexed: Uint8Array;
  /** `zPlanes[k-1]` = the object's `ZP0k`, absent slots = no data for that plane. */
  readonly zPlanes: ReadonlyArray<DecodedZPlane | null>;
}

/** Drawn objects in queue (draw) order — skips hidden/imageless objects, whose
 *  skip reasons surface in {@link composeFrame}'s own pass. */
function collectStamps(room: LoadedRoom, opts: ForegroundPlaneOptions): ObjectStamp[] {
  const out: ObjectStamp[] = [];
  if (!opts.objectDrawQueue) return out;
  for (const objId of opts.objectDrawQueue) {
    const obj = room.objects.get(objId);
    if (!obj) continue;
    const state = opts.getObjectState ? opts.getObjectState(objId) : 1;
    if (state <= 0) continue;
    const image = obj.images.get(state);
    if (!image) continue;
    const pos = opts.getObjectPosition?.(objId);
    out.push({
      x: pos?.x ?? obj.imhd.x,
      y: pos?.y ?? obj.imhd.y,
      width: obj.imhd.width,
      height: obj.imhd.height,
      indexed: image.indexed,
      zPlanes: image.zPlanes,
    });
  }
  return out;
}

/**
 * The effective z-plane stack that masks actors this frame: room z-planes
 * stamped over, in draw order, by every drawn object — SCUMM's stateful mask
 * surface. An object draw REWRITES the mask in its footprint strip by strip
 * (see {@link applyStamp}); it does not just OR bits in. Order matters: MI1's
 * forest (room 58) parks solid-mask path tiles under opaque dressing tiles
 * whose draws erase them — an order-blind OR occludes ego where the original
 * doesn't. The single entry point for "what occludes an actor" — used by
 * {@link composeFrame} for clipping and by the Z-planes debug overlay, so the
 * two can't drift. Stack is extended when an object targets a plane the room
 * lacks (zplane.md §"Per-object z-planes").
 */
export function actorOcclusionPlanes(
  room: LoadedRoom,
  opts: ForegroundPlaneOptions,
): readonly DecodedZPlane[] {
  const stamps = collectStamps(room, opts);
  if (stamps.length === 0) return room.zPlanes;
  const w = room.width, h = room.height;
  const maxIdx = Math.max(
    room.zPlanes.length - 1,
    ...stamps.map((s) => s.zPlanes.length - 1),
  );
  const masks: Uint8Array[] = [];
  for (let i = 0; i <= maxIdx; i++) {
    masks[i] = room.zPlanes[i] ? room.zPlanes[i]!.mask.slice() : new Uint8Array(w * h);
  }
  for (const s of stamps) applyStamp(masks, w, h, s, room.transparentIndex);
  return masks.map((mask) => ({ width: w, height: h, mask }));
}

/**
 * Stamp one drawn object into the mask stack — SCUMM's per-strip mask write:
 * an 8-px strip with NO transparent image pixel REPLACES the mask rows it
 * covers with the object's bits (zeros where it has no plane data); a strip
 * WITH transparency ORs its bits and leaves absent planes untouched.
 */
function applyStamp(
  masks: Uint8Array[],
  w: number,
  h: number,
  s: ObjectStamp,
  transparentIndex: number | null,
): void {
  const ow = s.width, oh = s.height;
  if (ow === 0 || oh === 0 || s.indexed.length !== ow * oh) return;
  const y0 = Math.max(0, s.y);
  const y1 = Math.min(h, s.y + oh);
  if (y0 >= y1) return;
  for (let sx = 0; sx < ow; sx += 8) {
    const sw = Math.min(8, ow - sx);
    const x0 = Math.max(0, s.x + sx);
    const x1 = Math.min(w, s.x + sx + sw);
    if (x0 >= x1) continue;
    let opaque = true;
    if (transparentIndex !== null) {
      scan: for (let py = 0; py < oh; py++) {
        for (let px = sx; px < sx + sw; px++) {
          if (s.indexed[py * ow + px] === transparentIndex) {
            opaque = false;
            break scan;
          }
        }
      }
    }
    for (let k = 0; k < masks.length; k++) {
      const bits = s.zPlanes[k] ?? null;
      if (!opaque && !bits) continue;
      const mask = masks[k]!;
      for (let fy = y0; fy < y1; fy++) {
        const py = fy - s.y;
        for (let fx = x0; fx < x1; fx++) {
          const px = fx - s.x;
          const bit = bits ? bits.mask[py * bits.width + px]! : 0;
          if (opaque) mask[fy * w + fx] = bit;
          else if (bit) mask[fy * w + fx] = 1;
        }
      }
    }
  }
}

/** Blit one object image, honouring the room's TRNS transparent index and
 *  clipping to the framebuffer (objects can legally overhang the room). */
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
    // Size/IMHD mismatch — bail rather than read past the end.
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
