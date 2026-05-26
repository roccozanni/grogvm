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
 * Z-plane rule: an actor at z-level `actorZ` is hidden at (x, y) iff
 * any plane whose 1-based index is greater than `actorZ` has its bit
 * set at (x, y). Plane index 1 = `ZP01` (= `zPlanes[0]`), index 2 =
 * `ZP02`, and so on. `actorZ` defaults to 0 — the back-most depth
 * band, which is occluded by any plane bit. Some MI1/MI2 rooms mark
 * the same pixel in multiple planes; that's redundant under this rule
 * but matches the game data.
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
  /** Actor z-level. Default 0 (back). */
  readonly actorZ?: number;
  /** Z-planes in source order — `zPlanes[0]` corresponds to `ZP01`. */
  readonly zPlanes?: readonly DecodedZPlane[];
}

export function compositeActor(opts: CompositeActorOptions): void {
  const { framebuffer, fbWidth, fbHeight, frame, costPalette, actorX, actorY } = opts;
  const actorZ = opts.actorZ ?? 0;
  const zPlanes = opts.zPlanes ?? [];

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

  const left = actorX + frame.redirX;
  const top = actorY + frame.redirY;

  // Clip the iteration range to the on-screen portion of the frame so
  // we never index out of bounds and avoid touching off-screen pixels.
  const startX = Math.max(0, -left);
  const endX = Math.min(frame.width, fbWidth - left);
  const startY = Math.max(0, -top);
  const endY = Math.min(frame.height, fbHeight - top);

  for (let py = startY; py < endY; py++) {
    const ry = top + py;
    const frameRowBase = py * frame.width;
    const fbRowBase = ry * fbWidth;
    for (let px = startX; px < endX; px++) {
      const idx = frame.pixels[frameRowBase + px]!;
      if (idx === COSTUME_FRAME_TRANSPARENT) continue;
      const rx = left + px;

      // Z-plane occlusion: hidden if any plane whose 1-based index >
      // actorZ has its bit set at this pixel.
      let occluded = false;
      for (let p = 0; p < zPlanes.length; p++) {
        const planeIndex = p + 1;
        if (planeIndex <= actorZ) continue;
        if (zPlanes[p]!.mask[ry * fbWidth + rx]) {
          occluded = true;
          break;
        }
      }
      if (occluded) continue;

      framebuffer[fbRowBase + rx] = costPalette[idx]!;
    }
  }
}
