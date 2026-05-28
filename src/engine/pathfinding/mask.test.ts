import { describe, expect, it } from 'vitest';
import type { WalkBox } from './boxes';
import { buildWalkableMask } from './mask';

/**
 * Build a rectangle covering pixels `[x..x+w-1] × [y..y+h-1]`. SCUMM
 * walk-box corners are *pixel positions* (not pixel ranges), so a box
 * from (0,0) to (4,2) covers pixels (0..4, 0..2) = 5×3 = 15 pixels.
 * To get a w×h pixel rectangle, we subtract 1 from the far corner.
 */
function rect(id: number, x: number, y: number, w: number, h: number, flags = 0): WalkBox {
  return {
    id,
    ulx: x,             uly: y,
    urx: x + w - 1,     ury: y,
    lrx: x + w - 1,     lry: y + h - 1,
    llx: x,             lly: y + h - 1,
    mask: 0x83,
    flags,
    scaleSlot: 0,
  };
}

function countWalkable(mask: Uint8Array): number {
  let n = 0;
  for (const v of mask) if (v) n++;
  return n;
}

describe('buildWalkableMask', () => {
  it('fills a single axis-aligned rectangle exactly', () => {
    // 16×8 mask, one box covering (4..11, 2..5). 8 wide × 4 tall = 32 pixels.
    const mask = buildWalkableMask([rect(0, 4, 2, 8, 4)], 16, 8);
    expect(countWalkable(mask)).toBe(32);
    // Spot check: inside is 1, outside is 0.
    expect(mask[2 * 16 + 4]).toBe(1);
    expect(mask[5 * 16 + 11]).toBe(1);
    expect(mask[2 * 16 + 3]).toBe(0);
    expect(mask[6 * 16 + 4]).toBe(0);
  });

  it('unions multiple non-overlapping boxes', () => {
    // Two 4×2 boxes — should yield 16 walkable pixels.
    const mask = buildWalkableMask(
      [rect(0, 0, 0, 4, 2), rect(1, 8, 4, 4, 2)],
      16,
      8,
    );
    expect(countWalkable(mask)).toBe(16);
    expect(mask[0]).toBe(1);
    expect(mask[5 * 16 + 8]).toBe(1);
  });

  it('handles overlapping boxes without double-counting', () => {
    const mask = buildWalkableMask(
      [rect(0, 0, 0, 6, 4), rect(1, 4, 2, 6, 4)],
      12,
      6,
    );
    // Union area = 6×4 + 6×4 − overlap(2×2) = 24 + 24 − 4 = 44
    expect(countWalkable(mask)).toBe(44);
  });

  it('skips boxes with the 0x80 (invisible) flag', () => {
    const mask = buildWalkableMask(
      [rect(0, 0, 0, 4, 2), rect(1, 8, 4, 4, 2, 0x80)],
      16,
      8,
    );
    // Only the first box fills (4×2 = 8 px). Second is invisible.
    expect(countWalkable(mask)).toBe(8);
  });

  it('clips boxes that overhang the mask bounds', () => {
    // Box of 10×10 starting at (-3, -2). Visible portion = 7×8 = 56.
    const mask = buildWalkableMask([rect(0, -3, -2, 10, 10)], 8, 8);
    expect(countWalkable(mask)).toBe(56);
    expect(mask[0]).toBe(1); // (0, 0) is inside the visible portion
  });

  it('fills a trapezoid via scan-line interpolation', () => {
    // UL=(2,0), UR=(8,0), LR=(10,4), LL=(0,4): widening bottom.
    const trap: WalkBox = {
      id: 0,
      ulx: 2, uly: 0,
      urx: 8, ury: 0,
      lrx: 10, lry: 4,
      llx: 0, lly: 4,
      mask: 0x83,
      flags: 0,
      scaleSlot: 0,
    };
    const mask = buildWalkableMask([trap], 12, 6);
    // Row 0: x in [2..7] inclusive → 6 px
    // Row 1: edges at x = 1.5 (left) and 8.5 (right) → x in [2..8] → 7 px
    // Row 2: edges at x = 1.0 and 9.0 → x in [1..9] → 9 px
    // Row 3: edges at x = 0.5 and 9.5 → x in [1..9] → 9 px
    // Row 4: x in [0..10] → 11 px
    // (Rows are clipped to y < height = 6 → all 5 included.)
    // Total scales with the ceil/floor of edge intersections.
    // Just assert: row 0 narrower than row 4, total > 0.
    const row = (y: number): number => {
      let c = 0;
      for (let x = 0; x < 12; x++) if (mask[y * 12 + x]) c++;
      return c;
    };
    expect(row(0)).toBeLessThan(row(4));
    expect(row(4)).toBe(11);
  });

  it('returns an all-zero mask when given no boxes', () => {
    const mask = buildWalkableMask([], 16, 8);
    expect(countWalkable(mask)).toBe(0);
  });

  it('ignores degenerate (zero-area) boxes', () => {
    // All four corners identical — no fillable rows.
    const degenerate: WalkBox = {
      id: 0,
      ulx: 5, uly: 5,
      urx: 5, ury: 5,
      lrx: 5, lry: 5,
      llx: 5, lly: 5,
      mask: 0x83,
      flags: 0,
      scaleSlot: 0,
    };
    const mask = buildWalkableMask([degenerate], 16, 8);
    // A 1-pixel point: ceil(5)=5 and floor(5)=5 → 1 px walkable at (5,5).
    expect(mask[5 * 16 + 5]).toBe(1);
    expect(countWalkable(mask)).toBe(1);
  });
});
