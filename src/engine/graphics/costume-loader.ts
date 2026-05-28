/**
 * SCUMM v5 costume loader — resolves a costume id to a parsed
 * `LoadedCostume` (header + raw payload) ready for the actor
 * compositor to decode frame-by-frame.
 *
 * Same shape as `room/loader.ts` (LOFF-driven lookup + tree-walk to
 * find the block) and `vm/scripts.ts` (DCOS-driven id → room/offset
 * resolution). We don't decode every frame up-front — those are
 * needed lazily based on the actor's current anim state. Storing the
 * payload alongside the header lets the compositor call
 * `decodeCostumeFrame(payload, framePtr)` on demand.
 */

import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';
import { payloadOf, type ResourceFile } from '../resources/tree';
import { parseCostumeHeader, walkCostumes, type CostumeHeader } from './costume';

export class CostumeLoadError extends Error {
  constructor(public readonly costumeId: number, detail: string) {
    super(`Cannot load costume #${costumeId}: ${detail}`);
    this.name = 'CostumeLoadError';
  }
}

export interface LoadedCostume {
  readonly id: number;
  readonly header: CostumeHeader;
  /**
   * COST block payload (without the 8-byte block header). All offsets
   * in `header` are relative to byte 0 of this buffer.
   */
  readonly payload: Uint8Array;
}

/**
 * Resolve a costume id to its parsed header + payload.
 *
 * Throws {@link CostumeLoadError} on:
 *   - costume id 0 / out of range
 *   - unused DCOS slot (room = 0)
 *   - owning room not in LOFF
 *   - resolved offset doesn't land on a COST block in the tree
 *   - header parse fails
 */
export function loadCostume(
  file: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  costumeId: number,
): LoadedCostume {
  if (costumeId <= 0) {
    throw new CostumeLoadError(costumeId, 'id must be ≥ 1');
  }
  const entry = index.costumes[costumeId];
  if (!entry) {
    throw new CostumeLoadError(
      costumeId,
      `id out of range (max ${index.costumes.length - 1})`,
    );
  }
  if (entry.room === 0) {
    throw new CostumeLoadError(costumeId, 'unused DCOS slot (room = 0)');
  }
  const roomOffset = loff.get(entry.room);
  if (roomOffset === undefined) {
    throw new CostumeLoadError(
      costumeId,
      `owning room ${entry.room} not present in LOFF`,
    );
  }
  const absoluteOffset = roomOffset + entry.offset;
  const block = findCostBlockAt(file, absoluteOffset);
  if (!block) {
    throw new CostumeLoadError(
      costumeId,
      `no COST block at 0x${absoluteOffset.toString(16)} (LOFF[${entry.room}] + DCOS offset 0x${entry.offset.toString(16)})`,
    );
  }
  const payload = new Uint8Array(payloadOf(file, block));
  let header: CostumeHeader;
  try {
    header = parseCostumeHeader(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CostumeLoadError(costumeId, `header parse failed: ${message}`);
  }
  return { id: costumeId, header, payload };
}

function findCostBlockAt(file: ResourceFile, offset: number) {
  // The COST block lives directly under an LFLF. `walkCostumes` already
  // enumerates them all so we just match on absolute offset.
  for (const entry of walkCostumes(file)) {
    if (entry.costBlock.offset === offset) return entry.costBlock;
  }
  return null;
}
