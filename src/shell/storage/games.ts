import type { GameId } from '../install/detect';

const DB_NAME = 'grogvm';
const DB_VERSION = 1;
const STORE = 'games';

export interface StoredGame {
  id: string;
  gameId: GameId;
  displayName: string;
  directoryHandle: FileSystemDirectoryHandle;
  installedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withDb<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  try {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    return await fn(store);
  } finally {
    db.close();
  }
}

export async function listGames(): Promise<StoredGame[]> {
  return withDb('readonly', (store) => request(store.getAll() as IDBRequest<StoredGame[]>));
}

export async function findInstalledGame(gameId: GameId): Promise<StoredGame | undefined> {
  const games = await listGames();
  return games.find((g) => g.gameId === gameId);
}

export async function addGame(
  game: Omit<StoredGame, 'id' | 'installedAt'>,
): Promise<StoredGame> {
  const stored: StoredGame = {
    id: crypto.randomUUID(),
    installedAt: Date.now(),
    ...game,
  };
  await withDb('readwrite', (store) => request(store.add(stored)));
  return stored;
}

export async function removeGame(id: string): Promise<void> {
  await withDb('readwrite', (store) => request(store.delete(id)));
}
