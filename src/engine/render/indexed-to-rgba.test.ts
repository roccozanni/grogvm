import { describe, it, expect } from 'vitest';
import { indexedToRgba } from './indexed-to-rgba';

function makePalette(): Uint8Array {
  const p = new Uint8Array(768);
  // index 0 = black (already 0)
  // index 1 = pure red
  p[3] = 255;
  // index 2 = pure green
  p[7] = 255;
  // index 255 = pure blue
  p[255 * 3 + 2] = 255;
  return p;
}

describe('indexedToRgba', () => {
  it('maps each indexed pixel through the palette to RGBA with full alpha', () => {
    const palette = makePalette();
    const indexed = new Uint8Array([0, 1, 2, 255]);
    const rgba = indexedToRgba(indexed, palette);

    // index 0 → (0,0,0,255)
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 255]);
    // index 1 → (255,0,0,255)
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([255, 0, 0, 255]);
    // index 2 → (0,255,0,255)
    expect([rgba[8], rgba[9], rgba[10], rgba[11]]).toEqual([0, 255, 0, 255]);
    // index 255 → (0,0,255,255)
    expect([rgba[12], rgba[13], rgba[14], rgba[15]]).toEqual([0, 0, 255, 255]);
  });

  it('returns a buffer of length 4 × indexed.length', () => {
    const palette = new Uint8Array(768);
    expect(indexedToRgba(new Uint8Array(0), palette).length).toBe(0);
    expect(indexedToRgba(new Uint8Array(100), palette).length).toBe(400);
  });

  it('throws when the palette is shorter than 768 bytes', () => {
    expect(() => indexedToRgba(new Uint8Array(1), new Uint8Array(767))).toThrow(/too short/);
  });

  it('emits fully transparent pixels for the configured transparent index', () => {
    const palette = makePalette();
    const indexed = new Uint8Array([0, 1, 2, 1]);
    const rgba = indexedToRgba(indexed, palette, 1);

    // index 0 → opaque black
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 255]);
    // index 1 (transparent) → (0,0,0,0)
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([0, 0, 0, 0]);
    // index 2 → opaque green
    expect([rgba[8], rgba[9], rgba[10], rgba[11]]).toEqual([0, 255, 0, 255]);
    // index 1 again → transparent
    expect([rgba[12], rgba[13], rgba[14], rgba[15]]).toEqual([0, 0, 0, 0]);
  });

  it('treats `null` transparent index as "no transparency" (all opaque)', () => {
    const palette = makePalette();
    const rgba = indexedToRgba(new Uint8Array([0, 1, 2]), palette, null);
    expect(rgba[3]).toBe(255);
    expect(rgba[7]).toBe(255);
    expect(rgba[11]).toBe(255);
  });
});
