import { describe, expect, it } from 'vitest';
import {
  IndexParseError,
  parseDobj,
  parseIndexFile,
  parseLaneDirectory,
  parseMaxs,
} from './index-file';
import { parseBlocks } from './block';
import type { ResourceFile } from './tree';

function buildIndexFile(
  blocks: ReadonlyArray<readonly [string, Uint8Array]>,
): ResourceFile {
  let total = 0;
  for (const [, p] of blocks) total += 8 + p.length;
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const [tag, p] of blocks) {
    for (let i = 0; i < 4; i++) bytes[cursor + i] = tag.charCodeAt(i);
    const size = 8 + p.length;
    bytes[cursor + 4] = (size >>> 24) & 0xff;
    bytes[cursor + 5] = (size >>> 16) & 0xff;
    bytes[cursor + 6] = (size >>> 8) & 0xff;
    bytes[cursor + 7] = size & 0xff;
    bytes.set(p, cursor + 8);
    cursor += size;
  }
  return { bytes, tree: parseBlocks(bytes) };
}

function laneBytes(
  entries: ReadonlyArray<readonly [number, number]>,
): Uint8Array {
  const count = entries.length;
  const out = new Uint8Array(2 + 5 * count);
  out[0] = count & 0xff;
  out[1] = (count >>> 8) & 0xff;
  for (let i = 0; i < count; i++) {
    out[2 + i] = entries[i]![0];
    const off = entries[i]![1];
    out[2 + count + i * 4 + 0] = off & 0xff;
    out[2 + count + i * 4 + 1] = (off >>> 8) & 0xff;
    out[2 + count + i * 4 + 2] = (off >>> 16) & 0xff;
    out[2 + count + i * 4 + 3] = (off >>> 24) & 0xff;
  }
  return out;
}

function u16LE(values: ReadonlyArray<number>): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    out[i * 2 + 0] = values[i]! & 0xff;
    out[i * 2 + 1] = (values[i]! >>> 8) & 0xff;
  }
  return out;
}

describe('parseDobj', () => {
  it('decodes owner (low nibble), state (high nibble) and the u32 class mask', () => {
    // 3 objects. owner/state bytes: 0x0f (owner15,state0), 0x12 (owner2,state1),
    // 0x00 (owner0,state0). Then 3 u32 LE class masks.
    const payload = new Uint8Array([
      0x03, 0x00, // count = 3
      0x0f, 0x12, 0x00, // owner/state per object
      0x00, 0x00, 0x00, 0x80, // obj0 class = 0x80000000 (Untouchable, bit 31)
      0x00, 0x10, 0x00, 0x00, // obj1 class = 0x1000
      0x00, 0x00, 0x00, 0x00, // obj2 class = 0
    ]);
    const objs = parseDobj(payload);
    expect(objs).toHaveLength(3);
    expect(objs[0]).toEqual({ owner: 15, state: 0, classMask: 0x80000000 });
    expect(objs[1]).toEqual({ owner: 2, state: 1, classMask: 0x1000 });
    expect(objs[2]).toEqual({ owner: 0, state: 0, classMask: 0 });
  });

  it('returns [] for an empty / too-short payload', () => {
    expect(parseDobj(new Uint8Array(0))).toEqual([]);
    expect(parseDobj(new Uint8Array([0x00, 0x00]))).toEqual([]);
  });
});

describe('parseMaxs', () => {
  it('extracts named fields from a 9-u16 MI1-shaped payload', () => {
    const m = parseMaxs(u16LE([800, 16, 2048, 200, 50, 7, 100, 50, 80]));
    expect(m.numVariables).toBe(800);
    expect(m.numBitVariables).toBe(2048);
    expect(m.numLocalObjects).toBe(200);
    expect(m.numCharsets).toBe(7);
    expect(m.numVerbs).toBe(100);
    expect(m.raw).toEqual([800, 16, 2048, 200, 50, 7, 100, 50, 80]);
  });

  it('handles odd-byte payloads by ignoring the trailing byte', () => {
    const buf = new Uint8Array(15);
    buf.set(u16LE([1, 2, 3, 4, 5, 6, 7]));
    const m = parseMaxs(buf);
    expect(m.raw).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('throws on too-short payload', () => {
    expect(() => parseMaxs(new Uint8Array(10))).toThrow(IndexParseError);
  });
});

describe('parseLaneDirectory', () => {
  it('decodes lane-1 u8 and lane-2 u32 LE in column order', () => {
    const rows = parseLaneDirectory(
      laneBytes([
        [0, 0],
        [10, 0x12345678],
        [11, 0xdeadbeef],
      ]),
      'DSCR',
    );
    expect(rows).toEqual([
      { a: 0, b: 0 },
      { a: 10, b: 0x12345678 },
      { a: 11, b: 0xdeadbeef },
    ]);
  });

  it('returns an empty list for count = 0', () => {
    const rows = parseLaneDirectory(new Uint8Array([0, 0]), 'DROO');
    expect(rows).toEqual([]);
  });

  it('throws when payload size disagrees with count', () => {
    const malformed = new Uint8Array(2 + 5 * 2);
    malformed[0] = 3;
    expect(() => parseLaneDirectory(malformed, 'DSCR')).toThrow(IndexParseError);
  });

  it('throws on truncated payload', () => {
    expect(() => parseLaneDirectory(new Uint8Array(1), 'DSCR')).toThrow(
      IndexParseError,
    );
  });
});

describe('parseIndexFile', () => {
  it('parses a synthetic .000-shaped buffer end to end', () => {
    const idx = parseIndexFile(
      buildIndexFile([
        ['RNAM', new Uint8Array(0)],
        ['MAXS', u16LE([800, 0, 2048, 200, 0, 7, 100, 0, 0])],
        // DROO: 3 rooms, room 1 and 2 present (disk=1), room 3 absent.
        ['DROO', laneBytes([[1, 0], [1, 0], [0, 0]])],
        // DSCR: script #0 unused, script #1 in room 10 at 0xabcd.
        ['DSCR', laneBytes([[0, 0], [10, 0xabcd]])],
        ['DSOU', laneBytes([])],
        ['DCOS', laneBytes([])],
        ['DCHR', laneBytes([])],
        ['DOBJ', new Uint8Array(0)],
      ]),
    );
    expect(idx.maxs.numVariables).toBe(800);
    expect(idx.rooms).toEqual([
      { disk: 1, offset: 0 },
      { disk: 1, offset: 0 },
      { disk: 0, offset: 0 },
    ]);
    expect(idx.scripts).toEqual([
      { room: 0, offset: 0 },
      { room: 10, offset: 0xabcd },
    ]);
  });

  it('throws when a required block is missing', () => {
    expect(() =>
      parseIndexFile(
        buildIndexFile([
          ['MAXS', u16LE([0, 0, 0, 0, 0, 0, 0, 0, 0])],
        ]),
      ),
    ).toThrow(IndexParseError);
  });
});
