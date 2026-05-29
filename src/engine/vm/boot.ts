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

import { loadCostume } from '../graphics/costume-loader';
import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import { loadRoom } from '../room/loader';
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

/**
 * Boot script #1's first local (`L0`) is the **boot parameter**.
 * Verified against MI1: after the credits, `#1` branches on it —
 * `L0 == 0` → the attract / title-idle setup (places ego in room 0 and
 * spins the input loop #23, leaving a black screen waiting for input);
 * `L0 != 0` → the new-game path that loads the opening scene (Mêlée
 * Island lookout, room 38) with Guybrush placed. Both 1 and 2 land on
 * room 38, so it's a "start a new game" flag, not a level index.
 * Default 1 so a fresh boot plays the credits and then drops into the
 * first interactive room.
 */
export const BOOT_PARAM_NEW_GAME = 1;
export const BOOT_PARAM_ATTRACT = 0;

export function bootGame(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
  bootParam: number = BOOT_PARAM_NEW_GAME,
): BootResult {
  const vm = new Vm({
    numVariables: Math.max(index.maxs.numVariables, 800),
    numBitVariables: Math.max(index.maxs.numBitVariables, 2048),
    handlers: SEED_OPCODES,
    resolveGlobalScript: (id) => {
      const s = loadGlobalScript(resourceFile, index, loff, id);
      return { bytecode: s.bytecode, room: s.room };
    },
    resolveRoom: (id) => loadRoom(resourceFile, loff, id),
    resolveCostume: (id) => loadCostume(resourceFile, index, loff, id),
  });

  seedEngineVariables(vm, gameId);

  const boot = loadGlobalScript(resourceFile, index, loff, 1);
  vm.startScript({
    scriptId: boot.id,
    bytecode: boot.bytecode,
    room: boot.room,
    args: [bootParam],
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

  // MI1 copy-protection: script #176 reads var[0x4a] (= "track-b-size",
  // the size of audio track 2 on the original CD) and quits if it's
  // outside [1200, 1250]. We don't have a CD, so we seed a known-good
  // value. The original CD's track 2 was ~1225 sectors.
  if (gameId === 'MI1') {
    vm.vars.writeGlobal(VAR_MI1_TRACK_B_SIZE, 1225);
  }
}

// ⚠️ These indices DISAGREE with the canonical v5 table in `vars.ts`:
// 17/18 are VAR_CAMERA_MIN_X/MAX_X, 19 is VAR_TIMER_NEXT, 21 is
// VAR_VIRT_MOUSE_Y — there is no "screen width/height" var in v5
// (screen dims come from the room). These seeds are early empirical
// guesses kept as anti-uninitialised-read scaffolding; the boot plays
// through with them, so a proper pass to seed the *right* indices is
// deferred until something observably needs it. Do not trust these
// names — see vars.ts.
const VAR_SCREEN_WIDTH = 17;
const VAR_SCREEN_HEIGHT = 18;
const VAR_GAME_ID = 19;
const VAR_CHARSET = 21;
/** MI1-specific: CD audio track 2 size in sectors. Used by script #176 copy protection. */
const VAR_MI1_TRACK_B_SIZE = 0x4a;
