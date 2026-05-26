import { describe, it, expect } from 'vitest';
import { decodeSmap, getSmapStripMethods, SmapError } from './smap';

function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Build an SMAP payload with `stripCount` strips, each strip a single
 * uncompressed (code 1) body that fills its 8×height column with the
 * given palette indices (`bodyFor(stripIndex)` returns the 8×height bytes
 * in row-major order).
 *
 * Real SCUMM v5 SMAP strip offsets are relative to the **start of the
 * SMAP block** (header inclusive). Synthetic test data follows the
 * same convention: payload-offset + 8.
 */
function buildSmap(stripCount: number, height: number, bodyFor: (i: number) => number[]): Uint8Array {
  const tableSize = stripCount * 4;
  const stripBodies: Uint8Array[] = [];
  for (let i = 0; i < stripCount; i++) {
    const body = bodyFor(i);
    if (body.length !== 8 * height) {
      throw new Error(`bodyFor(${i}) returned ${body.length} bytes, expected ${8 * height}`);
    }
    stripBodies.push(new Uint8Array([1, ...body]));
  }
  const offsets: Uint8Array[] = [];
  let cursor = tableSize;
  for (const s of stripBodies) {
    offsets.push(le32(cursor + 8)); // header-inclusive
    cursor += s.length;
  }
  return concat(...offsets, ...stripBodies);
}

describe('decodeSmap (method 1 — uncompressed)', () => {
  it('decodes a single 8×2 strip into the framebuffer', () => {
    const payload = buildSmap(1, 2, () => [
      // row 0
      10, 11, 12, 13, 14, 15, 16, 17,
      // row 1
      20, 21, 22, 23, 24, 25, 26, 27,
    ]);
    const out = decodeSmap(payload, 8, 2);
    expect(Array.from(out.subarray(0, 8))).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(Array.from(out.subarray(8, 16))).toEqual([20, 21, 22, 23, 24, 25, 26, 27]);
  });

  it('places multiple strips side-by-side in the framebuffer', () => {
    // 2 strips × 8 wide = 16 wide, height 1. Strip 0 = 0..7, strip 1 = 100..107.
    const payload = buildSmap(2, 1, (i) =>
      i === 0 ? [0, 1, 2, 3, 4, 5, 6, 7] : [100, 101, 102, 103, 104, 105, 106, 107],
    );
    const out = decodeSmap(payload, 16, 1);
    expect(Array.from(out)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
      100, 101, 102, 103, 104, 105, 106, 107,
    ]);
  });
});

describe('decodeSmap — error paths', () => {
  it('rejects a width not divisible by 8', () => {
    expect(() => decodeSmap(new Uint8Array(20), 17, 1)).toThrow(/multiple of 8/);
  });

  it('rejects a payload shorter than the strip offset table', () => {
    expect(() => decodeSmap(new Uint8Array(3), 16, 1)).toThrow(/too short/);
  });

  it('throws SmapError with the strip index and method code for unknown methods', () => {
    // 1 strip, offset = 12 (= 4-byte table + 8-byte block header)
    const payload = concat(le32(12), new Uint8Array([99, 0, 0, 0]));
    try {
      decodeSmap(payload, 8, 1);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SmapError);
      expect((err as SmapError).stripIndex).toBe(0);
      expect((err as SmapError).methodCode).toBe(99);
      expect((err as Error).message).toMatch(/unimplemented/i);
    }
  });

  it('throws when an uncompressed strip body is shorter than declared room dimensions', () => {
    // 1 strip, offset = 12 (header-inclusive), body = [1] (code only, no pixel data) for height 2
    const payload = concat(le32(12), new Uint8Array([1, 0, 0]));
    expect(() => decodeSmap(payload, 8, 2)).toThrow(/too short/);
  });

  it('rejects a strip offset smaller than 8 (header-inclusive convention)', () => {
    // offset = 4 (table-relative) violates the header-inclusive convention
    const payload = concat(le32(4), new Uint8Array([1, 0]));
    expect(() => decodeSmap(payload, 8, 1)).toThrow(/< 8/);
  });
});

// --------------------------------------------------------------------------
// Method 1 and Method 2 building-block regression tests.
//
// These exercise each branch of the bit grammars in isolation so the
// algorithms can be refactored without silently regressing. Strip bodies
// are constructed via `BitWriter`, which mirrors the decoder's LSB-first
// bit convention.
// --------------------------------------------------------------------------

class BitWriter {
  private bytes: number[] = [];
  private currentByte = 0;
  private bitIdx = 0;

  writeBit(bit: number): void {
    if (bit & 1) this.currentByte |= 1 << this.bitIdx;
    this.bitIdx++;
    if (this.bitIdx === 8) {
      this.bytes.push(this.currentByte);
      this.currentByte = 0;
      this.bitIdx = 0;
    }
  }

  /** LSB-first: bit 0 of `value` is written first. */
  writeBits(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.writeBit((value >> i) & 1);
    }
  }

  toBytes(): Uint8Array {
    const out = [...this.bytes];
    if (this.bitIdx > 0) out.push(this.currentByte);
    return new Uint8Array(out);
  }
}

function makeStripBody(
  code: number,
  initialColor: number,
  build: (w: BitWriter) => void,
): Uint8Array {
  const w = new BitWriter();
  build(w);
  const stream = w.toBytes();
  const out = new Uint8Array(2 + stream.length);
  out[0] = code;
  out[1] = initialColor;
  out.set(stream, 2);
  return out;
}

function singleStripSmap(body: Uint8Array): Uint8Array {
  // 4-byte offset table → strip body. Offset is header-inclusive: 4 (table) + 8 (block header).
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, 4 + 8, true);
  out.set(body, 4);
  return out;
}

describe('Method 1 — horizontal scan (code 0x18..0x1C)', () => {
  it('"0" bit keeps the current color', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      for (let i = 0; i < 7; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('"10" loads a new paletteBits-wide absolute color', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      w.writeBit(1);
      w.writeBit(0);
      w.writeBits(0x55, 8);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55]);
  });

  it('"110" subtracts the running `sub` (which starts at 1) from the color', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      w.writeBit(1);
      w.writeBit(1);
      w.writeBit(0);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9]);
  });

  it('"111" negates `sub`, then subtracts (net effect: walks the other way)', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      w.writeBit(1);
      w.writeBit(1);
      w.writeBit(1);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    // sub flips to -1, color -= -1 = color + 1
    expect(Array.from(out)).toEqual([0xaa, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab]);
  });

  it('`sub` persists across consecutive "110" ops so gradients accumulate', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      // Three 110s in a row → color -= 1 each time.
      for (let i = 0; i < 3; i++) {
        w.writeBit(1);
        w.writeBit(1);
        w.writeBit(0);
      }
      for (let i = 0; i < 4; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xa9, 0xa8, 0xa7, 0xa7, 0xa7, 0xa7, 0xa7]);
  });

  it('"111" then "110" continues in the new direction (sub stays inverted)', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      // 111 → sub=-1, color=0xab
      w.writeBit(1); w.writeBit(1); w.writeBit(1);
      // 110 with sub=-1 → color += 1 = 0xac
      w.writeBit(1); w.writeBit(1); w.writeBit(0);
      // 110 → 0xad
      w.writeBit(1); w.writeBit(1); w.writeBit(0);
      for (let i = 0; i < 4; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xab, 0xac, 0xad, 0xad, 0xad, 0xad, 0xad]);
  });

  it('"10" resets `sub` to 1 even after a previous "111" had flipped it', () => {
    const strip = makeStripBody(0x1c, 0xaa, (w) => {
      // 111 → sub=-1
      w.writeBit(1); w.writeBit(1); w.writeBit(1);
      // 10 → new color 0x80, sub reset to 1
      w.writeBit(1); w.writeBit(0);
      w.writeBits(0x80, 8);
      // 110 → sub=1 means color -= 1 = 0x7F
      w.writeBit(1); w.writeBit(1); w.writeBit(0);
      for (let i = 0; i < 4; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xab, 0x80, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f]);
  });
});

describe('Method 1 — vertical scan (code 0x0E..0x12)', () => {
  it('emits pixels column-by-column within the 8-wide strip', () => {
    // Strip 8×2. After 14 keeps we trigger a 110, which should affect the
    // very last decoded pixel (i=15). In vertical scan, i=15 maps to
    // (col=7, row=1), i.e. the bottom-right corner of the strip.
    const strip = makeStripBody(0x12, 0xaa, (w) => {
      for (let i = 0; i < 14; i++) w.writeBit(0);
      w.writeBit(1); w.writeBit(1); w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 2);
    expect(Array.from(out)).toEqual([
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, // row 0
      0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xa9, // row 1 (bottom-right has the delta)
    ]);
  });

  it('paletteBits scales with the code: 0x0E → 4, 0x12 → 8', () => {
    // For pb=4, "10" reads 4 bits. Encode the new color in just 4 bits.
    const strip = makeStripBody(0x0e, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(0);
      w.writeBits(0xb, 4); // 4-bit new color = 0xB
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b]);
  });
});

describe('Method 1 — transparent variants decode pixels identically to opaque', () => {
  it('0x26 (V transparent pb=8) matches 0x12 (V opaque pb=8) for the same bit stream', () => {
    const buildOps = (w: BitWriter): void => {
      w.writeBit(1); w.writeBit(0); w.writeBits(0x33, 8);
      for (let i = 0; i < 14; i++) w.writeBit(0);
    };
    const opaque = decodeSmap(singleStripSmap(makeStripBody(0x12, 0xaa, buildOps)), 8, 2);
    const transp = decodeSmap(singleStripSmap(makeStripBody(0x26, 0xaa, buildOps)), 8, 2);
    expect(Array.from(transp)).toEqual(Array.from(opaque));
  });

  it('0x30 (H transparent pb=8) matches 0x1C (H opaque pb=8) for the same bit stream', () => {
    const buildOps = (w: BitWriter): void => {
      w.writeBit(1); w.writeBit(1); w.writeBit(0); // 110
      for (let i = 0; i < 6; i++) w.writeBit(0);
    };
    const opaque = decodeSmap(singleStripSmap(makeStripBody(0x1c, 0xaa, buildOps)), 8, 1);
    const transp = decodeSmap(singleStripSmap(makeStripBody(0x30, 0xaa, buildOps)), 8, 1);
    expect(Array.from(transp)).toEqual(Array.from(opaque));
  });
});

describe('Method 2 — horizontal scan (code 0x40..0x44)', () => {
  it('"0" bit keeps the current color', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      for (let i = 0; i < 7; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('"10" loads a new paletteBits-wide absolute color', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(0); w.writeBits(0x99, 8);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99]);
  });

  it('"11 + d=0" decreases color by 4', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(1); w.writeBits(0, 3); // d=0
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6]);
  });

  it('"11 + d=3" decreases color by 1', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(1); w.writeBits(3, 3); // d=3
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9, 0xa9]);
  });

  it('"11 + d=5" increases color by 1', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(1); w.writeBits(5, 3); // d=5
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab, 0xab]);
  });

  it('"11 + d=7" increases color by 3', () => {
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(1); w.writeBits(7, 3); // d=7
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xad, 0xad, 0xad, 0xad, 0xad, 0xad, 0xad]);
  });

  it('"11 + d=4" is RLE — emits `reps` additional pixels of current color', () => {
    // pixelCount = 8. Auto-write pixel 0, then 7 more ops worth of pixels.
    // Op 1: keep → pixel 1 = 0xAA.
    // Op 2: RLE reps=5 → auto-write pixel 2 + 5 inner writes (pixels 3-7) = 6 pixels of 0xAA.
    // Total: 1 + 1 + 6 = 8 pixels of 0xAA.
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(0); // keep
      w.writeBit(1); w.writeBit(1); w.writeBits(4, 3); // d=4 (RLE)
      w.writeBits(5, 8); // reps=5
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('RLE stops at the strip boundary instead of overrunning', () => {
    // pixelCount = 4 (height=0.5? no, height must be int; use a single row).
    // Use a 1-strip × 1-row strip: pixelCount = 8.
    // Op 1: RLE reps=255. With 1 auto-write at iter start + 255 RLE writes = 256 attempts.
    // pixelCount=8 caps it. We expect 8 pixels of color, then loop exits.
    const strip = makeStripBody(0x44, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(1); w.writeBits(4, 3); // d=4
      w.writeBits(255, 8); // reps=255
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });
});

describe('Method 2 — transparent variants and code aliases', () => {
  it('0x58 (transparent pb=8) decodes the same pixel values as 0x44 (opaque pb=8)', () => {
    const buildOps = (w: BitWriter): void => {
      w.writeBit(1); w.writeBit(1); w.writeBits(0, 3); // d=0 → -4
      for (let i = 0; i < 6; i++) w.writeBit(0);
    };
    const opaque = decodeSmap(singleStripSmap(makeStripBody(0x44, 0xaa, buildOps)), 8, 1);
    const transp = decodeSmap(singleStripSmap(makeStripBody(0x58, 0xaa, buildOps)), 8, 1);
    expect(Array.from(transp)).toEqual(Array.from(opaque));
  });

  it('0x80 (alias of 0x44) uses paletteBits 8', () => {
    // If pb were anything other than 8 the readBits(pb) call would consume the wrong
    // number of bits and the trailing keep ops would underrun or misalign.
    const strip = makeStripBody(0x80, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(0); w.writeBits(0x55, 8);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55]);
  });

  it('0x6C (alias of 0x58) uses paletteBits 8', () => {
    const strip = makeStripBody(0x6c, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(0); w.writeBits(0x77, 8);
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77]);
  });

  it('0x54 with the (corrected) 0x50 subtract → paletteBits = 4', () => {
    // If we were still using the 0x51 subtract, this would compute pb=3 and the
    // readBits(pb) call would read 3 bits instead of 4 — the trailing keeps would
    // misalign and we'd get a different last-pixel color.
    const strip = makeStripBody(0x54, 0xaa, (w) => {
      w.writeBit(1); w.writeBit(0); w.writeBits(0x0b, 4); // 4-bit new color
      for (let i = 0; i < 6; i++) w.writeBit(0);
    });
    const out = decodeSmap(singleStripSmap(strip), 8, 1);
    expect(Array.from(out)).toEqual([0xaa, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b]);
  });
});

describe('getSmapStripMethods', () => {
  it('returns the method code at the start of each strip', () => {
    // 2 strips. Header-inclusive offsets: 8 (table size) + 8 (block header).
    // strip 0 body = [0x11, 0x05]  → method code 0x11
    // strip 1 body = [0x18, 0x06]  → method code 0x18
    const payload = concat(
      le32(8 + 8),
      le32(8 + 8 + 2),
      new Uint8Array([0x11, 0x05, 0x18, 0x06]),
    );
    expect(getSmapStripMethods(payload, 16)).toEqual([0x11, 0x18]);
  });

  it('rejects a width not divisible by 8', () => {
    expect(() => getSmapStripMethods(new Uint8Array(20), 17)).toThrow(/multiple of 8/);
  });
});
