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
    expect(pickObject({ objects: objs, x: 100, y: 100 })).toBeNull();
  });

  it('returns the single matching object', () => {
    // 4 × 4 cells = 32 × 32 px starting at (0, 0)
    const objs = objects(makeObj(7, { x: 0, y: 0, width: 4, height: 4 }));
    expect(pickObject({ objects: objs, x: 5, y: 5 })).toBe(7);
  });

  it('honours the 8-pixel-unit conversion (right/bottom edges exclusive)', () => {
    // x=2, w=3 cells = pixel range [16, 40). 39 is in, 40 is out.
    const objs = objects(makeObj(11, { x: 2, y: 2, width: 3, height: 3 }));
    expect(pickObject({ objects: objs, x: 39, y: 39 })).toBe(11);
    expect(pickObject({ objects: objs, x: 40, y: 39 })).toBeNull();
    expect(pickObject({ objects: objs, x: 16, y: 16 })).toBe(11);
    expect(pickObject({ objects: objs, x: 15, y: 15 })).toBeNull();
  });

  it('first object in source order wins among overlapping hotspots', () => {
    // The store safe (room 30): "la maniglia" #390 is declared FIRST, its box
    // nested inside the safe #389's — the nested hotspot wins inside its box,
    // the container everywhere else. Draw state plays no part.
    const objs = objects(
      makeObj(390, { x: 22, y: 7, width: 3, height: 3, parent: 2 }, 'la maniglia'),
      makeObj(389, { x: 20, y: 5, width: 5, height: 5 }, 'la cassaforte'),
    );
    expect(pickObject({ objects: objs, x: 180, y: 60 })).toBe(390); // inside the handle
    expect(pickObject({ objects: objs, x: 165, y: 45 })).toBe(389); // safe outside it
  });

  it('parent flags 0x0 requires the container CLOSED (state 0)', () => {
    // The handle is only a hotspot while the safe is shut; the open safe
    // (state 1) swallows its whole box.
    const objs = objects(
      makeObj(390, { x: 22, y: 7, width: 3, height: 3, parent: 2 }, 'la maniglia'),
      makeObj(389, { x: 20, y: 5, width: 5, height: 5 }, 'la cassaforte'),
    );
    const closed = (): number | undefined => 0;
    const open = (id: number): number | undefined => (id === 389 ? 1 : 0);
    expect(pickObject({ objects: objs, x: 180, y: 60, getObjectState: closed })).toBe(390);
    expect(pickObject({ objects: objs, x: 180, y: 60, getObjectState: open })).toBe(389);
  });

  it('parent flags 0x80 requires the container OPEN (non-0 state)', () => {
    // The cabin cupboard (room 7): "il baule" appears once "l'armadio" opens.
    const objs = objects(
      makeObj(81, { x: 0, y: 0, width: 2, height: 2, parent: 2, flags: 0x80 }, 'il baule'),
      makeObj(79, { x: 0, y: 0, width: 4, height: 4 }, "l'armadio"),
    );
    expect(pickObject({ objects: objs, x: 5, y: 5 })).toBe(79); // closed → chest hidden
    expect(
      pickObject({ objects: objs, x: 5, y: 5, getObjectState: (id) => (id === 79 ? 1 : 0) }),
    ).toBe(81);
  });

  it('parent chains nest, and an untouchable link still gates', () => {
    // Room 7 in full: chest → interior zone (untouchable) → cupboard. The
    // interior is never a hit itself but its state still gates the chest.
    const objs = objects(
      makeObj(81, { x: 0, y: 0, width: 2, height: 2, parent: 2, flags: 0x80 }, 'il baule'),
      makeObj(80, { x: 0, y: 0, width: 2, height: 4, parent: 3, flags: 0x80 }),
      makeObj(79, { x: 0, y: 0, width: 4, height: 4 }, "l'armadio"),
    );
    const isUntouchable = (id: number): boolean => id === 80;
    const states = new Map<number, number>();
    const args = { objects: objs, x: 5, y: 5, isUntouchable, getObjectState: (id: number) => states.get(id) };
    expect(pickObject(args)).toBe(79); // everything shut
    states.set(80, 1); // interior revealed but cupboard still shut → chain fails
    expect(pickObject(args)).toBe(79);
    states.set(79, 1); // both open → the chest resolves; the zone never does
    expect(pickObject(args)).toBe(81);
  });

  it('CDHD flags 0x80 on a parentless object does NOT hide it (not an untouchable bit)', () => {
    const objs = objects(makeObj(5, { x: 0, y: 0, width: 4, height: 4, flags: 0x80 }));
    expect(pickObject({ objects: objs, x: 5, y: 5 })).toBe(5);
  });

  it('skips objects the isUntouchable predicate rejects (Untouchable class)', () => {
    // Two overlapping objects; the first-declared one is Untouchable, so the
    // hit falls through to the next — mirroring SCUMM's findObject hiding
    // the not-yet-docked ship (#430) in room 33.
    const objs = objects(
      makeObj(1, { x: 0, y: 0, width: 4, height: 4 }, 'ship'),
      makeObj(2, { x: 0, y: 0, width: 4, height: 4 }, 'rock'),
    );
    const isUntouchable = (id: number): boolean => id === 1;
    expect(pickObject({ objects: objs, x: 1, y: 1, isUntouchable })).toBe(2);
    // With nothing else under it, an Untouchable object returns null (hidden).
    const onlyShip = objects(makeObj(1, { x: 0, y: 0, width: 4, height: 4 }, 'ship'));
    expect(pickObject({ objects: onlyShip, x: 1, y: 1, isUntouchable })).toBeNull();
  });
});
