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

import { COSTUME_FRAME_TRANSPARENT, type DecodedCostumeFrame } from './costume-frame';
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
