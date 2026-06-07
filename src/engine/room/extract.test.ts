/**
 * Tests the Explorer's graceful room extraction. No game data — synthetic
 * LECF/LFLF/ROOM fixtures. Focus is on what extract adds over loadRoom:
 * room enumeration from LOFF and per-section isolation (a broken background
 * must not sink the scripts, and vice-versa).
 */
import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../resources/block';
import { parseLoff } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';
import { listRooms, extractRoom } from './extract';

function block(tag: string, payload: Uint8Array | number[] = []): Uint8Array {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const size = 8 + bytes.length;
  const out = new Uint8Array(size);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(bytes, 8);
  return out;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0));
  let off = 0;
  for (const b of bufs) { out.set(b, off); off += b.length; }
  return out;
}

function makeFile(bytes: Uint8Array): ResourceFile {
  return { bytes, tree: parseBlocks(bytes) };
}

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

function rmhdBody(w: number, h: number, numObjects = 0): Uint8Array {
  return new Uint8Array([w & 0xff, (w >>> 8) & 0xff, h & 0xff, (h >>> 8) & 0xff, numObjects & 0xff, (numObjects >>> 8) & 0xff]);
}

function clutBody(): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) { out[i * 3] = i; out[i * 3 + 1] = 255 - i; out[i * 3 + 2] = (i * 7) & 0xff; }
  return out;
}

function smapBody(width: number, height: number, fill: number): Uint8Array {
  const stripCount = width / 8;
  const offsetsSize = stripCount * 4;
  const stripBody = new Uint8Array(1 + height * 8);
  stripBody[0] = 0x01;
  for (let i = 0; i < height * 8; i++) stripBody[i + 1] = fill;
  const out = new Uint8Array(offsetsSize + stripCount * stripBody.length);
  for (let i = 0; i < stripCount; i++) {
    const start = offsetsSize + i * stripBody.length + 8;
    out[i * 4] = start & 0xff;
    out[i * 4 + 1] = (start >>> 8) & 0xff;
    out[i * 4 + 2] = (start >>> 16) & 0xff;
    out[i * 4 + 3] = (start >>> 24) & 0xff;
  }
  for (let i = 0; i < stripCount; i++) out.set(stripBody, offsetsSize + i * stripBody.length);
  return out;
}

/** A complete, decodable ROOM (RMHD/CLUT/TRNS/RMIM) plus optional extras. */
function goodRoom(w: number, h: number, extra: Uint8Array[] = []): Uint8Array {
  const rmim = block('RMIM', concat(block('RMIH', new Uint8Array([0, 0])), block('IM00', block('SMAP', smapBody(w, h, 42)))));
  return block('ROOM', concat(block('RMHD', rmhdBody(w, h)), block('CLUT', clutBody()), block('TRNS', new Uint8Array([0, 0])), rmim, ...extra));
}

/** A ROOM with RMHD but no CLUT/RMIM — background decode must fail. */
function brokenBgRoom(extra: Uint8Array[] = []): Uint8Array {
  return block('ROOM', concat(block('RMHD', rmhdBody(8, 8)), ...extra));
}

/** Wrap rooms in LECF { LOFF, LFLF{ROOM}, … } and resolve each LOFF offset. */
function buildFile(rooms: Uint8Array[]): { file: ResourceFile; loff: ReturnType<typeof parseLoff> } {
  // First pass with a placeholder LOFF to learn each ROOM's absolute offset.
  const placeholder = loffBody(rooms.map((_, i) => ({ id: i + 1, offset: 0 })));
  const lflfs = rooms.map((r) => block('LFLF', r));
  const loffBlock0 = block('LOFF', placeholder);
  let cursor = 8 + loffBlock0.length; // LECF header + LOFF block
  const offsets: number[] = [];
  for (const lflf of lflfs) {
    offsets.push(cursor + 8); // ROOM sits right after the LFLF's 8-byte header
    cursor += lflf.length;
  }
  const loffBlock = block('LOFF', loffBody(rooms.map((_, i) => ({ id: i + 1, offset: offsets[i]! }))));
  const file = makeFile(block('LECF', concat(loffBlock, ...lflfs)));
  return { file, loff: parseLoff(file) };
}

describe('listRooms', () => {
  it('enumerates LOFF rooms with id + lflf index, sorted by id', () => {
    const { file, loff } = buildFile([goodRoom(8, 8), goodRoom(16, 8)]);
    const refs = listRooms(file, loff);
    expect(refs.map((r) => r.roomId)).toEqual([1, 2]);
    expect(refs.map((r) => r.lflfIndex)).toEqual([0, 1]);
  });
});

describe('extractRoom', () => {
  it('decodes the background of a well-formed room', () => {
    const { file, loff } = buildFile([goodRoom(16, 8)]);
    const dossier = extractRoom(file, listRooms(file, loff)[0]!);
    expect(dossier.background.ok).toBe(true);
    if (dossier.background.ok) {
      expect([dossier.background.value.width, dossier.background.value.height]).toEqual([16, 8]);
      expect(dossier.background.value.indexed.length).toBe(16 * 8);
    }
  });

  it('collects ENCD/EXCD/local scripts', () => {
    const extras = [
      block('ENCD', new Uint8Array([0xa0])),
      block('EXCD', new Uint8Array([0xa0])),
      block('LSCR', new Uint8Array([202, 0xa0])), // id 202 + one opcode byte
    ];
    const { file, loff } = buildFile([goodRoom(8, 8, extras)]);
    const dossier = extractRoom(file, listRooms(file, loff)[0]!);
    expect(dossier.scripts.ok).toBe(true);
    if (dossier.scripts.ok) {
      expect(dossier.scripts.value.map((s) => s.kind)).toEqual(['entry', 'exit', 'local']);
      const local = dossier.scripts.value.find((s) => s.kind === 'local')!;
      expect(local.id).toBe(202);
      expect([...local.bytecode]).toEqual([0xa0]);
    }
  });

  it('isolates a broken background while still parsing scripts', () => {
    const { file, loff } = buildFile([brokenBgRoom([block('ENCD', new Uint8Array([0xa0]))])]);
    const dossier = extractRoom(file, listRooms(file, loff)[0]!);
    expect(dossier.background.ok).toBe(false);
    expect(dossier.zPlanes.ok).toBe(false); // can't size planes without bg dims
    expect(dossier.scripts.ok).toBe(true);
    if (dossier.scripts.ok) expect(dossier.scripts.value).toHaveLength(1);
  });
});
