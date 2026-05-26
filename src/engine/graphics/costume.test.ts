import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../resources/block';
import { walkCostumes, parseCostumeHeader, decodeLimbTables } from './costume';
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

function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

function makeHeaderPayload(opts: {
  numAnim: number;
  format: number;
  palette: number[];
  animCmdOffset: number;
  limbOffsets: number[];
  animOffsets: number[];
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(opts.numAnim - 1);
  bytes.push(opts.format);
  bytes.push(...opts.palette);
  bytes.push(...u16le(opts.animCmdOffset));
  for (const o of opts.limbOffsets) bytes.push(...u16le(o));
  for (const o of opts.animOffsets) bytes.push(...u16le(o));
  return new Uint8Array(bytes);
}

describe('walkCostumes', () => {
  it('returns one entry per COST in each LFLF, in source order', () => {
    const lflf1 = block('LFLF', concat(block('ROOM'), block('COST', [0x00, 0x58]), block('COST', [0x00, 0x58])));
    const lflf2 = block('LFLF', concat(block('COST', [0x00, 0x58])));
    const lecf = block('LECF', concat(lflf1, lflf2));
    const file = makeFile(lecf);

    const costumes = walkCostumes(file);
    expect(costumes).toHaveLength(3);
    expect(costumes[0]!.lflfIndex).toBe(0);
    expect(costumes[0]!.indexInLflf).toBe(0);
    expect(costumes[1]!.lflfIndex).toBe(0);
    expect(costumes[1]!.indexInLflf).toBe(1);
    expect(costumes[2]!.lflfIndex).toBe(1);
    expect(costumes[2]!.indexInLflf).toBe(0);
    expect(costumes.every((c) => c.costBlock.tag === 'COST')).toBe(true);
  });

  it('skips LFLFs without any COST but still advances the lflfIndex', () => {
    const empty = block('LFLF', concat(block('ROOM')));
    const withCost = block('LFLF', concat(block('COST', [0x00, 0x58])));
    const lecf = block('LECF', concat(empty, withCost));
    const file = makeFile(lecf);

    const costumes = walkCostumes(file);
    expect(costumes).toHaveLength(1);
    expect(costumes[0]!.lflfIndex).toBe(1);
  });

  it('returns an empty array when there is no LECF', () => {
    const file = makeFile(block('RNAM'));
    expect(walkCostumes(file)).toEqual([]);
  });

  it('returns an empty array when no LFLF contains a COST', () => {
    const lflf = block('LFLF', concat(block('ROOM')));
    const file = makeFile(block('LECF', lflf));
    expect(walkCostumes(file)).toEqual([]);
  });
});

describe('parseCostumeHeader', () => {
  it('parses a 16-color costume with no mirror flag', () => {
    const palette = Array.from({ length: 16 }, (_, i) => 0x10 + i);
    const limbOffsets = Array.from({ length: 16 }, (_, i) => 0x1000 + i);
    const animOffsets = [0x2000, 0x2100, 0x2200];
    const payload = makeHeaderPayload({
      numAnim: 3,
      format: 0x58, // bit 7 = 0 (mirror flag off), bit 0 = 0 (16-color)
      palette,
      animCmdOffset: 0x0040,
      limbOffsets,
      animOffsets,
    });
    const header = parseCostumeHeader(payload);
    expect(header.numAnim).toBe(3);
    expect(header.format).toBe(0x58);
    expect(header.mirrorFlag).toBe(false);
    expect(header.paletteSize).toBe(16);
    expect(Array.from(header.palette)).toEqual(palette);
    expect(header.animCmdOffset).toBe(0x0040);
    expect(header.limbOffsets).toEqual(limbOffsets);
    expect(header.animOffsets).toEqual(animOffsets);
  });

  it('parses a 32-color costume with mirror flag set', () => {
    const palette = Array.from({ length: 32 }, (_, i) => i * 2);
    const limbOffsets = Array.from({ length: 16 }, (_, i) => 0x200 + i * 4);
    const animOffsets = [0x0400];
    const payload = makeHeaderPayload({
      numAnim: 1,
      format: 0x81, // bit 7 = 1 (mirror flag on), bit 0 = 1 (32-color)
      palette,
      animCmdOffset: 0x0080,
      limbOffsets,
      animOffsets,
    });
    const header = parseCostumeHeader(payload);
    expect(header.numAnim).toBe(1);
    expect(header.mirrorFlag).toBe(true);
    expect(header.paletteSize).toBe(32);
    expect(Array.from(header.palette)).toEqual(palette);
    expect(header.animCmdOffset).toBe(0x0080);
    expect(header.animOffsets).toEqual(animOffsets);
  });

  it('produces 16 limb offsets regardless of how many animations there are', () => {
    const header = parseCostumeHeader(
      makeHeaderPayload({
        numAnim: 1,
        format: 0x58,
        palette: Array.from({ length: 16 }, () => 0),
        animCmdOffset: 0,
        limbOffsets: Array.from({ length: 16 }, (_, i) => i),
        animOffsets: [0],
      }),
    );
    expect(header.limbOffsets).toHaveLength(16);
    expect(header.limbOffsets[15]).toBe(15);
  });

  it('throws when the payload is shorter than the declared palette', () => {
    const tooShort = new Uint8Array([0x00, 0x58, 0x10, 0x11]); // 2 bytes of palette, need 16
    expect(() => parseCostumeHeader(tooShort)).toThrow(/COST palette truncated/);
  });

  it('throws when there are not enough bytes for the anim-offset table', () => {
    const bytes: number[] = [];
    bytes.push(4); // numAnim - 1 = 4 → 5 anims
    bytes.push(0x58);
    bytes.push(...Array.from({ length: 16 }, () => 0)); // palette
    bytes.push(...u16le(0)); // animCmdOffset
    for (let i = 0; i < 16; i++) bytes.push(...u16le(0)); // limb offsets
    bytes.push(...u16le(0)); // only one anim offset, not five
    expect(() => parseCostumeHeader(new Uint8Array(bytes))).toThrow(/animOffsets\[1\]/);
  });
});

describe('decodeLimbTables', () => {
  function header(limbOffsets: number[]): import('./costume').CostumeHeader {
    return {
      numAnim: 1,
      format: 0x58,
      mirrorFlag: false,
      paletteSize: 16,
      palette: new Uint8Array(16),
      animCmdOffset: 0,
      limbOffsets,
      animOffsets: [0],
    };
  }

  it('groups limbs sharing the same offset', () => {
    const limbOffsets = [0x10, 0x20, 0x30, 0x30, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const payload = new Uint8Array(0x80);
    // Write three u16 LE values at each table location.
    const writeU16At = (off: number, vals: number[]): void => {
      for (let i = 0; i < vals.length; i++) {
        payload[off + i * 2] = vals[i]! & 0xff;
        payload[off + i * 2 + 1] = (vals[i]! >>> 8) & 0xff;
      }
    };
    writeU16At(0x10, [0x40, 0x44, 0x48, 0x4c, 0x50]); // limb 0 table — 5 entries fit before 0x20
    writeU16At(0x20, [0x54, 0x58, 0x5c, 0x60, 0x64]); // limb 1 table — 5 entries before 0x30
    writeU16At(0x30, [0x68, 0x6c]); // limbs 2..4 share this

    const tables = decodeLimbTables(payload, header(limbOffsets));
    expect(tables).toHaveLength(3);
    expect(tables[0]).toMatchObject({ tableOffset: 0x10, usedByLimbs: [0] });
    // Reads u16 values in the whole [0x10, 0x20) range — 8 entries; last 3
    // are zero padding from the test fixture.
    expect(tables[0]!.entries.slice(0, 5)).toEqual([0x40, 0x44, 0x48, 0x4c, 0x50]);
    expect(tables[0]!.entries).toHaveLength(8);
    expect(tables[1]).toMatchObject({ tableOffset: 0x20, usedByLimbs: [1] });
    expect(tables[2]).toMatchObject({ tableOffset: 0x30, usedByLimbs: [2, 3, 4] });
  });

  it('flags entries that point backwards or beyond the payload', () => {
    const limbOffsets = Array<number>(16).fill(0);
    limbOffsets[0] = 0x20;
    const payload = new Uint8Array(0x40);
    // Three entries: one good, one too small, one too big.
    payload[0x20] = 0x30;
    payload[0x21] = 0x00; // 0x30 — valid (in payload)
    payload[0x22] = 0x05;
    payload[0x23] = 0x00; // 0x05 — points backwards
    payload[0x24] = 0x00;
    payload[0x25] = 0x80; // 0x8000 — way past end

    const tables = decodeLimbTables(payload, header(limbOffsets));
    expect(tables).toHaveLength(1);
    expect(tables[0]!.entries.slice(0, 3)).toEqual([0x30, 0x05, 0x8000]);
    expect(tables[0]!.suspicious.slice(0, 3)).toEqual([false, true, true]);
    // Remaining entries are zero — suspicious (below tableOffset 0x20).
    expect(tables[0]!.suspicious.every((s, i) => i < 3 || s === true)).toBe(true);
  });

  it('returns an empty array when no limb is in use', () => {
    const limbOffsets = Array<number>(16).fill(0);
    const tables = decodeLimbTables(new Uint8Array(16), header(limbOffsets));
    expect(tables).toEqual([]);
  });
});
