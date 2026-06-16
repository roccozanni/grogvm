export type GameId = 'MI1' | 'MI2';

export interface DetectedGame {
  gameId: GameId;
  displayName: string;
}

const MI1_FILES = ['MONKEY.000', 'MONKEY.001'];
const MI2_FILES = ['MONKEY2.000', 'MONKEY2.001'];

/** The index file (`.000`) we hash to tell one release apart from another. */
export const INDEX_FILENAME: Record<GameId, string> = {
  MI1: 'MONKEY.000',
  MI2: 'MONKEY2.000',
};

export function detectGame(filenames: readonly string[]): DetectedGame | null {
  const upper = new Set(filenames.map((n) => n.toUpperCase()));

  if (MI1_FILES.every((f) => upper.has(f))) {
    return { gameId: 'MI1', displayName: 'The Secret of Monkey Island' };
  }
  if (MI2_FILES.every((f) => upper.has(f))) {
    return { gameId: 'MI2', displayName: "Monkey Island 2: LeChuck's Revenge" };
  }
  return null;
}

// SCUMM v5 data carries no language field — a release is identified by hashing
// the index file (the IT translation shifts every directory offset; see
// pages/docs/scumm/index-file.md). Add a line when a new hash is confirmed.
const KNOWN_VARIANTS: Record<string, string> = {
  '8f40364323a755b1b69fa026a4bb4f351cd3bf330cc005d91fa5d77f55cadefe': 'English',
  '4dfbd8f4ba61fcf604073c6960d98caa2c5dd43d6be296b82c25bd2ee1acc3f8': 'Italiano',
};

export interface GameVariant {
  /** SHA-256 of the index file, hex — the install identity / dedup key. */
  contentHash: string;
  variant: string;
}

/** Human label for an index-file content hash — a known release name, else a
 *  `variant <hash7>` fallback. Pure/sync, so Node callers (the integration
 *  catalog) can label a build off a `node:crypto` hash without `crypto.subtle`. */
export function variantName(contentHash: string): string {
  return KNOWN_VARIANTS[contentHash] ?? `variant ${contentHash.slice(0, 7)}`;
}

export async function identifyVariant(indexBytes: Uint8Array): Promise<GameVariant> {
  const digest = await crypto.subtle.digest('SHA-256', indexBytes as BufferSource);
  const contentHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { contentHash, variant: variantName(contentHash) };
}
