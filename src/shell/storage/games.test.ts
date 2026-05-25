import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { addGame, listGames, removeGame, findInstalledGame } from './games';

function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

async function resetDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('webscumm');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('games storage', () => {
  beforeEach(resetDb);

  it('starts empty', async () => {
    expect(await listGames()).toEqual([]);
  });

  it('adds and lists a game', async () => {
    const stored = await addGame({
      gameId: 'MI1',
      displayName: 'The Secret of Monkey Island',
      directoryHandle: fakeHandle('MI1'),
    });

    expect(stored.id).toBeTruthy();
    expect(stored.installedAt).toBeGreaterThan(0);

    const list = await listGames();
    expect(list).toHaveLength(1);
    expect(list[0]!.gameId).toBe('MI1');
    expect(list[0]!.displayName).toBe('The Secret of Monkey Island');
  });

  it('removes a game', async () => {
    const stored = await addGame({
      gameId: 'MI1',
      displayName: 'X',
      directoryHandle: fakeHandle('X'),
    });
    await removeGame(stored.id);
    expect(await listGames()).toEqual([]);
  });

  it('stores multiple games independently', async () => {
    await addGame({ gameId: 'MI1', displayName: 'MI1', directoryHandle: fakeHandle('a') });
    await addGame({ gameId: 'MI2', displayName: 'MI2', directoryHandle: fakeHandle('b') });
    const list = await listGames();
    expect(list).toHaveLength(2);
    expect(list.map((g) => g.gameId).sort()).toEqual(['MI1', 'MI2']);
  });
});

describe('findInstalledGame', () => {
  beforeEach(resetDb);

  it('returns undefined when no game with that id is installed', async () => {
    expect(await findInstalledGame('MI1')).toBeUndefined();
  });

  it('returns the installed game when present', async () => {
    const stored = await addGame({
      gameId: 'MI1',
      displayName: 'MI1',
      directoryHandle: fakeHandle('a'),
    });
    const found = await findInstalledGame('MI1');
    expect(found?.id).toBe(stored.id);
  });

  it('only matches the requested gameId', async () => {
    await addGame({ gameId: 'MI2', displayName: 'MI2', directoryHandle: fakeHandle('b') });
    expect(await findInstalledGame('MI1')).toBeUndefined();
    expect((await findInstalledGame('MI2'))?.gameId).toBe('MI2');
  });
});
