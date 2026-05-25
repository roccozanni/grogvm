import { parseBlocks, type Block } from './block';
import { xorDecrypt } from './xor';

/**
 * Parse a complete SCUMM v5 resource file (`MONKEY.000` or `MONKEY.001`,
 * and the MI2 equivalents): byte-XOR-decrypt the whole buffer, then walk
 * the block tree.
 *
 * Engine code intentionally stays DOM-free: the caller is responsible
 * for turning a `File` / `FileSystemFileHandle` into a `Uint8Array`.
 */
export function parseResourceFile(encrypted: Uint8Array, xorKey: number): Block[] {
  return parseBlocks(xorDecrypt(encrypted, xorKey));
}
