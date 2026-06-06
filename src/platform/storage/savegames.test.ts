import { beforeEach, describe, expect, it } from 'vitest';
import type { SaveState } from '../../engine/vm/savestate';
import { SAVE_VERSION } from '../../engine/vm/savestate';
import {
  deleteAllSaves,
  deleteSave,
  listSaves,
  readSave,
  SaveStoreError,
  writeSave,
} from './savegames';

/** Minimal in-memory localStorage for the node test environment. */
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

function fakeState(room: number, savedAt: number): SaveState {
  // Only the fields the store reads (currentRoom, savedAt) need to be real.
  return { version: SAVE_VERSION, game: 'MI1', currentRoom: room, savedAt } as SaveState;
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new MemStorage() as unknown as Storage;
});

describe('savegames storage', () => {
  it('starts empty', () => {
    expect(listSaves('MI1')).toEqual([]);
    expect(readSave('MI1', 'slot1')).toBeNull();
  });

  it('writes, lists, and reads a slot', () => {
    writeSave('MI1', 'slot1', fakeState(33, 1000));
    expect(listSaves('MI1')).toEqual([{ name: 'slot1', savedAt: 1000, room: 33 }]);
    expect(readSave('MI1', 'slot1')!.currentRoom).toBe(33);
  });

  it('overwrites a slot of the same name without duplicating the index entry', () => {
    writeSave('MI1', 'slot1', fakeState(33, 1000));
    writeSave('MI1', 'slot1', fakeState(38, 2000));
    const list = listSaves('MI1');
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ name: 'slot1', savedAt: 2000, room: 38 });
    expect(readSave('MI1', 'slot1')!.currentRoom).toBe(38);
  });

  it('lists most-recent first', () => {
    writeSave('MI1', 'old', fakeState(10, 1000));
    writeSave('MI1', 'new', fakeState(33, 5000));
    writeSave('MI1', 'mid', fakeState(20, 3000));
    expect(listSaves('MI1').map((s) => s.name)).toEqual(['new', 'mid', 'old']);
  });

  it('scopes slots by game id', () => {
    writeSave('MI1', 'slot1', fakeState(33, 1000));
    writeSave('MI2', 'slot1', fakeState(99, 1000));
    expect(listSaves('MI1').map((s) => s.room)).toEqual([33]);
    expect(listSaves('MI2').map((s) => s.room)).toEqual([99]);
    expect(readSave('MI1', 'slot1')!.currentRoom).toBe(33);
    expect(readSave('MI2', 'slot1')!.currentRoom).toBe(99);
  });

  it('deletes a slot and its index entry', () => {
    writeSave('MI1', 'a', fakeState(1, 1000));
    writeSave('MI1', 'b', fakeState(2, 2000));
    deleteSave('MI1', 'a');
    expect(listSaves('MI1').map((s) => s.name)).toEqual(['b']);
    expect(readSave('MI1', 'a')).toBeNull();
  });

  it('deleteAllSaves clears every slot for one game, leaving others intact', () => {
    writeSave('inst-1', 'a', fakeState(1, 1000));
    writeSave('inst-1', 'b', fakeState(2, 2000));
    writeSave('inst-2', 'a', fakeState(3, 3000));

    deleteAllSaves('inst-1');

    expect(listSaves('inst-1')).toEqual([]);
    expect(readSave('inst-1', 'a')).toBeNull();
    expect(readSave('inst-1', 'b')).toBeNull();
    // A different install's saves are untouched.
    expect(listSaves('inst-2').map((s) => s.name)).toEqual(['a']);
  });

  it('throws SaveStoreError when storage is unavailable', () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    expect(() => writeSave('MI1', 'x', fakeState(1, 1))).toThrow(SaveStoreError);
    // Reads degrade quietly.
    expect(listSaves('MI1')).toEqual([]);
    expect(readSave('MI1', 'x')).toBeNull();
  });

  it('tolerates a corrupt index / slot payload', () => {
    const ls = globalThis.localStorage;
    ls.setItem('grogvm:saves:MI1', '{not json');
    ls.setItem('grogvm:save:MI1:bad', '{not json');
    expect(listSaves('MI1')).toEqual([]);
    expect(readSave('MI1', 'bad')).toBeNull();
  });
});
