/**
 * SCUMM v5 LOFF parser — the room-id → ROOM-block file-offset table
 * that lives at the top of every resource file's `LECF` container.
 *
 * `LOFF` is the authoritative way to seek to a room in `.001`. The
 * index file's `DROO` directory exists alongside it but its offset
 * lane is empty on single-disk MI1/MI2 — the engine reads LOFF.
 *
 * Payload layout (after the 8-byte block header):
 *
 *   u8       count
 *   count × {
 *     u8     room
 *     u32 LE offset      ◀ byte offset of the ROOM block inside .001
 *   }
 *
 * Total payload = `1 + 5 * count`. The offset points at the ROOM
 * block's own 8-byte header, not its payload.
 */

import { payloadOf, type ResourceFile } from './tree';

export class LoffParseError extends Error {
  constructor(detail: string) {
    super(`LOFF parse error: ${detail}`);
    this.name = 'LoffParseError';
  }
}

/**
 * Maps `roomId` to the byte offset of that room's ROOM block in the
 * resource file. Rooms not present in this release are absent (no
 * entry).
 */
export type RoomOffsetTable = ReadonlyMap<number, number>;

export function parseLoff(file: ResourceFile): RoomOffsetTable {
  const lecf = file.tree.find((b) => b.tag === 'LECF');
  if (!lecf?.children) {
    throw new LoffParseError('no LECF container at the top of the file');
  }
  const loff = lecf.children.find((b) => b.tag === 'LOFF');
  if (!loff) {
    throw new LoffParseError('LECF has no LOFF child');
  }
  const payload = payloadOf(file, loff);
  if (payload.length < 1) {
    throw new LoffParseError(`payload too short (${payload.length} B)`);
  }
  const count = payload[0]!;
  const expected = 1 + 5 * count;
  if (payload.length !== expected) {
    throw new LoffParseError(
      `payload size ${payload.length} doesn't match count=${count} (expected ${expected})`,
    );
  }
  const table = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const room = payload[1 + i * 5]!;
    const offset =
      ((payload[1 + i * 5 + 1]! |
        (payload[1 + i * 5 + 2]! << 8) |
        (payload[1 + i * 5 + 3]! << 16) |
        (payload[1 + i * 5 + 4]! << 24)) >>>
        0);
    table.set(room, offset);
  }
  return table;
}
