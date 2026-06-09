import { parseBlocks } from './block';
import type { ResourceFile } from './tree';
import { xorDecrypt } from './xor';

/** XOR-decrypt a whole .000/.001 buffer and parse its block tree. */
export function parseResourceFile(encrypted: Uint8Array, xorKey: number): ResourceFile {
  const bytes = xorDecrypt(encrypted, xorKey);
  const tree = parseBlocks(bytes);
  return { bytes, tree };
}
