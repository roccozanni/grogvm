/**
 * Object hit-testing (`findObject`). Rules: pages/docs/scumm/objects.md §7a.
 *
 * Selection is draw-agnostic: objects are scanned in OBCD source order and
 * the FIRST containing object wins — rooms author nested hotspots before
 * their containers (the store's "la maniglia" #390 is declared right before
 * its safe #389). Two gates apply:
 *
 * - the runtime Untouchable class (32), via `isUntouchable`;
 * - the CDHD parent chain: `parent` is the 1-based source-order index of a
 *   container object, and flags bit 0x80 is the REQUIRED parent state — set
 *   means "parent must be non-0 / open" (the cabin's chest inside the open
 *   cupboard), clear means "parent must be 0 / closed" (the safe's handle,
 *   the jail cells' locks). A failed link hides the object from hit-testing;
 *   chains nest (chest → cupboard-interior → cupboard).
 */

import type { LoadedObject } from './loader';

const PARENT_STATE_FLAG = 0x80;

export interface PickObjectArgs {
  /** Insertion order = OBCD source order; hit-testing scans it forward. */
  readonly objects: ReadonlyMap<number, LoadedObject>;
  /** Pixel x in room coords. */
  readonly x: number;
  /** Pixel y in room coords. */
  readonly y: number;
  /** True if the object is in the runtime Untouchable class (class 32). */
  readonly isUntouchable?: (objId: number) => boolean;
  /** Current object state, for the parent-chain gate (default 0). */
  readonly getObjectState?: (objId: number) => number | undefined;
  /**
   * Runtime draw position set by `drawObject … at` (SO_AT), or `undefined`
   * for the IMHD default — the hotspot must move with the drawn object.
   */
  readonly getObjectPosition?: (objId: number) => { x: number; y: number } | undefined;
}

export function pickObject(args: PickObjectArgs): number | null {
  const { objects, x, y, isUntouchable, getObjectState, getObjectPosition } = args;
  const list = [...objects.values()];
  for (const obj of list) {
    if (isUntouchable?.(obj.objId)) continue;
    if (!containsPoint(obj, x, y, getObjectPosition?.(obj.objId))) continue;
    if (!parentChainSatisfied(obj, list, getObjectState)) continue;
    return obj.objId;
  }
  return null;
}

/**
 * Walk the parent chain: every link's container must sit in the required
 * state (flags 0x80 → non-0, else 0). An untouchable container still gates —
 * untouchability hides it from hits, not from being a state switch (the
 * cabin chest's middle link is an untouchable interior zone).
 */
function parentChainSatisfied(
  obj: LoadedObject,
  list: ReadonlyArray<LoadedObject>,
  getObjectState?: (objId: number) => number | undefined,
): boolean {
  let cur = obj;
  for (let hops = 0; cur.cdhd.parent !== 0 && hops < list.length; hops++) {
    const parent = list[cur.cdhd.parent - 1];
    if (!parent) return false;
    const required = cur.cdhd.flags & PARENT_STATE_FLAG ? 1 : 0;
    const state = getObjectState?.(parent.objId) ?? 0;
    if ((state !== 0 ? 1 : 0) !== required) return false;
    cur = parent;
  }
  return true;
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
  const { left, top, right, bottom } = objectHitBox(obj, pos);
  return x >= left && x < right && y >= top && y < bottom;
}
