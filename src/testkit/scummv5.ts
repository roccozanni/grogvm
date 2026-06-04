/**
 * SCUMM-v5 load/boot/save glue — the disk-facing half of the dev/test
 * harness, parameterised by game directory so it serves any v5 build (MI1
 * IT/EN, MI2, …). It reads real game files (Node only — `node:fs`), so it
 * lives in `src/testkit/` — a sibling of `engine`/`shell`, NOT inside
 * `engine/`, which stays a portable browser-bundled core free of `node:fs`.
 * Never imported by app code.
 *
 * The *game-agnostic* drivers (`setMouse`/`hover`/`driveTicks`/`driveUntil`/
 * `driveToRoom`) live in `drive.ts` and are re-exported here so a caller gets
 * the whole harness from one import:
 *
 *   import { bootScummV5, restoreSave, driveToRoom } from '../../src/testkit/scummv5.ts';
 *   const vm = bootScummV5('games/MI1-IT-CD-DOS-VGA');
 *   driveToRoom(vm, 33);
 *
 * Everything that touches game data is **data-gated**: callers guard with
 * {@link hasData} so a fresh checkout / CI (no copyrighted bytes) stays green.
 * Per-game specifics (which directory, which object/verb ids) live with the
 * playthrough that uses them under `integration/<game>/`, not here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseResourceFile } from '../engine/resources/file';
import { parseIndexFile } from '../engine/resources/index-file';
import { parseLoff } from '../engine/resources/loff';
import { SCUMM_V5_XOR_KEY } from '../engine/resources/xor';
import { bootGame, type GameId } from '../engine/vm/boot';
import { restoreVm } from '../engine/vm/savestate';
import type { Vm } from '../engine/vm/vm';

// The game-agnostic drivers are part of the harness API — re-export so
// callers import everything from here.
export * from './drive';
export * from './random';
export * from './actions';

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
 * title). Pass `random` (e.g. {@link makeSeededRandom}) to make the run
 * reproducible — the playthrough seeds it so a regression run is
 * deterministic; omit it for live randomness.
 */
export function bootScummV5(
  dir: string,
  gameId: GameId = 'MI1',
  random?: () => number,
): Vm {
  const { res, index, loff } = loadScummV5(dir);
  return bootGame(res, index, loff, gameId, undefined, random).vm;
}

/**
 * Restore a websave into `vm`. `nameOrPath` may be a full path, or a bare
 * slot name resolved under `saves/` (`.websave.json` appended if missing) —
 * `restoreSave(vm, 'MI1-bug-map-labels')` → `saves/MI1-bug-map-labels.websave.json`.
 * Returns `vm` for chaining.
 */
export function restoreSave(vm: Vm, nameOrPath: string): Vm {
  let path = nameOrPath;
  if (!path.includes('/')) path = `saves/${path}`;
  if (!path.endsWith('.json')) path += '.websave.json';
  restoreVm(vm, JSON.parse(readFileSync(path, 'utf8')));
  return vm;
}
