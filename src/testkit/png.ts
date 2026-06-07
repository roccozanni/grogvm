/**
 * Minimal PNG writer for the dev/test harness — turns an indexed
 * framebuffer + palette into a truecolour PNG on disk. Node-only (uses
 * `Buffer` + `zlib`), which is why it lives in testkit rather than the
 * DOM/Node-free engine core.
 *
 * Extracted from ~37 scratch render scripts that each carried a byte-for-byte
 * copy of the same crc32 / chunk / IHDR+IDAT assembly. Emits 8-bit RGB
 * (colour type 2) with nearest-neighbour integer upscaling — the shape every
 * one of those scripts wanted (small SCUMM rooms blown up 3× to be legible).
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  /** `width × height` palette indices. */
  readonly pixels: Uint8Array;
  /** RGB triples: the colour for index `i` is `palette[i*3 .. i*3+2]`. */
  readonly palette: Uint8Array;
  /** Nearest-neighbour upscale factor. Default 1 (no scaling). */
  readonly scale?: number;
}

export function encodeIndexedPng(image: IndexedImage): Buffer {
  const { width, height, pixels, palette } = image;
  const scale = image.scale ?? 1;
  const sw = width * scale;
  const sh = height * scale;

  // Raw image data: one filter byte (0 = none) per scanline, then RGB triples.
  const stride = sw * 3 + 1;
  const raw = Buffer.alloc(stride * sh);
  for (let y = 0; y < sh; y++) {
    const srcY = (y / scale) | 0;
    let o = y * stride + 1; // skip the leading filter byte
    for (let x = 0; x < sw; x++) {
      const c = pixels[srcY * width + ((x / scale) | 0)]!;
      raw[o++] = palette[c * 3]!;
      raw[o++] = palette[c * 3 + 1]!;
      raw[o++] = palette[c * 3 + 2]!;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(sw, 0);
  ihdr.writeUInt32BE(sh, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeIndexedPng(path: string, image: IndexedImage): void {
  writeFileSync(path, encodeIndexedPng(image));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
