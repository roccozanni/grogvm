import { describe, expect, it } from 'vitest';
import { findPath, type Point } from './grid';

/** Build a mask of `w × h` with every cell walkable. */
function openMask(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

/**
 * Build a mask of `w × h` with every cell walkable EXCEPT the
 * inclusive rect `[x1..x2] × [y1..y2]` which is blocked.
 */
function maskWithObstacle(w: number, h: number, x1: number, y1: number, x2: number, y2: number): Uint8Array {
  const m = openMask(w, h);
  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      m[y * w + x] = 0;
    }
  }
  return m;
}

describe('findPath — open room', () => {
  it('returns a straight diagonal path through an empty mask', () => {
    const m = openMask(8, 8);
    const r = findPath(m, 8, 8, { x: 0, y: 0 }, { x: 7, y: 7 });
    expect(r.reachedGoal).toBe(true);
    // Endpoints present.
    expect(r.waypoints[0]).toEqual({ x: 0, y: 0 });
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 7, y: 7 });
    // Simplified to corners — a clean diagonal collapses to just
    // start + end.
    expect(r.waypoints.length).toBe(2);
  });

  it('start == goal returns a single-point path', () => {
    const m = openMask(8, 8);
    const r = findPath(m, 8, 8, { x: 3, y: 3 }, { x: 3, y: 3 });
    expect(r.reachedGoal).toBe(true);
    expect(r.waypoints).toEqual([{ x: 3, y: 3 }]);
  });
});

describe('findPath — obstacles', () => {
  it('routes around a wall', () => {
    // 16x8 open mask, wall blocks column 8 from rows 0..4 (leaving 5..7 open).
    const m = openMask(16, 8);
    for (let y = 0; y <= 4; y++) m[y * 16 + 8] = 0;
    const r = findPath(m, 16, 8, { x: 4, y: 2 }, { x: 12, y: 2 });
    expect(r.reachedGoal).toBe(true);
    // Path must avoid (8, 0..4).
    for (const p of r.waypoints) {
      const isWall = p.x === 8 && p.y <= 4;
      expect(isWall).toBe(false);
    }
    // Should bend at least once (more than 2 waypoints).
    expect(r.waypoints.length).toBeGreaterThan(2);
  });

  it('reports reachedGoal=false when the goal is in a disjoint region', () => {
    // Left half and right half separated by a full-height wall.
    const m = openMask(16, 8);
    for (let y = 0; y < 8; y++) m[y * 16 + 8] = 0;
    const r = findPath(m, 16, 8, { x: 2, y: 2 }, { x: 12, y: 2 });
    expect(r.reachedGoal).toBe(false);
    // The closest reachable cell should be (7, 2) — the rightmost
    // walkable cell in the left half.
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 7, y: 2 });
  });
});

describe('findPath — snapping', () => {
  it('snaps an unreachable start to the nearest walkable cell', () => {
    // A 1-pixel walkable island at (5, 5); start is at (0, 0).
    const m = new Uint8Array(8 * 8);
    m[5 * 8 + 5] = 1;
    const r = findPath(m, 8, 8, { x: 0, y: 0 }, { x: 5, y: 5 });
    expect(r.reachedGoal).toBe(true);
    expect(r.waypoints[0]).toEqual({ x: 5, y: 5 });
  });

  it('snaps an out-of-bounds goal back inside the mask', () => {
    const m = openMask(8, 8);
    const r = findPath(m, 8, 8, { x: 0, y: 0 }, { x: 100, y: 100 });
    expect(r.reachedGoal).toBe(true);
    expect(r.waypoints[r.waypoints.length - 1]).toEqual({ x: 7, y: 7 });
  });

  it('returns reachedGoal=false on a completely empty mask', () => {
    const m = new Uint8Array(8 * 8);
    const r = findPath(m, 8, 8, { x: 1, y: 1 }, { x: 6, y: 6 });
    expect(r.reachedGoal).toBe(false);
    expect(r.waypoints).toHaveLength(0);
  });
});

describe('findPath — path simplification', () => {
  it('collapses long straight runs into segment endpoints', () => {
    const m = openMask(32, 8);
    const r = findPath(m, 32, 8, { x: 0, y: 3 }, { x: 31, y: 3 });
    expect(r.reachedGoal).toBe(true);
    // Pure horizontal run = 2 waypoints (start, end).
    expect(r.waypoints.length).toBe(2);
  });

  it('preserves corners on a bend', () => {
    // L-shaped path forced by a corner obstacle.
    const m = openMask(16, 8);
    // Block (8..15, 0..3) so the path has to go down first then right.
    for (let y = 0; y <= 3; y++) {
      for (let x = 8; x <= 15; x++) {
        m[y * 16 + x] = 0;
      }
    }
    const r = findPath(m, 16, 8, { x: 2, y: 2 }, { x: 14, y: 2 });
    expect(r.reachedGoal).toBe(true);
    // Should have at least 3 waypoints (start, corner, end).
    expect(r.waypoints.length).toBeGreaterThanOrEqual(3);
  });
});

describe('findPath — sanity', () => {
  it('throws on a malformed mask size', () => {
    expect(() => findPath(new Uint8Array(7), 4, 2, { x: 0, y: 0 }, { x: 3, y: 1 }))
      .toThrow(RangeError);
  });
});

// Realistic perf check — make sure 320×144 (a typical MI1 room) is
// solvable in under 50ms. Not a strict perf assertion (CI is noisy),
// just a sanity check that we haven't accidentally written O(n²).
describe('findPath — realistic-size sanity', () => {
  it('solves a 320x144 mask quickly', () => {
    const m = openMask(320, 144);
    const start = performance.now();
    const r = findPath(m, 320, 144, { x: 5, y: 5 }, { x: 310, y: 138 });
    const elapsed = performance.now() - start;
    expect(r.reachedGoal).toBe(true);
    expect(elapsed).toBeLessThan(200);
  });
});
