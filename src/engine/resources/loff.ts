/**
 * LOFF parser — room id → ROOM-block file offset, the authoritative room
 * lookup (DROO's offset lane is empty). See pages/docs/scumm/index-file.md §5.
 */

import { payloadOf, type ResourceFile } from './tree';

export class LoffParseError extends Error {
  constructor(detail: string) {
    super(`LOFF parse error: ${detail}`);
    this.name = 'LoffParseError';
  }
}

/** roomId → byte offset of the ROOM block's header (rooms not in this release are absent). */
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
