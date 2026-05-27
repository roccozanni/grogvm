/**
 * SCUMM v5 index file parser (MONKEY.000 / MONKEY2.000).
 *
 * The index lists every resource the engine can name — variables and
 * bit-vars in `MAXS`, then per-type directories (`DROO`, `DSCR`,
 * `DSOU`, `DCOS`, `DCHR`) mapping a resource id to its owning room
 * (or disk, for `DROO`) and its offset inside the matching `.001`.
 * `DOBJ` tracks object state and is deferred until objects are needed.
 *
 * # Lane encoding
 *
 * Every per-resource directory in v5 stores its rows column-wise, not
 * row-wise:
 *
 *   u16 LE  count
 *   u8     × count       (lane 1)
 *   u32 LE × count       (lane 2)
 *
 * Total payload = `2 + count + 4 * count = 2 + 5 * count`. We verified
 * this empirically against MI1: the row-wise alternative produces
 * gibberish; the column-wise read produces sensible values across all
 * four resource families.
 *
 * # Lane-1 semantics (this surprised us)
 *
 *   - **`DROO`** — lane 1 is the **disk number**. Single-disk MI1 has
 *     `disk = 1` on every present room and `0` on unused slots.
 *   - **`DSCR` / `DSOU` / `DCOS` / `DCHR`** — lane 1 is the **owning
 *     room number**. The script (or sound, costume, charset) lives
 *     inside that room's LFLF. Use LOFF (see `loff.ts`) to turn the
 *     room number into a file offset, then add the lane-2 offset.
 *
 *   `room = 0` is the SCUMM "unused" sentinel — most directories
 *   have a sprinkling of these (e.g. MI1's script #0 and #15).
 *
 * # Lane-2 semantics
 *
 *   - **`DROO`** — typically `0` (single-disk releases); the real
 *     ROOM-block offsets live in LOFF.
 *   - **`DSCR` / `DSOU` / `DCOS` / `DCHR`** — byte offset relative to
 *     the owning room's ROOM-block file offset. To resolve the
 *     absolute file position of script N's SCRP header:
 *     `LOFF[scripts[N].room] + scripts[N].offset`.
 *
 * # MAXS
 *
 * 9 × u16 LE on MI1. The fields that matter for the VM right now:
 *
 *   [0] numVariables        — globals 0..numVariables-1
 *   [2] numBitVariables     — bit vars 0..numBitVariables-1
 *   [3] numLocalObjects     — upper bound on objects per room
 *   [5] numCharsets         — number of CHAR resources
 *   [6] numVerbs            — number of verb slots
 *
 * The remaining slots vary by reverse-engineering source. We expose
 * the raw u16 array so any later consumer can read positions we don't
 * yet name.
 */

import { payloadOf, type ResourceFile } from './tree';

export interface Maxs {
  /** Raw u16 LE array, as read from the MAXS block payload. */
  readonly raw: ReadonlyArray<number>;
  readonly numVariables: number;
  readonly numBitVariables: number;
  readonly numLocalObjects: number;
  readonly numCharsets: number;
  readonly numVerbs: number;
}

/** One row of `DROO`. */
export interface RoomDirectoryEntry {
  /** `0` means "not present in this release", any non-zero means disk N. */
  readonly disk: number;
  /** Typically `0` for single-disk v5 — real offset is in LOFF. */
  readonly offset: number;
}

/** One row of `DSCR` / `DSOU` / `DCOS` / `DCHR`. */
export interface ResourceDirectoryEntry {
  /** Room id that owns this resource. `0` means the slot is unused. */
  readonly room: number;
  /**
   * Byte offset relative to the owning room's ROOM-block file
   * offset. Combined with LOFF this gives the absolute file position
   * of the resource's block header.
   */
  readonly offset: number;
}

export interface IndexFile {
  readonly maxs: Maxs;
  readonly rooms: ReadonlyArray<RoomDirectoryEntry>;
  readonly scripts: ReadonlyArray<ResourceDirectoryEntry>;
  readonly sounds: ReadonlyArray<ResourceDirectoryEntry>;
  readonly costumes: ReadonlyArray<ResourceDirectoryEntry>;
  readonly charsets: ReadonlyArray<ResourceDirectoryEntry>;
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
  return {
    maxs: parseMaxs(blockPayload(file, 'MAXS')),
    rooms: droo.map(({ a, b }) => ({ disk: a, offset: b })),
    scripts: dscr.map(({ a, b }) => ({ room: a, offset: b })),
    sounds: dsou.map(({ a, b }) => ({ room: a, offset: b })),
    costumes: dcos.map(({ a, b }) => ({ room: a, offset: b })),
    charsets: dchr.map(({ a, b }) => ({ room: a, offset: b })),
  };
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
