import { findChild, findDescendant, payloadOf, type ResourceFile } from '../resources/tree';
import type { Block } from '../resources/block';
import { parseRmhd } from './rmhd';
import { parseClut } from './clut';
import { decodeSmap, getSmapStripMethods } from './smap';
import { parseTrns } from './trns';

/** One room as positioned in the LECF/LFLF tree of a resource file. */
export interface RoomEntry {
  /** 0-based index of the enclosing LFLF inside LECF. */
  readonly lflfIndex: number;
  readonly lflfBlock: Block;
  readonly roomBlock: Block;
}

/**
 * Walk a resource file's top-level LECF in source order and yield each
 * `LFLF > ROOM` pair. LFLFs without a ROOM child are skipped (but still
 * counted by `lflfIndex` so the indices match what the block-tree view
 * shows the user).
 */
export function walkRooms(file: ResourceFile): RoomEntry[] {
  const lecf = file.tree.find((b) => b.tag === 'LECF');
  if (!lecf?.children) return [];

  const result: RoomEntry[] = [];
  let lflfIndex = 0;
  for (const child of lecf.children) {
    if (child.tag === 'LFLF') {
      const roomBlock = findChild(child, 'ROOM');
      if (roomBlock) {
        result.push({ lflfIndex, lflfBlock: child, roomBlock });
      }
      lflfIndex++;
    }
  }
  return result;
}

export interface DecodedRoom {
  readonly width: number;
  readonly height: number;
  readonly numObjects: number;
  /** 256 RGB triples = 768 bytes, in 0–255 range. */
  readonly palette: Uint8Array;
  /** `width × height` palette indices. */
  readonly indexed: Uint8Array;
  /** Encoding method code at the head of each SMAP strip (one per 8-px column). */
  readonly stripMethods: readonly number[];
  /** Palette index that acts as transparent; `null` if the room lacks a TRNS block. */
  readonly transparentIndex: number | null;
}

/**
 * Decode a room's background bitmap and palette. Throws if any of the
 * required sub-blocks (RMHD, CLUT, RMIM > IM00 > SMAP) are missing or
 * if the SMAP uses a compression method we have not implemented yet.
 */
export function decodeRoom(file: ResourceFile, roomBlock: Block): DecodedRoom {
  const rmhdBlock = findChild(roomBlock, 'RMHD');
  if (!rmhdBlock) throw new Error('Room is missing its RMHD block.');
  const header = parseRmhd(payloadOf(file, rmhdBlock));

  const clutBlock = findChild(roomBlock, 'CLUT');
  if (!clutBlock) throw new Error('Room is missing its CLUT (palette) block.');
  const palette = parseClut(payloadOf(file, clutBlock));

  const smapBlock = findDescendant(roomBlock.children ?? [], 'RMIM', 'IM00', 'SMAP');
  if (!smapBlock) throw new Error('Room is missing its RMIM > IM00 > SMAP background bitmap.');
  const smapPayload = payloadOf(file, smapBlock);
  const indexed = decodeSmap(smapPayload, header.width, header.height);
  const stripMethods = getSmapStripMethods(smapPayload, header.width);

  const trnsBlock = findChild(roomBlock, 'TRNS');
  const transparentIndex = trnsBlock ? parseTrns(payloadOf(file, trnsBlock)) : null;

  return {
    width: header.width,
    height: header.height,
    numObjects: header.numObjects,
    palette,
    indexed,
    stripMethods,
    transparentIndex,
  };
}
