import { payloadOf, type ResourceFile } from '../resources/tree';
import type { Block } from '../resources/block';

/**
 * One COST block as positioned in the LECF/LFLF tree of a resource file.
 * A single LFLF can hold multiple costumes; we record both the LFLF
 * position (matching `walkRooms`) and the costume's position within it.
 */
export interface CostumeEntry {
  readonly lflfIndex: number;
  readonly indexInLflf: number;
  readonly lflfBlock: Block;
  readonly costBlock: Block;
}

/**
 * Walk a resource file's `LECF > LFLF > COST` blocks in source order.
 * Indexed by LFLF position (so cross-references with `walkRooms` line
 * up) plus the COST's position within its LFLF.
 */
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
  /**
   * Bit 7 of `format`. The exact sense (mirror enabled vs mirror disabled)
   * varies between references; we expose the raw bit and let compositing
   * decide. Validate empirically.
   */
  readonly mirrorFlag: boolean;
  /** Palette size in entries: 16 or 32, decided by bit 0 of `format`. */
  readonly paletteSize: 16 | 32;
  /**
   * Local costume palette: each byte is an index into the room CLUT.
   * Entry 0 acts as transparent in the frame RLE stream.
   */
  readonly palette: Uint8Array;
  /**
   * Offset (relative to the start of the COST payload) where the limb
   * command stream begins.
   */
  readonly animCmdOffset: number;
  /** 16 limb image offsets (LE u16, payload-relative). */
  readonly limbOffsets: readonly number[];
  /** Per-anim entry offsets (LE u16, payload-relative). Length = numAnim. */
  readonly animOffsets: readonly number[];
}

/**
 * Parse the fixed-size header that begins every v5 COST payload. The
 * payload-relative offsets returned here drive every deeper decoder
 * (anim streams, limb commands, frame RLE).
 *
 * Layout (post 8-byte block header):
 *
 *   [0]              numAnim - 1
 *   [1]              format byte (bit 7 = mirror flag, bit 0 = palette size)
 *   [2..2+pal-1]     palette: 16 or 32 CLUT indices
 *   [after palette]  u16 LE animCmdOffset
 *   [next 32 B]      16 × u16 LE limb image offsets
 *   [next 2*N]       N × u16 LE anim offsets  (N = numAnim)
 *
 * All offsets are relative to the start of the COST *payload* (i.e. the
 * Uint8Array passed in, not including the 8-byte block header).
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

/**
 * One limb's frame-pointer table. Multiple limbs frequently share the
 * same `tableOffset` — typically the "unused limb" sentinel — so we
 * group them into a single decoded entry tagged with the limb indices
 * that reference it.
 */
export interface LimbTable {
  readonly tableOffset: number;
  readonly usedByLimbs: readonly number[];
  /**
   * u16 LE values read from `tableOffset` up to the next-larger distinct
   * `limbOffsets` value (or the end of payload for the last group). Not
   * every entry is necessarily a real frame pointer — trailing values
   * can run into adjacent data. `suspicious[i] === true` flags entries
   * that don't look like a sensible pointer into the payload.
   */
  readonly entries: readonly number[];
  readonly suspicious: readonly boolean[];
}

/**
 * Group `limbOffsets` by distinct value and decode the u16-LE pointer
 * sequence at each group. Bounded above by the next-larger distinct
 * value (or by `payload.length` for the highest group).
 *
 * Note on suspicion heuristic: an entry is flagged when its value falls
 * below the table's own offset (would point backwards into header
 * territory) or beyond the payload. Useful for the UI; not a guarantee.
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
