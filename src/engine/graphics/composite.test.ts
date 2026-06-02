import { describe, it, expect } from 'vitest';
import { compositeActor, actorFramePlacement } from './composite';
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

describe('compositeActor — mirror', () => {
  it('reflects the frame horizontally about the anchor X when mirror=true', () => {
    // 3×1 frame: pixels [1, 2, 3] at redirX=0, anchor (0,0) in a 6×1 fb.
    // Unmirrored it occupies cols 0,1,2 as [1,2,3]; mirrored about X=0 it
    // occupies cols -3..-1 (off-screen left), so nudge the anchor right.
    const fb = new Uint8Array(6);
    compositeActor({
      framebuffer: fb, fbWidth: 6, fbHeight: 1,
      frame: frame(3, 1, [1, 2, 3], 0, 0),
      costPalette: identityPalette(8), actorX: 3, actorY: 0, mirror: true,
    });
    // Unmirrored at anchor 3 would be cols 3,4,5 = [1,2,3]. Mirrored about
    // X=3 reflects to cols 0,1,2, reversed → [3,2,1].
    expect(Array.from(fb)).toEqual([3, 2, 1, 0, 0, 0]);
  });

  it('is identity (left-right) compared to the unmirrored draw', () => {
    const mk = (mirror: boolean) => {
      const fb = new Uint8Array(6);
      compositeActor({
        framebuffer: fb, fbWidth: 6, fbHeight: 1,
        frame: frame(3, 1, [1, 2, 3], 0, 0),
        costPalette: identityPalette(8), actorX: 0, actorY: 0, mirror,
      });
      return Array.from(fb);
    };
    expect(mk(false)).toEqual([1, 2, 3, 0, 0, 0]); // cols 0,1,2
    // Mirrored about X=0 → cols -3..-1 off-screen, nothing drawn.
    expect(mk(true)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('compositeActor — scale', () => {
  it('scale 255 is identical to an un-scaled draw', () => {
    const draw = (scale?: number) => {
      const fb = new Uint8Array(16);
      compositeActor({
        framebuffer: fb, fbWidth: 4, fbHeight: 4,
        frame: frame(2, 2, [1, 2, 3, 4], 0, 0),
        costPalette: identityPalette(8), actorX: 0, actorY: 0, scale,
      });
      return Array.from(fb);
    };
    expect(draw(255)).toEqual(draw(undefined)); // explicit 255 == default
    expect(draw(255)).toEqual([1, 2, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('halves a frame at scale ~128 (nearest-neighbour)', () => {
    // 4×2 frame → round(4*128/255)=2 wide, round(2*128/255)=1 tall.
    const fb = new Uint8Array(16); // 8×2
    compositeActor({
      framebuffer: fb, fbWidth: 8, fbHeight: 2,
      frame: frame(4, 2, [1, 1, 1, 1, 1, 1, 1, 1], 0, 0),
      costPalette: identityPalette(8), actorX: 0, actorY: 0, scale: 128,
    });
    // 2×1 block at the anchor; rest untouched.
    expect(Array.from(fb)).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps the feet anchored — the sprite shrinks upward toward (actorX, actorY)', () => {
    // redirY = -2: the 2-tall frame sits with its bottom at the anchor row.
    // At full scale it occupies rows 2..3 (anchor y=4 → feet just below).
    const full = new Uint8Array(20); // 4×5
    compositeActor({
      framebuffer: full, fbWidth: 4, fbHeight: 5,
      frame: frame(1, 2, [1, 1], 0, -2),
      costPalette: identityPalette(8), actorX: 0, actorY: 4, scale: 255,
    });
    expect([full[8], full[12]]).toEqual([1, 1]); // rows 2 and 3 (y*4 + 0)

    // At scale 128 the 1-tall scaled sprite lands at row 3 (bottom stays put),
    // NOT row 2 — it shrank toward the feet, not the top.
    const half = new Uint8Array(20);
    compositeActor({
      framebuffer: half, fbWidth: 4, fbHeight: 5,
      frame: frame(1, 2, [1, 1], 0, -2),
      costPalette: identityPalette(8), actorX: 0, actorY: 4, scale: 128,
    });
    expect(half[12]).toBe(1); // row 3
    expect(half[8]).toBe(0); // row 2 empty
  });

  it('draws nothing at scale 0', () => {
    const fb = new Uint8Array(16);
    compositeActor({
      framebuffer: fb, fbWidth: 4, fbHeight: 4,
      frame: frame(2, 2, [1, 2, 3, 4], 0, 0),
      costPalette: identityPalette(8), actorX: 0, actorY: 0, scale: 0,
    });
    expect(Array.from(fb)).toEqual(new Array(16).fill(0));
  });
});

describe('actorFramePlacement', () => {
  it('is the native extent at scale 255', () => {
    const f = frame(10, 20, new Array(200).fill(1), -5, -18);
    expect(actorFramePlacement(f, 100, 50, false, 255)).toEqual({
      left: 95, top: 32, width: 10, height: 20,
    });
  });

  it('shrinks toward the feet anchor at half scale', () => {
    const f = frame(10, 20, new Array(200).fill(1), -5, -20); // feet at anchor
    const p = actorFramePlacement(f, 100, 50, false, 128);
    // width/height ~halve; bottom (top+height) stays at the feet row (~50).
    expect(p.width).toBe(5);
    expect(p.height).toBe(10);
    expect(p.top + p.height).toBe(50); // feet anchored
  });
});

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

  it('hides pixels where the actor clip plane has its bit set', () => {
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
      clipPlane: 1, // masked by ZP01
      zPlanes: [zp01],
    });
    // Column 2 was occluded → 0x77 preserved. Others written.
    expect(Array.from(framebuffer)).toEqual([1, 2, 0x77, 4]);
  });

  it('does not occlude when clipPlane is 0 (in front of every plane)', () => {
    const framebuffer = new Uint8Array(4 * 1).fill(0x77);
    const zp01 = plane(4, 1, [0, 0, 1, 0]);
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 1,
      frame: frame(4, 1, [1, 2, 3, 4]),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
      clipPlane: 0, // in front → no masking
      zPlanes: [zp01],
    });
    expect(Array.from(framebuffer)).toEqual([1, 2, 3, 4]);
  });

  it('masks by EXACTLY the clip plane, not a cumulative stack', () => {
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
      clipPlane: 2, // masked by ZP02 ALONE
      zPlanes: [zp01, zp02],
    });
    // Col 0 NOT occluded (ZP01 is not this actor's clip plane).
    // Col 3 occluded by ZP02 (the clip plane).
    expect(Array.from(framebuffer)).toEqual([1, 2, 3, 0x77]);
  });

  it('clipPlane 1 ignores a higher plane even when it is a superset (MI1 room 30)', () => {
    // Room 30: ZP02 ⊇ ZP01 (ZP01 = foreground barrels, ZP02 adds the
    // loft railing/stairs). A floor actor at clipPlane 1 must be masked
    // by ZP01 ALONE and stay in front of the ZP02-only stairs. The old
    // cumulative "any plane > actorZ" rule wrongly hid col 3 too.
    const framebuffer = new Uint8Array(4 * 1).fill(0x77);
    const zp01 = plane(4, 1, [1, 0, 0, 0]); // barrels
    const zp02 = plane(4, 1, [1, 0, 0, 1]); // superset: barrels + stairs (col 3)
    compositeActor({
      framebuffer,
      fbWidth: 4,
      fbHeight: 1,
      frame: frame(4, 1, [1, 2, 3, 4]),
      costPalette: identityPalette(16),
      actorX: 0,
      actorY: 0,
      clipPlane: 1, // floor actor → ZP01 only
      zPlanes: [zp01, zp02],
    });
    // Col 0 occluded by ZP01 (barrels). Col 3 (ZP02-only stairs) stays drawn.
    expect(Array.from(framebuffer)).toEqual([0x77, 2, 3, 4]);
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
