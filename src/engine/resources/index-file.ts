/** Index file (.000) parser. Format and lane semantics: pages/docs/scumm/index-file.md. */

import { payloadOf, type ResourceFile } from './tree';

export interface Maxs {
  /** Raw u16 LE array — unnamed positions stay readable. */
  readonly raw: ReadonlyArray<number>;
  readonly numVariables: number;
  readonly numBitVariables: number;
  readonly numLocalObjects: number;
  readonly numCharsets: number;
  readonly numVerbs: number;
}

/** One row of `DROO`. */
export interface RoomDirectoryEntry {
  /** Disk number; `0` = not present in this release. */
  readonly disk: number;
  /** Typically `0` for single-disk v5 — real offsets live in LOFF. */
  readonly offset: number;
}

/** One row of `DSCR` / `DSOU` / `DCOS` / `DCHR`. */
export interface ResourceDirectoryEntry {
  /** Owning room id — NOT a disk number (index-file.md §4). `0` = unused slot. */
  readonly room: number;
  /** Relative to the owning room's ROOM-block file offset: absolute = LOFF[room] + offset. */
  readonly offset: number;
}

/** Initial per-object owner/state/class from `DOBJ` — seeded before any script runs. */
export interface ObjectInit {
  /** 0..15. 15 = `OF_OWNER_ROOM` (in the room); an actor id = inventory; 0 = removed. */
  readonly owner: number;
  /** Initial object state (0..15) — which OBIM image variant / open-closed etc. */
  readonly state: number;
  /** 32-bit class mask (class N → bit N-1). */
  readonly classMask: number;
}

export interface IndexFile {
  readonly maxs: Maxs;
  readonly rooms: ReadonlyArray<RoomDirectoryEntry>;
  readonly scripts: ReadonlyArray<ResourceDirectoryEntry>;
  readonly sounds: ReadonlyArray<ResourceDirectoryEntry>;
  readonly costumes: ReadonlyArray<ResourceDirectoryEntry>;
  readonly charsets: ReadonlyArray<ResourceDirectoryEntry>;
  /** Indexed by global object id. */
  readonly objects: ReadonlyArray<ObjectInit>;
}

export class IndexParseError extends Error {
  constructor(public readonly tag: string, detail: string) {
    super(`Index parse error in ${tag}: ${detail}`);
    this.name = 'IndexParseError';
  }
}

export function parseIndexFile(file: ResourceFile): IndexFile {
  const droo = parseLaneDirectory(blockPayload(file, 'DROO'), 'DROO');
  const dscr = parseLaneDirectory(blockPayload(file, 'DSCR'), 'DSCR');
  const dsou = parseLaneDirectory(blockPayload(file, 'DSOU'), 'DSOU');
  const dcos = parseLaneDirectory(blockPayload(file, 'DCOS'), 'DCOS');
  const dchr = parseLaneDirectory(blockPayload(file, 'DCHR'), 'DCHR');
  const dobjBlock = file.tree.find((b) => b.tag === 'DOBJ');
  return {
    maxs: parseMaxs(blockPayload(file, 'MAXS')),
    rooms: droo.map(({ a, b }) => ({ disk: a, offset: b })),
    scripts: dscr.map(({ a, b }) => ({ room: a, offset: b })),
    sounds: dsou.map(({ a, b }) => ({ room: a, offset: b })),
    costumes: dcos.map(({ a, b }) => ({ room: a, offset: b })),
    charsets: dchr.map(({ a, b }) => ({ room: a, offset: b })),
    objects: dobjBlock ? parseDobj(payloadOf(file, dobjBlock)) : [],
  };
}

/** DOBJ: u16 count, then packed owner/state bytes, then u32 LE class masks. */
export function parseDobj(payload: Uint8Array): ObjectInit[] {
  const num = payload.length >= 2 ? readU16LE(payload, 0) : 0;
  const classOff = 2 + num;
  const out: ObjectInit[] = new Array(num);
  for (let i = 0; i < num; i++) {
    const b = payload[2 + i] ?? 0;
    const o = classOff + i * 4;
    const classMask =
      ((payload[o] ?? 0) |
        ((payload[o + 1] ?? 0) << 8) |
        ((payload[o + 2] ?? 0) << 16) |
        ((payload[o + 3] ?? 0) << 24)) >>>
      0;
    out[i] = { owner: b & 0x0f, state: b >> 4, classMask };
  }
  return out;
}

export function parseMaxs(payload: Uint8Array): Maxs {
  if (payload.length < 14) {
    throw new IndexParseError(
      'MAXS',
      `payload too short (${payload.length} B); need at least 14 for the named fields`,
    );
  }
  const raw: number[] = [];
  for (let i = 0; i + 1 < payload.length; i += 2) {
    raw.push(readU16LE(payload, i));
  }
  return {
    raw,
    numVariables: raw[0]!,
    numBitVariables: raw[2]!,
    numLocalObjects: raw[3]!,
    numCharsets: raw[5]!,
    numVerbs: raw[6]!,
  };
}

interface LaneRow {
  readonly a: number;
  readonly b: number;
}

/** Decode a count u16 + count u8 + count u32 LE directory into raw lane pairs. */
export function parseLaneDirectory(payload: Uint8Array, tag: string): LaneRow[] {
  if (payload.length < 2) {
    throw new IndexParseError(tag, `payload too short (${payload.length} B)`);
  }
  const count = readU16LE(payload, 0);
  const expected = 2 + 5 * count;
  if (payload.length !== expected) {
    throw new IndexParseError(
      tag,
      `payload size ${payload.length} doesn't match count=${count} (expected ${expected})`,
    );
  }
  const out: LaneRow[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = payload[2 + i]!;
    const b = readU32LE(payload, 2 + count + i * 4);
    out[i] = { a, b };
  }
  return out;
}

function blockPayload(file: ResourceFile, tag: string): Uint8Array {
  const block = file.tree.find((b) => b.tag === tag);
  if (!block) {
    throw new IndexParseError(tag, 'block not found at index top level');
  }
  return payloadOf(file, block);
}

function readU16LE(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function readU32LE(b: Uint8Array, off: number): number {
  return (
    ((b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>>
      0)
  );
}
