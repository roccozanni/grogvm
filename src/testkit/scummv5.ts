/**
 * SCUMM-v5 load/boot/save glue — the disk-facing (Node-only) half of the
 * harness; re-exports the rest so callers import everything from here.
 * See pages/docs/engine/harness.md.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { parseResourceFile } from '../engine/resources/file';
import { parseIndexFile } from '../engine/resources/index-file';
import { parseLoff } from '../engine/resources/loff';
import { SCUMM_V5_XOR_KEY } from '../engine/resources/xor';
import { audioDurationJiffies } from '../engine/sound/duration';
import { bootGame, type GameId } from '../engine/vm/boot';
import { restoreVm } from '../engine/vm/savestate';
import type { Vm } from '../engine/vm/vm';

export * from './drive';
export * from './random';
export * from './actions';
export * from './png';
export * from './screenshot';

/** The two resource files every v5 game ships (index + data). */
const INDEX_FILE = 'MONKEY.000';
const DATA_FILE = 'MONKEY.001';

/** Whether `dir` holds a bootable v5 game (gate tests / probes on this). */
export function hasData(dir: string): boolean {
  return existsSync(`${dir}/${INDEX_FILE}`) && existsSync(`${dir}/${DATA_FILE}`);
}

/** Parsed v5 resources — the inputs {@link bootGame} needs. */
export interface LoadedGame {
  res: ReturnType<typeof parseResourceFile>;
  index: ReturnType<typeof parseIndexFile>;
  loff: ReturnType<typeof parseLoff>;
}

/** XOR-decrypt + parse a game's index/data files into `{ res, index, loff }`. */
export function loadScummV5(dir: string): LoadedGame {
  const index = parseIndexFile(
    parseResourceFile(new Uint8Array(readFileSync(`${dir}/${INDEX_FILE}`)), SCUMM_V5_XOR_KEY),
  );
  const res = parseResourceFile(new Uint8Array(readFileSync(`${dir}/${DATA_FILE}`)), SCUMM_V5_XOR_KEY);
  return { res, index, loff: parseLoff(res) };
}

/**
 * Load + boot the game in `dir`, returning the booted {@link Vm} (at the
 * title). Pass `random` (e.g. {@link makeSeededRandom}) for a reproducible run.
 */
export function bootScummV5(
  dir: string,
  gameId: GameId = 'MI1',
  random?: () => number,
): Vm {
  const { res, index, loff } = loadScummV5(dir);
  return bootGame(res, index, loff, gameId, undefined, random, readCdTrackDurations(dir)).vm;
}

const CD_TRACK_RE = /^Track(\d+)\.(fla|mp3)$/i;
const CD_TRACK_HEADER_BYTES = 2048;

/**
 * Read every `TrackN.{fla,mp3}` CD track's duration (jiffies) from its header
 * only — never the multi-MB body. See pages/docs/engine/audio.md §3.
 */
export function readCdTrackDurations(dir: string): Map<number, number> {
  const durations = new Map<number, number>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return durations;
  }
  for (const name of entries) {
    const match = CD_TRACK_RE.exec(name);
    if (!match) continue;
    let fd: number | undefined;
    try {
      fd = openSync(`${dir}/${name}`, 'r');
      const buf = Buffer.allocUnsafe(CD_TRACK_HEADER_BYTES);
      const n = readSync(fd, buf, 0, CD_TRACK_HEADER_BYTES, 0);
      const size = fstatSync(fd).size;
      durations.set(Number(match[1]), audioDurationJiffies(new Uint8Array(buf.subarray(0, n)), size));
    } catch {
      // unreadable track — skip; its gate stays non-blocking
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return durations;
}

/**
 * Restore a websave into `vm` (returned for chaining). `nameOrPath` may be a
 * full path or a bare slot name → `saves/<name>.websave.json`.
 */
export function restoreSave(vm: Vm, nameOrPath: string): Vm {
  let path = nameOrPath;
  if (!path.includes('/')) path = `saves/${path}`;
  if (!path.endsWith('.json')) path += '.websave.json';
  restoreVm(vm, JSON.parse(readFileSync(path, 'utf8')));
  return vm;
}
