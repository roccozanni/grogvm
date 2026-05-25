/**
 * SCUMM v5 disk files (`MONKEY.000`, `MONKEY.001`, and their MI2
 * equivalents) are stored byte-for-byte XOR'd with a constant key.
 *
 * For MI1 CD VGA and MI2 DOS VGA, the key is 0x69. Other v5 releases
 * (Indy 4, FOA, FM-Towns variants) may differ — we'd discover the right
 * key empirically when we add support for them, which is out of scope.
 */
export const SCUMM_V5_XOR_KEY = 0x69;

export function xorDecrypt(data: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ key;
  }
  return out;
}
