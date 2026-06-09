/**
 * Room dossier for the Explorer: same decoders as the VM, but per-section
 * try/catch — a format browser must show what it CAN parse, unlike the VM's
 * all-or-nothing loadRoom.
 */
import type { Block } from '../resources/block';
import { findChild, payloadOf, type ResourceFile } from '../resources/tree';
import type { RoomOffsetTable } from '../resources/loff';
import type { IndexFile } from '../resources/index-file';
import { decodeRoom, walkRooms } from '../graphics/room';
import { decodeZPlanes, type DecodedZPlane } from '../graphics/zplane';
import { parseRoomObjects, type LoadedObject } from '../object/loader';
import { parseWalkBoxes, parseBoxMatrix, type WalkBox, type BoxMatrix } from '../pathfinding/boxes';
import { parseScal, type ScaleSlot } from '../pathfinding/scale';
import { disassemble } from '../vm/disasm';
import { loadGlobalScript } from '../vm/scripts';

export interface RoomRef {
  readonly roomId: number;
  /** 0-based LFLF position inside LECF. */
  readonly lflfIndex: number;
  readonly roomBlock: Block;
}

/** A dossier section that decoded, or the reason it didn't. */
export type Section<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export interface RoomBackground {
  readonly width: number;
  readonly height: number;
  /** Room CLUT — 256 RGB triples. */
  readonly palette: Uint8Array;
  readonly transparentIndex: number | null;
  /** `width × height` palette indices. */
  readonly indexed: Uint8Array;
  /** Per-strip SMAP encoding method codes (diagnostic). */
  readonly stripMethods: readonly number[];
}

export interface RoomScript {
  /** Human label: `ENCD (entry)`, `EXCD (exit)`, `local #202`. */
  readonly label: string;
  readonly kind: 'entry' | 'exit' | 'local';
  /** Local-script id, or `null` for ENCD/EXCD. */
  readonly id: number | null;
  readonly bytecode: Uint8Array;
}

export interface RoomDossier {
  readonly roomId: number;
  readonly lflfIndex: number;
  readonly background: Section<RoomBackground>;
  readonly zPlanes: Section<readonly DecodedZPlane[]>;
  readonly objects: Section<ReadonlyMap<number, LoadedObject>>;
  readonly scripts: Section<readonly RoomScript[]>;
  readonly walkBoxes: Section<readonly WalkBox[]>;
  readonly boxMatrix: Section<BoxMatrix>;
  readonly scaleSlots: Section<readonly ScaleSlot[]>;
}

/** Every LOFF room sorted by id; LECF rooms with no LOFF id are skipped. */
export function listRooms(file: ResourceFile, loff: RoomOffsetTable): RoomRef[] {
  const roomIdAt = new Map<number, number>();
  for (const [roomId, offset] of loff) roomIdAt.set(offset, roomId);

  const refs: RoomRef[] = [];
  for (const entry of walkRooms(file)) {
    const roomId = roomIdAt.get(entry.roomBlock.offset);
    if (roomId === undefined) continue;
    refs.push({ roomId, lflfIndex: entry.lflfIndex, roomBlock: entry.roomBlock });
  }
  refs.sort((a, b) => a.roomId - b.roomId);
  return refs;
}

function section<T>(decode: () => T): Section<T> {
  try {
    return { ok: true, value: decode() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Decode every section of a room independently; never throws. */
export function extractRoom(file: ResourceFile, ref: RoomRef): RoomDossier {
  const { roomBlock } = ref;

  const background = section<RoomBackground>(() => {
    const d = decodeRoom(file, roomBlock);
    return {
      width: d.width,
      height: d.height,
      palette: d.palette,
      transparentIndex: d.transparentIndex,
      indexed: d.indexed,
      stripMethods: d.stripMethods,
    };
  });

  // Z-planes are sized by the background dimensions.
  const zPlanes = section<readonly DecodedZPlane[]>(() => {
    if (!background.ok) throw new Error('background failed; cannot size z-planes');
    return decodeZPlanes(file, roomBlock, background.value.width, background.value.height).planes;
  });

  const objects = section(() => parseRoomObjects(file, roomBlock));
  const scripts = section<readonly RoomScript[]>(() => collectScripts(file, roomBlock));

  const walkBoxes = section<readonly WalkBox[]>(() => {
    const boxd = findChild(roomBlock, 'BOXD');
    return boxd ? parseWalkBoxes(payloadOf(file, boxd)) : [];
  });
  const boxMatrix = section<BoxMatrix>(() => {
    const boxm = findChild(roomBlock, 'BOXM');
    const boxCount = walkBoxes.ok ? walkBoxes.value.length : 0;
    return boxm && boxCount > 0 ? parseBoxMatrix(payloadOf(file, boxm), boxCount) : [];
  });
  const scaleSlots = section<readonly ScaleSlot[]>(() => {
    const scal = findChild(roomBlock, 'SCAL');
    return scal ? parseScal(payloadOf(file, scal)) : [];
  });

  return {
    roomId: ref.roomId,
    lflfIndex: ref.lflfIndex,
    background,
    zPlanes,
    objects,
    scripts,
    walkBoxes,
    boxMatrix,
    scaleSlots,
  };
}

export interface ReferencedScript {
  readonly id: number;
  /** Owning room id (from DSCR). */
  readonly room: number;
  readonly bytecode: Uint8Array;
}

// SCUMM v5 reserves 200..255 for room-local scripts; ids below that are global.
const LOCAL_SCRIPT_MIN = 200;
// Matches a `startScript`/`chainScript` line with a LITERAL id (a var id renders
// as `g123`/`L0`, which won't match — we can't resolve a dynamic id anyway).
const SCRIPT_REF = /^(?:startScript|chainScript)\S*\s+(\d+)\b/;

function referencedGlobalIds(bytecode: Uint8Array): number[] {
  const ids: number[] = [];
  for (const ins of disassemble(bytecode)) {
    const m = SCRIPT_REF.exec(ins.text);
    if (m && Number(m[1]) < LOCAL_SCRIPT_MIN) ids.push(Number(m[1]));
  }
  return ids;
}

/**
 * Global scripts this room *directly* calls with a literal id (one hop, not
 * transitive). Ids that don't resolve via DSCR are dropped.
 */
export function referencedGlobalScripts(
  dossier: RoomDossier,
  file: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
): Section<readonly ReferencedScript[]> {
  return section(() => {
    const ids = new Set<number>();
    if (dossier.scripts.ok) for (const s of dossier.scripts.value) for (const id of referencedGlobalIds(s.bytecode)) ids.add(id);
    if (dossier.objects.ok) {
      for (const obj of dossier.objects.value.values()) {
        for (const bytecode of obj.verbs.values()) for (const id of referencedGlobalIds(bytecode)) ids.add(id);
      }
    }
    const out: ReferencedScript[] = [];
    for (const id of [...ids].sort((a, b) => a - b)) {
      try {
        const script = loadGlobalScript(file, index, loff, id);
        out.push({ id, room: script.room, bytecode: script.bytecode });
      } catch {
        /* referenced id with no resolvable DSCR entry — skip */
      }
    }
    return out;
  });
}

function collectScripts(file: ResourceFile, roomBlock: Block): RoomScript[] {
  const scripts: RoomScript[] = [];

  const encd = findChild(roomBlock, 'ENCD');
  if (encd) scripts.push({ label: 'ENCD (entry)', kind: 'entry', id: null, bytecode: new Uint8Array(payloadOf(file, encd)) });
  const excd = findChild(roomBlock, 'EXCD');
  if (excd) scripts.push({ label: 'EXCD (exit)', kind: 'exit', id: null, bytecode: new Uint8Array(payloadOf(file, excd)) });

  // LSCR payload: u8 script id, then bytecode.
  for (const child of roomBlock.children ?? []) {
    if (child.tag !== 'LSCR') continue;
    const payload = payloadOf(file, child);
    if (payload.length < 1) continue;
    scripts.push({
      label: `local #${payload[0]}`,
      kind: 'local',
      id: payload[0]!,
      bytecode: new Uint8Array(payload.subarray(1)),
    });
  }

  return scripts;
}
