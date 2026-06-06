import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { addGame, listGames, removeGame, findGameByHash, type StoredGame } from './games';

function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

function gameArg(over: Partial<Omit<StoredGame, 'id' | 'installedAt'>> = {}) {
  return {
    gameId: 'MI1' as const,
    displayName: 'The Secret of Monkey Island',
    contentHash: 'hash-en',
    variant: 'English',
    directoryHandle: fakeHandle('MI1'),
    ...over,
  };
}

async function resetDb(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('grogvm');
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
    const stored = await addGame(gameArg());

    expect(stored.id).toBeTruthy();
    expect(stored.installedAt).toBeGreaterThan(0);

    const list = await listGames();
    expect(list).toHaveLength(1);
    expect(list[0]!.gameId).toBe('MI1');
    expect(list[0]!.variant).toBe('English');
    expect(list[0]!.contentHash).toBe('hash-en');
  });

  it('removes a game', async () => {
    const stored = await addGame(gameArg());
    await removeGame(stored.id);
    expect(await listGames()).toEqual([]);
  });

  it('stores two language variants of the same game independently', async () => {
    await addGame(gameArg({ contentHash: 'hash-en', variant: 'English', directoryHandle: fakeHandle('en') }));
    await addGame(gameArg({ contentHash: 'hash-it', variant: 'Italiano', directoryHandle: fakeHandle('it') }));
    const list = await listGames();
    expect(list).toHaveLength(2);
    // Same gameId, distinct installs.
    expect(list.map((g) => g.gameId)).toEqual(['MI1', 'MI1']);
    expect(list.map((g) => g.variant).sort()).toEqual(['English', 'Italiano']);
  });
});

describe('findGameByHash', () => {
  beforeEach(resetDb);

  it('returns undefined when no game with that hash is installed', async () => {
    expect(await findGameByHash('hash-en')).toBeUndefined();
  });

  it('returns the installed game with the matching content hash', async () => {
    const stored = await addGame(gameArg({ contentHash: 'hash-en' }));
    const found = await findGameByHash('hash-en');
    expect(found?.id).toBe(stored.id);
  });

  it('does not match a different content hash (so EN and IT coexist)', async () => {
    await addGame(gameArg({ contentHash: 'hash-en', variant: 'English' }));
    expect(await findGameByHash('hash-it')).toBeUndefined();
    expect((await findGameByHash('hash-en'))?.variant).toBe('English');
  });
});
