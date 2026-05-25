import { describe, it, expect } from 'vitest';
import { xorDecrypt, SCUMM_V5_XOR_KEY } from './xor';

describe('xorDecrypt', () => {
  it('returns empty for empty input', () => {
    expect(xorDecrypt(new Uint8Array(0), 0x69)).toEqual(new Uint8Array(0));
  });

  it('is identity when key is 0', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    expect(Array.from(xorDecrypt(data, 0))).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips: xor twice with the same key returns the original', () => {
    const original = new Uint8Array([0x00, 0x69, 0xff, 0x42, 0x4c, 0x45, 0x43, 0x46]);
    const encrypted = xorDecrypt(original, SCUMM_V5_XOR_KEY);
    const decrypted = xorDecrypt(encrypted, SCUMM_V5_XOR_KEY);
    expect(Array.from(decrypted)).toEqual(Array.from(original));
  });

  it('XORs each byte independently', () => {
    const data = new Uint8Array([0x00, 0xff, 0x69, 0x96]);
    expect(Array.from(xorDecrypt(data, 0x69))).toEqual([
      0x00 ^ 0x69,
      0xff ^ 0x69,
      0x69 ^ 0x69,
      0x96 ^ 0x69,
    ]);
  });

  it('does not mutate the input buffer', () => {
    const data = new Uint8Array([1, 2, 3]);
    const before = Array.from(data);
    xorDecrypt(data, 0x69);
    expect(Array.from(data)).toEqual(before);
  });

  it('exposes the SCUMM v5 key constant as 0x69', () => {
    expect(SCUMM_V5_XOR_KEY).toBe(0x69);
  });
});
