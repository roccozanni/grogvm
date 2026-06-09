import { payloadOf, type ResourceFile } from '../resources/tree';
import type { Block } from '../resources/block';

/** One COST block as positioned in the LECF/LFLF tree; `lflfIndex` matches
 *  `walkRooms` indices. */
export interface CostumeEntry {
  readonly lflfIndex: number;
  readonly indexInLflf: number;
  readonly lflfBlock: Block;
  readonly costBlock: Block;
}

/** Walk a resource file's `LECF > LFLF > COST` blocks in source order. */
export function walkCostumes(file: ResourceFile): CostumeEntry[] {
  const lecf = file.tree.find((b) => b.tag === 'LECF');
  if (!lecf?.children) return [];

  const result: CostumeEntry[] = [];
  let lflfIndex = 0;
  for (const lflf of lecf.children) {
    if (lflf.tag === 'LFLF') {
      let indexInLflf = 0;
      for (const inner of lflf.children ?? []) {
        if (inner.tag === 'COST') {
          result.push({ lflfIndex, indexInLflf, lflfBlock: lflf, costBlock: inner });
          indexInLflf++;
        }
      }
      lflfIndex++;
    }
  }
  return result;
}

export interface CostumeHeader {
  /** Total number of animations. */
  readonly numAnim: number;
  /** Raw format byte from the header — surfaced so the UI can show it. */
  readonly format: number;
  /** Format bit 7 — "do NOT mirror West" (dedicated per-direction art).
   *  See pages/docs/scumm/costume-anim.md §Mirroring. */
  readonly mirrorFlag: boolean;
  /** Palette size in entries: 16 or 32, decided by bit 0 of `format`. */
  readonly paletteSize: 16 | 32;
  /**
   * Local costume palette: each byte is an index into the room CLUT.
   * Entry 0 acts as transparent in the frame RLE stream.
   */
  readonly palette: Uint8Array;
  /** Stored offset of the anim-command stream (read with the −6 base). */
  readonly animCmdOffset: number;
  /** 16 limb image-table offsets (LE u16, stored values — −6 base applies). */
  readonly limbOffsets: readonly number[];
  /** Per-anim record offsets (LE u16, −6 base). Length = numAnim. */
  readonly animOffsets: readonly number[];
}

/**
 * Parse the fixed-size header that begins every v5 COST payload.
 * Layout: pages/docs/scumm/cost.md §3.
 */
export function parseCostumeHeader(payload: Uint8Array): CostumeHeader {
  if (payload.length < 4) {
    throw new Error(`COST payload too short for a header (length ${payload.length}).`);
  }
  const numAnim = payload[0]! + 1;
  const format = payload[1]!;
  const mirrorFlag = (format & 0x80) !== 0;
  const paletteSize: 16 | 32 = (format & 0x01) === 0 ? 16 : 32;

  let cursor = 2;
  if (payload.length < cursor + paletteSize) {
    throw new Error(
      `COST palette truncated: needed ${paletteSize} bytes at offset ${cursor}, ` +
        `payload length ${payload.length}.`,
    );
  }
  const palette = new Uint8Array(payload.subarray(cursor, cursor + paletteSize));
  cursor += paletteSize;

  const animCmdOffset = readU16LE(payload, cursor, 'animCmdOffset');
  cursor += 2;

  const limbOffsets: number[] = [];
  for (let i = 0; i < 16; i++) {
    limbOffsets.push(readU16LE(payload, cursor, `limbOffsets[${i}]`));
    cursor += 2;
  }

  const animOffsets: number[] = [];
  for (let i = 0; i < numAnim; i++) {
    animOffsets.push(readU16LE(payload, cursor, `animOffsets[${i}]`));
    cursor += 2;
  }

  return {
    numAnim,
    format,
    mirrorFlag,
    paletteSize,
    palette,
    animCmdOffset,
    limbOffsets,
    animOffsets,
  };
}

/** Convenience: walk + parse-header for one costume entry. */
export function readCostumeHeader(file: ResourceFile, entry: CostumeEntry): CostumeHeader {
  return parseCostumeHeader(payloadOf(file, entry.costBlock));
}

/** One limb's frame-pointer table; limbs sharing a `tableOffset` are grouped
 *  into one entry. */
export interface LimbTable {
  readonly tableOffset: number;
  readonly usedByLimbs: readonly number[];
  /**
   * u16 LE values up to the next-larger distinct `limbOffsets` value (or
   * payload end). Trailing values can run into adjacent data;
   * `suspicious[i]` flags entries that don't look like real pointers.
   */
  readonly entries: readonly number[];
  readonly suspicious: readonly boolean[];
}

/**
 * Group `limbOffsets` by distinct value and decode the u16-LE pointer
 * sequence at each group. The suspicion heuristic is for the UI, not a
 * guarantee.
 */
export function decodeLimbTables(payload: Uint8Array, header: CostumeHeader): LimbTable[] {
  const distinct = new Map<number, number[]>();
  for (let i = 0; i < header.limbOffsets.length; i++) {
    const off = header.limbOffsets[i]!;
    if (off === 0) continue;
    const list = distinct.get(off) ?? [];
    list.push(i);
    distinct.set(off, list);
  }

  const offsetsSorted = [...distinct.keys()].sort((a, b) => a - b);
  const tables: LimbTable[] = [];
  for (let g = 0; g < offsetsSorted.length; g++) {
    const start = offsetsSorted[g]!;
    const end = offsetsSorted[g + 1] ?? payload.length;
    const entries: number[] = [];
    const suspicious: boolean[] = [];
    for (let p = start; p + 2 <= end; p += 2) {
      const v = payload[p]! | (payload[p + 1]! << 8);
      entries.push(v);
      suspicious.push(v < start || v >= payload.length);
    }
    tables.push({
      tableOffset: start,
      usedByLimbs: distinct.get(start)!,
      entries,
      suspicious,
    });
  }
  return tables;
}

function readU16LE(buf: Uint8Array, off: number, fieldName: string): number {
  if (off + 2 > buf.length) {
    throw new Error(
      `COST: read u16 for ${fieldName} at offset ${off} overruns payload (length ${buf.length}).`,
    );
  }
  return buf[off]! | (buf[off + 1]! << 8);
}
