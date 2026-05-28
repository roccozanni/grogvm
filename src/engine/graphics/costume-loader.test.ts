import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../resources/block';
import { parseIndexFile } from '../resources/index-file';
import { parseLoff } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';
import { CostumeLoadError, loadCostume } from './costume-loader';

// ─── helpers ──────────────────────────────────────────────────────────

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

/** LOFF body (`u8 count + count × (u8 room, u32 LE offset)`). */
function loffBody(entries: ReadonlyArray<{ id: number; offset: number }>): Uint8Array {
  const out = new Uint8Array(1 + 5 * entries.length);
  out[0] = entries.length;
  let off = 1;
  for (const e of entries) {
    out[off++] = e.id;
    out[off++] = e.offset & 0xff;
    out[off++] = (e.offset >>> 8) & 0xff;
    out[off++] = (e.offset >>> 16) & 0xff;
    out[off++] = (e.offset >>> 24) & 0xff;
  }
  return out;
}

/**
 * A minimal COST payload: numAnim=1, format=0 (16-color, no mirror),
 * 16-byte palette, animCmdOffset=0, 16 limb offsets all 0, 1 anim
 * offset = 0. Total = 2 + 16 + 2 + 32 + 2 = 54 bytes.
 */
function minimalCostPayload(): Uint8Array {
  const out = new Uint8Array(2 + 16 + 2 + 32 + 2);
  out[0] = 0; // numAnim - 1 = 0 → numAnim = 1
  out[1] = 0; // format = 16-color, no mirror
  // palette[0..15]: leave as zeros
  // animCmdOffset @ 18 = 0
  // limbOffsets[0..15] @ 20..51 = 0
  // animOffsets[0] @ 52 = 0
  return out;
}

/**
 * Build a synthetic .000 (index file) + .001 (resource file) pair
 * that defines one costume in one room. Returns both files.
 */
function buildSyntheticFiles(opts: {
  costumeId: number;
}): { indexFile: ResourceFile; resourceFile: ResourceFile } {
  // ── .001 resource file: LECF { LOFF, LFLF { ROOM, COST } }
  const room = block('ROOM', new Uint8Array(0));
  const cost = block('COST', minimalCostPayload());
  const lflf = block('LFLF', concat(room, cost));

  const loffPayloadSize = 1 + 5 * 1;
  const loffSize = 8 + loffPayloadSize;
  const lecfHeaderSize = 8;
  const lflfHeaderSize = 8;
  const roomBlockOffset = lecfHeaderSize + loffSize + lflfHeaderSize;
  const costBlockOffset = roomBlockOffset + room.length;

  const loff = block('LOFF', loffBody([{ id: 1, offset: roomBlockOffset }]));
  const lecf = block('LECF', concat(loff, lflf));
  const resourceFile = makeFile(lecf);

  // ── .000 index file: needs MAXS, DROO, DSCR, DSOU, DCOS, DCHR
  // DCOS holds one entry: id `opts.costumeId` → owning room 1, offset
  // relative to room block. The COST sits just past the room block,
  // so its offset (relative to room block) = room.length.
  const costRelOffset = room.length;

  // Lane-encoded directory: u16 count, count × u8 (lane 1), count × u32 LE (lane 2)
  const dcosCount = opts.costumeId + 1;
  const dcosPayload = new Uint8Array(2 + dcosCount + dcosCount * 4);
  dcosPayload[0] = dcosCount & 0xff;
  dcosPayload[1] = (dcosCount >>> 8) & 0xff;
  // owning-room lane: all zeros except entry at costumeId
  dcosPayload[2 + opts.costumeId] = 1; // room 1
  // offset lane: all zeros except entry at costumeId
  const offBase = 2 + dcosCount + opts.costumeId * 4;
  dcosPayload[offBase + 0] = costRelOffset & 0xff;
  dcosPayload[offBase + 1] = (costRelOffset >>> 8) & 0xff;
  dcosPayload[offBase + 2] = (costRelOffset >>> 16) & 0xff;
  dcosPayload[offBase + 3] = (costRelOffset >>> 24) & 0xff;

  // Other directories: empty. MAXS needs at least 7 fields (14 bytes) — give it 9 (18 bytes).
  const maxs = block('MAXS', new Uint8Array(18));
  const droo = block('DROO', new Uint8Array([0x00, 0x00]));
  const dscr = block('DSCR', new Uint8Array([0x00, 0x00]));
  const dsou = block('DSOU', new Uint8Array([0x00, 0x00]));
  const dcos = block('DCOS', dcosPayload);
  const dchr = block('DCHR', new Uint8Array([0x00, 0x00]));

  const indexBytes = concat(maxs, droo, dscr, dsou, dcos, dchr);
  const indexFile = makeFile(indexBytes);
  return { indexFile, resourceFile };
}

describe('loadCostume — synthetic fixtures', () => {
  it('resolves costume id → header + payload via DCOS + LOFF', () => {
    const { indexFile, resourceFile } = buildSyntheticFiles({ costumeId: 3 });
    const index = parseIndexFile(indexFile);
    const loff = parseLoff(resourceFile);
    const cost = loadCostume(resourceFile, index, loff, 3);
    expect(cost.id).toBe(3);
    expect(cost.header.numAnim).toBe(1);
    expect(cost.header.paletteSize).toBe(16);
    expect(cost.payload.length).toBeGreaterThan(0);
    expect(cost.payload[0]).toBe(0); // numAnim - 1
  });

  it('throws CostumeLoadError on id 0', () => {
    const { indexFile, resourceFile } = buildSyntheticFiles({ costumeId: 1 });
    const index = parseIndexFile(indexFile);
    const loff = parseLoff(resourceFile);
    expect(() => loadCostume(resourceFile, index, loff, 0)).toThrow(CostumeLoadError);
  });

  it('throws CostumeLoadError on out-of-range id', () => {
    const { indexFile, resourceFile } = buildSyntheticFiles({ costumeId: 1 });
    const index = parseIndexFile(indexFile);
    const loff = parseLoff(resourceFile);
    expect(() => loadCostume(resourceFile, index, loff, 999)).toThrow(/out of range/);
  });

  it('throws CostumeLoadError on unused DCOS slot (room = 0)', () => {
    const { indexFile, resourceFile } = buildSyntheticFiles({ costumeId: 2 });
    const index = parseIndexFile(indexFile);
    const loff = parseLoff(resourceFile);
    // id 0 is "unused" by default (no entry written); id 1 is also unused
    // (we only wrote id 2). id 1 should give us the "room = 0" path.
    expect(() => loadCostume(resourceFile, index, loff, 1)).toThrow(/unused DCOS slot/);
  });
});
