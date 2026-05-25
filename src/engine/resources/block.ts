/**
 * SCUMM v5 block format
 * ---------------------
 *
 *   ┌────────────┬──────────────┬───────────────┐
 *   │ tag (4 B)  │ size (4 B)   │ payload (...) │
 *   │  ASCII     │  big-endian  │               │
 *   └────────────┴──────────────┴───────────────┘
 *
 * `size` is the **total block size including the 8-byte header**.
 *
 * Some tags identify *containers* whose payload is itself a sequence of
 * child blocks (e.g. LECF, LFLF, ROOM, RMIM, OBIM, OBCD, IM00…IM0F).
 * All other tags are treated as leaves with opaque payload bytes.
 */

export interface Block {
  /** 4-char ASCII block tag. */
  readonly tag: string;
  /** Absolute byte offset of the block header in the source buffer. */
  readonly offset: number;
  /** Total block size in bytes, including the 8-byte header. */
  readonly size: number;
  /**
   * Present iff this is a container block. May be an empty array for
   * containers with no children.
   */
  readonly children?: readonly Block[];
}

const CONTAINER_TAGS = new Set(['LECF', 'LFLF', 'ROOM', 'RMIM', 'OBIM', 'OBCD']);
const IM_CONTAINER_PATTERN = /^IM[0-9A-F]{2}$/;

export function isContainerTag(tag: string): boolean {
  return CONTAINER_TAGS.has(tag) || IM_CONTAINER_PATTERN.test(tag);
}

export function parseBlocks(data: Uint8Array, baseOffset = 0): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;

  while (cursor < data.length) {
    const blockStart = baseOffset + cursor;
    const remaining = data.length - cursor;

    if (remaining < 8) {
      throw new BlockParseError(
        blockStart,
        `not enough bytes for an 8-byte header (have ${remaining})`,
      );
    }

    const tag = readTag(data, cursor);
    const size = readBigEndianUint32(data, cursor + 4);

    if (size < 8) {
      throw new BlockParseError(
        blockStart,
        `block "${tag}" reports size ${size}, smaller than the 8-byte header`,
      );
    }
    if (size > remaining) {
      throw new BlockParseError(
        blockStart,
        `block "${tag}" size ${size} overshoots remaining buffer (${remaining})`,
      );
    }

    const block: Block = isContainerTag(tag)
      ? {
          tag,
          offset: blockStart,
          size,
          children: parseBlocks(
            data.subarray(cursor + 8, cursor + size),
            blockStart + 8,
          ),
        }
      : { tag, offset: blockStart, size };

    blocks.push(block);
    cursor += size;
  }

  return blocks;
}

export class BlockParseError extends Error {
  constructor(
    public readonly offset: number,
    detail: string,
  ) {
    super(`Block parse error at offset 0x${offset.toString(16)}: ${detail}`);
    this.name = 'BlockParseError';
  }
}

function readTag(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset]!,
    data[offset + 1]!,
    data[offset + 2]!,
    data[offset + 3]!,
  );
}

function readBigEndianUint32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset]! << 24) |
      (data[offset + 1]! << 16) |
      (data[offset + 2]! << 8) |
      data[offset + 3]!) >>>
    0
  );
}
