/** Room-object loader (OBCD + OBIM pairing). Format: pages/docs/scumm/objects.md. */

import { decodeSmap } from '../graphics/smap';
import { decodeZPlane, type DecodedZPlane } from '../graphics/zplane';
import type { Block } from '../resources/block';
import { findChild, payloadOf, type ResourceFile } from '../resources/tree';
import { parseVerbScripts } from './verbs';

export class ObjectParseError extends Error {
  constructor(public readonly objId: number, detail: string) {
    super(`Object #${objId}: ${detail}`);
    this.name = 'ObjectParseError';
  }
}

/** Object code header (CDHD), 13 bytes. Layout: pages/docs/scumm/objects.md §2. */
export interface CDHD {
  readonly objId: number;
  /** Room x in **8-pixel units** (multiply by 8 for px). */
  readonly x: number;
  /** 8-pixel units. */
  readonly y: number;
  /** 8-pixel units. */
  readonly width: number;
  /** 8-pixel units. */
  readonly height: number;
  readonly flags: number;
  /** Parent object id (0 = no parent). */
  readonly parent: number;
  /** Walk-to point, in pixels (unlike x/y). */
  readonly walkX: number;
  readonly walkY: number;
  readonly actorDir: number;
}

/** Object image header (IMHD). */
export interface IMHD {
  readonly objId: number;
  /** Number of IMxx children present (state 1 → IM01, etc.). */
  readonly numImages: number;
  readonly flags: number;
  /** Pixel-precise position + size (unlike CDHD's 8-px units). */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ObjectImage {
  /** 1-based state index — matches the IMxx tag's number. */
  readonly state: number;
  /** `width × height` palette indices, decoded from the IMxx's SMAP. */
  readonly indexed: Uint8Array;
  /**
   * Per-plane: `zPlanes[k-1]` = `ZP0k`, occluding actors at clip level `k`
   * ALONE — same mapping as room planes (pages/docs/scumm/zplane.md). `null`
   * slot = absent/undecodable plane; `[]` = no z-planes.
   */
  readonly zPlanes: ReadonlyArray<DecodedZPlane | null>;
}

export interface LoadedObject {
  readonly objId: number;
  readonly cdhd: CDHD;
  /** The compositor draws at IMHD's pixel position — CDHD can't express sub-cell offsets. */
  readonly imhd: IMHD;
  /** Decoded image per state — keyed by state index (1, 2, …). */
  readonly images: ReadonlyMap<number, ObjectImage>;
  /** Object name from OBNA, or empty if absent. */
  readonly name: string;
  /** Verb bytecode by verb id (views into the file bytes). Empty when no VERB block. */
  readonly verbs: ReadonlyMap<number, Uint8Array>;
}

/**
 * Parse every object in a ROOM block, pairing OBCD and OBIM by obj_id.
 * Orphans (either block without its sibling) are silently dropped.
 */
export function parseRoomObjects(
  file: ResourceFile,
  roomBlock: Block,
): ReadonlyMap<number, LoadedObject> {
  const obims = new Map<number, Block>();
  const imhds = new Map<number, IMHD>();
  for (const child of roomBlock.children ?? []) {
    if (child.tag !== 'OBIM') continue;
    const imhdBlock = findChild(child, 'IMHD');
    if (!imhdBlock) continue;
    const imhd = parseIMHD(payloadOf(file, imhdBlock));
    obims.set(imhd.objId, child);
    imhds.set(imhd.objId, imhd);
  }

  const out = new Map<number, LoadedObject>();
  for (const child of roomBlock.children ?? []) {
    if (child.tag !== 'OBCD') continue;
    const cdhdBlock = findChild(child, 'CDHD');
    if (!cdhdBlock) continue;
    const cdhd = parseCDHD(payloadOf(file, cdhdBlock));

    const obim = obims.get(cdhd.objId);
    const imhd = imhds.get(cdhd.objId);
    if (!obim || !imhd) continue;

    const images = decodeImages(file, obim, imhd);

    const obnaBlock = findChild(child, 'OBNA');
    let name = '';
    if (obnaBlock) {
      const p = payloadOf(file, obnaBlock);
      let end = 0;
      while (end < p.length && p[end] !== 0) end++;
      name = String.fromCharCode(...p.subarray(0, end));
    }

    const verbBlock = findChild(child, 'VERB');
    const verbs = verbBlock
      ? parseVerbScripts(payloadOf(file, verbBlock))
      : new Map<number, Uint8Array>();

    out.set(cdhd.objId, { objId: cdhd.objId, cdhd, imhd, images, name, verbs });
  }
  return out;
}

function i16(lo: number, hi: number): number {
  const v = lo | (hi << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

export function parseCDHD(payload: Uint8Array): CDHD {
  if (payload.length < 13) {
    throw new ObjectParseError(
      payload.length >= 2 ? (payload[0]! | (payload[1]! << 8)) : 0,
      `CDHD payload too short: ${payload.length} bytes (need ≥ 13)`,
    );
  }
  return {
    objId: payload[0]! | (payload[1]! << 8),
    x: payload[2]!,
    y: payload[3]!,
    width: payload[4]!,
    height: payload[5]!,
    flags: payload[6]!,
    parent: payload[7]!,
    // SIGNED — an edge exit's walk-to x can be negative (objects.md §2).
    walkX: i16(payload[8]!, payload[9]!),
    walkY: i16(payload[10]!, payload[11]!),
    actorDir: payload[12]!,
  };
}

/** Reads the fixed first 16 bytes; trailing hotspot entries (4 B each) are ignored. */
export function parseIMHD(payload: Uint8Array): IMHD {
  if (payload.length < 16) {
    throw new ObjectParseError(
      payload.length >= 2 ? (payload[0]! | (payload[1]! << 8)) : 0,
      `IMHD payload too short: ${payload.length} bytes (need ≥ 16)`,
    );
  }
  return {
    objId: payload[0]! | (payload[1]! << 8),
    numImages: payload[2]! | (payload[3]! << 8),
    flags: payload[4]!,
    // payload[5] = unknown / padding
    // payload[6..7] = numHotspots (we ignore)
    x: payload[8]! | (payload[9]! << 8),
    y: payload[10]! | (payload[11]! << 8),
    width: payload[12]! | (payload[13]! << 8),
    height: payload[14]! | (payload[15]! << 8),
  };
}

/** Decode every IMxx child of an OBIM, sized by IMHD (SMAP doesn't carry dimensions). */
function decodeImages(
  file: ResourceFile,
  obim: Block,
  imhd: IMHD,
): Map<number, ObjectImage> {
  const images = new Map<number, ObjectImage>();
  if (imhd.width === 0 || imhd.height === 0) return images;
  for (const child of obim.children ?? []) {
    const match = /^IM([0-9A-F]{2})$/.exec(child.tag);
    if (!match) continue;
    const state = parseInt(match[1]!, 16);
    if (state === 0) continue; // IM00 reserved for the room background
    const smap = findChild(child, 'SMAP');
    if (!smap) continue;
    try {
      const indexed = decodeSmap(payloadOf(file, smap), imhd.width, imhd.height);
      const zPlanes = decodeObjectZPlanes(file, child, imhd);
      images.set(state, { state, indexed, zPlanes });
    } catch {
      // Skip unparsable image variants — keep the others.
    }
  }
  return images;
}

/**
 * `ZP0k` → index `k-1`, preserving the per-plane mapping — do NOT collapse the
 * chunks into one mask (single-plane rule, pages/docs/scumm/zplane.md). `[]`
 * when width isn't a multiple of 8 (strip RLE requires it) or no ZP## blocks.
 */
function decodeObjectZPlanes(
  file: ResourceFile,
  imBlock: Block,
  imhd: IMHD,
): Array<DecodedZPlane | null> {
  if (imhd.width % 8 !== 0) return [];
  const planes: Array<DecodedZPlane | null> = [];
  for (const child of imBlock.children ?? []) {
    const match = /^ZP([0-9A-F]{2})$/.exec(child.tag);
    if (!match) continue;
    const idx = parseInt(match[1]!, 16) - 1; // ZP01 → plane index 0
    if (idx < 0) continue;
    try {
      planes[idx] = decodeZPlane(payloadOf(file, child), imhd.width, imhd.height);
    } catch {
      planes[idx] = null; // unparsable plane — object still draws
    }
  }
  return planes;
}
