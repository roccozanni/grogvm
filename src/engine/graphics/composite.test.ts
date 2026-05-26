import { describe, it, expect } from 'vitest';
import { compositeActor } from './composite';
import { COSTUME_FRAME_TRANSPARENT } from './costume-frame';
import type { DecodedCostumeFrame } from './costume-frame';
import type { DecodedZPlane } from './zplane';

const T = COSTUME_FRAME_TRANSPARENT;

function frame(
  width: number,
  height: number,
  pixels: number[],
  redirX = 0,
  redirY = 0,
): DecodedCostumeFrame {
  if (pixels.length !== width * height) {
    throw new Error(`fixture: pixels length ${pixels.length} ≠ ${width}×${height}`);
  }
  return {
    width,
    height,
    redirX,
    redirY,
    xinc: 0,
    yinc: 0,
    pixels: new Uint8Array(pixels),
    rleByteCount: 0,
  };
}

function plane(width: number, height: number, mask: number[]): DecodedZPlane {
  return { width, height, mask: new Uint8Array(mask) };
}

/** Identity palette — costume index N maps straight to CLUT index N. */
function identityPalette(size: number): Uint8Array {
  const p = new Uint8Array(size);
  for (let i = 0; i < size; i++) p[i] = i;
  return p;
}

describe('compositeActor', () => {
  it('writes opaque costume pixels into the framebuffer through the cost palette', () => {
    const framebuffer = new Uint8Array(4 * 4); // all zeros
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 4,
      frame: frame(2, 2, [1, 2, 3, 4]),
      costPalette: new Uint8Array([0, 0x10, 0x20, 0x30, 0x40]),
      actorX: 1,
      actorY: 1,
    });
    // Frame written at (1,1)..(2,2):
    expect(Array.from(framebuffer)).toEqual([
      0,    0,    0,    0,
      0,    0x10, 0x20, 0,
      0,    0x30, 0x40, 0,
      0,    0,    0,    0,
    ]);
  });

  it('skips transparent pixels — they pass through whatever the framebuffer already had', () => {
    const framebuffer = new Uint8Array([
      0xaa, 0xaa, 0xaa, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa,
      0xaa, 0xaa, 0xaa, 0xaa,
    ]);
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 4,
      frame: frame(2, 2, [T, 1, 1, T]),
      costPalette: new Uint8Array([0, 0x55]),
      actorX: 1,
      actorY: 1,
    });
    // (1,1) and (2,2) stay as 0xaa (transparent in costume); (1,2) and (2,1) become 0x55.
    expect(framebuffer[1 * 4 + 1]).toBe(0xaa);
    expect(framebuffer[1 * 4 + 2]).toBe(0x55);
    expect(framebuffer[2 * 4 + 1]).toBe(0x55);
    expect(framebuffer[2 * 4 + 2]).toBe(0xaa);
  });

  it('honours redirX and redirY: actor anchor is at (actorX, actorY), frame top-left is (actorX+redirX, actorY+redirY)', () => {
    const framebuffer = new Uint8Array(5 * 5);
    // 1x1 frame with the pixel placed 2 left and 1 above the anchor.
    compositeActor({
      framebuffer,
      fbWidth: 5,
      fbHeight: 5,
      frame: frame(1, 1, [1], -2, -1),
      costPalette: new Uint8Array([0, 0x99]),
      actorX: 3,
      actorY: 3,
    });
    // Pixel lands at (3 + -2, 3 + -1) = (1, 2)
    expect(framebuffer[2 * 5 + 1]).toBe(0x99);
  });

  it('clips at framebuffer edges (top-left)', () => {
    const framebuffer = new Uint8Array(3 * 3);
    // 3×3 frame centered around the actor — but actor is at (0,0), so
    // only the bottom-right 2×2 of the frame should land on screen.
    compositeActor({
      framebuffer,
      fbWidth: 3,
      fbHeight: 3,
      frame: frame(3, 3, [
        1, 2, 3,
        4, 5, 6,
        7, 8, 9,
      ], -1, -1),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
    });
    // Frame top-left = (-1, -1). Visible portion: frame pixels (1,1)..(2,2)
    // mapped to framebuffer (0,0)..(1,1).
    expect(Array.from(framebuffer)).toEqual([
      5, 6, 0,
      8, 9, 0,
      0, 0, 0,
    ]);
  });

  it('clips at framebuffer edges (bottom-right)', () => {
    const framebuffer = new Uint8Array(3 * 3);
    compositeActor({
      framebuffer,
      fbWidth: 3,
      fbHeight: 3,
      frame: frame(3, 3, [
        1, 2, 3,
        4, 5, 6,
        7, 8, 9,
      ]),
      costPalette: identityPalette(16),
      actorX: 2,
      actorY: 2,
    });
    // Frame top-left = (2, 2). Only frame pixel (0,0) lands on-screen at (2,2).
    expect(framebuffer[2 * 3 + 2]).toBe(1);
    // Surrounding pixels untouched.
    for (let i = 0; i < 8; i++) expect(framebuffer[i]).toBe(0);
  });

  it('hides pixels when a z-plane with index > actorZ has its bit set', () => {
    const framebuffer = new Uint8Array(4 * 1).fill(0x77);
    // ZP01: column 2 occludes.
    const zp01 = plane(4, 1, [0, 0, 1, 0]);
    // Frame: 4 opaque pixels in a row.
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 1,
      frame: frame(4, 1, [1, 2, 3, 4]),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
      actorZ: 0,
      zPlanes: [zp01],
    });
    // Column 2 was occluded → 0x77 preserved. Others written.
    expect(Array.from(framebuffer)).toEqual([1, 2, 0x77, 4]);
  });

  it('does not occlude when actorZ >= plane index', () => {
    const framebuffer = new Uint8Array(4 * 1).fill(0x77);
    const zp01 = plane(4, 1, [0, 0, 1, 0]); // index 1
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 1,
      frame: frame(4, 1, [1, 2, 3, 4]),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
      actorZ: 1, // not strictly less than plane index 1 → not occluded
      zPlanes: [zp01],
    });
    expect(Array.from(framebuffer)).toEqual([1, 2, 3, 4]);
  });

  it('checks every plane with index > actorZ — multiple planes', () => {
    const framebuffer = new Uint8Array(4 * 1).fill(0x77);
    const zp01 = plane(4, 1, [1, 0, 0, 0]); // index 1 — occludes col 0
    const zp02 = plane(4, 1, [0, 0, 0, 1]); // index 2 — occludes col 3
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 1,
      frame: frame(4, 1, [1, 2, 3, 4]),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
      actorZ: 1, // hidden by ZP02 only (index 2 > 1)
      zPlanes: [zp01, zp02],
    });
    // Col 0 not occluded (ZP01 index 1 not > actorZ 1).
    // Col 3 occluded by ZP02 (index 2 > 1).
    expect(Array.from(framebuffer)).toEqual([1, 2, 3, 0x77]);
  });

  it('throws if a z-plane size mismatches the framebuffer', () => {
    expect(() =>
      compositeActor({
        framebuffer: new Uint8Array(4),
        fbWidth: 4,
        fbHeight: 1,
        frame: frame(1, 1, [1]),
        costPalette: identityPalette(2),
        actorX: 0,
        actorY: 0,
        zPlanes: [plane(8, 1, new Array(8).fill(0))],
      }),
    ).toThrow(/z-plane size/);
  });

  it('throws if framebuffer length is inconsistent with declared dimensions', () => {
    expect(() =>
      compositeActor({
        framebuffer: new Uint8Array(7),
        fbWidth: 4,
        fbHeight: 2,
        frame: frame(1, 1, [1]),
        costPalette: identityPalette(2),
        actorX: 0,
        actorY: 0,
      }),
    ).toThrow(/framebuffer length/);
  });
});
