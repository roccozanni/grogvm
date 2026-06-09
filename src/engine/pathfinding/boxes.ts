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

/**
 * SCUMM `adjustXYToBeInBox` for placement: a point already in a box is
 * unchanged, else clamp to the nearest visible box's bounding rect — MI1
 * object walk-to points sit just past box edges. Unchanged when no boxes.
 */
export function clampPointToBoxes(
  boxes: ReadonlyArray<WalkBox>,
  x: number,
  y: number,
): { x: number; y: number } {
  if (findBoxAt(boxes, x, y)) return { x, y };
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  for (const box of boxes) {
    if (isInvisibleBox(box)) continue;
    const minX = Math.min(box.ulx, box.urx, box.lrx, box.llx);
    const maxX = Math.max(box.ulx, box.urx, box.lrx, box.llx);
    const minY = Math.min(box.uly, box.ury, box.lry, box.lly);
    const maxY = Math.max(box.uly, box.ury, box.lry, box.lly);
    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = { x: cx, y: cy };
    }
  }
  return best ?? { x, y };
}

/**
 * {@link findBoxAt}, falling back to the nearest visible box — MI1's thin
 * cliff boxes leave a standing actor strictly inside no box, which would stick
 * its perspective scale. Kept separate so findBoxAt's z-clip use is unchanged.
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
    const minX = Math.min(box.ulx, box.urx, box.lrx, box.llx);
    const maxX = Math.max(box.ulx, box.urx, box.lrx, box.llx);
    const minY = Math.min(box.uly, box.ury, box.lry, box.lly);
    const maxY = Math.max(box.uly, box.ury, box.lry, box.lly);
    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));
    const dist = (x - cx) ** 2 + (y - cy) ** 2;
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
