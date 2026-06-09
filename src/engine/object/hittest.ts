/** Topmost-first object hit-testing. Rules: pages/docs/scumm/objects.md §7/§7a. */

import type { LoadedObject } from './loader';

const UNTOUCHABLE_FLAG = 0x80;

export interface PickObjectArgs {
  readonly objects: ReadonlyMap<number, LoadedObject>;
  /** Insertion order = paint order; hit-testing iterates it in reverse. */
  readonly drawQueue: ReadonlySet<number>;
  /** Pixel x in room coords. */
  readonly x: number;
  /** Pixel y in room coords. */
  readonly y: number;
  /** True if the object is in the runtime Untouchable class (class 32). */
  readonly isUntouchable?: (objId: number) => boolean;
  /**
   * Runtime draw position set by `drawObject … at` (SO_AT), or `undefined`
   * for the IMHD default — the hotspot must move with the drawn object.
   */
  readonly getObjectPosition?: (objId: number) => { x: number; y: number } | undefined;
}

export function pickObject(args: PickObjectArgs): number | null {
  const { objects, drawQueue, x, y, isUntouchable, getObjectPosition } = args;
  const untouchable = (id: number): boolean => (isUntouchable ? isUntouchable(id) : false);

  // Drawn objects topmost-first, then un-drawn objects in OBCD source order
  // (those don't paint but stay interactable — hotspots without an image).
  const drawn = [...drawQueue].reverse();
  for (const id of drawn) {
    const obj = objects.get(id);
    if (!obj) continue;
    if (untouchable(id)) continue;
    if (containsPoint(obj, x, y, getObjectPosition?.(id))) return id;
  }

  for (const obj of objects.values()) {
    if (drawQueue.has(obj.objId)) continue;
    if (untouchable(obj.objId)) continue;
    if (containsPoint(obj, x, y, getObjectPosition?.(obj.objId))) return obj.objId;
  }

  return null;
}

/**
 * Hotspot box in room px. CDHD (8-px units) is the design box; an SO_AT
 * reposition shifts it by the draw displacement `(pos − imhd)`.
 */
export function objectHitBox(
  obj: LoadedObject,
  pos?: { x: number; y: number },
): { left: number; top: number; right: number; bottom: number } {
  const left = obj.cdhd.x * 8 + (pos ? pos.x - obj.imhd.x : 0);
  const top = obj.cdhd.y * 8 + (pos ? pos.y - obj.imhd.y : 0);
  return { left, top, right: left + obj.cdhd.width * 8, bottom: top + obj.cdhd.height * 8 };
}

function containsPoint(
  obj: LoadedObject,
  x: number,
  y: number,
  pos?: { x: number; y: number },
): boolean {
  if (obj.cdhd.flags & UNTOUCHABLE_FLAG) return false;
  const { left, top, right, bottom } = objectHitBox(obj, pos);
  return x >= left && x < right && y >= top && y < bottom;
}
