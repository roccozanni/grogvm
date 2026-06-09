/**
 * Room id → fully-decoded LoadedRoom, via LOFF. Transition sequencing
 * (EXCD/ENCD dispatch) lives in the VM: pages/docs/engine/room-transitions.md.
 */

import { findChild, payloadOf, type ResourceFile } from '../resources/tree';
import { decodeRoom, walkRooms, type DecodedRoom } from '../graphics/room';
import { decodeZPlanes, type DecodedZPlane } from '../graphics/zplane';
import { parseRoomObjects, type LoadedObject } from '../object/loader';
import { parseWalkBoxes, parseBoxMatrix, type WalkBox, type BoxMatrix } from '../pathfinding/boxes';
import { parseScal, type ScaleSlot } from '../pathfinding/scale';
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
  /** ENCD bytecode, `null` if absent. */
  readonly entryScript: Uint8Array | null;
  /** EXCD bytecode, `null` if absent. */
  readonly exitScript: Uint8Array | null;
  /** LSCR blocks keyed by script id (200..255 — the room-local id range). */
  readonly localScripts: ReadonlyMap<number, Uint8Array>;
  readonly objects: ReadonlyMap<number, LoadedObject>;
  /** Empty when the room has no BOXD (some title / cutscene rooms). */
  readonly walkBoxes: ReadonlyArray<WalkBox>;
  /** Empty when the room has no BOXM; routing then degrades to a straight line. */
  readonly boxMatrix: BoxMatrix;
  /** SCAL perspective gradients; empty when absent. */
  readonly scaleSlots: readonly ScaleSlot[];
}

/**
 * Throws `RoomLoadError` when the id has no LOFF entry, the offset matches no
 * ROOM block, or a decoder fails. Room 0 always throws: SCUMM's "no room"
 * sentinel has no LOFF entry — the VM catches it and blanks the screen.
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

  // LSCR payload: u8 script id, then bytecode (copied so it outlives the file).
  const localScripts = new Map<number, Uint8Array>();
  for (const child of roomBlock.children ?? []) {
    if (child.tag !== 'LSCR') continue;
    const payload = payloadOf(file, child);
    if (payload.length < 1) continue;
    const id = payload[0]!;
    localScripts.set(id, new Uint8Array(payload.subarray(1)));
  }

  const objects = parseRoomObjects(file, roomBlock);

  // BOXD / BOXM / SCAL are all optional — default to empty, don't throw.
  const boxdBlock = findChild(roomBlock, 'BOXD');
  const walkBoxes = boxdBlock
    ? parseWalkBoxes(payloadOf(file, boxdBlock))
    : [];
  const boxmBlock = findChild(roomBlock, 'BOXM');
  const boxMatrix =
    boxmBlock && walkBoxes.length > 0
      ? parseBoxMatrix(payloadOf(file, boxmBlock), walkBoxes.length)
      : [];

  const scalBlock = findChild(roomBlock, 'SCAL');
  const scaleSlots = scalBlock ? parseScal(payloadOf(file, scalBlock)) : [];

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
    objects,
    walkBoxes,
    boxMatrix,
    scaleSlots,
  };
}

function findRoomBlockAt(file: ResourceFile, offset: number) {
  for (const entry of walkRooms(file)) {
    if (entry.roomBlock.offset === offset) return entry.roomBlock;
  }
  return null;
}
