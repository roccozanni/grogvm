import { parseBlocks } from './block';
import type { ResourceFile } from './tree';
import { xorDecrypt } from './xor';

/**
 * Parse a complete SCUMM v5 resource file (`MONKEY.000` or `MONKEY.001`,
 * and the MI2 equivalents): byte-XOR-decrypt the whole buffer, walk the
 * block tree, return the decrypted bytes and tree together.
 *
 * Engine code intentionally stays DOM-free: the caller is responsible
 * for turning a `File` / `FileSystemFileHandle` into a `Uint8Array`.
 */
export function parseResourceFile(encrypted: Uint8Array, xorKey: number): ResourceFile {
  const bytes = xorDecrypt(encrypted, xorKey);
  const tree = parseBlocks(bytes);
  return { bytes, tree };
}
