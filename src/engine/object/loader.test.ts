import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../resources/block';
import type { ResourceFile } from '../resources/tree';
import { ObjectParseError, parseCDHD, parseIMHD, parseRoomObjects } from './loader';

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

function cdhdBody(opts: {
  objId: number;
  x?: number; y?: number;
  width?: number; height?: number;
  parent?: number;
  walkX?: number; walkY?: number;
}): Uint8Array {
  const wx = opts.walkX ?? 0, wy = opts.walkY ?? 0;
  return new Uint8Array([
    opts.objId & 0xff, (opts.objId >>> 8) & 0xff,
    opts.x ?? 0, opts.y ?? 0,
    opts.width ?? 1, opts.height ?? 1,
    0, // flags
    opts.parent ?? 0,
    wx & 0xff, (wx >>> 8) & 0xff, // walkX (signed 16-bit LE)
    wy & 0xff, (wy >>> 8) & 0xff, // walkY (signed 16-bit LE)
    0, // actorDir
  ]);
}

function imhdBody(opts: {
  objId: number;
  numImages: number;
  x: number; y: number;
  width: number; height: number;
}): Uint8Array {
  return new Uint8Array([
    opts.objId & 0xff, (opts.objId >>> 8) & 0xff,
    opts.numImages & 0xff, (opts.numImages >>> 8) & 0xff,
    0, // flags
    0, // unknown
    0, 0, // numHotspots
    opts.x & 0xff, (opts.x >>> 8) & 0xff,
    opts.y & 0xff, (opts.y >>> 8) & 0xff,
    opts.width & 0xff, (opts.width >>> 8) & 0xff,
    opts.height & 0xff, (opts.height >>> 8) & 0xff,
  ]);
}

/**
 * Minimal SMAP for a `width × height` block of constant index 0x42.
 * Matches the layout the loader test uses; reused so we get real
 * decoded image bytes without coupling to the SMAP decoder's deeper
 * compression modes.
 */
function smapBody(width: number, height: number, fillIndex: number): Uint8Array {
  const stripCount = width / 8;
  if (!Number.isInteger(stripCount)) throw new Error('width must be a multiple of 8');
  const offsetsSize = stripCount * 4;
  const stripBody = new Uint8Array(1 + height * 8);
  stripBody[0] = 0x01; // uncompressed
  for (let i = 0; i < height * 8; i++) stripBody[i + 1] = fillIndex;
  const out = new Uint8Array(offsetsSize + stripCount * stripBody.length);
  for (let i = 0; i < stripCount; i++) {
    const stripStart = offsetsSize + i * stripBody.length + 8;
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

// ─── CDHD / IMHD parsers ──────────────────────────────────────────────

describe('parseCDHD', () => {
  it('decodes the 13-byte header', () => {
    const cdhd = parseCDHD(cdhdBody({ objId: 0x006d, x: 6, y: 3, width: 28, height: 15, parent: 7 }));
    expect(cdhd.objId).toBe(0x006d);
    expect(cdhd.x).toBe(6);
    expect(cdhd.y).toBe(3);
    expect(cdhd.width).toBe(28);
    expect(cdhd.height).toBe(15);
    expect(cdhd.parent).toBe(7);
  });

  it('decodes positive walk-to coordinates', () => {
    const cdhd = parseCDHD(cdhdBody({ objId: 1, walkX: 341, walkY: 143 }));
    expect(cdhd.walkX).toBe(341);
    expect(cdhd.walkY).toBe(143);
  });

  it('decodes NEGATIVE walk-to coordinates as signed (MI1 room 78 left exit)', () => {
    // The left "uscita" walks the ego to x=-25 (just off the room's left
    // edge, inside its [-25..345] floor box). Read unsigned that became
    // 65511, so the ego marched off-screen right and could never reach the
    // exit — the "can't leave room 78" bug.
    const cdhd = parseCDHD(cdhdBody({ objId: 857, walkX: -25, walkY: 143 }));
    expect(cdhd.walkX).toBe(-25);
    expect(cdhd.walkY).toBe(143);
  });

  it('throws on a short payload', () => {
    expect(() => parseCDHD(new Uint8Array(12))).toThrow(ObjectParseError);
  });
});

describe('parseIMHD', () => {
  it('decodes the 16-byte header', () => {
    const imhd = parseIMHD(imhdBody({
      objId: 0x006d,
      numImages: 1,
      x: 48,
      y: 24,
      width: 224,
      height: 120,
    }));
    expect(imhd.objId).toBe(0x006d);
    expect(imhd.numImages).toBe(1);
    expect(imhd.x).toBe(48);
    expect(imhd.y).toBe(24);
    expect(imhd.width).toBe(224);
    expect(imhd.height).toBe(120);
  });

  it('throws on a short payload', () => {
    expect(() => parseIMHD(new Uint8Array(15))).toThrow(ObjectParseError);
  });
});

// ─── parseRoomObjects ────────────────────────────────────────────────

describe('parseRoomObjects', () => {
  it('pairs OBCD + OBIM by obj_id and decodes the IM01 image', () => {
    const obim = block('OBIM', concat(
      block('IMHD', imhdBody({ objId: 100, numImages: 1, x: 16, y: 8, width: 16, height: 4 })),
      block('IM01', block('SMAP', smapBody(16, 4, 0x42))),
    ));
    const obcd = block('OBCD', concat(
      block('CDHD', cdhdBody({ objId: 100, x: 2, y: 1, width: 2, height: 1 })),
      block('OBNA', new Uint8Array([0x6b, 0x65, 0x79, 0x00])), // "key\0"
    ));
    const room = block('ROOM', concat(obim, obcd));
    const file = makeFile(room);

    const objects = parseRoomObjects(file, file.tree[0]!);
    expect(objects.size).toBe(1);
    const obj = objects.get(100)!;
    expect(obj.objId).toBe(100);
    expect(obj.cdhd.x).toBe(2);
    expect(obj.imhd.x).toBe(16);
    expect(obj.imhd.width).toBe(16);
    expect(obj.name).toBe('key');
    expect(obj.images.size).toBe(1);
    expect(obj.images.get(1)!.indexed[0]).toBe(0x42);
    expect(obj.images.get(1)!.indexed).toHaveLength(16 * 4);
  });

  it('decodes multiple image variants (state 1 + state 2)', () => {
    const obim = block('OBIM', concat(
      block('IMHD', imhdBody({ objId: 50, numImages: 2, x: 0, y: 0, width: 8, height: 4 })),
      block('IM01', block('SMAP', smapBody(8, 4, 0x10))),
      block('IM02', block('SMAP', smapBody(8, 4, 0x20))),
    ));
    const obcd = block('OBCD', block('CDHD', cdhdBody({ objId: 50 })));
    const room = block('ROOM', concat(obim, obcd));
    const file = makeFile(room);
    const objects = parseRoomObjects(file, file.tree[0]!);
    const obj = objects.get(50)!;
    expect(obj.images.size).toBe(2);
    expect(obj.images.get(1)!.indexed[0]).toBe(0x10);
    expect(obj.images.get(2)!.indexed[0]).toBe(0x20);
  });

  it('skips orphan OBCD without a matching OBIM', () => {
    const obcd = block('OBCD', block('CDHD', cdhdBody({ objId: 7 })));
    const room = block('ROOM', obcd);
    const file = makeFile(room);
    expect(parseRoomObjects(file, file.tree[0]!).size).toBe(0);
  });

  it('skips orphan OBIM without a matching OBCD', () => {
    const obim = block('OBIM', concat(
      block('IMHD', imhdBody({ objId: 99, numImages: 1, x: 0, y: 0, width: 8, height: 4 })),
      block('IM01', block('SMAP', smapBody(8, 4, 0))),
    ));
    const room = block('ROOM', obim);
    const file = makeFile(room);
    expect(parseRoomObjects(file, file.tree[0]!).size).toBe(0);
  });

  it('handles a room with no objects gracefully', () => {
    const room = block('ROOM', new Uint8Array(0));
    const file = makeFile(room);
    expect(parseRoomObjects(file, file.tree[0]!).size).toBe(0);
  });

  it('handles missing OBNA without throwing', () => {
    const obim = block('OBIM', concat(
      block('IMHD', imhdBody({ objId: 1, numImages: 1, x: 0, y: 0, width: 8, height: 4 })),
      block('IM01', block('SMAP', smapBody(8, 4, 0))),
    ));
    const obcd = block('OBCD', block('CDHD', cdhdBody({ objId: 1 })));
    const room = block('ROOM', concat(obim, obcd));
    const file = makeFile(room);
    const obj = parseRoomObjects(file, file.tree[0]!).get(1)!;
    expect(obj.name).toBe('');
  });
});
