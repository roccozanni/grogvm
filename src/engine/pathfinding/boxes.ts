/** BOXD walk-box + BOXM box-matrix parsers. Format: pages/docs/scumm/walk-boxes.md. */

export class WalkBoxParseError extends Error {
  constructor(detail: string) {
    super(`Walk-box parse error: ${detail}`);
    this.name = 'WalkBoxParseError';
  }
}

export interface WalkBox {
  /** 0-based BOXD index; BOXM rows are keyed by it. */
  readonly id: number;
  readonly ulx: number;
  readonly uly: number;
  readonly urx: number;
  readonly ury: number;
  readonly lrx: number;
  readonly lry: number;
  readonly llx: number;
  readonly lly: number;
  /** Z-plane clip level for an actor in this box (0 = front). See pages/docs/scumm/zplane.md §box-mask. */
  readonly mask: number;
  /** Bit 0x80 = invisible box (excluded from pathfinding). */
  readonly flags: number;
  /**
   * u16: `0` = no per-box scaling; bit 0x8000 = SCAL-slot reference
   * (index `scale & 0x7FFF`); otherwise a direct fixed scale 1..255.
   * See resolveScale in pathfinding/scale.ts.
   */
  readonly scale: number;
}

export function isInvisibleBox(box: WalkBox): boolean {
  return (box.flags & 0x80) !== 0;
}

/**
 * Same-side test (all edge cross-products share a sign); on-edge counts as
 * inside, so adjacent boxes both claim the seam. Either winding works.
 */
export function pointInBox(box: WalkBox, x: number, y: number): boolean {
  const px = [box.ulx, box.urx, box.lrx, box.llx];
  const py = [box.uly, box.ury, box.lry, box.lly];
  let sawPos = false;
  let sawNeg = false;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const cross =
      (px[j]! - px[i]!) * (y - py[i]!) - (py[j]! - py[i]!) * (x - px[i]!);
    if (cross > 0) sawPos = true;
    else if (cross < 0) sawNeg = true;
    if (sawPos && sawNeg) return false;
  }
  if (!sawPos && !sawNeg) {
    // Degenerate (point/line) box: the bbox test keeps a real "line" box
    // matching its segment (actors stand on MI1's staircase boxes) while the
    // all-(-32000) box-0 sentinel — every cross = 0 — matches nothing.
    return (
      x >= Math.min(...px) && x <= Math.max(...px) &&
      y >= Math.min(...py) && y <= Math.max(...py)
    );
  }
  return true;
}

/** Lowest-index visible box containing the point, or `null`. Invisible boxes skipped. */
export function findBoxAt(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): WalkBox | null {
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    if (pointInBox(box, x, y)) return box;
  }
  return null;
}

type Pt = { x: number; y: number };

/** Corners of a box as a closed 4-point loop (UL → UR → LR → LL). */
export function corners(b: WalkBox): Pt[] {
  return [
    { x: b.ulx, y: b.uly },
    { x: b.urx, y: b.ury },
    { x: b.lrx, y: b.lry },
    { x: b.llx, y: b.lly },
  ];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Closest pair of points between segments p1p2 and p3p4 (Ericson, Real-Time
 * Collision Detection, ClosestPtSegmentSegment). Handles degenerate
 * point/line segments — MI1's "line" boxes collapse to a segment or a point.
 */
export function closestSeg(p1: Pt, p2: Pt, p3: Pt, p4: Pt): [Pt, Pt] {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const rx = p1.x - p3.x, ry = p1.y - p3.y;
  const a = d1x * d1x + d1y * d1y;
  const e = d2x * d2x + d2y * d2y;
  const f = d2x * rx + d2y * ry;
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) {
    s = t = 0;
  } else if (a <= 1e-9) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry;
    if (e <= 1e-9) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const bdot = d1x * d2x + d1y * d2y;
      const denom = a * e - bdot * bdot;
      s = denom > 1e-9 ? clamp((bdot * f - c * e) / denom, 0, 1) : 0;
      t = (bdot * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((bdot - c) / a, 0, 1); }
    }
  }
  return [
    { x: p1.x + d1x * s, y: p1.y + d1y * s },
    { x: p3.x + d2x * t, y: p3.y + d2y * t },
  ];
}

/**
 * SCUMM `adjustXYToBeInBox`: the point of box `b` closest to `(x, y)`, by true
 * EDGE distance (not the bounding rect) — a slanted box's bbox can dip far past
 * its real edge, which would mis-rank it as "nearest" against a square box and
 * snap an off-box placement into the wrong walkbox (the room 2↔5 boat crossing
 * landing on land instead of water). Returns integer pixels.
 */
export function closestPointInBox(b: WalkBox, x: number, y: number): Pt {
  if (pointInBox(b, x, y)) return { x, y };
  const c = corners(b);
  const p: Pt = { x, y };
  let best: Pt = c[0]!;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const [, q] = closestSeg(p, p, c[i]!, c[(i + 1) % 4]!);
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bestDist) { bestDist = d; best = q; }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) };
}

/**
 * SCUMM `adjustXYToBeInBox` for placement: a point already in a box is
 * unchanged, else snap to the closest point on the nearest visible box — MI1
 * object walk-to points sit just past box edges. Nearness is by true edge
 * distance ({@link closestPointInBox}), not bounding rect. Unchanged when no
 * boxes.
 */
export function clampPointToBoxes(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): { x: number; y: number } {
  if (findBoxAt(boxes, x, y)) return { x, y };
  let best: Pt | null = null;
  let bestDist = Infinity;
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    const q = closestPointInBox(box, x, y);
    const dist = (x - q.x) ** 2 + (y - q.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = q;
    }
  }
  return best ?? { x, y };
}

/**
 * {@link findBoxAt}, falling back to the nearest visible box — MI1's thin
 * cliff boxes leave a standing actor strictly inside no box, which would stick
 * its perspective scale. Kept separate so findBoxAt's z-clip use is unchanged.
 * Nearness is by true edge distance ({@link closestPointInBox}), matching
 * SCUMM — a slanted box's bounding rect can otherwise win against a square box
 * it doesn't really reach.
 */
export function findBoxAtOrNearest(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): WalkBox | null {
  const strict = findBoxAt(boxes, x, y);
  if (strict) return strict;
  let best: WalkBox | null = null;
  let bestDist = Infinity;
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    const q = closestPointInBox(box, x, y);
    const dist = (x - q.x) ** 2 + (y - q.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = box;
    }
  }
  return best;
}

/** Triple `{from, to, next}`: to reach any box in `[from, to]`, step into `next`. */
export type BoxMatrixRow = ReadonlyArray<{ readonly from: number; readonly to: number; readonly next: number }>;

/** One row per box, indexed by source box id. */
export type BoxMatrix = ReadonlyArray<BoxMatrixRow>;

/** BOXM layout: pages/docs/scumm/walk-boxes.md §4. */
export function parseBoxMatrix(payload: Uint8Array, numBoxes: number): BoxMatrix {
  const rows: BoxMatrixRow[] = [];
  let off = 0;
  for (let b = 0; b < numBoxes; b++) {
    const row: { from: number; to: number; next: number }[] = [];
    while (off < payload.length && payload[off] !== 0xff) {
      // A truncated final triple is dropped — degrades to "no hop", not a crash.
      if (off + 2 >= payload.length) { off = payload.length; break; }
      row.push({ from: payload[off]!, to: payload[off + 1]!, next: payload[off + 2]! });
      off += 3;
    }
    off++; // skip the 0xff terminator
    rows.push(row);
  }
  return rows;
}

/** Next box to step into from `from` toward `to`, or `-1` when unreachable. */
export function getNextBox(matrix: BoxMatrix, from: number, to: number): number {
  const row = matrix[from];
  if (!row) return -1;
  for (const t of row) {
    if (to >= t.from && to <= t.to) return t.next;
  }
  return -1;
}

export function parseWalkBoxes(payload: Uint8Array): WalkBox[] {
  if (payload.length < 2) {
    throw new WalkBoxParseError(`payload too short: ${payload.length} B (need ≥ 2 for count)`);
  }
  const count = payload[0]! | (payload[1]! << 8);
  const expected = 2 + 20 * count;
  if (payload.length !== expected) {
    throw new WalkBoxParseError(
      `payload size ${payload.length} doesn't match count=${count} (expected ${expected})`,
    );
  }
  const out: WalkBox[] = [];
  let off = 2;
  for (let i = 0; i < count; i++) {
    out.push({
      id: i,
      ulx: readI16LE(payload, off + 0),
      uly: readI16LE(payload, off + 2),
      urx: readI16LE(payload, off + 4),
      ury: readI16LE(payload, off + 6),
      lrx: readI16LE(payload, off + 8),
      lry: readI16LE(payload, off + 10),
      llx: readI16LE(payload, off + 12),
      lly: readI16LE(payload, off + 14),
      mask: payload[off + 16]!,
      flags: payload[off + 17]!,
      // u16: the high bit (0x8000) flags a SCAL-slot reference, so this must
      // be read as 16 bits — not just the low byte.
      scale: payload[off + 18]! | (payload[off + 19]! << 8),
    });
    off += 20;
  }
  return out;
}

function readI16LE(buf: Uint8Array, off: number): number {
  const v = buf[off]! | (buf[off + 1]! << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}
