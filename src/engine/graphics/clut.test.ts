import { describe, it, expect } from 'vitest';
import { parseClut } from './clut';

describe('parseClut', () => {
  it('returns 768 bytes for a valid payload', () => {
    const payload = new Uint8Array(768).fill(42);
    const palette = parseClut(payload);
    expect(palette.length).toBe(768);
    expect(palette[0]).toBe(42);
    expect(palette[767]).toBe(42);
  });

  it('truncates any trailing bytes after the 256 RGB triples', () => {
    const payload = new Uint8Array(800);
    payload[765] = 1;
    payload[766] = 2;
    payload[767] = 3;
    payload[768] = 99; // trailing, should be dropped
    const palette = parseClut(payload);
    expect(palette.length).toBe(768);
    expect(palette[767]).toBe(3);
  });

  it('returns an independent buffer (caller can mutate without affecting input)', () => {
    const payload = new Uint8Array(768).fill(5);
    const palette = parseClut(payload);
    palette[0] = 99;
    expect(payload[0]).toBe(5);
  });

  it('throws if the payload is shorter than 768 bytes', () => {
    expect(() => parseClut(new Uint8Array(767))).toThrow(/too short/);
    expect(() => parseClut(new Uint8Array(0))).toThrow(/too short/);
  });
});
