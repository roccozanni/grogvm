import { describe, expect, it } from 'vitest';
import { areBoxesNeighbors, buildBoxMatrix, routeThroughBoxes, gateBetween } from './boxgraph';
import { closestPointInBox, getNextBox, parseBoxMatrix, type WalkBox } from './boxes';

/** Build a WalkBox from corners; id defaults to its intended array index. */
function wb(
  id: number,
  corners: readonly [number, number, number, number, number, number, number, number],
  flags = 0,
): WalkBox {
  const [ulx, uly, urx, ury, lrx, lry, llx, lly] = corners;
  return { id, ulx, uly, urx, ury, lrx, lry, llx, lly, mask: 0, flags, scale: 0 };
}

describe('closestPointInBox (adjustXYToBeInBox)', () => {
  const rect = wb(0, [10, 10, 50, 10, 50, 40, 10, 40]);

  it('leaves a point already inside unchanged', () => {
    expect(closestPointInBox(rect, 30, 25)).toEqual({ x: 30, y: 25 });
  });

  it('clamps an outside point to the nearest point on the box', () => {
    expect(closestPointInBox(rect, 5, 25)).toEqual({ x: 10, y: 25 }); // left of box
    expect(closestPointInBox(rect, 30, 99)).toEqual({ x: 30, y: 40 }); // below box
    expect(closestPointInBox(rect, 99, 99)).toEqual({ x: 50, y: 40 }); // past the corner
  });
});

describe('gateBetween', () => {
  it('finds a vertical shared edge and biases the crossing toward the target', () => {
    const a = wb(0, [0, 0, 20, 0, 20, 20, 0, 20]); // left box, right edge x=20
    const b = wb(1, [20, 5, 40, 5, 40, 15, 20, 15]); // right box, left edge x=20, y 5..15
    // Shared vertical seam x=20 over y 5..15; target low → clamp to y=15.
    expect(gateBetween(a, b, { x: 99, y: 99 })).toEqual({ x: 20, y: 15 });
    // Target high → clamp to y=5.
    expect(gateBetween(a, b, { x: 99, y: -99 })).toEqual({ x: 20, y: 5 });
  });

  it('finds a horizontal shared edge', () => {
    const a = wb(0, [0, 0, 20, 0, 20, 10, 0, 10]); // bottom edge y=10
    const b = wb(1, [0, 10, 20, 10, 20, 20, 0, 20]); // top edge y=10
    expect(gateBetween(a, b, { x: 5, y: 99 })).toEqual({ x: 5, y: 10 });
  });

  it('falls back to the shared corner for corner-touching diagonal boxes', () => {
    // Two MI1-staircase-style line boxes meeting at (20,20).
    const a = wb(0, [0, 0, 0, 0, 20, 20, 20, 20]); // line (0,0)→(20,20)
    const b = wb(1, [20, 20, 20, 20, 40, 10, 40, 10]); // line (20,20)→(40,10)
    expect(gateBetween(a, b, { x: 99, y: 99 })).toEqual({ x: 20, y: 20 });
  });
});

describe('routeThroughBoxes', () => {
  // A linear corridor of 3 abutting boxes, ids 0,1,2 (id == array index).
  const boxes = [
    wb(0, [0, 0, 20, 0, 20, 10, 0, 10]),
    wb(1, [20, 0, 40, 0, 40, 10, 20, 10]),
    wb(2, [40, 0, 60, 0, 60, 10, 40, 10]),
  ];
  // BOXM: from each box, hop one step toward the destination.
  const matrix = parseBoxMatrix(
    new Uint8Array([
      0x00, 0x02, 0x01, 0xff, // box0: to reach 0..2 → next 1 (well, 0 self handled separately)
      0x00, 0x00, 0x01, 0x02, 0x02, 0x02, 0xff, // box1: →0 hop0, →2 hop2
      0x00, 0x02, 0x01, 0xff, // box2: to reach 0..2 → next 1
    ]),
    3,
  );

  it('returns the box-clamped target directly when start and goal share a box', () => {
    const r = routeThroughBoxes(boxes, matrix, { x: 5, y: 5 }, { x: 15, y: 8 });
    expect(r.reachedGoal).toBe(true);
    expect(r.waypoints).toEqual([{ x: 15, y: 8 }]);
  });

  it('routes box→box→box with a gate per transition, ending at the target', () => {
    const r = routeThroughBoxes(boxes, matrix, { x: 5, y: 5 }, { x: 55, y: 5 });
    expect(r.reachedGoal).toBe(true);
    // Gate box0→box1 at x=20, gate box1→box2 at x=40, then the target.
    expect(r.waypoints.map((w) => w.x)).toEqual([20, 40, 55]);
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 55, y: 5 });
  });

  it('stops short (reachedGoal=false) when a locked box seals the route', () => {
    // Lock the middle box (0x80) → box2 is unreachable from box0.
    const locked = [boxes[0]!, { ...boxes[1]!, flags: 0x80 }, boxes[2]!];
    const r = routeThroughBoxes(locked, matrix, { x: 5, y: 5 }, { x: 55, y: 5 });
    expect(r.reachedGoal).toBe(false);
    // The goal snaps to a reachable box (not the locked one); never crosses it.
    expect(r.waypoints.every((w) => w.x <= 20)).toBe(true);
  });

  it('straight-lines to the target when there are no usable boxes', () => {
    const r = routeThroughBoxes([], [], { x: 0, y: 0 }, { x: 30, y: 30 });
    expect(r.reachedGoal).toBe(false);
    expect(r.waypoints).toEqual([{ x: 30, y: 30 }]);
  });
});

describe('areBoxesNeighbors', () => {
  it('detects a shared edge span and rejects disjoint boxes', () => {
    const a = wb(0, [0, 0, 20, 0, 20, 10, 0, 10]);
    const b = wb(1, [20, 0, 40, 0, 40, 10, 20, 10]); // abuts a at x=20
    const c = wb(2, [50, 0, 70, 0, 70, 10, 50, 10]); // 10px gap from b
    expect(areBoxesNeighbors(a, b)).toBe(true);
    expect(areBoxesNeighbors(b, c)).toBe(false);
  });

  it('connects line boxes through a single shared corner', () => {
    const a = wb(0, [0, 0, 0, 0, 20, 20, 20, 20]); // line (0,0)→(20,20)
    const b = wb(1, [20, 20, 20, 20, 40, 10, 40, 10]); // line (20,20)→(40,10)
    expect(areBoxesNeighbors(a, b)).toBe(true);
  });
});

describe('buildBoxMatrix (createBoxMatrix)', () => {
  // A 2×2 ring of boxes: 0─1 across the top, 2─3 across the bottom;
  // 0|2 and 1|3 also abut. Every pair has a 2-hop alternative route.
  const ring = [
    wb(0, [0, 0, 20, 0, 20, 10, 0, 10]),
    wb(1, [20, 0, 40, 0, 40, 10, 20, 10]),
    wb(2, [0, 10, 20, 10, 20, 20, 0, 20]),
    wb(3, [20, 10, 40, 10, 40, 20, 20, 20]),
  ];

  it('encodes direct hops for adjacent boxes', () => {
    const m = buildBoxMatrix(ring);
    expect(getNextBox(m, 0, 1)).toBe(1);
    expect(getNextBox(m, 0, 2)).toBe(2);
    expect(getNextBox(m, 1, 2)).toBeGreaterThanOrEqual(0); // any shortest 2-hop
  });

  it('merges consecutive destinations with the same next hop into one range', () => {
    const corridor = [
      wb(0, [0, 0, 20, 0, 20, 10, 0, 10]),
      wb(1, [20, 0, 40, 0, 40, 10, 20, 10]),
      wb(2, [40, 0, 60, 0, 60, 10, 40, 10]),
    ];
    const m = buildBoxMatrix(corridor);
    expect(m[0]).toEqual([{ from: 1, to: 2, next: 1 }]);
  });

  it('routes around a locked box when a detour exists (the room-7 chest)', () => {
    const locked = ring.map((b) => (b.id === 1 ? { ...b, flags: 0x80 } : b));
    const m = buildBoxMatrix(locked);
    expect(getNextBox(m, 0, 3)).toBe(2); // detour under, not through locked 1
    expect(getNextBox(m, 0, 1)).toBe(-1); // the locked box itself is no destination
    expect(m[1]).toEqual([]); // and no source
  });

  it('reports unreachable when locking severs the graph', () => {
    const corridor = [
      wb(0, [0, 0, 20, 0, 20, 10, 0, 10]),
      wb(1, [20, 0, 40, 0, 40, 10, 20, 10], 0x80),
      wb(2, [40, 0, 60, 0, 60, 10, 40, 10]),
    ];
    const m = buildBoxMatrix(corridor);
    expect(getNextBox(m, 0, 2)).toBe(-1);
  });
});
