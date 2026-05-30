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
import { currentLimbPicture, COSTUME_OFFSET_ADJUST } from '../graphics/costume-anim';
import { compositeActor } from '../graphics/composite';
import type { LoadedCostume } from '../graphics/costume-loader';
import { decodeCostumeFrame } from '../graphics/costume-frame';
import type { LoadedObject } from '../object/loader';
import type { LoadedRoom } from '../room/loader';

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

export function composeFrame(input: ComposeFrameInput): ComposeFrameResult {
  const { room, framebuffer, actors, getCostume, objectDrawQueue, getObjectState } = input;
  const skippedActors: SkippedActor[] = [];
  const skippedLimbs: SkippedLimb[] = [];
  const skippedObjects: SkippedObject[] = [];
  let actorsDrawn = 0;
  let objectsDrawn = 0;

  if (!room) {
    framebuffer.fill(0);
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

  // Objects — drawn between bg and actors. SCUMM uses TRNS-indexed
  // transparency on object SMAPs (same convention as the room bg).
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
      drawObjectImage(framebuffer, room.width, room.height, obj, image.indexed, room.transparentIndex);
      objectsDrawn++;
    }
  }

  if (!actors || actors.length === 0 || !getCostume) {
    return { actorsDrawn, skippedActors, skippedLimbs, objectsDrawn, skippedObjects };
  }

  // Render actors in id ascending order for stable layering.
  const sorted = [...actors].sort((a, b) => a.id - b.id);
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

    let drewLimb = false;
    // Union of every drawn limb's room-space extent — becomes the
    // actor's hit-test box (mirrors SCUMM's per-actor gfx-usage bits).
    let bLeft = Infinity, bTop = Infinity, bRight = -Infinity, bBottom = -Infinity;
    const limbSkipsBefore = skippedLimbs.length;
    // SCUMM composites the limbs the current anim activated. When the
    // anim decoder produced at least one active limb, only those draw.
    // Otherwise (no anim yet, or an anim record we can't decode) we fall
    // back to a best-effort init pose — frame 0 of every limb — so a
    // freshly-placed actor still shows its base sprite. In that fallback
    // a limb whose frame-ptr doesn't decode is expected noise (costumes
    // park their unused limbs on a shared dummy table), so we bypass it
    // silently; a decode failure on an *active* limb is a real bug and
    // is still recorded for the inspector.
    let anyActive = false;
    for (const l of actor.anim.limbs) {
      if (l.active) { anyActive = true; break; }
    }
    // Mirror: MI1 stores side-view frames facing RIGHT (East renders
    // correctly unmirrored) and draws them flipped for West. The costume
    // format's mirror bit (0x80) is clear on every MI1 costume, so it
    // isn't the gate — mirroring is keyed purely on facing West. (S/N
    // are front/back views with their own art and are never mirrored.)
    const mirror = actor.facing === 'W';
    for (let limbIdx = 0; limbIdx < costume.header.limbOffsets.length; limbIdx++) {
      const tableOffset = costume.header.limbOffsets[limbIdx]!;
      if (tableOffset === 0) continue; // unused limb
      const limbActive = actor.anim.limbs[limbIdx]?.active ?? false;
      // When an anim is driving, limbs it doesn't touch don't draw.
      if (anyActive && !limbActive) continue;
      // Active limbs resolve their picture through the anim state, which
      // honours the per-limb "stopped" bit and skips command bytes
      // (returns -1 = draw nothing). Inactive limbs in the init-pose
      // fallback read frame 0.
      let frameIdx: number;
      if (limbActive) {
        frameIdx = currentLimbPicture(actor.anim, limbIdx, costume.payload);
        if (frameIdx < 0) continue;
      } else {
        frameIdx = 0;
      }
      // Limb image table is read with the v5 −6 base correction.
      const ptrOffset = tableOffset + COSTUME_OFFSET_ADJUST + frameIdx * 2;
      if (ptrOffset + 2 > costume.payload.length) {
        if (limbActive) {
          skippedLimbs.push({
            actorId: actor.id,
            limbIdx,
            reason: `frame-ptr offset 0x${ptrOffset.toString(16)} past end of costume payload`,
          });
        }
        continue;
      }
      const framePtr =
        costume.payload[ptrOffset]! | (costume.payload[ptrOffset + 1]! << 8);
      // Sentinels. SCUMM v5 marks an unused limb with a frame ptr
      // that can't be a real frame: 0x0000 (explicit), 0xFFFF (end
      // marker), and — common in practice — any value where the
      // 12-byte header (framePtr − 6 .. framePtr + 5) doesn't fit
      // inside the payload. MI1's Guybrush costume groups limbs 3..15
      // under one shared "unused" table whose entries happen to read
      // as 0xFFDD; treating those as decode failures fills the
      // inspector skip list with noise. Silently bypass instead.
      if (
        framePtr === 0 ||
        framePtr < 6 ||
        framePtr + 6 > costume.payload.length
      ) {
        continue;
      }
      try {
        const frame = decodeCostumeFrame(costume.payload, framePtr);
        compositeActor({
          framebuffer,
          fbWidth: room.width,
          fbHeight: room.height,
          frame,
          costPalette: costume.header.palette,
          actorX: actor.x,
          actorY: actor.y,
          mirror,
          // Default actor z = in front of every plane. Walk-box-derived
          // Z lands with the pathfinding sub-phase; until then this
          // matches "actor is the topmost layer above the room bg"
          // which is what nearly every script wants on first place.
          actorZ: room.zPlanes.length,
          zPlanes: room.zPlanes,
        });
        drewLimb = true;
        // Same extent compositeActor draws into: actor anchor + frame redir.
        const left = actor.x + frame.redirX;
        const top = actor.y + frame.redirY;
        if (left < bLeft) bLeft = left;
        if (top < bTop) bTop = top;
        if (left + frame.width > bRight) bRight = left + frame.width;
        if (top + frame.height > bBottom) bBottom = top + frame.height;
      } catch (err) {
        if (limbActive) {
          skippedLimbs.push({
            actorId: actor.id,
            limbIdx,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (drewLimb) {
      actorsDrawn++;
      actor.drawBounds = { left: bLeft, top: bTop, right: bRight, bottom: bBottom };
    } else if (skippedLimbs.length === limbSkipsBefore) {
      // Iterated every limb, nothing drew and nothing was logged as
      // a skip — every limb must have hit a sentinel framePtr (or
      // had a tableOffset of 0 meaning "unused limb"). Worth
      // surfacing so the user knows the actor was a no-op.
      skippedActors.push({
        actorId: actor.id,
        reason: 'all limbs had no frame data (unused / sentinel framePtr)',
      });
    }
  }

  return { actorsDrawn, skippedActors, skippedLimbs, objectsDrawn, skippedObjects };
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
): void {
  const left = obj.imhd.x;
  const top = obj.imhd.y;
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
