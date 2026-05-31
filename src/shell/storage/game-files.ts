/**
 * Load + parse a stored game's `.000`/`.001` files into the bundle an
 * EngineSession (and the resource browsers) need. Shared by the Play page;
 * the legacy player still has its own inline copy until task 7.
 */
import { parseResourceFile } from '../../engine/resources/file';
import { parseIndexFile } from '../../engine/resources/index-file';
import { parseLoff } from '../../engine/resources/loff';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import type { SessionGame } from '../../engine/session';
import type { GameId } from '../install/detect';
import type { StoredGame } from './games';

function indexFilenameFor(gameId: GameId): string {
  return gameId === 'MI1' ? 'MONKEY.000' : 'MONKEY2.000';
}
function resourcesFilenameFor(gameId: GameId): string {
  return gameId === 'MI1' ? 'MONKEY.001' : 'MONKEY2.001';
}

async function findFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  const target = name.toUpperCase();
  for await (const [entryName, entry] of dir.entries()) {
    if (entry.kind === 'file' && entryName.toUpperCase() === target) {
      return entry.getFile();
    }
  }
  return null;
}

/** Read + parse the game's index + resource files into a `SessionGame`. */
export async function loadSessionGame(game: StoredGame): Promise<SessionGame> {
  const indexName = indexFilenameFor(game.gameId);
  const resourcesName = resourcesFilenameFor(game.gameId);
  const [indexFileHandle, resourceFileHandle] = await Promise.all([
    findFile(game.directoryHandle, indexName),
    findFile(game.directoryHandle, resourcesName),
  ]);
  if (!indexFileHandle) throw new Error(`Could not find ${indexName} in "${game.directoryHandle.name}".`);
  if (!resourceFileHandle) throw new Error(`Could not find ${resourcesName} in "${game.directoryHandle.name}".`);

  const [indexBytes, resourceBytes] = await Promise.all([
    indexFileHandle.arrayBuffer(),
    resourceFileHandle.arrayBuffer(),
  ]);
  const resourceFile = parseResourceFile(new Uint8Array(resourceBytes), SCUMM_V5_XOR_KEY);
  const index = parseIndexFile(parseResourceFile(new Uint8Array(indexBytes), SCUMM_V5_XOR_KEY));
  const loff = parseLoff(resourceFile);
  return { resourceFile, index, loff, gameId: game.gameId };
}
