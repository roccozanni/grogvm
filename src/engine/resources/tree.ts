import type { Block } from './block';

/**
 * The parsed contents of a SCUMM resource file together with its
 * source bytes. Decoders take a `ResourceFile` and a `Block` reference
 * and slice the payload they need; they never copy.
 */
export interface ResourceFile {
  /** Fully XOR-decrypted file bytes. */
  readonly bytes: Uint8Array;
  /** Top-level blocks parsed from `bytes`. */
  readonly tree: readonly Block[];
}

/** Bytes of a block's payload — everything after the 8-byte header. */
export function payloadOf(file: ResourceFile, block: Block): Uint8Array {
  return file.bytes.subarray(block.offset + 8, block.offset + block.size);
}

/** First direct child of `block` with the given tag, or undefined. */
export function findChild(block: Block, tag: string): Block | undefined {
  return block.children?.find((c) => c.tag === tag);
}

/** All direct children with the given tag (in source order). */
export function findChildren(block: Block, tag: string): Block[] {
  return block.children?.filter((c) => c.tag === tag) ?? [];
}

/**
 * Walk a path of tags from a list of sibling blocks down to a single
 * descendant. Returns the matching block, or undefined if any step
 * fails.
 */
export function findDescendant(
  blocks: readonly Block[],
  ...path: readonly string[]
): Block | undefined {
  if (path.length === 0) return undefined;
  let current: Block | undefined = blocks.find((b) => b.tag === path[0]);
  for (let i = 1; i < path.length; i++) {
    if (!current?.children) return undefined;
    current = current.children.find((b) => b.tag === path[i]);
  }
  return current;
}
