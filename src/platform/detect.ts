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

// SCUMM v5 has no language field in its data — the EN and IT MONKEY.000 are the
// same size and differ only in the resource-directory offset tables (the IT
// translation resizes scripts in .001, shifting every offset; see
// pages/docs/scumm/index-file.md). ScummVM identifies a release by hashing the
// index file and looking the language up in a table; we do the same. Add a line
// here when a new release's hash is confirmed.
const KNOWN_VARIANTS: Record<string, string> = {
  '8f40364323a755b1b69fa026a4bb4f351cd3bf330cc005d91fa5d77f55cadefe': 'English',
  '4dfbd8f4ba61fcf604073c6960d98caa2c5dd43d6be296b82c25bd2ee1acc3f8': 'Italiano',
};

export interface GameVariant {
  /** SHA-256 of the index file, hex — the install identity / dedup key. */
  contentHash: string;
  variant: string;
}

/** Hash a game's index-file bytes and resolve a variant label. */
export async function identifyVariant(indexBytes: Uint8Array): Promise<GameVariant> {
  const digest = await crypto.subtle.digest('SHA-256', indexBytes as BufferSource);
  const contentHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return { contentHash, variant: KNOWN_VARIANTS[contentHash] ?? `variant ${contentHash.slice(0, 7)}` };
}
