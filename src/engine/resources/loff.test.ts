import { describe, expect, it } from 'vitest';
import { LoffParseError, parseLoff } from './loff';
import { parseBlocks } from './block';
import type { ResourceFile } from './tree';

/** Build a synthetic .001-style ResourceFile: LECF { LOFF { …entries… } }. */
function buildResource(loffEntries: ReadonlyArray<readonly [number, number]>): ResourceFile {
  const loffPayload = new Uint8Array(1 + 5 * loffEntries.length);
  loffPayload[0] = loffEntries.length;
  for (let i = 0; i < loffEntries.length; i++) {
    loffPayload[1 + i * 5] = loffEntries[i]![0];
    const off = loffEntries[i]![1];
    loffPayload[1 + i * 5 + 1] = off & 0xff;
    loffPayload[1 + i * 5 + 2] = (off >>> 8) & 0xff;
    loffPayload[1 + i * 5 + 3] = (off >>> 16) & 0xff;
    loffPayload[1 + i * 5 + 4] = (off >>> 24) & 0xff;
  }
  const loffBlock = new Uint8Array(8 + loffPayload.length);
  loffBlock.set([76, 79, 70, 70], 0); // 'LOFF'
  const loffSize = 8 + loffPayload.length;
  loffBlock[4] = (loffSize >>> 24) & 0xff;
  loffBlock[5] = (loffSize >>> 16) & 0xff;
  loffBlock[6] = (loffSize >>> 8) & 0xff;
  loffBlock[7] = loffSize & 0xff;
  loffBlock.set(loffPayload, 8);

  const lecfPayload = loffBlock;
  const bytes = new Uint8Array(8 + lecfPayload.length);
  bytes.set([76, 69, 67, 70], 0); // 'LECF'
  const lecfSize = 8 + lecfPayload.length;
  bytes[4] = (lecfSize >>> 24) & 0xff;
  bytes[5] = (lecfSize >>> 16) & 0xff;
  bytes[6] = (lecfSize >>> 8) & 0xff;
  bytes[7] = lecfSize & 0xff;
  bytes.set(lecfPayload, 8);

  return { bytes, tree: parseBlocks(bytes) };
}

describe('parseLoff', () => {
  it('returns a roomId → offset map', () => {
    const table = parseLoff(
      buildResource([
        [1, 0x100],
        [2, 0x200],
        [7, 0x700],
      ]),
    );
    expect(table.size).toBe(3);
    expect(table.get(1)).toBe(0x100);
    expect(table.get(2)).toBe(0x200);
    expect(table.get(7)).toBe(0x700);
    expect(table.get(3)).toBeUndefined();
  });

  it('handles count = 0', () => {
    const table = parseLoff(buildResource([]));
    expect(table.size).toBe(0);
  });

  it('decodes a u32 LE offset > 0x7fffffff (high bit set) as unsigned', () => {
    // 0x80000000 reads as 2147483648, not -2147483648.
    const table = parseLoff(buildResource([[1, 0x80000000]]));
    expect(table.get(1)).toBe(0x80000000);
  });

  it('throws when LECF is missing', () => {
    const bytes = new Uint8Array(8);
    bytes.set([88, 88, 88, 88], 0); // 'XXXX'
    bytes[7] = 8;
    expect(() => parseLoff({ bytes, tree: parseBlocks(bytes) })).toThrow(
      LoffParseError,
    );
  });

  it('throws when LOFF size disagrees with count', () => {
    // Build a malformed LOFF: count says 3 but payload only fits 2.
    const bad = new Uint8Array(1 + 5 * 2);
    bad[0] = 3;
    const loffBlock = new Uint8Array(8 + bad.length);
    loffBlock.set([76, 79, 70, 70], 0);
    const sz = 8 + bad.length;
    loffBlock[4] = (sz >>> 24) & 0xff;
    loffBlock[5] = (sz >>> 16) & 0xff;
    loffBlock[6] = (sz >>> 8) & 0xff;
    loffBlock[7] = sz & 0xff;
    loffBlock.set(bad, 8);
    const file = new Uint8Array(8 + loffBlock.length);
    file.set([76, 69, 67, 70], 0);
    const fsz = 8 + loffBlock.length;
    file[4] = (fsz >>> 24) & 0xff;
    file[5] = (fsz >>> 16) & 0xff;
    file[6] = (fsz >>> 8) & 0xff;
    file[7] = fsz & 0xff;
    file.set(loffBlock, 8);
    expect(() => parseLoff({ bytes: file, tree: parseBlocks(file) })).toThrow(
      LoffParseError,
    );
  });
});
