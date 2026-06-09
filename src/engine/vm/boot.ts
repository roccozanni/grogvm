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
import { resolveCharsetById } from '../graphics/charset';
import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import { loadRoom } from '../room/loader';
import type { ResourceFile } from '../resources/tree';
import { LIGHTMODE_DEFAULT } from './lighting';
import { SEED_OPCODES } from './opcodes';
import { loadGlobalScript, loadSound } from './scripts';
import { VAR_CURRENT_LIGHTS } from './vars';
import { Vm } from './vm';
import { SilentTimingBackend } from '../sound/backend';

export type GameId = 'MI1' | 'MI2';

export interface BootResult {
  readonly vm: Vm;
  readonly bootScriptId: number;
  readonly bytecodeLength: number;
}

/**
 * Boot script #1's first local (`L0`) is the **boot parameter**.
 * Verified against MI1, it selects the boot's *late* branch (after the
 * credits-wait):
 * - `L0 == 0` → plays the credits cutscene (room 10), then the
 *   attract / title-idle setup (parks ego in room 0, spins the input
 *   loop #23). This is the real intro's first half.
 * - `L0 != 0` → **skips the credits** and jumps straight to a new game
 *   in the opening scene (Mêlée Island lookout, room 38). A "skip
 *   intro / new game" shortcut — both 1 and 2 land on room 38.
 *
 * Default 0: a fresh boot plays the cutscene (matching the original
 * intro). The credits → lookout auto-transition is NOT either param on
 * its own — it's triggered from the title-idle state (TODO: still being
 * reverse-engineered). `BOOT_PARAM_NEW_GAME` is exposed for testing the
 * lookout directly.
 */
export const BOOT_PARAM_NEW_GAME = 1;
export const BOOT_PARAM_ATTRACT = 0;

export function bootGame(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
  bootParam: number = BOOT_PARAM_ATTRACT,
  /**
   * Optional seeded entropy source ({@link VmInit.random}). Omitted by
   * the app (→ Math.random); supplied by the integration playthrough so
   * the run is reproducible.
   */
  random?: () => number,
  /**
   * Optional CD-audio track durations ({@link VmInit.cdTrackDurations}) — read
   * up front from the `TrackN.fla` headers by the boot caller (it knows how to
   * reach the track files), so CD-trigger sounds can be timed. Absent → CD-gated
   * waits fall through. See `bootScummV5` (node) / `loadSessionGame` (web).
   */
  cdTrackDurations?: ReadonlyMap<number, number>,
): BootResult {
  // Lazy object id → home-room index. Object numbers are globally unique
  // (each object's OBCD is defined in exactly one room), so the first room
  // we see owning an id is its home room. Built once on first miss by
  // walking every room's object table (~100ms for MI1's 83 rooms), then
  // cached — only touched when a carried inventory item's code is needed
  // off-room (see Vm.findObjectCode). Null entry ⇒ scan done, id not owned.
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
    resolveCharset: (id) => resolveCharsetById(resourceFile, index, loff, id),
    resolveObjectRoom,
    resolveSound: (id) => loadSound(resourceFile, index, loff, id),
    cdTrackDurations,
    audio: new SilentTimingBackend(),
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
 * Seed initial per-object owner / state / class from the index `DOBJ`
 * directory — SCUMM applies these before any script runs. Only
 * non-default rows are stored so the maps stay small (and saves
 * stay lean): owner ≠ 15 (the room default {@link Vm.getObjectOwner}
 * already supplies), state ≠ 0, class ≠ 0. The class bits are the
 * important part — `Untouchable` (bit 31) keeps not-yet-active objects
 * (e.g. the ship that docks in room 33 later) out of the hover hit-test
 * (`findObject`). Without this, ~half of MI1's objects are wrongly
 * interactive everywhere.
 */
export function seedObjectTable(vm: Vm, index: IndexFile): void {
  for (let id = 0; id < index.objects.length; id++) {
    const o = index.objects[id]!;
    if (o.classMask !== 0) vm.objectClasses.set(id, o.classMask);
    if (o.state !== 0) vm.objectStates.set(id, o.state);
    if (o.owner !== 15) vm.objectOwners.set(id, o.owner);
  }
}

/**
 * Populate the small set of system variables we know the boot prefix
 * touches. Extend this only when an *observed* uninitialized read
 * forces it — keeps the var bank honest as a diagnostic.
 */
export function seedEngineVariables(vm: Vm, gameId: GameId): void {
  // Screen dimensions in pixels — variables the engine sets so
  // scripts can size things off them.
  vm.vars.writeGlobal(VAR_SCREEN_WIDTH, 320);
  vm.vars.writeGlobal(VAR_SCREEN_HEIGHT, 200);

  // Game id — 0 = MI1, 1 = MI2 per common convention. Scripts branch
  // on this for game-specific behavior.
  vm.vars.writeGlobal(VAR_GAME_ID, gameId === 'MI1' ? 0 : 1);

  // Lighting default. The engine seeds VAR_CURRENT_LIGHTS at reset for
  // every v4–v5 game (room lit + actors palette-lit); the per-room
  // `lights` opcode overrides it later. Without this, g9 stays 0 and
  // *every* room reads as dark — e.g. MI1's sentence script #2 then
  // answers "Look at" with "Non si riesce, troppo buio" because it
  // gates the real description on g9 != 0. Confirmed by inspection:
  // the `lights` opcode is never dispatched on the credits→room-33
  // intro path, so the lit state can only come from this reset seed.
  vm.vars.writeGlobal(VAR_CURRENT_LIGHTS, LIGHTMODE_DEFAULT);

  // Charset id — 0 by default; the boot script will normally call
  // setCharset(N) to change it.
  vm.vars.writeGlobal(VAR_CHARSET, 0);

  // MI1 copy-protection: script #176 reads var[0x4a] (= "track-b-size",
  // the size of audio track 2 on the original CD) and quits if it's
  // outside [1200, 1250]. We don't have a CD, so we seed a known-good
  // value. The original CD's track 2 was ~1225 sectors. This is the
  // same MONKEY-only reset seed the original engine applies (it sets
  // var 74 = 1225 unconditionally for Monkey); 0x4a == 74.
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
