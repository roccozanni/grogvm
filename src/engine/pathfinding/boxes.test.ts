import { describe, expect, it } from 'vitest';
import {
  findBoxAt,
  findBoxAtOrNearest,
  getNextBox,
  isInvisibleBox,
  parseBoxMatrix,
  parseWalkBoxes,
  pointInBox,
  WalkBoxParseError,
  type WalkBox,
} from './boxes';

function box(corners: ReadonlyArray<number>, mask = 0x83, flags = 0, scale = 0): number[] {
  // corners: [ulx, uly, urx, ury, lrx, lry, llx, lly] — 8 i16 LE values.
  const bytes: number[] = [];
  for (const v of corners) {
    const u = v & 0xffff;
    bytes.push(u & 0xff, (u >>> 8) & 0xff);
  }
  bytes.push(mask, flags, scale & 0xff, (scale >>> 8) & 0xff);
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

  it('round-trips mask and the u16 scale field (incl. the 0x8000 slot flag)', () => {
    const boxes = parseWalkBoxes(payload(1, box([0, 0, 10, 0, 10, 10, 0, 10], 0x42, 0x40, 0x8001)));
    expect(boxes[0]!.mask).toBe(0x42);
    expect(boxes[0]!.flags).toBe(0x40);
    expect(boxes[0]!.scale).toBe(0x8001); // slot-ref flag preserved
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
    scale: 0,
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

describe('findBoxAtOrNearest', () => {
  const boxes: WalkBox[] = [
    wb([0, 0, 40, 0, 40, 40, 0, 40], { id: 0, mask: 0 }),
    wb([100, 0, 140, 0, 140, 40, 100, 40], { id: 1, mask: 1 }),
    wb([60, 0, 80, 0, 80, 40, 60, 40], { id: 2, mask: 1, flags: 0x80 }), // invisible
  ];

  it('returns the containing box when there is one (like findBoxAt)', () => {
    expect(findBoxAtOrNearest(boxes, 20, 20)?.id).toBe(0);
    expect(findBoxAtOrNearest(boxes, 120, 20)?.id).toBe(1);
  });

  it('falls back to the nearest visible box when no box contains the point', () => {
    // (50,20) is in the gap; box 0 (ends x40) is nearer than box 1 (starts x100).
    expect(findBoxAtOrNearest(boxes, 50, 20)?.id).toBe(0);
    // (90,20) is nearer box 1; the invisible box 2 between them is ignored.
    expect(findBoxAtOrNearest(boxes, 90, 20)?.id).toBe(1);
  });

  it('returns null only when there are no visible boxes at all', () => {
    expect(findBoxAtOrNearest([], 10, 10)).toBeNull();
    expect(
      findBoxAtOrNearest([wb([0, 0, 10, 0, 10, 10, 0, 10], { id: 0, flags: 0x80 })], 99, 99),
    ).toBeNull();
  });

  it('ranks by true edge distance, not bounding rect (the room 2↔5 boat crossing)', () => {
    // A slanted quad whose bounding rect dips far below its real lower edge,
    // beside a near-square box. For a point just past the bottom, the slanted
    // box's bbox is "closer" (its bbox bottom is lower) yet its real edge is far
    // away — SCUMM `adjustXYToBeInBox` ranks by edge distance, so the square box
    // wins. Mirrors room 5's slanted land box (2) vs water box (15): a boat
    // crossing that lands just off the bottom must snap to 15 (water), not 2
    // (land) — bounding-rect ranking wrongly chose 2 and stranded ego on land.
    const slantedLand = wb([34, 142, 106, 124, 106, 134, 34, 198], { id: 2 });
    const squareWater = wb([114, 142, 163, 129, 163, 196, 63, 196], { id: 15 });
    // (86,202): bbox dist → box 2 (its bbox bottom y=198); edge dist → box 15
    // (real lower edge y=196; box 2's real edge at x=86 is up at y≈152).
    expect(findBoxAtOrNearest([slantedLand, squareWater], 86, 202)?.id).toBe(15);
  });
});

describe('parseBoxMatrix + getNextBox', () => {
  // MI1 room 38's real BOXM (6 boxes), trailing 0x00 pad byte included.
  const ROOM38 = new Uint8Array([
    0x00, 0x00, 0x00, 0xff,
    0x01, 0x01, 0x01, 0x02, 0x05, 0x03, 0xff,
    0x01, 0x01, 0x03, 0x02, 0x02, 0x02, 0x03, 0x04, 0x03, 0x05, 0x05, 0x05, 0xff,
    0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04, 0x05, 0x05, 0x02, 0xff,
    0x01, 0x03, 0x03, 0x04, 0x04, 0x04, 0x05, 0x05, 0x03, 0xff,
    0x01, 0x04, 0x02, 0x05, 0x05, 0x05, 0xff,
    0x00,
  ]);

  it('decodes one row per box as (from,to,next) triples', () => {
    const m = parseBoxMatrix(ROOM38, 6);
    expect(m).toHaveLength(6);
    expect(m[1]).toEqual([{ from: 1, to: 1, next: 1 }, { from: 2, to: 5, next: 3 }]);
    expect(m[5]).toEqual([{ from: 1, to: 4, next: 2 }, { from: 5, to: 5, next: 5 }]);
  });

  it('getNextBox returns the next hop for a destination in range', () => {
    const m = parseBoxMatrix(ROOM38, 6);
    expect(getNextBox(m, 1, 5)).toBe(3); // box1: to reach 2..5, hop to 3
    expect(getNextBox(m, 1, 1)).toBe(1); // self
    expect(getNextBox(m, 5, 4)).toBe(2); // box5: to reach 1..4, hop to 2
    expect(getNextBox(m, 3, 5)).toBe(2); // box3: to reach box5, hop to 2
  });

  it('getNextBox returns -1 for an unreachable / out-of-range destination', () => {
    const m = parseBoxMatrix(ROOM38, 6);
    expect(getNextBox(m, 1, 0)).toBe(-1); // box 0 in no range
    expect(getNextBox(m, 99, 1)).toBe(-1); // no such source row
  });

  it('tolerates a truncated final triple without reading past the buffer', () => {
    // Row for box 0 then a row that runs off the end mid-triple.
    const m = parseBoxMatrix(new Uint8Array([0x00, 0x00, 0x00, 0xff, 0x01, 0x02]), 2);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual([{ from: 0, to: 0, next: 0 }]);
    expect(m[1]).toEqual([]); // truncated triple dropped
  });
});
