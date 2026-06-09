/** v5 disk files are byte-XOR'd. 0x69 is MI1 CD / MI2 DOS; other releases may differ. */
export const SCUMM_V5_XOR_KEY = 0x69;

export function xorDecrypt(data: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ key;
  }
  return out;
}
