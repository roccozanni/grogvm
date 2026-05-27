/**
 * Boot driver — assemble a `Vm`, prime engine-controlled variables,
 * load global script #1 (the SCUMM boot script), and hand back the
 * live VM so the inspector / loop can drive it.
 *
 * # Engine-controlled variables
 *
 * SCUMM scripts read a handful of variables the *engine* is expected
 * to populate before any user script runs — game id, screen size,
 * language, etc. The Wilmunder notes call these "system variables"
 * (vars 0..15 roughly, with a few higher slots reserved per-game).
 *
 * We deliberately do **not** pre-seed all of them. The plan is to
 * surface uninitialized reads via the inspector's trace and add a
 * seed entry only when the boot script demands it. The current
 * seed list below is the minimum needed for the boot prefix; expect
 * it to grow as we replay further.
 */

import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';
import { SEED_OPCODES } from './opcodes';
import { loadGlobalScript } from './scripts';
import { Vm } from './vm';

export type GameId = 'MI1' | 'MI2';

export interface BootResult {
  readonly vm: Vm;
  readonly bootScriptId: number;
  readonly bytecodeLength: number;
}

export function bootGame(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
): BootResult {
  const vm = new Vm({
    numVariables: Math.max(index.maxs.numVariables, 800),
    numBitVariables: Math.max(index.maxs.numBitVariables, 2048),
    handlers: SEED_OPCODES,
  });

  seedEngineVariables(vm, gameId);

  const boot = loadGlobalScript(resourceFile, index, loff, 1);
  vm.startScript({
    scriptId: boot.id,
    bytecode: boot.bytecode,
    room: boot.room,
  });
  return { vm, bootScriptId: boot.id, bytecodeLength: boot.bytecode.length };
}

/**
 * Populate the small set of system variables we know the boot prefix
 * touches. Extend this only when an *observed* uninitialized read
 * forces it — keeps the var bank honest as a diagnostic.
 */
function seedEngineVariables(vm: Vm, gameId: GameId): void {
  // Screen dimensions in pixels — variables the engine sets so
  // scripts can size things off them.
  vm.vars.writeGlobal(VAR_SCREEN_WIDTH, 320);
  vm.vars.writeGlobal(VAR_SCREEN_HEIGHT, 200);

  // Game id — 0 = MI1, 1 = MI2 per common convention. Scripts branch
  // on this for game-specific behavior.
  vm.vars.writeGlobal(VAR_GAME_ID, gameId === 'MI1' ? 0 : 1);

  // Charset id — 0 by default; the boot script will normally call
  // setCharset(N) to change it.
  vm.vars.writeGlobal(VAR_CHARSET, 0);
}

// The exact var indices vary slightly between v5 games; these are the
// commonly-cited slots. We name them here so the seed call site reads
// like docs, and we can adjust the numbers without hunting through
// the codebase.
const VAR_SCREEN_WIDTH = 17;
const VAR_SCREEN_HEIGHT = 18;
const VAR_GAME_ID = 19;
const VAR_CHARSET = 21;
