/**
 * SMAP — strip-encoded room background bitmap (SCUMM v5).
 *
 * Payload layout:
 *
 *   ┌──────────────────────────────┬──────────────────┐
 *   │ stripCount × uint32 LE offset│ strip bodies     │
 *   └──────────────────────────────┴──────────────────┘
 *
 * Strips are 8 pixels wide and `roomHeight` pixels tall. Each strip has
 * its own compression code and bit stream and decodes independently. The
 * offset table entries are relative to the SMAP **block** start (header
 * inclusive), not the payload; see `readStripOffsets`.
 *
 * Full format reference (with the gotchas and corrections that took us
 * a while to figure out): pages/docs/scumm/smap.md.
 */

export function decodeSmap(
  payload: Uint8Array,
  roomWidth: number,
  roomHeight: number,
): Uint8Array {
  if (roomWidth % 8 !== 0) {
    throw new Error(`SMAP room width must be a multiple of 8 (got ${roomWidth})`);
  }
  const stripCount = roomWidth / 8;
  if (payload.length < stripCount * 4) {
    throw new Error(
      `SMAP payload too short for ${stripCount} strip offsets (${payload.length} bytes)`,
    );
  }

  const offsets = readStripOffsets(payload, stripCount);
  const out = new Uint8Array(roomWidth * roomHeight);

  for (let s = 0; s < stripCount; s++) {
    const start = offsets[s]!;
    const end = s + 1 < stripCount ? offsets[s + 1]! : payload.length;
    decodeStrip(payload.subarray(start, end), s, roomWidth, roomHeight, out);
  }

  return out;
}

/**
 * Read each strip's encoding code byte without running the decoder.
 * Used by the player's diagnostic UI to show which compression method
 * each strip uses. Returns the code, or -1 for any strip whose offset
 * lands outside the payload (malformed file).
 */
export function getSmapStripMethods(payload: Uint8Array, roomWidth: number): number[] {
  if (roomWidth % 8 !== 0) {
    throw new Error(`SMAP room width must be a multiple of 8 (got ${roomWidth})`);
  }
  const stripCount = roomWidth / 8;
  if (payload.length < stripCount * 4) {
    throw new Error(
      `SMAP payload too short for ${stripCount} strip offsets (${payload.length} bytes)`,
    );
  }
  const offsets = readStripOffsets(payload, stripCount);
  const methods: number[] = [];
  for (let s = 0; s < stripCount; s++) {
    const offset = offsets[s]!;
    methods.push(offset >= 0 && offset < payload.length ? payload[offset]! : -1);
  }
  return methods;
}

function readStripOffsets(payload: Uint8Array, stripCount: number): number[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const offsets: number[] = new Array<number>(stripCount);
  for (let i = 0; i < stripCount; i++) {
    // SCUMM v5 SMAP offsets are stored relative to the **start of the
    // SMAP block** (header inclusive). We're handed the post-header
    // payload, so subtract 8 to convert to payload-relative.
    const raw = view.getUint32(i * 4, true);
    if (raw < 8) {
      throw new Error(
        `SMAP strip ${i} offset ${raw} < 8 (expected to include the 8-byte block header)`,
      );
    }
    offsets[i] = raw - 8;
  }
  return offsets;
}

function decodeStrip(
  data: Uint8Array,
  stripIndex: number,
  roomWidth: number,
  roomHeight: number,
  out: Uint8Array,
): void {
  if (data.length === 0) {
    throw new SmapError(stripIndex, 0, `strip body is empty`);
  }
  const code = data[0]!;

  // SCUMM v5 SMAP method dispatch:
  //
  //   0x01           uncompressed · horizontal
  //   0x0E..0x12     method 1 · vertical   · opaque       paletteBits = code − 0x0A
  //   0x18..0x1C     method 1 · horizontal · opaque       paletteBits = code − 0x14
  //   0x22..0x26     method 1 · vertical   · transparent  paletteBits = code − 0x1E
  //   0x2C..0x30     method 1 · horizontal · transparent  paletteBits = code − 0x28
  //   0x40..0x44     method 2 · horizontal · opaque       paletteBits = code − 0x3C
  //   0x54..0x58     method 2 · horizontal · transparent  paletteBits = code − 0x50
  //   0x68..0x6C     method 2 · horizontal · transparent  paletteBits = code − 0x64  (alias of 0x54..0x58)
  //   0x7C..0x80     method 2 · horizontal · opaque       paletteBits = code − 0x78  (alias of 0x40..0x44)
  //
  // Method 2 only exists in the horizontal direction. "Transparent" variants
  // decode pixels identically to their opaque counterparts for backgrounds;
  // transparency only matters when compositing over other things.

  if (code === 0x01) {
    decodeUncompressed(data, stripIndex, roomWidth, roomHeight, out);
    return;
  }
  if (code >= 0x0E && code <= 0x12) {
    decodeStripMethod1(data, stripIndex, roomWidth, roomHeight, code - 0x0A, out, 'vertical');
    return;
  }
  if (code >= 0x18 && code <= 0x1C) {
    decodeStripMethod1(data, stripIndex, roomWidth, roomHeight, code - 0x14, out, 'horizontal');
    return;
  }
  if (code >= 0x22 && code <= 0x26) {
    decodeStripMethod1(data, stripIndex, roomWidth, roomHeight, code - 0x1E, out, 'vertical');
    return;
  }
  if (code >= 0x2C && code <= 0x30) {
    decodeStripMethod1(data, stripIndex, roomWidth, roomHeight, code - 0x28, out, 'horizontal');
    return;
  }
  if (code >= 0x40 && code <= 0x44) {
    decodeStripMethod2H(data, stripIndex, roomWidth, roomHeight, code - 0x3C, out);
    return;
  }
  if (code >= 0x54 && code <= 0x58) {
    decodeStripMethod2H(data, stripIndex, roomWidth, roomHeight, code - 0x50, out);
    return;
  }
  if (code >= 0x68 && code <= 0x6C) {
    decodeStripMethod2H(data, stripIndex, roomWidth, roomHeight, code - 0x64, out);
    return;
  }
  if (code >= 0x7C && code <= 0x80) {
    decodeStripMethod2H(data, stripIndex, roomWidth, roomHeight, code - 0x78, out);
    return;
  }

  throw new SmapError(
    stripIndex,
    code,
    `unimplemented SMAP method ${code} (0x${code.toString(16)})`,
  );
}

/** Method 1: 8 × roomHeight raw palette indices, row-major within the strip. */
function decodeUncompressed(
  data: Uint8Array,
  stripIndex: number,
  roomWidth: number,
  roomHeight: number,
  out: Uint8Array,
): void {
  const need = 1 + 8 * roomHeight;
  if (data.length < need) {
    throw new SmapError(
      stripIndex,
      1,
      `uncompressed strip body too short: ${data.length} < ${need}`,
    );
  }
  let src = 1;
  const baseX = stripIndex * 8;
  for (let y = 0; y < roomHeight; y++) {
    const row = y * roomWidth + baseX;
    for (let x = 0; x < 8; x++) {
      out[row + x] = data[src++]!;
    }
  }
}

/**
 * LSB-first bit reader for SMAP strips.
 *
 * Within each byte, bit 0 (LSB) is read first, then bit 1, …, then bit 7.
 * `readBits(n)` assembles the integer LSB-first: the first bit read becomes
 * the integer's bit 0. So 7 bits read in order `0,1,1,1,1,1,1` yield 126
 * (= 0x7E).
 *
 * The same convention applies to Method 2's 3-bit selector and 8-bit RLE
 * count. Some long-circulating notes label Method 2's branches in a way
 * that looks like read order ("100 (4)" etc.); ignore those — the
 * parenthesised integer is the truth, read LSB-first.
 */
class BitReader {
  private byteIdx = 0;
  private bitIdx = 0;
  constructor(private readonly data: Uint8Array) {}

  readBit(): number {
    const byte = this.data[this.byteIdx];
    if (byte === undefined) {
      throw new Error('SMAP bit stream underrun');
    }
    const bit = (byte >> this.bitIdx) & 1;
    this.bitIdx++;
    if (this.bitIdx === 8) {
      this.bitIdx = 0;
      this.byteIdx++;
    }
    return bit;
  }

  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v |= this.readBit() << i;
    }
    return v;
  }
}

/**
 * Method 1 (horizontal or vertical). Bit grammar:
 *
 *   0     keep — draw next pixel with current color
 *   10    read paletteBits → new color; reset `sub` to 1
 *   110   color -= sub
 *   111   sub = -sub; color -= sub
 *
 * `sub` (the "subtraction variable") starts at 1 for each strip and is
 * reset to 1 every time the 10-branch loads a new absolute color. Method 1
 * has no run-length encoding — solid color regions are encoded as runs of
 * `0` bits, one per pixel. See pages/docs/scumm/smap.md for details.
 */
function decodeStripMethod1(
  data: Uint8Array,
  stripIndex: number,
  roomWidth: number,
  roomHeight: number,
  paletteBits: number,
  out: Uint8Array,
  scan: 'horizontal' | 'vertical',
): void {
  if (data.length < 2) {
    throw new SmapError(stripIndex, data[0]!, `strip too short for header (need ≥ 2 bytes)`);
  }
  let color = data[1]!;
  let sub = 1;
  const bits = new BitReader(data.subarray(2));
  const baseX = stripIndex * 8;
  const pixelCount = 8 * roomHeight;
  const writeAt = makeWriteAt(scan, roomWidth, roomHeight, baseX, out);

  let i = 0;
  while (i < pixelCount) {
    writeAt(i, color);
    i++;
    if (i >= pixelCount) break;

    if (bits.readBit() === 0) {
      // 0 → keep
      continue;
    }
    if (bits.readBit() === 0) {
      // 10 → new color
      color = bits.readBits(paletteBits);
      sub = 1;
      continue;
    }
    if (bits.readBit() === 0) {
      // 110 → color -= sub
      color = (color - sub) & 0xff;
    } else {
      // 111 → negate sub, color -= sub
      sub = -sub;
      color = (color - sub) & 0xff;
    }
  }
}

/**
 * Method 2 (horizontal only). Bit grammar:
 *
 *   0     keep — draw next pixel with current color
 *   10    read paletteBits → new color
 *   11    read 3 more bits as LSB-first unsigned `d`:
 *           d == 4 → RLE: read 8 bits as `reps`; emit `reps` additional pixels
 *           else   → color -= (4 - d)
 *                    (d=0 → -4, d=1 → -3, …, d=3 → -1, d=5 → +1, d=6 → +2, d=7 → +3)
 *
 * Sign of the delta is inverted relative to most circulating reverse-
 * engineering notes (which label d=0 as "Increase by 4"). Empirically —
 * verified by decoding real MI1 / MI2 room strips — the encoded data does
 * the opposite: d=0 *decreases* by 4. See pages/docs/scumm/smap.md for the
 * discovery story and worked examples.
 */
function decodeStripMethod2H(
  data: Uint8Array,
  stripIndex: number,
  roomWidth: number,
  roomHeight: number,
  paletteBits: number,
  out: Uint8Array,
): void {
  if (data.length < 2) {
    throw new SmapError(stripIndex, data[0]!, `strip too short for header (need ≥ 2 bytes)`);
  }
  let color = data[1]!;
  const bits = new BitReader(data.subarray(2));
  const baseX = stripIndex * 8;
  const pixelCount = 8 * roomHeight;
  const writeAt = makeWriteAt('horizontal', roomWidth, roomHeight, baseX, out);

  let i = 0;
  while (i < pixelCount) {
    writeAt(i, color);
    i++;
    if (i >= pixelCount) break;

    if (bits.readBit() === 0) {
      // 0 → keep
      continue;
    }
    if (bits.readBit() === 0) {
      // 10 → new color
      color = bits.readBits(paletteBits);
      continue;
    }
    // 11 → 3-bit selector
    const d = bits.readBits(3);
    if (d === 4) {
      // RLE: the auto-write at the top of the next iter accounts for one
      // pixel; this loop emits `reps` additional pixels of the same color.
      const reps = bits.readBits(8);
      for (let r = 0; r < reps && i < pixelCount; r++) {
        writeAt(i, color);
        i++;
      }
    } else {
      color = (color - (4 - d)) & 0xff;
    }
  }
}

function makeWriteAt(
  scan: 'horizontal' | 'vertical',
  roomWidth: number,
  roomHeight: number,
  baseX: number,
  out: Uint8Array,
): (i: number, value: number) => void {
  if (scan === 'horizontal') {
    return (i, value) => {
      const row = (i / 8) | 0;
      const col = i % 8;
      out[row * roomWidth + baseX + col] = value;
    };
  }
  return (i, value) => {
    const col = (i / roomHeight) | 0;
    const row = i % roomHeight;
    out[row * roomWidth + baseX + col] = value;
  };
}

export class SmapError extends Error {
  constructor(
    public readonly stripIndex: number,
    public readonly methodCode: number,
    detail: string,
  ) {
    super(`SMAP strip ${stripIndex}: ${detail}`);
    this.name = 'SmapError';
  }
}
