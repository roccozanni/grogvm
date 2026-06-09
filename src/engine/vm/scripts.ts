/**
 * Resolve a SCUMM v5 global script (SCRP block) to its bytecode body.
 *
 * Three-way join across the index file, LOFF, and the resource file:
 *
 *   1. `index.scripts[id]` → `{ room, offset }`. `room = 0` means the
 *      slot is unused.
 *   2. `loff.get(room)` → absolute byte offset of the room's ROOM
 *      block in `.001`. LOFF lives at `LECF/LOFF` inside the resource
 *      file (see `loff.ts`).
 *   3. `loff[room] + index.scripts[id].offset` lands on the SCRP
 *      block header in `.001`. We verify the tag, slice off the
 *      8-byte block header, and return the raw bytecode payload.
 *
 * Verified empirically against MI1: 178 / 199 DSCR entries resolve to
 * a valid SCRP via this rule; the other 21 are zero-room "unused"
 * slots, correctly rejected with `ScriptLoadError`.
 *
 * For Phase 5 only `SCRP` (global scripts) is supported. `LSCR`
 * (room-local) and `OBCD` (object verbs) come later.
 */

import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';

export class ScriptLoadError extends Error {
  constructor(public readonly scriptId: number, detail: string) {
    super(`Cannot load global script #${scriptId}: ${detail}`);
    this.name = 'ScriptLoadError';
  }
}

export interface LoadedScript {
  /** Global script id, as known by `DSCR`. */
  readonly id: number;
  /** Owning room id. */
  readonly room: number;
  /** Raw bytecode — the SCRP block's payload. */
  readonly bytecode: Uint8Array;
  /** Absolute byte offset of the SCRP header in `.001`. */
  readonly offsetInFile: number;
}

export function loadGlobalScript(
  file: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  scriptId: number,
): LoadedScript {
  const entry = index.scripts[scriptId];
  if (!entry) {
    throw new ScriptLoadError(
      scriptId,
      `id out of range (max ${index.scripts.length - 1})`,
    );
  }
  if (entry.room === 0) {
    throw new ScriptLoadError(scriptId, 'unused entry (room = 0)');
  }

  const roomOffset = loff.get(entry.room);
  if (roomOffset === undefined) {
    throw new ScriptLoadError(
      scriptId,
      `owning room ${entry.room} not present in LOFF`,
    );
  }

  const candidate = roomOffset + entry.offset;
  if (candidate + 8 > file.bytes.length) {
    throw new ScriptLoadError(
      scriptId,
      `resolved offset 0x${candidate.toString(16)} past end of file`,
    );
  }
  const tag = readTag(file.bytes, candidate);
  if (tag !== 'SCRP') {
    throw new ScriptLoadError(
      scriptId,
      `expected SCRP at 0x${candidate.toString(16)}, got '${tag}'`,
    );
  }
  const size = readU32BE(file.bytes, candidate + 4);
  if (size < 8 || candidate + size > file.bytes.length) {
    throw new ScriptLoadError(
      scriptId,
      `SCRP at 0x${candidate.toString(16)} has invalid size ${size}`,
    );
  }
  return {
    id: scriptId,
    room: entry.room,
    bytecode: file.bytes.subarray(candidate + 8, candidate + size),
    offsetInFile: candidate,
  };
}

/**
 * Resolve a sound id to its `SOUN` block payload (everything after the
 * 8-byte block header), via the same index/LOFF join as
 * {@link loadGlobalScript} but over the `DSOU` directory. Returns null for
 * unused slots or when the resolved bytes aren't a `SOUN` block, so the
 * caller treats a missing sound as silence rather than throwing. The audio
 * timing seam parses this payload with `parseSound`.
 */
export function loadSound(
  file: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  soundId: number,
): Uint8Array | null {
  const entry = index.sounds[soundId];
  if (!entry || entry.room === 0) return null;
  const roomOffset = loff.get(entry.room);
  if (roomOffset === undefined) return null;
  const candidate = roomOffset + entry.offset;
  if (candidate + 8 > file.bytes.length) return null;
  if (readTag(file.bytes, candidate) !== 'SOUN') return null;
  const size = readU32BE(file.bytes, candidate + 4);
  if (size < 8 || candidate + size > file.bytes.length) return null;
  return file.bytes.subarray(candidate + 8, candidate + size);
}

function readTag(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!);
}

function readU32BE(b: Uint8Array, off: number): number {
  return (
    ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0
  );
}
