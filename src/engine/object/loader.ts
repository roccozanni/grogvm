/**
 * SCUMM v5 room-object loader. Objects in a room are split across two
 * sibling blocks that share an `obj_id`:
 *
 *   ROOM
 *   ├── OBIM (object image — header + per-state image variants)
 *   │   ├── IMHD
 *   │   ├── IM01 (state 1 image)  ←─ SMAP + ZP##
 *   │   ├── IM02 (state 2 image)
 *   │   └── …
 *   ├── OBCD (object code — header, verb scripts, name)
 *   │   ├── CDHD
 *   │   ├── VERB (verb-id → script-offset table)  *(Phase 7)*
 *   │   └── OBNA (NUL-terminated object name)
 *   └── …
 *
 * The state determines which IMxx is drawn. State 0 = invisible /
 * not drawn. State N = draw IMnn (1-indexed, so state 1 → IM01).
 *
 * # Phase 6 scope
 *
 * - Parse CDHD (position + dimensions in 8-pixel units, parent, flags)
 * - Parse IMHD (pixel-precise x/y/w/h, image-variant count)
 * - Decode each IMxx's SMAP into an indexed bitmap sized by IMHD
 * - Pair OBCD and OBIM by `obj_id`
 * - Capture OBNA for trace-friendly labels
 *
 * Deferred: VERB script payloads (Phase 7), z-planes per object state
 * (compositor uses room z-planes for occlusion; per-object planes can
 * follow when the verb UI lands).
 */

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

/** Object code header (CDHD), 13 bytes. */
export interface CDHD {
  /** Object id — used by setState, drawObject, getObjectState, … */
  readonly objId: number;
  /** Room x in **8-pixel units** (i.e. multiply by 8 for px). */
  readonly x: number;
  /** Room y in 8-pixel units. */
  readonly y: number;
  /** Bounding-box width in 8-pixel units. */
  readonly width: number;
  /** Bounding-box height in 8-pixel units. */
  readonly height: number;
  readonly flags: number;
  /** Parent object id (0 = no parent). */
  readonly parent: number;
  /** Walk-to point (where an actor stands to interact). Pixel coords. */
  readonly walkX: number;
  readonly walkY: number;
  /** Suggested actor facing on use (N/S/E/W mapped through engine convention). */
  readonly actorDir: number;
}

/** Object image header (IMHD). */
export interface IMHD {
  readonly objId: number;
  /** Number of IMxx children present (state 1 → IM01, etc.). */
  readonly numImages: number;
  readonly flags: number;
  /** Pixel-precise position + size for the image. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One per-state image: decoded SMAP at the object's dimensions. */
export interface ObjectImage {
  /** 1-based state index — matches the IMxx tag's number. */
  readonly state: number;
  /** `width × height` palette indices, decoded from the IMxx's SMAP. */
  readonly indexed: Uint8Array;
  /**
   * The object's own z-plane (the OR of the IMxx's `ZP##` blocks), sized
   * to the object's `imhd.width × imhd.height`, or `null` if the image
   * has none. When the object is drawn, this mask makes the object a
   * foreground that occludes z-clipped actors (e.g. the MI1 title logo
   * occludes the drifting clouds). Positioned at the object's
   * `imhd.x / imhd.y`. Width is always a multiple of 8.
   */
  readonly zPlane: DecodedZPlane | null;
}

/** A room-object — the OBIM image data paired with its OBCD metadata. */
export interface LoadedObject {
  readonly objId: number;
  /** CDHD-derived position + size. */
  readonly cdhd: CDHD;
  /**
   * IMHD-derived position + size in pixels. The compositor uses this
   * (not CDHD's 8-pixel-unit values) because some objects have
   * sub-cell offsets that CDHD can't express.
   */
  readonly imhd: IMHD;
  /** Decoded image per state — keyed by state index (1, 2, …). */
  readonly images: ReadonlyMap<number, ObjectImage>;
  /** Object name from OBNA (NUL-terminated), or empty if absent. */
  readonly name: string;
  /**
   * Verb scripts from the OBCD's VERB block, keyed by verb id. Each
   * value is the bytecode for that verb (a view into the file bytes),
   * runnable as a synthetic slot via `vm.startVerbScript`. Empty when
   * the object has no VERB block. See {@link parseVerbScripts}.
   */
  readonly verbs: ReadonlyMap<number, Uint8Array>;
}

/**
 * Parse every object in a ROOM block. Returns a Map keyed by obj_id
 * so callers (the compositor) can look up by the id they have in
 * hand. OBCD and OBIM are paired by obj_id; orphans (OBCD without a
 * matching OBIM, or vice-versa) are silently dropped — they don't
 * help the compositor.
 */
export function parseRoomObjects(
  file: ResourceFile,
  roomBlock: Block,
): ReadonlyMap<number, LoadedObject> {
  // Index OBIM blocks by obj_id from their IMHD.
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
    // OBCD without OBIM = object with no image (script-only sentinel).
    // Skip — the compositor has nothing to draw.
    if (!obim || !imhd) continue;

    const images = decodeImages(file, obim, imhd);

    // OBNA is optional — when present, a NUL-terminated string.
    const obnaBlock = findChild(child, 'OBNA');
    let name = '';
    if (obnaBlock) {
      const p = payloadOf(file, obnaBlock);
      let end = 0;
      while (end < p.length && p[end] !== 0) end++;
      name = String.fromCharCode(...p.subarray(0, end));
    }

    // VERB is optional — objects with no interactions (pure scenery)
    // omit it, yielding an empty verb map.
    const verbBlock = findChild(child, 'VERB');
    const verbs = verbBlock
      ? parseVerbScripts(payloadOf(file, verbBlock))
      : new Map<number, Uint8Array>();

    out.set(cdhd.objId, { objId: cdhd.objId, cdhd, imhd, images, name, verbs });
  }
  return out;
}

/**
 * Parse a CDHD payload. Throws on short payload — every MI1/MI2 CDHD
 * is exactly 13 bytes; anything shorter is malformed.
 */
/** Assemble a signed 16-bit LE value from two bytes. */
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
    // walk_x / walk_y are SIGNED 16-bit — an object's walk-to point can sit
    // just off the room's left edge (negative x). MI1 room 78's left exit
    // (obj 857) walks to x=-25; read unsigned it became 65511, so the ego
    // marched off-screen right and never reached the exit (the "can't leave
    // room 78" bug). Walk boxes are already parsed signed; match them here.
    walkX: i16(payload[8]!, payload[9]!),
    walkY: i16(payload[10]!, payload[11]!),
    actorDir: payload[12]!,
  };
}

/**
 * Parse an IMHD payload. v5 layout is fixed-size 16 bytes when there
 * are no hotspots; hotspots add 4 bytes each. We don't care about
 * hotspots for rendering (they're verb/interaction concerns), so we
 * just read the first 16.
 */
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

/**
 * Decode every IMxx child of an OBIM block into an indexed bitmap.
 * Each IMxx is structured like the room's IM00: an SMAP child holds
 * the bitmap data. We use the IMHD's width / height as the canvas
 * size for `decodeSmap`.
 */
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
      const zPlane = decodeObjectZPlane(file, child, imhd);
      images.set(state, { state, indexed, zPlane });
    } catch {
      // Skip unparsable image variants — keep the others.
    }
  }
  return images;
}

/**
 * Decode an IMxx's `ZP##` z-plane(s) into a single foreground mask (the
 * OR of all planes present), sized to the object's dimensions. Returns
 * `null` when the image has no z-plane or its width isn't a multiple of
 * 8 (the z-plane RLE is strip-based and requires it). A z-plane decode
 * failure is swallowed — the object still draws, just without occluding
 * actors.
 */
function decodeObjectZPlane(
  file: ResourceFile,
  imBlock: Block,
  imhd: IMHD,
): DecodedZPlane | null {
  if (imhd.width % 8 !== 0) return null;
  let merged: DecodedZPlane | null = null;
  for (const child of imBlock.children ?? []) {
    if (!/^ZP[0-9A-F]{2}$/.test(child.tag)) continue;
    try {
      const plane = decodeZPlane(payloadOf(file, child), imhd.width, imhd.height);
      if (!merged) {
        merged = { width: plane.width, height: plane.height, mask: plane.mask.slice() };
      } else {
        for (let i = 0; i < merged.mask.length; i++) merged.mask[i]! |= plane.mask[i]!;
      }
    } catch {
      // Skip an unparsable plane; keep any others.
    }
  }
  return merged;
}
