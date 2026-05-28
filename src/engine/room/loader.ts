/**
 * SCUMM v5 room loader — resolves a room id to a fully-decoded
 * `LoadedRoom` ready for the compositor to consume.
 *
 * Sits on top of Phase 2 (background bitmap, palette, transparency) and
 * Phase 3 (z-planes) decoders. We add: ROOM-block resolution via LOFF,
 * room-scoped scripts (ENCD entry script, EXCD exit script) captured
 * for the VM to dispatch, and a single error type for the failure
 * modes the engine cares about (no LOFF entry, no ROOM block, etc.).
 *
 * Walk-box parsing is deferred to the pathfinding sub-phase — the
 * BOXD/BOXM blocks are still present on the ROOM, the loader just
 * doesn't decode them yet.
 *
 * # Resolution flow
 *
 *   roomId → LOFF[roomId]               (file offset of ROOM block)
 *          → walk file tree to find the matching Block by offset
 *          → decodeRoom() + decodeZPlanes() + capture ENCD/EXCD
 *
 * # Room id 0
 *
 * SCUMM uses room 0 as the "no room loaded" sentinel — boot scripts
 * call `loadRoom 0` mid-init to blank the screen before switching to
 * a real room. There's no entry in LOFF for room 0. The loader throws
 * `RoomLoadError` on id 0; the VM's `loadRoom` opcode handler catches
 * that and sets `loadedRoom = null` (the compositor renders a blank).
 */

import { findChild, payloadOf, type ResourceFile } from '../resources/tree';
import { decodeRoom, walkRooms, type DecodedRoom } from '../graphics/room';
import { decodeZPlanes, type DecodedZPlane } from '../graphics/zplane';
import type { RoomOffsetTable } from '../resources/loff';

export class RoomLoadError extends Error {
  constructor(public readonly roomId: number, detail: string) {
    super(`Cannot load room #${roomId}: ${detail}`);
    this.name = 'RoomLoadError';
  }
}

export interface LoadedRoom {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly numObjects: number;
  /** Room CLUT — 256 RGB triples, values in 0..255. */
  readonly palette: Uint8Array;
  /** Palette index acting as transparent, or `null` if the room has no TRNS. */
  readonly transparentIndex: number | null;
  /** `width × height` palette indices — the room background. */
  readonly indexed: Uint8Array;
  /** Per-strip SMAP encoding method codes (diagnostic). */
  readonly stripMethods: readonly number[];
  /** Z-planes for occlusion — index N hides actors with `actorZ < N`. */
  readonly zPlanes: readonly DecodedZPlane[];
  /** ENCD bytecode — runs when the engine enters this room. `null` if absent. */
  readonly entryScript: Uint8Array | null;
  /** EXCD bytecode — runs when the engine leaves this room. `null` if absent. */
  readonly exitScript: Uint8Array | null;
  /**
   * Local scripts (LSCR blocks) keyed by their script id. SCUMM v5
   * reserves ids 200..255 for local scripts; the `startScript` opcode
   * routes those ids to the current room's localScripts table.
   */
  readonly localScripts: ReadonlyMap<number, Uint8Array>;
}

/**
 * Resolve a room id to a fully-decoded `LoadedRoom`.
 *
 * Throws `RoomLoadError` on:
 *   - room id not present in LOFF (e.g. room 0, unused slots)
 *   - LOFF offset doesn't land on a known ROOM block in the file tree
 *   - any of the Phase 2 / Phase 3 decoders throw (rethrown wrapped)
 */
export function loadRoom(
  file: ResourceFile,
  loff: RoomOffsetTable,
  roomId: number,
): LoadedRoom {
  const roomOffset = loff.get(roomId);
  if (roomOffset === undefined) {
    throw new RoomLoadError(roomId, 'not present in LOFF');
  }

  const roomBlock = findRoomBlockAt(file, roomOffset);
  if (!roomBlock) {
    throw new RoomLoadError(
      roomId,
      `no ROOM block at LOFF offset 0x${roomOffset.toString(16)}`,
    );
  }

  let decoded: DecodedRoom;
  try {
    decoded = decodeRoom(file, roomBlock);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RoomLoadError(roomId, `background decode failed: ${message}`);
  }

  const { planes: zPlanes } = decodeZPlanes(
    file,
    roomBlock,
    decoded.width,
    decoded.height,
  );

  const encdBlock = findChild(roomBlock, 'ENCD');
  const excdBlock = findChild(roomBlock, 'EXCD');

  // LSCR blocks live as direct children of ROOM. Each one's payload
  // starts with a u8 script id (200..255 in MI1), followed by the
  // bytecode. We collect them into a Map for O(1) lookup at
  // startScript dispatch time.
  const localScripts = new Map<number, Uint8Array>();
  for (const child of roomBlock.children ?? []) {
    if (child.tag !== 'LSCR') continue;
    const payload = payloadOf(file, child);
    if (payload.length < 1) continue;
    const id = payload[0]!;
    // Bytecode is everything after the id byte. We copy so the
    // returned buffer is independent of the file's lifetime.
    localScripts.set(id, new Uint8Array(payload.subarray(1)));
  }

  return {
    id: roomId,
    width: decoded.width,
    height: decoded.height,
    numObjects: decoded.numObjects,
    palette: decoded.palette,
    transparentIndex: decoded.transparentIndex,
    indexed: decoded.indexed,
    stripMethods: decoded.stripMethods,
    zPlanes,
    entryScript: encdBlock ? new Uint8Array(payloadOf(file, encdBlock)) : null,
    exitScript: excdBlock ? new Uint8Array(payloadOf(file, excdBlock)) : null,
    localScripts,
  };
}

/**
 * Find the ROOM block at the given absolute file offset by walking
 * the LECF tree. `walkRooms` already enumerates every `LFLF > ROOM`
 * pair so we just match on offset. O(N) per call where N is the
 * number of LFLFs (~100 for MI1) — fine, loadRoom is rare.
 */
function findRoomBlockAt(file: ResourceFile, offset: number) {
  for (const entry of walkRooms(file)) {
    if (entry.roomBlock.offset === offset) return entry.roomBlock;
  }
  return null;
}
