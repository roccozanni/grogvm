import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../resources/block';
import { parseLoff } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';
import { RoomLoadError, loadRoom } from './loader';

// ─── synthetic-file helpers ──────────────────────────────────────────
// Each `block(tag, payload)` produces a SCUMM block with the standard
// big-endian 32-bit size header. Total bytes are tracked so we can
// compute the LOFF offset of the ROOM block precisely.

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

/** LOFF body: u8 count + count × (u8 roomId, u32 LE offset). */
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

function rmhdBody(width: number, height: number, numObjects = 0): Uint8Array {
  return new Uint8Array([
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
    numObjects & 0xff, (numObjects >>> 8) & 0xff,
  ]);
}

/** 768-byte CLUT (256 RGB triples). Fill with a recognisable gradient. */
function clutBody(): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    out[i * 3] = i;        // R
    out[i * 3 + 1] = 255 - i; // G
    out[i * 3 + 2] = (i * 7) & 0xff; // B
  }
  return out;
}

/**
 * Build a minimal SMAP for a `width × height` room of constant color.
 * For 8 columns (`width / 8 = stripCount`), each strip is "method 1
 * uncompressed" — but the simplest valid SMAP is `0x01` (uncompressed
 * VH) for each strip pointing at `width * height` bytes of pixel data.
 * We don't actually exercise the SMAP decoder here — the room loader
 * just passes through `decodeRoom`, which uses `decodeSmap`. So the
 * tests use the synthetic-block fixtures that `room.test.ts` proves
 * work end-to-end.
 *
 * Simpler approach: use SMAP code `0x01` (uncompressed) which expects
 * `height` bytes per strip after the header.
 */
function smapBody(width: number, height: number, fillIndex: number): Uint8Array {
  const stripCount = width / 8;
  if (!Number.isInteger(stripCount)) throw new Error('width must be a multiple of 8');
  const offsetsSize = stripCount * 4;
  // Per-strip body: 1 byte method code (0x01 = uncompressed) + height pixels of fillIndex
  const stripBody = new Uint8Array(1 + height * 8);
  stripBody[0] = 0x01;
  for (let i = 0; i < height * 8; i++) stripBody[i + 1] = fillIndex;
  const stripsTotal = stripCount * stripBody.length;
  const out = new Uint8Array(offsetsSize + stripsTotal);
  // Offsets are SMAP-block-relative including the 8-byte header (so we
  // add 8 to where the strip body starts inside the payload).
  for (let i = 0; i < stripCount; i++) {
    const stripStart = offsetsSize + i * stripBody.length + 8; // +8 for header inclusion
    out[i * 4 + 0] = stripStart & 0xff;
    out[i * 4 + 1] = (stripStart >>> 8) & 0xff;
    out[i * 4 + 2] = (stripStart >>> 16) & 0xff;
    out[i * 4 + 3] = (stripStart >>> 24) & 0xff;
  }
  for (let i = 0; i < stripCount; i++) {
    out.set(stripBody, offsetsSize + i * stripBody.length);
  }
  return out;
}

function trnsBody(idx: number): Uint8Array {
  return new Uint8Array([idx & 0xff, (idx >>> 8) & 0xff]);
}

function rmihBody(numPlanes: number): Uint8Array {
  return new Uint8Array([numPlanes & 0xff, (numPlanes >>> 8) & 0xff]);
}

/**
 * Build a complete LECF that contains a single LFLF with one ROOM at
 * a known position. Returns the file plus the resolved LOFF offset
 * (= absolute file position of the ROOM block).
 *
 * Synthetic LECF structure:
 *   LECF
 *   ├── LOFF
 *   └── LFLF
 *       └── ROOM
 *           ├── RMHD
 *           ├── CLUT
 *           ├── TRNS
 *           ├── RMIM
 *           │   ├── RMIH (plane count)
 *           │   └── IM00 (SMAP only — no ZP## for the simple case)
 *           ├── ENCD (optional)
 *           └── EXCD (optional)
 */
function buildSyntheticFile(opts: {
  roomId: number;
  width: number;
  height: number;
  includeEncd?: boolean;
  includeExcd?: boolean;
  encdBytes?: Uint8Array;
  excdBytes?: Uint8Array;
  transparentIndex?: number;
}): { file: ResourceFile; loffOffset: number } {
  const rmhd = block('RMHD', rmhdBody(opts.width, opts.height, 3));
  const clut = block('CLUT', clutBody());
  const trns = block(
    'TRNS',
    trnsBody(opts.transparentIndex ?? 0),
  );
  const rmih = block('RMIH', rmihBody(0));
  const smap = block('SMAP', smapBody(opts.width, opts.height, 42));
  const im00 = block('IM00', smap);
  const rmim = block('RMIM', concat(rmih, im00));

  const roomChildren: Uint8Array[] = [rmhd, clut, trns, rmim];
  if (opts.includeEncd) {
    roomChildren.push(block('ENCD', opts.encdBytes ?? new Uint8Array([0xa0]))); // stopObjectCode
  }
  if (opts.includeExcd) {
    roomChildren.push(block('EXCD', opts.excdBytes ?? new Uint8Array([0xa0])));
  }
  const room = block('ROOM', concat(...roomChildren));
  const lflf = block('LFLF', room);

  // We need to know the ROOM block's absolute file offset to put it in
  // LOFF. Layout: LECF (8) + LOFF (8 + body) + LFLF (8) + ROOM (8) + …
  // For a single-room file, this is computable up front.
  const loffPayloadSize = 1 + 5 * 1; // 1 entry
  const loffSize = 8 + loffPayloadSize;
  const lecfHeaderSize = 8;
  const lflfHeaderSize = 8;
  const roomOffset = lecfHeaderSize + loffSize + lflfHeaderSize;

  const loff = block('LOFF', loffBody([{ id: opts.roomId, offset: roomOffset }]));
  const lecf = block('LECF', concat(loff, lflf));

  // Sanity check: parse and ensure ROOM ends up at the computed offset.
  const file = makeFile(lecf);
  const parsedLoff = parseLoff(file);
  const actualOff = parsedLoff.get(opts.roomId);
  if (actualOff !== roomOffset) {
    throw new Error(
      `synthetic fixture mismatch: LOFF says 0x${actualOff?.toString(16)}, computed 0x${roomOffset.toString(16)}`,
    );
  }
  return { file, loffOffset: roomOffset };
}

describe('loadRoom — synthetic fixtures', () => {
  it('decodes a minimal 320×144 room end-to-end', () => {
    const { file } = buildSyntheticFile({ roomId: 5, width: 320, height: 144 });
    const loff = parseLoff(file);
    const room = loadRoom(file, loff, 5);
    expect(room.id).toBe(5);
    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
    expect(room.numObjects).toBe(3);
    expect(room.palette).toHaveLength(768);
    expect(room.indexed).toHaveLength(320 * 144);
    // The SMAP fill was index 42 → every pixel decodes to 42.
    expect(room.indexed[0]).toBe(42);
    expect(room.indexed[room.indexed.length - 1]).toBe(42);
    expect(room.transparentIndex).toBe(0);
    expect(room.zPlanes).toHaveLength(0);
    expect(room.entryScript).toBeNull();
    expect(room.exitScript).toBeNull();
  });

  it('captures LSCR local scripts keyed by their script id', () => {
    // Hand-build a ROOM with two LSCR blocks (ids 201 + 202).
    const rmhd = block('RMHD', rmhdBody(320, 144, 3));
    const clut = block('CLUT', clutBody());
    const trns = block('TRNS', trnsBody(0));
    const rmih = block('RMIH', rmihBody(0));
    const smap = block('SMAP', smapBody(320, 144, 42));
    const im00 = block('IM00', smap);
    const rmim = block('RMIM', concat(rmih, im00));
    const lscr201 = block('LSCR', new Uint8Array([201, 0x80, 0xa0])); // id 201 + breakHere + stopObjectCode
    const lscr202 = block('LSCR', new Uint8Array([202, 0xa0]));
    const room = block('ROOM', concat(rmhd, clut, trns, rmim, lscr201, lscr202));
    const lflf = block('LFLF', room);
    const loffPayloadSize = 1 + 5;
    const loffSize = 8 + loffPayloadSize;
    const roomOffset = 8 + loffSize + 8;
    const loff = block('LOFF', loffBody([{ id: 5, offset: roomOffset }]));
    const lecf = block('LECF', concat(loff, lflf));
    const file = makeFile(lecf);

    const room5 = loadRoom(file, parseLoff(file), 5);
    expect(room5.localScripts.size).toBe(2);
    expect(Array.from(room5.localScripts.get(201)!)).toEqual([0x80, 0xa0]);
    expect(Array.from(room5.localScripts.get(202)!)).toEqual([0xa0]);
  });

  it('captures ENCD and EXCD bytecode when present', () => {
    const { file } = buildSyntheticFile({
      roomId: 7,
      width: 320,
      height: 144,
      includeEncd: true,
      includeExcd: true,
      encdBytes: new Uint8Array([0x80, 0xa0]),       // breakHere + stopObjectCode
      excdBytes: new Uint8Array([0x18, 0x00, 0x00]), // jumpRelative +0
    });
    const loff = parseLoff(file);
    const room = loadRoom(file, loff, 7);
    expect(Array.from(room.entryScript!)).toEqual([0x80, 0xa0]);
    expect(Array.from(room.exitScript!)).toEqual([0x18, 0x00, 0x00]);
  });

  it('throws RoomLoadError on unknown room id (not in LOFF)', () => {
    const { file } = buildSyntheticFile({ roomId: 1, width: 320, height: 144 });
    const loff = parseLoff(file);
    expect(() => loadRoom(file, loff, 99)).toThrow(RoomLoadError);
    expect(() => loadRoom(file, loff, 99)).toThrow(/not present in LOFF/);
  });

  it('throws RoomLoadError on room id 0 (SCUMM sentinel — never in LOFF)', () => {
    const { file } = buildSyntheticFile({ roomId: 1, width: 320, height: 144 });
    const loff = parseLoff(file);
    expect(() => loadRoom(file, loff, 0)).toThrow(RoomLoadError);
  });

  it('roundtrips the same room across two loadRoom calls', () => {
    const { file } = buildSyntheticFile({ roomId: 12, width: 320, height: 144 });
    const loff = parseLoff(file);
    const a = loadRoom(file, loff, 12);
    const b = loadRoom(file, loff, 12);
    expect(a.indexed).toEqual(b.indexed);
    expect(a.palette).toEqual(b.palette);
  });

  it('surfaces a meaningful error if LOFF points to a non-ROOM offset', () => {
    // Build a normal file and then surgically corrupt the LOFF entry
    // to point at the LECF header — guaranteed wrong tag.
    const { file } = buildSyntheticFile({ roomId: 1, width: 320, height: 144 });
    const badLoff = new Map([[1, 0]]); // offset 0 = LECF header
    expect(() => loadRoom(file, badLoff, 1)).toThrow(RoomLoadError);
    expect(() => loadRoom(file, badLoff, 1)).toThrow(/no ROOM block/);
  });

  it('wraps decoder errors in RoomLoadError with the room id attached', () => {
    // Build a file where the ROOM is missing its RMHD — decodeRoom will throw.
    const clut = block('CLUT', clutBody());
    const room = block('ROOM', clut); // no RMHD
    const lflf = block('LFLF', room);
    const loffSize = 8 + 1 + 5;
    const roomOffset = 8 + loffSize + 8;
    const loff = block('LOFF', loffBody([{ id: 3, offset: roomOffset }]));
    const lecf = block('LECF', concat(loff, lflf));
    const file = makeFile(lecf);

    expect(() => loadRoom(file, parseLoff(file), 3)).toThrow(RoomLoadError);
    expect(() => loadRoom(file, parseLoff(file), 3)).toThrow(/background decode failed/);
    try {
      loadRoom(file, parseLoff(file), 3);
    } catch (err) {
      expect(err).toBeInstanceOf(RoomLoadError);
      expect((err as RoomLoadError).roomId).toBe(3);
    }
  });
});
