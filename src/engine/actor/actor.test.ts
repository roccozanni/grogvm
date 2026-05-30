import { describe, expect, it } from 'vitest';
import {
  ActorTable,
  DEFAULT_ACTOR_COUNT,
  DEFAULT_SCALE,
  DEFAULT_WALK_SPEED_X,
  DEFAULT_WALK_SPEED_Y,
  createActor,
  putActor,
  setActorCostume,
} from './actor';

describe('createActor', () => {
  it('initializes a dormant actor with sensible defaults', () => {
    const a = createActor(5);
    expect(a.id).toBe(5);
    expect(a.room).toBe(0);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
    expect(a.costume).toBe(0);
    expect(a.facing).toBe('S');
    expect(a.visible).toBe(true);
    expect(a.scale).toBe(DEFAULT_SCALE);
    expect(a.walkSpeedX).toBe(DEFAULT_WALK_SPEED_X);
    expect(a.walkSpeedY).toBe(DEFAULT_WALK_SPEED_Y);
    expect(a.isMoving).toBe(false);
    expect(a.walkPath).toHaveLength(0);
    expect(a.anim.animId).toBe(0);
  });
});

describe('putActor', () => {
  it('updates position and room, cancels any in-flight walk', () => {
    const a = createActor(1);
    a.isMoving = true;
    a.walkTarget = { x: 10, y: 20 };
    a.walkPath = [
      { x: 5, y: 5 },
      { x: 10, y: 20 },
    ];
    a.walkPathIdx = 1;

    putActor(a, 100, 50, 7);

    expect(a.x).toBe(100);
    expect(a.y).toBe(50);
    expect(a.room).toBe(7);
    expect(a.isMoving).toBe(false);
    expect(a.walkTarget).toBeNull();
    expect(a.walkPath).toHaveLength(0);
    expect(a.walkPathIdx).toBe(0);
  });

  it('coerces floats to integers', () => {
    const a = createActor(1);
    putActor(a, 100.7, 50.2, 5.9);
    expect(a.x).toBe(100);
    expect(a.y).toBe(50);
    expect(a.room).toBe(5);
  });
});

describe('setActorCostume', () => {
  it('assigns the costume and resets anim state', () => {
    const a = createActor(1);
    // Pretend the actor was mid-anim — every limb active and cursored.
    a.anim = {
      animId: 7,
      stopped: 0,
      limbs: a.anim.limbs.map((l) => ({ ...l, active: true, cursor: 5 })),
    };
    setActorCostume(a, 42);
    expect(a.costume).toBe(42);
    expect(a.anim.animId).toBe(0);
    expect(a.anim.limbs.every((l) => l.active === false)).toBe(true);
  });
});

describe('ActorTable', () => {
  it('builds the requested number of slots plus the sentinel', () => {
    const table = new ActorTable(DEFAULT_ACTOR_COUNT);
    expect(table.capacity).toBe(13);
    // The sentinel must not be reachable through `get`
    expect(() => table.get(0)).toThrow();
    // Every valid id resolves
    for (let i = 1; i <= 13; i++) expect(table.get(i).id).toBe(i);
  });

  it('rejects out-of-range ids', () => {
    const table = new ActorTable(5);
    expect(() => table.get(6)).toThrow();
    expect(() => table.get(-1)).toThrow();
  });

  it('rejects capacity < 1', () => {
    expect(() => new ActorTable(0)).toThrow();
  });

  it('inRoom filters by room + visibility, preserving id order', () => {
    const table = new ActorTable(5);
    putActor(table.get(1), 10, 10, 7);
    putActor(table.get(2), 20, 20, 8);
    putActor(table.get(3), 30, 30, 7);
    table.get(3).visible = false;
    putActor(table.get(4), 40, 40, 7);

    const inRoom7 = table.inRoom(7).map((a) => a.id);
    expect(inRoom7).toEqual([1, 4]);
    const inRoom8 = table.inRoom(8).map((a) => a.id);
    expect(inRoom8).toEqual([2]);
    const inRoom0 = table.inRoom(0).map((a) => a.id);
    expect(inRoom0).toEqual([5]); // dormant slot, room=0, visible by default
  });

  it('all() yields every populated slot (including dormant)', () => {
    const table = new ActorTable(3);
    const ids = [...table.all()].map((a) => a.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});
