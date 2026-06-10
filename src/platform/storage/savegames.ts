/**
 * Save-game storage: named localStorage slots scoped per install, plus a
 * lightweight index so the UI can list slots without parsing every blob.
 * Reads degrade to empty/null; writes surface a typed {@link SaveStoreError}.
 */

import type { SaveState } from '../../engine/vm/savestate';

export interface SaveSlotMeta {
  readonly name: string;
  /** Epoch ms the slot was written. */
  readonly savedAt: number;
  /** Room id at save time. */
  readonly room: number;
}

export class SaveStoreError extends Error {
  constructor(detail: string) {
    super(`Save store: ${detail}`);
    this.name = 'SaveStoreError';
  }
}

const slotKey = (gameId: string, name: string): string => `grogvm:save:${gameId}:${name}`;
const indexKey = (gameId: string): string => `grogvm:saves:${gameId}`;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // accessing localStorage can throw (sandboxed iframes)
  }
}

function readIndex(gameId: string): SaveSlotMeta[] {
  const ls = store();
  if (!ls) return [];
  try {
    const raw = ls.getItem(indexKey(gameId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SaveSlotMeta[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(gameId: string, index: SaveSlotMeta[]): void {
  const ls = store();
  if (!ls) throw new SaveStoreError('localStorage is unavailable');
  ls.setItem(indexKey(gameId), JSON.stringify(index));
}

/** Slots for `gameId`, most-recently-saved first. */
export function listSaves(gameId: string): SaveSlotMeta[] {
  return readIndex(gameId).sort((a, b) => b.savedAt - a.savedAt);
}

/** Read a slot's full state, or `null` if it doesn't exist / is corrupt. */
export function readSave(gameId: string, name: string): SaveState | null {
  const ls = store();
  if (!ls) return null;
  try {
    const raw = ls.getItem(slotKey(gameId, name));
    return raw ? (JSON.parse(raw) as SaveState) : null;
  } catch {
    return null;
  }
}

/** Throws {@link SaveStoreError} when storage is unavailable or the quota is hit. */
export function writeSave(gameId: string, name: string, state: SaveState): void {
  const ls = store();
  if (!ls) throw new SaveStoreError('localStorage is unavailable');
  try {
    ls.setItem(slotKey(gameId, name), JSON.stringify(state));
  } catch (err) {
    throw new SaveStoreError(
      err instanceof Error && /quota/i.test(err.message)
        ? 'storage quota exceeded — delete a slot and retry'
        : `write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const meta: SaveSlotMeta = { name, savedAt: state.savedAt, room: state.currentRoom };
  const index = readIndex(gameId).filter((s) => s.name !== name);
  index.push(meta);
  writeIndex(gameId, index);
}

/**
 * Used on uninstall: saves are keyed by the random install id, so once the
 * install is gone they'd leak as unreachable storage.
 */
export function deleteAllSaves(gameId: string): void {
  const ls = store();
  if (!ls) return;
  for (const meta of readIndex(gameId)) {
    try {
      ls.removeItem(slotKey(gameId, meta.name));
    } catch {
      /* best-effort */
    }
  }
  try {
    ls.removeItem(indexKey(gameId));
  } catch {
    /* best-effort */
  }
}

export function deleteSave(gameId: string, name: string): void {
  const ls = store();
  if (!ls) return;
  try {
    ls.removeItem(slotKey(gameId, name));
  } catch {
    /* best-effort */
  }
  const index = readIndex(gameId).filter((s) => s.name !== name);
  try {
    writeIndex(gameId, index);
  } catch {
    /* best-effort */
  }
}
