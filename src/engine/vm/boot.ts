/**
 * Boot driver — assemble a `Vm`, seed engine variables, and start global
 * script #1 (the SCUMM boot script). See pages/docs/scumm/boot.md.
 */

import { loadCostume } from '../graphics/costume-loader';
import { charsetByWalkOrder, resolveCharsetById } from '../graphics/charset';
import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import { loadRoom } from '../room/loader';
import type { ResourceFile } from '../resources/tree';
import { LIGHTMODE_DEFAULT } from './lighting';
import { SEED_OPCODES } from './opcodes';
import { loadGlobalScript, loadSound } from './scripts';
import { VAR_CURRENT_LIGHTS, VAR_VIDEOMODE } from './vars';
import { Vm } from './vm';
import type { AudioBackend } from '../sound/backend';

export type GameId = 'MI1' | 'MI2';

export interface BootResult {
  readonly vm: Vm;
  readonly bootScriptId: number;
  readonly bytecodeLength: number;
}

/**
 * Boot script #1's `L0` selects the boot branch: 0 plays the credits then
 * the title-idle attract; non-zero skips straight to a new game in room 38.
 * See pages/docs/scumm/boot.md.
 */
export const BOOT_PARAM_NEW_GAME = 1;
export const BOOT_PARAM_ATTRACT = 0;

export function bootGame(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
  bootParam: number = BOOT_PARAM_ATTRACT,
  /** Seeded entropy for reproducible integration runs; omitted → Math.random. */
  random?: () => number,
  /** CD track durations in jiffies (from the `TrackN.fla` headers); absent → CD-gated waits fall through. */
  cdTrackDurations?: ReadonlyMap<number, number>,
  /** Output backend; omitted → the Vm's default SilentTimingBackend (headless / tests). */
  audio?: AudioBackend,
): BootResult {
  // Lazy object-id → home-room index: object ids are globally unique, so the
  // first room seen owning an id is its home. Built once on first miss
  // (~100 ms for MI1's 83 rooms), then cached.
  let objectRoomIndex: Map<number, number> | null = null;
  const resolveObjectRoom = (objId: number): number | null => {
    if (!objectRoomIndex) {
      objectRoomIndex = new Map();
      for (const roomId of loff.keys()) {
        let room;
        try {
          room = loadRoom(resourceFile, loff, roomId);
        } catch {
          continue;
        }
        for (const oid of room.objects.keys()) {
          if (!objectRoomIndex.has(oid)) objectRoomIndex.set(oid, roomId);
        }
      }
    }
    return objectRoomIndex.get(objId) ?? null;
  };

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
    resolveCharset: (id) =>
      resolveCharsetById(resourceFile, index, loff, id) ?? charsetByWalkOrder(resourceFile, id),
    resolveObjectRoom,
    resolveSound: (id) => loadSound(resourceFile, index, loff, id),
    cdTrackDurations,
    audio,
    random,
  });

  seedEngineVariables(vm, gameId);
  seedObjectTable(vm, index);

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
 * Seed per-object owner / state / class from the index `DOBJ` directory,
 * applied before any script runs; only non-default rows are stored. The
 * class bits matter most — Untouchable keeps inactive objects out of the
 * hover hit-test. See pages/docs/scumm/objects.md.
 *
 * The seed is captured on `vm.objectSeed` so a save can store only the
 * runtime diff against it (see savestate.ts); the live maps are populated
 * via `applyObjectSeed`, the same path a restore uses.
 */
export function seedObjectTable(vm: Vm, index: IndexFile): void {
  const { classes, states, owners } = vm.objectSeed;
  classes.clear();
  states.clear();
  owners.clear();
  for (let id = 0; id < index.objects.length; id++) {
    const o = index.objects[id]!;
    if (o.classMask !== 0) classes.set(id, o.classMask);
    if (o.state !== 0) states.set(id, o.state);
    if (o.owner !== 15) owners.set(id, o.owner);
  }
  vm.applyObjectSeed();
}

/**
 * Seed the system variables the boot prefix reads. Extend only when an
 * observed uninitialized read forces it — keeps the var bank honest.
 */
export function seedEngineVariables(vm: Vm, gameId: GameId): void {
  vm.vars.writeGlobal(VAR_SCREEN_WIDTH, 320);
  vm.vars.writeGlobal(VAR_SCREEN_HEIGHT, 200);

  vm.vars.writeGlobal(VAR_GAME_ID, gameId === 'MI1' ? 0 : 1);

  // Seed VAR_CURRENT_LIGHTS lit — the `lights` opcode never runs on MI1's
  // intro path, so without this reset seed every room reads as dark. See
  // pages/docs/scumm/lighting.md.
  vm.vars.writeGlobal(VAR_CURRENT_LIGHTS, LIGHTMODE_DEFAULT);

  vm.vars.writeGlobal(VAR_CHARSET, 0);

  // VGA (BIOS mode 0x13). The entry-hook script #6 branches on this to pick
  // the UI palette: 19 → re-apply the boot purples from g377–g388 each room
  // load; anything else → an EGA fallback that blacks the verb-panel slots.
  vm.vars.writeGlobal(VAR_VIDEOMODE, 19);

  // MI1 copy-protection: script #176 checks var 74 ("track-b-size") is in
  // [1200, 1250]; the original engine seeds 1225 unconditionally for Monkey.
  // See pages/docs/scumm/boot.md.
  if (gameId === 'MI1') {
    vm.vars.writeGlobal(VAR_MI1_TRACK_B_SIZE, 1225);
  }
}

// ⚠️ These names DISAGREE with the canonical table in vars.ts (17/18 are
// camera min/max X, 19 is VAR_TIMER_NEXT, 21 is VAR_VIRT_MOUSE_Y). Early
// empirical seeds kept as anti-uninitialised-read scaffolding — do not
// trust the names; see vars.ts.
const VAR_SCREEN_WIDTH = 17;
const VAR_SCREEN_HEIGHT = 18;
const VAR_GAME_ID = 19;
const VAR_CHARSET = 21;
/** MI1-specific: CD audio track 2 size in sectors. Used by script #176 copy protection. */
const VAR_MI1_TRACK_B_SIZE = 0x4a;
