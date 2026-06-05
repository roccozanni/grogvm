/**
 * Actor compositor: draw a decoded costume frame onto a room's indexed
 * framebuffer at a given position, honouring transparency and z-plane
 * occlusion.
 *
 * The framebuffer is mutated in place — pass a copy of the room's
 * `decoded.indexed` if you want to preserve the original.
 *
 * Coordinate convention: `actorX` / `actorY` is the actor's anchor
 * point in room pixels (conventionally the feet). The frame's
 * top-left in room space is `(actorX + frame.redirX, actorY +
 * frame.redirY)` — `redirX/Y` are typically negative so the frame
 * extends to the left of and above the anchor.
 *
 * Z-plane rule: an actor has a 1-based `clipPlane` (its SCUMM `_zbuf`
 * level) and is hidden at (x, y) iff **that one z-plane** has its bit
 * set at (x, y). `clipPlane` 1 = `ZP01` (= `zPlanes[0]`), 2 = `ZP02`,
 * and so on; `clipPlane` 0 (the default) means "in front of every
 * plane" — never occluded. This mirrors SCUMM exactly: the costume
 * renderer masks an actor against the *single* mask buffer for its
 * z-level, not a cumulative stack. Rooms whose planes nest the other
 * way (MI1 room 30: `ZP02 ⊇ ZP01`, where `ZP01` is just the foreground
 * barrels and `ZP02` adds the loft railing/stairs) only render right
 * under this single-plane rule — a floor actor at clipPlane 1 must be
 * masked by `ZP01` alone, so it walks *in front* of the stairs in
 * `ZP02`. See docs/SCUMM-V5-ZPLANE.md §"the drawing rule".
 */

import { COSTUME_FRAME_TRANSPARENT, decodeCostumeFrame, type DecodedCostumeFrame } from './costume-frame';
import { currentLimbPicture, COSTUME_OFFSET_ADJUST } from './costume-anim';
import type { LoadedCostume } from './costume-loader';
import type { Actor } from '../actor/actor';
import type { DecodedZPlane } from './zplane';

export interface CompositeActorOptions {
  /** Output framebuffer (`fbWidth × fbHeight` indexed bytes), mutated in place. */
  readonly framebuffer: Uint8Array;
  readonly fbWidth: number;
  readonly fbHeight: number;
  readonly frame: DecodedCostumeFrame;
  /** The costume's local palette: each entry is a CLUT index in the room palette. */
  readonly costPalette: Uint8Array;
  /** Actor anchor position in room coords (typically the feet). */
  readonly actorX: number;
  readonly actorY: number;
  /**
   * Actor clip level — the 1-based z-plane (SCUMM `_zbuf`) that masks
   * this actor. 0 (default) = in front of every plane (never occluded);
   * `k` = masked by `zPlanes[k-1]` only. See the file header.
   */
  readonly clipPlane?: number;
  /** Z-planes in source order — `zPlanes[0]` corresponds to `ZP01`. */
  readonly zPlanes?: readonly DecodedZPlane[];
  /**
   * Draw the frame horizontally mirrored (reflected about the actor's
   * anchor X). SCUMM costumes store side-view frames facing one way and
   * flip them for the opposite facing.
   */
  readonly mirror?: boolean;
  /**
   * Actor scale, 0..255 where 255 = 100% (the default). The frame is
   * nearest-neighbour scaled around the anchor — the feet stay at
   * (actorX, actorY) and the sprite shrinks toward them — so a distant
   * actor draws smaller. SCUMM scales actors by position; 255 is exactly
   * the un-scaled blit.
   */
  readonly scale?: number;
}

/** Where (and how big) a costume frame lands on screen for a given anchor,
 *  mirror, and scale. Shared by the blit and the compositor's hit-test bounds
 *  so they never disagree. At scale 255 this is the native, un-scaled extent. */
export interface ActorPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function actorFramePlacement(
  frame: DecodedCostumeFrame,
  actorX: number,
  actorY: number,
  mirror: boolean,
  scale: number,
): ActorPlacement {
  const s = Math.max(0, Math.min(255, scale));
  const width = Math.max(1, Math.round((frame.width * s) / 255));
  const height = Math.max(1, Math.round((frame.height * s) / 255));
  const redirX = Math.round((frame.redirX * s) / 255);
  const redirY = Math.round((frame.redirY * s) / 255);
  // Anchor (feet) stays at (actorX, actorY); the offset scales with the frame
  // so the sprite shrinks toward it. Mirror reflects the span about actorX.
  const left = mirror ? actorX - redirX - width : actorX + redirX;
  const top = actorY + redirY;
  return { left, top, width, height };
}

/** A limb that will draw this frame: its index and decoded picture. */
export interface PreparedLimb {
  readonly limbIdx: number;
  readonly frame: DecodedCostumeFrame;
}

/**
 * Everything needed to draw (and hit-test) an actor for the current frame —
 * the decoded limbs, the shared mirror/scale, and the unioned sprite box.
 * {@link prepareActorDraw} resolves it from actor + costume state alone, so
 * the compositor (which blits the limbs) and a headless hit-test (which only
 * needs `bounds`) share one source of truth and can never disagree.
 */
export interface ActorDrawPrep {
  readonly mirror: boolean;
  readonly scale: number;
  /** Limbs to draw, in limb order, frames decoded. */
  readonly limbs: readonly PreparedLimb[];
  /** Active-limb decode failures (a real-bug signal for the inspector). */
  readonly skippedLimbs: readonly { readonly limbIdx: number; readonly reason: string }[];
  /**
   * Union of every drawn limb's room-space extent — the actor's hit-test box
   * (SCUMM's per-actor gfx-usage bits). `null` when no limb drew.
   */
  readonly bounds: { left: number; top: number; right: number; bottom: number } | null;
}

/**
 * Resolve an actor's drawable limbs and on-screen extent from its current
 * costume + anim + position — the geometry the compositor blits and that
 * `actorFromPos` hit-tests against, with no framebuffer required.
 *
 * Mirrors SCUMM's per-frame limb walk: pick the anim-driven picture for each
 * active limb (or frame 0 in the init-pose fallback when no anim is running),
 * decode it, and union the scaled placements. Limbs parked on a sentinel /
 * out-of-range frame pointer are silently bypassed (costumes share a dummy
 * table for unused limbs); a decode failure on an *active* limb is recorded.
 */
export function prepareActorDraw(actor: Actor, costume: LoadedCostume): ActorDrawPrep {
  // West and East share side-view art; the engine flips one horizontally.
  // mirror = horizontal AND (facing-West XOR the costume's native orientation).
  const facing = actor.facing;
  const horizontal = facing === 'W' || facing === 'E';
  const mirror = horizontal && (facing === 'W') !== costume.header.mirrorFlag;

  // When an anim has activated any limb, only the active limbs draw; with no
  // anim yet we fall back to frame 0 of every limb (the base sprite).
  let anyActive = false;
  for (const l of actor.anim.limbs) {
    if (l.active) {
      anyActive = true;
      break;
    }
  }

  const limbs: PreparedLimb[] = [];
  const skippedLimbs: { limbIdx: number; reason: string }[] = [];
  let bLeft = Infinity,
    bTop = Infinity,
    bRight = -Infinity,
    bBottom = -Infinity;

  for (let limbIdx = 0; limbIdx < costume.header.limbOffsets.length; limbIdx++) {
    const tableOffset = costume.header.limbOffsets[limbIdx]!;
    if (tableOffset === 0) continue; // unused limb
    const limbActive = actor.anim.limbs[limbIdx]?.active ?? false;
    if (anyActive && !limbActive) continue;
    let frameIdx: number;
    if (limbActive) {
      frameIdx = currentLimbPicture(actor.anim, limbIdx, costume.payload);
      if (frameIdx < 0) continue; // stopped / draw-nothing
    } else {
      frameIdx = 0;
    }
    // Limb image table is read with the v5 −6 base correction.
    const ptrOffset = tableOffset + COSTUME_OFFSET_ADJUST + frameIdx * 2;
    if (ptrOffset + 2 > costume.payload.length) {
      if (limbActive) {
        skippedLimbs.push({
          limbIdx,
          reason: `frame-ptr offset 0x${ptrOffset.toString(16)} past end of costume payload`,
        });
      }
      continue;
    }
    const framePtr = costume.payload[ptrOffset]! | (costume.payload[ptrOffset + 1]! << 8);
    // Sentinels: 0x0000, anything < 6, or a header that won't fit the payload.
    if (framePtr === 0 || framePtr < 6 || framePtr + 6 > costume.payload.length) continue;
    try {
      const frame = decodeCostumeFrame(costume.payload, framePtr, {
        paletteSize: costume.header.paletteSize,
      });
      limbs.push({ limbIdx, frame });
      const place = actorFramePlacement(frame, actor.x, actor.y, mirror, actor.scale);
      if (place.left < bLeft) bLeft = place.left;
      if (place.top < bTop) bTop = place.top;
      if (place.left + place.width > bRight) bRight = place.left + place.width;
      if (place.top + place.height > bBottom) bBottom = place.top + place.height;
    } catch (err) {
      if (limbActive) {
        skippedLimbs.push({ limbIdx, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const bounds =
    limbs.length > 0 ? { left: bLeft, top: bTop, right: bRight, bottom: bBottom } : null;
  return { mirror, scale: actor.scale, limbs, skippedLimbs, bounds };
}

export function compositeActor(opts: CompositeActorOptions): void {
  const { framebuffer, fbWidth, fbHeight, frame, costPalette, actorX, actorY } = opts;
  const clipPlane = opts.clipPlane ?? 0;
  const zPlanes = opts.zPlanes ?? [];
  // The single z-plane (if any) that masks this actor. SCUMM masks an
  // actor against exactly its `_zbuf` level's plane — never a cumulative
  // stack — so clipPlane 0 (or a level past the last plane) = unmasked.
  const maskPlane =
    clipPlane > 0 && clipPlane <= zPlanes.length ? zPlanes[clipPlane - 1]! : null;
  const mirror = opts.mirror ?? false;
  const scale = Math.max(0, Math.min(255, opts.scale ?? 255));

  if (framebuffer.length !== fbWidth * fbHeight) {
    throw new Error(
      `compositeActor: framebuffer length ${framebuffer.length} ≠ ${fbWidth}×${fbHeight} = ${fbWidth * fbHeight}.`,
    );
  }
  for (const plane of zPlanes) {
    if (plane.width !== fbWidth || plane.height !== fbHeight) {
      throw new Error(
        `compositeActor: z-plane size ${plane.width}×${plane.height} ≠ framebuffer ${fbWidth}×${fbHeight}.`,
      );
    }
  }

  if (scale === 0) return; // scaled to nothing

  // Scaled placement (nearest-neighbour). At scale 255 this is the native
  // extent and every map below is the identity, so the path is an exact no-op
  // for un-scaled actors.
  const { left, top, width: drawW, height: drawH } = actorFramePlacement(
    frame,
    actorX,
    actorY,
    mirror,
    scale,
  );

  // Clip the iteration range to the on-screen portion of the (scaled) frame so
  // we never index out of bounds and avoid touching off-screen pixels.
  const startX = Math.max(0, -left);
  const endX = Math.min(drawW, fbWidth - left);
  const startY = Math.max(0, -top);
  const endY = Math.min(drawH, fbHeight - top);

  for (let py = startY; py < endY; py++) {
    const ry = top + py;
    // Map this scaled destination row back to a source row. CENTERED
    // nearest-neighbour — sample the middle of each destination cell's source
    // span (`(py + 0.5) · h / drawH`) rather than its top edge. Centering
    // distributes the dropped rows/columns evenly instead of biasing toward
    // one edge, so thin features (Guybrush's eyes) survive downscaling far
    // better. At scale 255 (drawH == h) this is still exactly `py`.
    const sy = Math.min(frame.height - 1, Math.floor(((py + 0.5) * frame.height) / drawH));
    const frameRowBase = sy * frame.width;
    const fbRowBase = ry * fbWidth;
    for (let px = startX; px < endX; px++) {
      const sx = Math.min(frame.width - 1, Math.floor(((px + 0.5) * frame.width) / drawW));
      // Mirror: sample the column from the opposite edge of the frame.
      const srcPx = mirror ? frame.width - 1 - sx : sx;
      const idx = frame.pixels[frameRowBase + srcPx]!;
      if (idx === COSTUME_FRAME_TRANSPARENT) continue;
      const rx = left + px;

      // Z-plane occlusion: hidden iff this actor's single clip plane has
      // its bit set here (SCUMM masks against one mask buffer per actor).
      if (maskPlane && maskPlane.mask[ry * fbWidth + rx]) continue;

      framebuffer[fbRowBase + rx] = costPalette[idx]!;
    }
  }
}
