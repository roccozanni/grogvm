import { describe, it, expect } from 'vitest';
import { parseTrns } from './trns';

describe('parseTrns', () => {
  it('reads the 16-bit little-endian palette index', () => {
    expect(parseTrns(new Uint8Array([0x05, 0x00]))).toBe(5);
    expect(parseTrns(new Uint8Array([0xff, 0x00]))).toBe(255);
    expect(parseTrns(new Uint8Array([0x00, 0x01]))).toBe(256);
    expect(parseTrns(new Uint8Array([0xab, 0xcd]))).toBe(0xcdab);
  });

  it('ignores any bytes after the first two', () => {
    expect(parseTrns(new Uint8Array([0x42, 0x00, 0x99, 0x99, 0xff]))).toBe(0x42);
  });

  it('throws if the payload is shorter than 2 bytes', () => {
    expect(() => parseTrns(new Uint8Array(1))).toThrow(/too short/);
    expect(() => parseTrns(new Uint8Array(0))).toThrow(/too short/);
  });
});
