/**
 * Round-trips the harness PNG writer: encode an indexed image, then parse the
 * bytes back (signature, IHDR, inflated IDAT) and assert the pixels survived.
 * No game data — pure, runs everywhere incl. CI.
 */
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodeIndexedPng } from './png';

/** Pull width/height + RGB pixels back out of a colour-type-2 PNG. */
function decodePng(png: Buffer): { width: number; height: number; rgb: number[][] } {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let off = 8;
  let ihdr: Buffer | undefined;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    off += 12 + len; // len + type + data + crc
  }
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  expect(ihdr[8]).toBe(8); // bit depth
  expect(ihdr[9]).toBe(2); // truecolour

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  const rgb: number[][] = [];
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter type: none
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      rgb.push([raw[o]!, raw[o + 1]!, raw[o + 2]!]);
    }
  }
  return { width, height, rgb };
}

describe('encodeIndexedPng', () => {
  // A 2×2 image, indices 0..3, mapped to four distinct colours.
  const palette = new Uint8Array(768);
  palette.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120], 0);
  const pixels = new Uint8Array([0, 1, 2, 3]);
  const image = { width: 2, height: 2, pixels, palette };

  it('maps indices through the palette at scale 1', () => {
    const { width, height, rgb } = decodePng(encodeIndexedPng(image));
    expect([width, height]).toEqual([2, 2]);
    expect(rgb).toEqual([
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
      [100, 110, 120],
    ]);
  });

  it('upscales each pixel into a scale×scale block', () => {
    const { width, height, rgb } = decodePng(encodeIndexedPng({ ...image, scale: 2 }));
    expect([width, height]).toEqual([4, 4]);
    // Top-left index 0 fills the top-left 2×2 block.
    expect(rgb[0]).toEqual([10, 20, 30]);
    expect(rgb[1]).toEqual([10, 20, 30]);
    expect(rgb[4]).toEqual([10, 20, 30]);
    expect(rgb[5]).toEqual([10, 20, 30]);
    // Index 1 fills the top-right 2×2 block.
    expect(rgb[2]).toEqual([40, 50, 60]);
    expect(rgb[7]).toEqual([40, 50, 60]);
    // Index 3 fills the bottom-right corner.
    expect(rgb[15]).toEqual([100, 110, 120]);
  });
});
