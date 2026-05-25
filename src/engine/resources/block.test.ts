import { describe, it, expect } from 'vitest';
import { parseBlocks, isContainerTag, BlockParseError } from './block';

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

describe('isContainerTag', () => {
  it('recognizes the fixed container set', () => {
    for (const tag of ['LECF', 'LFLF', 'ROOM', 'RMIM', 'OBIM', 'OBCD']) {
      expect(isContainerTag(tag)).toBe(true);
    }
  });

  it('matches IM00..IM0F as containers', () => {
    expect(isContainerTag('IM00')).toBe(true);
    expect(isContainerTag('IM01')).toBe(true);
    expect(isContainerTag('IM0F')).toBe(true);
  });

  it('rejects unknown tags', () => {
    for (const tag of ['SMAP', 'CLUT', 'RMHD', 'SCRP', 'BOXD', 'IMHD', 'IMG0']) {
      expect(isContainerTag(tag)).toBe(false);
    }
  });
});

describe('parseBlocks', () => {
  it('returns no blocks for an empty buffer', () => {
    expect(parseBlocks(new Uint8Array(0))).toEqual([]);
  });

  it('parses a single leaf block', () => {
    const buf = block('RNAM', [1, 2, 3, 4]);
    const result = parseBlocks(buf);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ tag: 'RNAM', offset: 0, size: 12 });
    expect(result[0]!.children).toBeUndefined();
  });

  it('parses a sequence of leaf blocks at the top level', () => {
    const buf = concat(block('RNAM', [0]), block('MAXS', [0, 0, 0]), block('DROO'));

    const result = parseBlocks(buf);
    expect(result.map((b) => b.tag)).toEqual(['RNAM', 'MAXS', 'DROO']);
    expect(result.map((b) => b.offset)).toEqual([0, 9, 20]);
    expect(result.map((b) => b.size)).toEqual([9, 11, 8]);
  });

  it('recurses into a container and tracks absolute offsets', () => {
    const inner = concat(block('RMHD', [0, 0, 0, 0]), block('CLUT', [0, 0]));
    const outer = block('ROOM', inner);

    const [room] = parseBlocks(outer);
    expect(room!.tag).toBe('ROOM');
    expect(room!.offset).toBe(0);
    expect(room!.children).toBeDefined();

    const children = room!.children!;
    expect(children.map((c) => c.tag)).toEqual(['RMHD', 'CLUT']);
    expect(children[0]!.offset).toBe(8);
    expect(children[1]!.offset).toBe(8 + (8 + 4));
  });

  it('handles deeply nested containers (LECF -> LFLF -> ROOM -> leaves)', () => {
    const room = block('ROOM', concat(block('RMHD'), block('CLUT')));
    const lflf = block('LFLF', concat(room, block('SCRP', [0xff])));
    const lecf = block('LECF', lflf);

    const [top] = parseBlocks(lecf);
    expect(top!.tag).toBe('LECF');
    expect(top!.children).toHaveLength(1);

    const lflfNode = top!.children![0]!;
    expect(lflfNode.tag).toBe('LFLF');
    expect(lflfNode.children!.map((c) => c.tag)).toEqual(['ROOM', 'SCRP']);

    const roomNode = lflfNode.children![0]!;
    expect(roomNode.children!.map((c) => c.tag)).toEqual(['RMHD', 'CLUT']);
  });

  it('treats unknown tags as leaves regardless of payload size', () => {
    const buf = block('XXXX', new Uint8Array(100));
    const [b] = parseBlocks(buf);
    expect(b!.tag).toBe('XXXX');
    expect(b!.children).toBeUndefined();
  });

  it('records empty containers as containers with empty children', () => {
    const buf = block('LECF', []);
    const [b] = parseBlocks(buf);
    expect(b!.tag).toBe('LECF');
    expect(b!.children).toEqual([]);
  });

  it('throws BlockParseError when size is smaller than the header', () => {
    const bad = new Uint8Array([
      0x52, 0x4e, 0x41, 0x4d, // tag "RNAM"
      0x00, 0x00, 0x00, 0x04, // size = 4 (< 8)
    ]);
    expect(() => parseBlocks(bad)).toThrow(BlockParseError);
  });

  it('throws BlockParseError when size overshoots the buffer', () => {
    const bad = new Uint8Array([
      0x52, 0x4e, 0x41, 0x4d, // tag "RNAM"
      0x00, 0x00, 0x10, 0x00, // size = 4096 (overshoots)
    ]);
    expect(() => parseBlocks(bad)).toThrow(BlockParseError);
  });

  it('throws BlockParseError on a truncated header', () => {
    const bad = new Uint8Array([0x52, 0x4e, 0x41]); // only 3 bytes
    expect(() => parseBlocks(bad)).toThrow(BlockParseError);
  });

  it('error message includes the byte offset where it went wrong', () => {
    const buf = concat(block('RNAM'), new Uint8Array([0xff, 0xff])); // trailing garbage
    try {
      parseBlocks(buf);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockParseError);
      expect((err as BlockParseError).offset).toBe(8);
      expect((err as Error).message).toMatch(/0x8/);
    }
  });

  it('respects baseOffset for top-level reporting', () => {
    const buf = block('RNAM');
    const [b] = parseBlocks(buf, 0x1000);
    expect(b!.offset).toBe(0x1000);
  });
});
