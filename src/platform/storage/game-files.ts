/**
 * Load + parse a stored game's `.000`/`.001` files into the bundle an
 * EngineSession (and the resource browsers) need. Shared by the Play page;
 * the legacy player still has its own inline copy until task 7.
 */
import { parseResourceFile } from '../../engine/resources/file';
import { parseIndexFile } from '../../engine/resources/index-file';
import { parseLoff } from '../../engine/resources/loff';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import { audioDurationJiffies } from '../../engine/sound/duration';
import type { SessionGame } from '../../engine/session';
import type { GameId } from '../detect';
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

const CD_TRACK_RE = /^track(\d+)\.(fla|mp3)$/i;
const CD_TRACK_HEADER_BYTES = 2048;

/**
 * Read every `TrackN.{fla,mp3}` CD-audio track's duration (jiffies) from its
 * header, up front (like the other resources), so the VM can time CD-trigger
 * sounds. Only the header is read — a partial `File.slice`, not the whole
 * multi-MB track ({@link audioDurationJiffies} needs the FLAC STREAMINFO or
 * the MP3 Xing/Info frame; `file.size` feeds the MP3 CBR fallback). Tracks
 * are discovered from the folder, not assumed.
 */
async function readCdTrackDurations(
  dir: FileSystemDirectoryHandle,
): Promise<Map<number, number>> {
  const durations = new Map<number, number>();
  for await (const [entryName, entry] of dir.entries()) {
    const match = CD_TRACK_RE.exec(entryName);
    if (!match || entry.kind !== 'file') continue;
    const file = await entry.getFile();
    const head = new Uint8Array(await file.slice(0, CD_TRACK_HEADER_BYTES).arrayBuffer());
    durations.set(Number(match[1]), audioDurationJiffies(head, file.size));
  }
  return durations;
}

/** Read + parse the game's index + resource files into a `SessionGame`. */
export async function loadSessionGame(game: StoredGame): Promise<SessionGame> {
  const indexName = indexFilenameFor(game.gameId);
  const resourcesName = resourcesFilenameFor(game.gameId);
  const [indexFileHandle, resourceFileHandle, cdTrackDurations] = await Promise.all([
    findFile(game.directoryHandle, indexName),
    findFile(game.directoryHandle, resourcesName),
    readCdTrackDurations(game.directoryHandle),
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
  return { resourceFile, index, loff, gameId: game.gameId, cdTrackDurations };
}
