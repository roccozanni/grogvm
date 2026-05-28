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
import { currentLimbFrame } from '../graphics/costume-anim';
import { compositeActor } from '../graphics/composite';
import type { LoadedCostume } from '../graphics/costume-loader';
import { decodeCostumeFrame } from '../graphics/costume-frame';
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
}

/** Reason an entire actor didn't draw — surfaced for diagnostics. */
export interface SkippedActor {
  readonly actorId: number;
  readonly reason: string;
}

export interface ComposeFrameResult {
  /** Actors that were drawn (at least one limb composited successfully). */
  readonly actorsDrawn: number;
  /** Actors skipped before limb iteration — costume not loadable, etc. */
  readonly skippedActors: ReadonlyArray<SkippedActor>;
  /** Per-limb skips with reasons — populated for diagnostics. */
  readonly skippedLimbs: ReadonlyArray<SkippedLimb>;
}

const COSTUME_FRAME_SENTINEL_END = 0xffff;

export function composeFrame(input: ComposeFrameInput): ComposeFrameResult {
  const { room, framebuffer, actors, getCostume } = input;
  const skippedActors: SkippedActor[] = [];
  const skippedLimbs: SkippedLimb[] = [];
  let actorsDrawn = 0;

  if (!room) {
    framebuffer.fill(0);
    return { actorsDrawn: 0, skippedActors, skippedLimbs };
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

  if (!actors || actors.length === 0 || !getCostume) {
    return { actorsDrawn, skippedActors, skippedLimbs };
  }

  // Render actors in id ascending order for stable layering.
  const sorted = [...actors].sort((a, b) => a.id - b.id);
  for (const actor of sorted) {
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
    const limbSkipsBefore = skippedLimbs.length;
    for (let limbIdx = 0; limbIdx < costume.header.limbOffsets.length; limbIdx++) {
      const tableOffset = costume.header.limbOffsets[limbIdx]!;
      if (tableOffset === 0) continue; // unused limb
      const frameIdx = currentLimbFrame(actor.anim, limbIdx);
      const ptrOffset = tableOffset + frameIdx * 2;
      if (ptrOffset + 2 > costume.payload.length) {
        skippedLimbs.push({
          actorId: actor.id,
          limbIdx,
          reason: `frame-ptr offset 0x${ptrOffset.toString(16)} past end of costume payload`,
        });
        continue;
      }
      const framePtr =
        costume.payload[ptrOffset]! | (costume.payload[ptrOffset + 1]! << 8);
      if (framePtr === 0 || framePtr === COSTUME_FRAME_SENTINEL_END) continue;
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
          // Default actor z = in front of every plane. Walk-box-derived
          // Z lands with the pathfinding sub-phase; until then this
          // matches "actor is the topmost layer above the room bg"
          // which is what nearly every script wants on first place.
          actorZ: room.zPlanes.length,
          zPlanes: room.zPlanes,
        });
        drewLimb = true;
      } catch (err) {
        skippedLimbs.push({
          actorId: actor.id,
          limbIdx,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (drewLimb) {
      actorsDrawn++;
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

  return { actorsDrawn, skippedActors, skippedLimbs };
}
