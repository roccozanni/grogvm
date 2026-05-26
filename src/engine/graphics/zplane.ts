/**
 * SCUMM v5 z-plane decoder.
 *
 * Z-planes mark room regions actors should be drawn *behind*. A room
 * has up to ~4 of them in v5, named `ZP01`, `ZP02`, … and stored
 * alongside the background `SMAP` under `RMIM > IM00`. The plane count
 * for the room lives in the 2-byte `RMIH`.
 *
 * Layout of one `ZP##` block payload:
 *
 *   ┌─────────────────────────────────┬─────────────────┐
 *   │ stripCount × u16 LE offsets     │ strip bodies    │
 *   └─────────────────────────────────┴─────────────────┘
 *
 * The offsets share SMAP's "header-inclusive" convention: each one is
 * measured from the start of the `ZP##` block (i.e. including the
 * 8-byte block header), so the decoder must subtract 8 to get a
 * payload-relative position. The value **`0` is a sentinel** meaning
 * "this strip is entirely zero" — no body is stored for it, the strip
 * is left as-pass-through. (The original engine reportedly does
 * something funny on these strips; for our purposes, a zero mask is
 * the correct semantics.)
 *
 * Each strip body decodes to `roomHeight` bytes — one byte per row of
 * the 8-pixel-wide strip — using a packbits-style RLE:
 *
 *   read byte `op`:
 *     op & 0x80 set  →  run of (op & 0x7F) copies of the next byte
 *     op & 0x80 clr  →  `op` literal bytes follow
 *
 * Each emitted byte covers the 8 pixels of one row; bit 7 (MSB) is the
 * leftmost pixel of the strip, bit 0 the rightmost.
 *
 * For the compositor: a non-zero mask bit at (x, y) means an actor with
 * z-level *less than this plane's index* should be hidden at that
 * pixel. Plane indices run 1..N (ZP01 → index 1, ZP02 → index 2, …);
 * `actorZ` of 0 means "always occluded by any plane bit".
 */

import { findChild, payloadOf, type ResourceFile } from '../resources/tree';
import type { Block } from '../resources/block';

export interface DecodedZPlane {
  readonly width: number;
  readonly height: number;
  /**
   * `width × height` bytes, one per pixel. `1` means the plane's bit is
   * set at this pixel (an actor below this plane's level is hidden
   * here); `0` means the plane passes through.
   */
  readonly mask: Uint8Array;
}

export interface DecodedZPlanes {
  readonly width: number;
  readonly height: number;
  /** Plane count reported by RMIH. Should match `planes.length` in well-formed rooms. */
  readonly declaredCount: number;
  /** One entry per ZP## block, in source order. Index 0 = ZP01. */
  readonly planes: readonly DecodedZPlane[];
}

/** Read RMIH's 2-byte u16 LE z-plane count. */
export function parseRmihPlaneCount(payload: Uint8Array): number {
  if (payload.length < 2) {
    throw new Error(`RMIH payload too short (${payload.length} bytes).`);
  }
  return payload[0]! | (payload[1]! << 8);
}

/**
 * Decode every z-plane present under `roomBlock`'s `RMIM > IM00`. The
 * declared count from RMIH is reported alongside the actual decoded
 * planes; they should match in well-formed rooms but a room with
 * RMIH=0 and no ZP## blocks is perfectly normal.
 */
export function decodeZPlanes(
  file: ResourceFile,
  roomBlock: Block,
  width: number,
  height: number,
): DecodedZPlanes {
  const rmim = findChild(roomBlock, 'RMIM');
  if (!rmim) return { width, height, declaredCount: 0, planes: [] };

  const rmih = findChild(rmim, 'RMIH');
  const declaredCount = rmih ? parseRmihPlaneCount(payloadOf(file, rmih)) : 0;

  const im00 = findChild(rmim, 'IM00');
  if (!im00) return { width, height, declaredCount, planes: [] };

  const planes: DecodedZPlane[] = [];
  for (const child of im00.children ?? []) {
    if (!/^ZP[0-9A-F]{2}$/.test(child.tag)) continue;
    planes.push(decodeZPlane(payloadOf(file, child), width, height));
  }
  return { width, height, declaredCount, planes };
}

/**
 * Decode a single ZP## block payload into a `width × height` byte mask.
 * Public so synthetic-fixture tests can call it directly.
 */
export function decodeZPlane(payload: Uint8Array, width: number, height: number): DecodedZPlane {
  if (width <= 0 || width % 8 !== 0) {
    throw new Error(`ZP##: room width ${width} must be a positive multiple of 8.`);
  }
  if (height <= 0) {
    throw new Error(`ZP##: room height ${height} must be positive.`);
  }
  const stripCount = width >>> 3;
  if (payload.length < stripCount * 2) {
    throw new Error(
      `ZP##: payload too short for ${stripCount} strip offsets (have ${payload.length} B).`,
    );
  }

  const mask = new Uint8Array(width * height);

  // First pass: read every raw offset. A raw value of 0 is the
  // "implicit all-zero strip" sentinel — we keep the corresponding
  // entry as `null` and the strip's mask region just stays zero.
  const stripStarts: (number | null)[] = [];
  for (let s = 0; s < stripCount; s++) {
    const raw = payload[s * 2]! | (payload[s * 2 + 1]! << 8);
    stripStarts.push(raw === 0 ? null : raw - 8);
  }

  for (let s = 0; s < stripCount; s++) {
    const start = stripStarts[s]!;
    if (start === null) continue; // sentinel: leave strip's region zeroed.

    // Body ends at the next non-sentinel strip's start, or at the end
    // of the payload if this is the last non-sentinel strip.
    let end = payload.length;
    for (let next = s + 1; next < stripCount; next++) {
      const ns = stripStarts[next]!;
      if (ns !== null) {
        end = ns;
        break;
      }
    }

    if (start < 0 || end > payload.length || end < start) {
      throw new Error(
        `ZP##: strip ${s} body out of range (start=${start}, end=${end}, payload=${payload.length}).`,
      );
    }
    decodeStripInto(payload.subarray(start, end), mask, s * 8, width, height, s);
  }

  return { width, height, mask };
}

function decodeStripInto(
  body: Uint8Array,
  mask: Uint8Array,
  colStart: number,
  width: number,
  height: number,
  stripIdx: number,
): void {
  let pos = 0;
  let row = 0;
  while (row < height) {
    if (pos >= body.length) {
      throw new Error(
        `ZP## strip ${stripIdx}: ran out of RLE bytes at row ${row}/${height}.`,
      );
    }
    const op = body[pos++]!;
    if (op & 0x80) {
      const count = op & 0x7f;
      if (pos >= body.length) {
        throw new Error(
          `ZP## strip ${stripIdx}: truncated run byte after op 0x${op.toString(16)}.`,
        );
      }
      const data = body[pos++]!;
      for (let r = 0; r < count && row < height; r++) {
        emitRow(mask, colStart, row, width, data);
        row++;
      }
    } else {
      const count = op;
      for (let r = 0; r < count && row < height; r++) {
        if (pos >= body.length) {
          throw new Error(
            `ZP## strip ${stripIdx}: ran out of literal bytes at row ${row}/${height}.`,
          );
        }
        emitRow(mask, colStart, row, width, body[pos++]!);
        row++;
      }
    }
  }
}

function emitRow(
  mask: Uint8Array,
  colStart: number,
  row: number,
  width: number,
  byteVal: number,
): void {
  const base = row * width + colStart;
  // Bit 7 (MSB) is the leftmost pixel of the strip — verified against
  // MI1 room geometry by overlaying the decoded mask on the canvas.
  for (let b = 0; b < 8; b++) {
    mask[base + b] = (byteVal >>> (7 - b)) & 1;
  }
}

/** O(1) accessor. Returns 0 or 1; out-of-bounds reads return 0. */
export function zplaneBit(plane: DecodedZPlane, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= plane.width || y >= plane.height) return 0;
  return plane.mask[y * plane.width + x]!;
}
