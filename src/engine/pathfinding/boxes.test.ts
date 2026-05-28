import { describe, expect, it } from 'vitest';
import { isInvisibleBox, parseWalkBoxes, WalkBoxParseError } from './boxes';

function box(corners: ReadonlyArray<number>, mask = 0x83, flags = 0, scaleSlot = 0): number[] {
  // corners: [ulx, uly, urx, ury, lrx, lry, llx, lly] — 8 i16 LE values.
  const bytes: number[] = [];
  for (const v of corners) {
    const u = v & 0xffff;
    bytes.push(u & 0xff, (u >>> 8) & 0xff);
  }
  bytes.push(mask, flags, scaleSlot, 0);
  return bytes;
}

function payload(count: number, ...boxBytes: number[][]): Uint8Array {
  const out = [count & 0xff, (count >>> 8) & 0xff];
  for (const b of boxBytes) out.push(...b);
  return new Uint8Array(out);
}

describe('parseWalkBoxes', () => {
  it('decodes a single rectangular box', () => {
    const boxes = parseWalkBoxes(payload(1, box([0, 0, 100, 0, 100, 50, 0, 50])));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({
      id: 0,
      ulx: 0, uly: 0,
      urx: 100, ury: 0,
      lrx: 100, lry: 50,
      llx: 0, lly: 50,
      mask: 0x83,
      flags: 0,
    });
  });

  it('decodes multiple boxes with sequential ids', () => {
    const boxes = parseWalkBoxes(
      payload(
        3,
        box([0, 0, 32, 0, 32, 16, 0, 16]),
        box([32, 0, 64, 0, 64, 16, 32, 16]),
        box([64, 0, 96, 0, 96, 16, 64, 16]),
      ),
    );
    expect(boxes.map((b) => b.id)).toEqual([0, 1, 2]);
    expect(boxes[1]!.ulx).toBe(32);
  });

  it('handles signed coordinates (boxes with negative i16 corners)', () => {
    const boxes = parseWalkBoxes(payload(1, box([-10, -5, 50, -5, 50, 30, -10, 30])));
    expect(boxes[0]!.ulx).toBe(-10);
    expect(boxes[0]!.uly).toBe(-5);
  });

  it('flags bit 0x80 marks a box as invisible', () => {
    const boxes = parseWalkBoxes(
      payload(2,
        box([0, 0, 10, 0, 10, 10, 0, 10], 0x83, 0x00),
        box([20, 0, 30, 0, 30, 10, 20, 10], 0x83, 0x80),
      ),
    );
    expect(isInvisibleBox(boxes[0]!)).toBe(false);
    expect(isInvisibleBox(boxes[1]!)).toBe(true);
  });

  it('round-trips mask and scaleSlot bytes', () => {
    const boxes = parseWalkBoxes(payload(1, box([0, 0, 10, 0, 10, 10, 0, 10], 0x42, 0x40, 5)));
    expect(boxes[0]!.mask).toBe(0x42);
    expect(boxes[0]!.flags).toBe(0x40);
    expect(boxes[0]!.scaleSlot).toBe(5);
  });

  it('handles count = 0 (empty walk-box block)', () => {
    expect(parseWalkBoxes(new Uint8Array([0x00, 0x00]))).toEqual([]);
  });

  it('throws if payload size doesn\'t match the declared count', () => {
    // count=2, but only 1 box of data
    expect(() =>
      parseWalkBoxes(payload(2, box([0, 0, 10, 0, 10, 10, 0, 10]))),
    ).toThrow(WalkBoxParseError);
  });

  it('throws on a tiny payload that can\'t even hold the count', () => {
    expect(() => parseWalkBoxes(new Uint8Array([0x01]))).toThrow(WalkBoxParseError);
  });
});
