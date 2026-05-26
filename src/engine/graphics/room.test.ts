import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../resources/block';
import { walkRooms } from './room';
import type { ResourceFile } from '../resources/tree';

function block(tag: string, payload: Uint8Array | number[] = []): Uint8Array {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const size = 8 + payloadBytes.length;
  const out = new Uint8Array(size);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(payloadBytes, 8);
  return out;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function makeFile(bytes: Uint8Array): ResourceFile {
  return { bytes, tree: parseBlocks(bytes) };
}

describe('walkRooms', () => {
  it('returns one entry per LFLF that contains a ROOM, in source order', () => {
    const lflf1 = block('LFLF', concat(block('ROOM', block('RMHD'))));
    const lflf2 = block('LFLF', concat(block('ROOM', block('RMHD'))));
    const lecf = block('LECF', concat(lflf1, lflf2));
    const file = makeFile(lecf);

    const rooms = walkRooms(file);
    expect(rooms).toHaveLength(2);
    expect(rooms[0]!.lflfIndex).toBe(0);
    expect(rooms[1]!.lflfIndex).toBe(1);
    expect(rooms.every((r) => r.roomBlock.tag === 'ROOM')).toBe(true);
  });

  it('skips LFLFs without a ROOM child but still advances the lflfIndex', () => {
    const empty = block('LFLF', concat());
    const withRoom = block('LFLF', concat(block('ROOM', block('RMHD'))));
    const lecf = block('LECF', concat(empty, withRoom));
    const file = makeFile(lecf);

    const rooms = walkRooms(file);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.lflfIndex).toBe(1);
  });

  it('returns an empty array when there is no LECF', () => {
    const file = makeFile(block('RNAM'));
    expect(walkRooms(file)).toEqual([]);
  });

  it('returns an empty array when LECF has no LFLFs', () => {
    const file = makeFile(block('LECF', concat()));
    expect(walkRooms(file)).toEqual([]);
  });
});
