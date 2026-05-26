import { describe, it, expect } from 'vitest';
import { parseBlocks } from './block';
import { payloadOf, findChild, findChildren, findDescendant, type ResourceFile } from './tree';

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

describe('payloadOf', () => {
  it('returns the bytes after the header for a leaf', () => {
    const bytes = block('RNAM', [10, 20, 30, 40]);
    const file = makeFile(bytes);
    const payload = payloadOf(file, file.tree[0]!);
    expect(Array.from(payload)).toEqual([10, 20, 30, 40]);
  });

  it('returns the full container body (children inclusive) for a container', () => {
    const bytes = block('ROOM', concat(block('RMHD', [1, 2]), block('CLUT', [3, 4])));
    const file = makeFile(bytes);
    const payload = payloadOf(file, file.tree[0]!);
    expect(payload.length).toBe(bytes.length - 8);
  });

  it('is a view, not a copy (shares memory with the source bytes)', () => {
    const bytes = block('RNAM', [99]);
    const file = makeFile(bytes);
    const payload = payloadOf(file, file.tree[0]!);
    expect(payload.buffer).toBe(bytes.buffer);
  });
});

describe('findChild', () => {
  it('returns the first child with the matching tag', () => {
    const bytes = block('ROOM', concat(block('RMHD', [0]), block('CLUT', [1])));
    const file = makeFile(bytes);
    expect(findChild(file.tree[0]!, 'CLUT')?.tag).toBe('CLUT');
  });

  it('returns undefined for an unknown tag', () => {
    const bytes = block('ROOM', concat(block('RMHD'), block('CLUT')));
    const file = makeFile(bytes);
    expect(findChild(file.tree[0]!, 'SMAP')).toBeUndefined();
  });

  it('returns undefined when called on a leaf block', () => {
    const bytes = block('RNAM', [0]);
    const file = makeFile(bytes);
    expect(findChild(file.tree[0]!, 'XXXX')).toBeUndefined();
  });
});

describe('findChildren', () => {
  it('returns every direct child with the matching tag, in source order', () => {
    // SCRP is a leaf, safe to use as synthetic test payload-bearing block.
    const bytes = block(
      'ROOM',
      concat(block('SCRP', [1]), block('CLUT'), block('SCRP', [2]), block('SCRP', [3])),
    );
    const file = makeFile(bytes);
    const scrps = findChildren(file.tree[0]!, 'SCRP');
    expect(scrps).toHaveLength(3);
    expect(scrps.map((b) => b.size)).toEqual([9, 9, 9]);
  });

  it('returns an empty array when called on a leaf block', () => {
    const bytes = block('RNAM', [0]);
    const file = makeFile(bytes);
    expect(findChildren(file.tree[0]!, 'XXXX')).toEqual([]);
  });
});

describe('findDescendant', () => {
  it('walks a multi-step path', () => {
    const smap = block('SMAP', [42]);
    const im00 = block('IM00', smap);
    const rmim = block('RMIM', im00);
    const room = block('ROOM', rmim);
    const file = makeFile(room);

    const target = findDescendant(file.tree, 'ROOM', 'RMIM', 'IM00', 'SMAP');
    expect(target?.tag).toBe('SMAP');
  });

  it('returns undefined when the path is broken at any step', () => {
    const bytes = block('ROOM', block('RMHD'));
    const file = makeFile(bytes);
    expect(findDescendant(file.tree, 'ROOM', 'RMIM')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    expect(findDescendant([], )).toBeUndefined();
  });
});
