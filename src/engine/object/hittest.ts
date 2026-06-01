/**
 * Hit-test a point against the objects in a room.
 *
 * # Selection rule
 *
 * Among the objects whose CDHD bounding box contains the point, the
 * "topmost" wins. v5 paint order is:
 *
 *   1. Room background
 *   2. Objects in `vm.objectDrawQueue` — drawn in queue order (later
 *      entries paint on top).
 *   3. Actors (handled elsewhere).
 *
 * So hit-test priority is the *reverse* of paint order among the
 * queued objects, then any unqueued objects in OBCD source order as a
 * tiebreaker (those don't paint, but they remain interactable per the
 * v5 convention — e.g. hotspots without an image).
 *
 * # The untouchable flag / class
 *
 * Two things hide an object from hit-testing:
 *   - CDHD `flags & 0x80` — a static "untouchable" bit baked into the
 *     object header.
 *   - The runtime **Untouchable class** (class 32 → bit 31), set from the
 *     index `DOBJ` class table at boot and toggled by `setClass`. This is
 *     how SCUMM keeps not-yet-active objects out of `findObject` — e.g.
 *     room 33's ship sprite (#430), Untouchable until it docks. The caller
 *     supplies this via `isUntouchable` (the VM owns the class map).
 *
 * # Coordinates
 *
 * CDHD stores `x`, `y`, `width`, `height` in **8-pixel units**. The
 * test rectangle in pixel coords is therefore
 * `[x*8, x*8 + w*8) × [y*8, y*8 + h*8)`. The point passed in is in
 * pixel room coords (matching what the input layer hands us).
 *
 * # Returns
 *
 * The object id of the topmost matching object, or `null` if nothing
 * is under the cursor.
 */

import type { LoadedObject } from './loader';

const UNTOUCHABLE_FLAG = 0x80;

export interface PickObjectArgs {
  /** All objects in the current room, keyed by id. */
  readonly objects: ReadonlyMap<number, LoadedObject>;
  /**
   * Object ids the room compositor is currently drawing. JS `Set`
   * preserves insertion order — later inserts paint on top, so we
   * iterate in reverse for hit-testing.
   */
  readonly drawQueue: ReadonlySet<number>;
  /** Pixel x in room coords. */
  readonly x: number;
  /** Pixel y in room coords. */
  readonly y: number;
  /**
   * True if the object is in the runtime Untouchable class (class 32) and
   * should be skipped — typically
   * `(id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0`.
   */
  readonly isUntouchable?: (objId: number) => boolean;
}

export function pickObject(args: PickObjectArgs): number | null {
  const { objects, drawQueue, x, y, isUntouchable } = args;
  const untouchable = (id: number): boolean => (isUntouchable ? isUntouchable(id) : false);

  // 1. Drawn objects, reverse insertion order = topmost first.
  const drawn = [...drawQueue].reverse();
  for (const id of drawn) {
    const obj = objects.get(id);
    if (!obj) continue;
    if (untouchable(id)) continue;
    if (containsPoint(obj, x, y)) return id;
  }

  // 2. Un-drawn objects in OBCD source order (the loader populates the
  //    map in source order; iterate in that order and skip anything
  //    we already checked).
  for (const obj of objects.values()) {
    if (drawQueue.has(obj.objId)) continue;
    if (untouchable(obj.objId)) continue;
    if (containsPoint(obj, x, y)) return obj.objId;
  }

  return null;
}

function containsPoint(obj: LoadedObject, x: number, y: number): boolean {
  if (obj.cdhd.flags & UNTOUCHABLE_FLAG) return false;
  const left = obj.cdhd.x * 8;
  const top = obj.cdhd.y * 8;
  const right = left + obj.cdhd.width * 8;
  const bottom = top + obj.cdhd.height * 8;
  return x >= left && x < right && y >= top && y < bottom;
}
