/**
 * Actor compositor: blit a decoded costume frame into an indexed
 * framebuffer (mutated in place), honouring transparency, mirroring,
 * scale, and z-plane occlusion. Z-plane rule: pages/docs/scumm/zplane.md §6.
 */

import { COSTUME_FRAME_TRANSPARENT, decodeCostumeFrame, type DecodedCostumeFrame } from './costume-frame';
import { currentLimbPicture, COSTUME_OFFSET_ADJUST } from './costume-anim';
import type { LoadedCostume } from './costume-loader';
import type { Actor } from '../actor/actor';
import type { DecodedZPlane } from './zplane';

/**
 * Downscale sampling phases, `sy = floor((py + PHASE_Y) * src / draw)` (and
 * the X analogue). NOT the original interpreter's row selection (that
 * pattern is unrecovered — PROGRESS.md Tier-2) and NOT centered (0.5):
 * centered sampling dropped Guybrush's one-pixel eye row through the whole
 * lookout dialogue (scale 241 talking face, intro cutscene). These values
 * came from an empirical 16×16 phase grid with two hard constraints — every
 * draw of that cutscene keeps an eye, AND the town-dock resting pose (room
 * 33, standing at fixed box scale 210) keeps its eye in both mirror senses
 * (a first pick of PHASE_X = 13/16 satisfied the cutscene but blinded the
 * dock) — then ranked by eye misses across every scale MI1's walk boxes and
 * scale slots actually use. At scale 255 any phase < 1 is identity.
 * (A bit-reversal scale-table variant was trialled and reverted: better
 * static fidelity vs the oracle, but its count-based sizes fluctuate ±1
 * across walk frames — visible strut. See PROGRESS.md Tier-2.)
 */
const PHASE_Y = 11 / 16;
const PHASE_X = 3 / 8;

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
   * 1-based z-plane (SCUMM `_zbuf`) that masks this actor: `k` = masked
   * by `zPlanes[k-1]` alone; 0 (default) = in front of every plane.
   */
  readonly clipPlane?: number;
  /** Z-planes in source order — `zPlanes[0]` corresponds to `ZP01`. */
  readonly zPlanes?: readonly DecodedZPlane[];
  /** Draw horizontally mirrored, reflected about the actor's anchor X. */
  readonly mirror?: boolean;
  /** Actor scale, 0..255 where 255 = 100%; the sprite shrinks toward the anchor. */
  readonly scale?: number;
  /** Running `_xmove`/`_ymove` for this limb (from {@link PreparedLimb}),
   *  added to the frame's own offset. Default 0. */
  readonly accX?: number;
  readonly accY?: number;
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
  accX = 0,
  accY = 0,
): ActorPlacement {
  const s = Math.max(0, Math.min(255, scale));
  const width = Math.max(1, Math.round((frame.width * s) / 255));
  const height = Math.max(1, Math.round((frame.height * s) / 255));
  const redirX = Math.round(((frame.redirX + accX) * s) / 255);
  const redirY = Math.round(((frame.redirY + accY) * s) / 255);
  // Anchor (feet) stays put; the offset scales with the frame so the sprite
  // shrinks toward it. Mirror reflects the span about actorX.
  const left = mirror ? actorX - redirX - width : actorX + redirX;
  const top = actorY + redirY;
  return { left, top, width, height };
}

/** A limb that will draw this frame: its index and decoded picture. */
export interface PreparedLimb {
  readonly limbIdx: number;
  readonly frame: DecodedCostumeFrame;
  /** Running `_xmove`/`_ymove` at this limb — the sum of earlier-drawn limbs'
   *  xinc/yinc. Added to the frame's own offset at placement time. */
  readonly accX: number;
  readonly accY: number;
}

/** Everything needed to draw (and hit-test) an actor this frame; resolved by
 *  {@link prepareActorDraw}. */
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
 * Resolve an actor's drawable limbs and on-screen extent from costume +
 * anim + position alone (no framebuffer) — the one geometry source for
 * both the compositor blit and `actorFromPos` hit-testing.
 */
export function prepareActorDraw(actor: Actor, costume: LoadedCostume): ActorDrawPrep {
  // Only West ever mirrors; the format bit-7 flag means "dedicated
  // per-direction art, do NOT mirror West" — it never makes East flip.
  // See pages/docs/scumm/costume-anim.md §Mirroring (cost107 is the case).
  const facing = actor.facing;
  const mirror = facing === 'W' && !costume.header.mirrorFlag;

  // SCUMM raises a sprite by its elevation (drawn at `y − elevation`, the feet
  // anchor lifted). MUST match the `actorY` composeFrame passes compositeActor,
  // or the hit-box and the pixels drift. Meathook's small inner door (room 37
  // actor 5, y=0 elevation=−100) draws 100px down over the cage — without this
  // it drew off the top of the room. See pages/docs/scumm/costume-anim.md.
  const drawY = actor.y - actor.elevation;

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

  // Running `_xmove`/`_ymove`: each drawn limb's xinc/yinc shifts every
  // SUBSEQUENT limb; limbs that don't draw must not accumulate.
  // See pages/docs/scumm/costume-anim.md §"Limbs assemble".
  let accX = 0,
    accY = 0;

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
      limbs.push({ limbIdx, frame, accX, accY });
      const place = actorFramePlacement(frame, actor.x, drawY, mirror, actor.scale, accX, accY);
      if (place.left < bLeft) bLeft = place.left;
      if (place.top < bTop) bTop = place.top;
      if (place.left + place.width > bRight) bRight = place.left + place.width;
      if (place.top + place.height > bBottom) bBottom = place.top + place.height;
      accX += frame.xinc;
      accY += frame.yinc;
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
  // An actor is masked by its clipPlane's plane ALONE — never the OR of
  // planes 0..k (MI1 room 30 breaks otherwise; pages/docs/scumm/zplane.md §6).
  const maskPlane =
    clipPlane > 0 && clipPlane <= zPlanes.length ? zPlanes[clipPlane - 1]! : null;
  const mirror = opts.mirror ?? false;
  const scale = Math.max(0, Math.min(255, opts.scale ?? 255));
  const accX = opts.accX ?? 0;
  const accY = opts.accY ?? 0;

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

  const { left, top, width: drawW, height: drawH } = actorFramePlacement(
    frame,
    actorX,
    actorY,
    mirror,
    scale,
    accX,
    accY,
  );

  const startX = Math.max(0, -left);
  const endX = Math.min(drawW, fbWidth - left);
  const startY = Math.max(0, -top);
  const endY = Math.min(drawH, fbHeight - top);

  for (let py = startY; py < endY; py++) {
    const ry = top + py;
    const sy = Math.min(frame.height - 1, Math.floor(((py + PHASE_Y) * frame.height) / drawH));
    const frameRowBase = sy * frame.width;
    const fbRowBase = ry * fbWidth;
    for (let px = startX; px < endX; px++) {
      const sx = Math.min(frame.width - 1, Math.floor(((px + PHASE_X) * frame.width) / drawW));
      const srcPx = mirror ? frame.width - 1 - sx : sx;
      const idx = frame.pixels[frameRowBase + srcPx]!;
      if (idx === COSTUME_FRAME_TRANSPARENT) continue;
      const rx = left + px;

      if (maskPlane && maskPlane.mask[ry * fbWidth + rx]) continue;

      framebuffer[fbRowBase + rx] = costPalette[idx]!;
    }
  }
}
