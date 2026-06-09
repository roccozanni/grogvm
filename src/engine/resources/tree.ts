import type { Block } from './block';

export interface ResourceFile {
  /** Fully XOR-decrypted file bytes. */
  readonly bytes: Uint8Array;
  /** Top-level blocks parsed from `bytes`. */
  readonly tree: readonly Block[];
}

/** Bytes of a block's payload — everything after the 8-byte header. A view, not a copy. */
export function payloadOf(file: ResourceFile, block: Block): Uint8Array {
  return file.bytes.subarray(block.offset + 8, block.offset + block.size);
}

export function findChild(block: Block, tag: string): Block | undefined {
  return block.children?.find((c) => c.tag === tag);
}

/** All direct children with the given tag, in source order. */
export function findChildren(block: Block, tag: string): Block[] {
  return block.children?.filter((c) => c.tag === tag) ?? [];
}

/** Walk a path of tags down to a single descendant; undefined if any step fails. */
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
