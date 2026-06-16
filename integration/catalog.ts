/**
 * The installed-game catalog for the integration playthroughs: discover which
 * builds are present under games/, and select which to run. Game-agnostic — MI1
 * today, MI2 when its suite lands.
 *
 * A build's identity is its index-file content hash (see platform/detect.ts).
 * GROGVM_GAME_SELECTOR chooses which builds run:
 *
 *   (unset)  every installed variant of every game — the default, and the
 *            pre-commit "does this engine change keep ALL builds working?" run.
 *   <prefix> a case-insensitive prefix match on {hash, variant, gameId, dir
 *            basename} — `EN`, `ital`, `mi2`, `4dfb` each narrow the run.
 *
 * Game selection is orthogonal: each game has its own integration/<game>/ suite,
 * scoped with a vitest path filter (`-- integration/mi1`).
 *
 * When nothing matches — a typo'd selector, or no game data installed —
 * requireBuilds throws, so the suite FAILS rather than passing as a green no-op.
 * That's safe: CI runs only the synthetic `npm test` + `npm run build`, never
 * this suite, so a checkout without the (uncommittable) game bytes never hits it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { detectGame, INDEX_FILENAME, variantName, type GameId } from '../src/platform/detect';

export interface Build {
  /** Game-data dir, e.g. `games/MI1-IT-CD-DOS-VGA`. */
  dir: string;
  gameId: GameId;
  /** Release label (Italiano / English / `variant <hash7>`). */
  variant: string;
  /** SHA-256 of the index file, hex — the build's identity. */
  contentHash: string;
}

const cache = new Map<string, Build[]>();

/** Every bootable build under `root` (sorted by dir), classified + hashed. The
 *  games/ tree doesn't change mid-run, so the scan is memoized per root. */
export function discoverBuilds(root = 'games'): Build[] {
  const cached = cache.get(root);
  if (cached) return cached;
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    cache.set(root, []); // no games/ root at all
    return [];
  }
  const builds: Build[] = [];
  for (const name of names) {
    const dir = `${root}/${name}`;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a stray file, not a build directory
    }
    const game = detectGame(entries);
    if (!game) continue;
    const bytes = readFileSync(`${dir}/${INDEX_FILENAME[game.gameId]}`);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    builds.push({ dir, gameId: game.gameId, variant: variantName(contentHash), contentHash });
  }
  cache.set(root, builds);
  return builds;
}

const SELECTOR = process.env.GROGVM_GAME_SELECTOR?.trim().toLowerCase() || undefined;

/** A build matches when no selector is set (run everything), else when the
 *  selector is a case-insensitive prefix of any identity facet. */
const matchesSelector = (b: Build): boolean =>
  !SELECTOR ||
  [b.contentHash, b.variant, b.gameId, basename(b.dir)].some((facet) =>
    facet.toLowerCase().startsWith(SELECTOR),
  );

/** The builds to run for `gameId` (possibly empty). */
export function selectBuilds(gameId: GameId): Build[] {
  return discoverBuilds().filter((b) => b.gameId === gameId && matchesSelector(b));
}

/**
 * Like {@link selectBuilds} but throws when nothing matches, so the suite fails
 * loudly instead of silently running zero tests — a typo'd selector or absent
 * game data is a mistake, not a pass. The message distinguishes the two.
 */
export function requireBuilds(gameId: GameId): Build[] {
  const builds = selectBuilds(gameId);
  if (builds.length > 0) return builds;
  const installed = discoverBuilds().filter((b) => b.gameId === gameId);
  const have = installed.map((b) => b.variant).join(', ') || '(none)';
  throw new Error(
    SELECTOR
      ? `No ${gameId} build matches GROGVM_GAME_SELECTOR="${process.env.GROGVM_GAME_SELECTOR}" ` +
        `(installed ${gameId}: ${have}). The selector is a case-insensitive prefix of a ` +
        `hash/variant/gameId/dir; unset it to run every installed build.`
      : `No ${gameId} game data installed under games/ (the copyrighted bytes are never ` +
        `committed). Add a build (e.g. games/MI1-IT-CD-DOS-VGA) to run the playthroughs.`,
  );
}
