import { describe, it, expect } from 'vitest';
import { MemoryRenderer } from './memory';

describe('MemoryRenderer', () => {
  it('records the most recent palette and framebuffer', () => {
    const r = new MemoryRenderer();
    const palette = new Uint8Array(768);
    palette[3] = 255; // index 1 = pure red
    r.setPalette(palette);
    r.present(new Uint8Array([0, 1, 0, 1]));

    expect(r.palette[3]).toBe(255);
    expect(Array.from(r.framebuffer)).toEqual([0, 1, 0, 1]);
    expect(r.presentCount).toBe(1);
  });

  it('keeps the palette and framebuffer independent of the inputs', () => {
    const r = new MemoryRenderer();
    const palette = new Uint8Array(768).fill(7);
    const indexed = new Uint8Array([3, 3, 3]);
    r.setPalette(palette);
    r.present(indexed);

    palette[0] = 99;
    indexed[0] = 99;
    expect(r.palette[0]).toBe(7);
    expect(r.framebuffer[0]).toBe(3);
  });

  it('rgbaSnapshot returns the same RGBA the canvas backend would', () => {
    const r = new MemoryRenderer();
    const palette = new Uint8Array(768);
    palette[3] = 255; // red
    r.setPalette(palette);
    r.present(new Uint8Array([1, 0]));

    const rgba = r.rgbaSnapshot();
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([255, 0, 0, 255]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([0, 0, 0, 255]);
  });

  it('counts present calls', () => {
    const r = new MemoryRenderer();
    r.setPalette(new Uint8Array(768));
    r.present(new Uint8Array(0));
    r.present(new Uint8Array(0));
    r.present(new Uint8Array(0));
    expect(r.presentCount).toBe(3);
  });

  it('records the latest dims via resize', () => {
    const r = new MemoryRenderer();
    expect([r.width, r.height]).toEqual([0, 0]);
    r.resize(320, 144);
    expect([r.width, r.height]).toEqual([320, 144]);
    r.resize(320, 200);
    expect([r.width, r.height]).toEqual([320, 200]);
  });

  it('marks itself disposed', () => {
    const r = new MemoryRenderer();
    expect(r.disposed).toBe(false);
    r.dispose();
    expect(r.disposed).toBe(true);
  });

  it('honours the transparent index in rgbaSnapshot', () => {
    const r = new MemoryRenderer();
    const palette = new Uint8Array(768);
    palette[3] = 255; // index 1 = red
    r.setPalette(palette);
    r.setTransparentIndex(1);
    r.present(new Uint8Array([1, 0]));

    const rgba = r.rgbaSnapshot();
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 0]);
    expect([rgba[4], rgba[5], rgba[6], rgba[7]]).toEqual([0, 0, 0, 255]);
  });
});
