import { describe, expect, it } from 'vitest';
import type { CDHD, LoadedObject } from './loader';
import { pickObject } from './hittest';

function makeObj(
  objId: number,
  cdhd: Partial<CDHD> & Pick<CDHD, 'x' | 'y' | 'width' | 'height'>,
  name = '',
): LoadedObject {
  const fullCdhd: CDHD = {
    objId,
    x: cdhd.x,
    y: cdhd.y,
    width: cdhd.width,
    height: cdhd.height,
    flags: cdhd.flags ?? 0,
    parent: cdhd.parent ?? 0,
    walkX: cdhd.walkX ?? 0,
    walkY: cdhd.walkY ?? 0,
    actorDir: cdhd.actorDir ?? 0,
  };
  return {
    objId,
    cdhd: fullCdhd,
    imhd: {
      objId,
      numImages: 0,
      flags: 0,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    },
    images: new Map(),
    name,
    verbs: new Map(),
  };
}

function objects(
  ...list: ReadonlyArray<LoadedObject>
): ReadonlyMap<number, LoadedObject> {
  const m = new Map<number, LoadedObject>();
  for (const o of list) m.set(o.objId, o);
  return m;
}

describe('pickObject', () => {
  it('returns null when no object contains the point', () => {
    const objs = objects(makeObj(1, { x: 0, y: 0, width: 4, height: 4 }));
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 100, y: 100 })).toBeNull();
  });

  it('returns the single matching object', () => {
    // 4 × 4 cells = 32 × 32 px starting at (0, 0)
    const objs = objects(makeObj(7, { x: 0, y: 0, width: 4, height: 4 }));
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 5, y: 5 })).toBe(7);
  });

  it('honours the 8-pixel-unit conversion (right/bottom edges exclusive)', () => {
    // x=2, w=3 cells = pixel range [16, 40). 39 is in, 40 is out.
    const objs = objects(makeObj(11, { x: 2, y: 2, width: 3, height: 3 }));
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 39, y: 39 })).toBe(11);
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 40, y: 39 })).toBeNull();
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 16, y: 16 })).toBe(11);
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 15, y: 15 })).toBeNull();
  });

  it('skips untouchable objects (CDHD flags & 0x80)', () => {
    const objs = objects(
      makeObj(1, { x: 0, y: 0, width: 4, height: 4, flags: 0x80 }, 'invisible'),
      makeObj(2, { x: 0, y: 0, width: 4, height: 4 }, 'real'),
    );
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 5, y: 5 })).toBe(2);
  });

  it('drawn objects beat un-drawn objects when both contain the point', () => {
    const objs = objects(
      makeObj(1, { x: 0, y: 0, width: 4, height: 4 }, 'background'),
      makeObj(2, { x: 0, y: 0, width: 4, height: 4 }, 'drawn-on-top'),
    );
    expect(
      pickObject({ objects: objs, drawQueue: new Set([2]), x: 5, y: 5 }),
    ).toBe(2);
  });

  it('among drawn objects, most-recently-queued wins (reverse insertion order)', () => {
    const objs = objects(
      makeObj(1, { x: 0, y: 0, width: 4, height: 4 }),
      makeObj(2, { x: 0, y: 0, width: 4, height: 4 }),
      makeObj(3, { x: 0, y: 0, width: 4, height: 4 }),
    );
    // 1 queued first, then 2, then 3 — 3 paints last so 3 is topmost.
    const drawQueue = new Set<number>();
    drawQueue.add(1);
    drawQueue.add(2);
    drawQueue.add(3);
    expect(pickObject({ objects: objs, drawQueue, x: 5, y: 5 })).toBe(3);
  });

  it('falls back to OBCD source order for un-drawn objects', () => {
    const objs = objects(
      makeObj(10, { x: 0, y: 0, width: 4, height: 4 }, 'first'),
      makeObj(20, { x: 0, y: 0, width: 4, height: 4 }, 'second'),
    );
    expect(pickObject({ objects: objs, drawQueue: new Set(), x: 5, y: 5 })).toBe(10);
  });

  it('drawn ids missing from the objects map are skipped (no throw)', () => {
    const objs = objects(makeObj(1, { x: 0, y: 0, width: 4, height: 4 }));
    expect(
      pickObject({ objects: objs, drawQueue: new Set([999]), x: 5, y: 5 }),
    ).toBe(1);
  });

  it('skips objects the isUntouchable predicate rejects (Untouchable class)', () => {
    // Two overlapping objects; the topmost (drawn) one is Untouchable, so the
    // hit falls through to the one below — mirroring SCUMM's findObject hiding
    // the not-yet-docked ship (#430) in room 33.
    const objs = objects(
      makeObj(1, { x: 0, y: 0, width: 4, height: 4 }, 'rock'),
      makeObj(2, { x: 0, y: 0, width: 4, height: 4 }, 'ship'),
    );
    const drawQueue = new Set([1, 2]); // 2 painted last = topmost
    const isUntouchable = (id: number): boolean => id === 2;
    expect(pickObject({ objects: objs, drawQueue, x: 1, y: 1, isUntouchable })).toBe(1);
    // With nothing else under it, an Untouchable object returns null (hidden).
    const onlyShip = objects(makeObj(2, { x: 0, y: 0, width: 4, height: 4 }, 'ship'));
    expect(
      pickObject({ objects: onlyShip, drawQueue: new Set(), x: 1, y: 1, isUntouchable }),
    ).toBeNull();
  });
});
