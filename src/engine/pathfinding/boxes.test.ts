import { describe, expect, it } from 'vitest';
import {
  findBoxAt,
  isInvisibleBox,
  parseWalkBoxes,
  pointInBox,
  WalkBoxParseError,
  type WalkBox,
} from './boxes';

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

/** Build a WalkBox literal from corners + mask/flags (id defaults to 0). */
function wb(
  corners: ReadonlyArray<number>,
  opts: { id?: number; mask?: number; flags?: number } = {},
): WalkBox {
  const [ulx, uly, urx, ury, lrx, lry, llx, lly] = corners;
  return {
    id: opts.id ?? 0,
    ulx: ulx!, uly: uly!,
    urx: urx!, ury: ury!,
    lrx: lrx!, lry: lry!,
    llx: llx!, lly: lly!,
    mask: opts.mask ?? 0,
    flags: opts.flags ?? 0,
    scaleSlot: 0,
  };
}

describe('pointInBox', () => {
  const rect = wb([10, 10, 50, 10, 50, 40, 10, 40]);

  it('is true for an interior point', () => {
    expect(pointInBox(rect, 30, 25)).toBe(true);
  });

  it('is false for a point outside on each side', () => {
    expect(pointInBox(rect, 5, 25)).toBe(false); // left
    expect(pointInBox(rect, 60, 25)).toBe(false); // right
    expect(pointInBox(rect, 30, 5)).toBe(false); // above
    expect(pointInBox(rect, 30, 50)).toBe(false); // below
  });

  it('counts edge and corner points as inside (shared seams)', () => {
    expect(pointInBox(rect, 10, 25)).toBe(true); // left edge
    expect(pointInBox(rect, 50, 40)).toBe(true); // corner
    expect(pointInBox(rect, 30, 10)).toBe(true); // top edge
  });

  it('handles a non-axis-aligned convex quad', () => {
    // A slanted parallelogram.
    const slant = wb([20, 0, 60, 0, 80, 30, 40, 30]);
    expect(pointInBox(slant, 50, 15)).toBe(true);
    expect(pointInBox(slant, 25, 15)).toBe(false); // left of the slope
  });

  it('reads opposite winding identically (CW vs CCW corners)', () => {
    // Same rectangle, corners listed the other way round.
    const cw = wb([10, 10, 10, 40, 50, 40, 50, 10]);
    expect(pointInBox(cw, 30, 25)).toBe(true);
    expect(pointInBox(cw, 5, 25)).toBe(false);
  });

  it('treats a degenerate (zero-area line) box as containing no off-line point', () => {
    // MI1 room-33-style staircase line box (UL==UR, LR==LL collapses it).
    const line = wb([10, 10, 50, 30, 50, 30, 10, 10]);
    expect(pointInBox(line, 30, 35)).toBe(false);
  });

  it('matches an on-segment point of a zero-area line box (within extent)', () => {
    // MI1 room 38 box 1: a horizontal segment, UL==LL / UR==LR, y=106.
    const seg = wb([154, 106, 199, 106, 199, 106, 154, 106]);
    expect(pointInBox(seg, 177, 106)).toBe(true); // on the segment
    expect(pointInBox(seg, 220, 106)).toBe(false); // past the right end
    expect(pointInBox(seg, 177, 105)).toBe(false); // off the line
  });

  it('rejects every real point for the (-32000) invalid box-0 sentinel', () => {
    // SCUMM reserves box 0 as invalid; MI1 ships it with all corners at
    // (-32000, -32000). It must match nothing (a single collapsed point).
    const sentinel = wb([-32000, -32000, -32000, -32000, -32000, -32000, -32000, -32000]);
    expect(pointInBox(sentinel, 0, 0)).toBe(false);
    expect(pointInBox(sentinel, 160, 100)).toBe(false);
  });
});

describe('findBoxAt', () => {
  const boxes: WalkBox[] = [
    wb([0, 0, 40, 0, 40, 40, 0, 40], { id: 0, mask: 0 }),
    wb([40, 0, 80, 0, 80, 40, 40, 40], { id: 1, mask: 1 }),
    wb([80, 0, 120, 0, 120, 40, 80, 40], { id: 2, mask: 1, flags: 0x80 }), // invisible
  ];

  it('returns the box a point falls in', () => {
    expect(findBoxAt(boxes, 20, 20)?.id).toBe(0);
    expect(findBoxAt(boxes, 60, 20)?.id).toBe(1);
  });

  it('returns null when the point is in no box', () => {
    expect(findBoxAt(boxes, 200, 200)).toBeNull();
  });

  it('skips invisible boxes (an actor never stands on one)', () => {
    expect(findBoxAt(boxes, 100, 20)).toBeNull();
  });

  it('returns the lowest-index box when boxes overlap', () => {
    const overlap: WalkBox[] = [
      wb([0, 0, 60, 0, 60, 40, 0, 40], { id: 0, mask: 0 }),
      wb([40, 0, 100, 0, 100, 40, 40, 40], { id: 1, mask: 1 }),
    ];
    expect(findBoxAt(overlap, 50, 20)?.id).toBe(0); // in both → lowest id
  });
});
