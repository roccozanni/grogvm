/**
 * SMAP — strip-encoded room background bitmap (SCUMM v5).
 * Format reference (including the corrections to circulating notes):
 * pages/docs/scumm/smap.md.
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
 * Each strip's compression-code byte without running the decoder (for the
 * diagnostic UI); -1 for a strip whose offset lands outside the payload.
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
    // Stored offsets are header-INCLUSIVE (relative to the block start, not
    // the payload), so subtract 8 — pages/docs/scumm/smap.md §3.
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

  // Dispatch table: pages/docs/scumm/smap.md §6.
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
    // Subtract 0x50, NOT the 0x51 in circulating notes — paletteBits must be
    // 4..8 like every other Method 2 range. See pages/docs/scumm/smap.md §6.
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

/** Code 0x01: 8 × roomHeight raw palette indices, row-major within the strip. */
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
 * LSB-first bit reader: bit 0 of each byte is read first, and `readBits`
 * assembles the integer LSB-first (pages/docs/scumm/smap.md §5). Applies
 * to Method 2's 3-bit selector and RLE count too.
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
 * Method 1 palette walk — bit grammar in pages/docs/scumm/smap.md §8.
 * No RLE branch: solid regions are runs of `0` bits, one per pixel.
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
 * Method 2 palette walk + RLE — bit grammar in pages/docs/scumm/smap.md §9.
 * The delta sign is INVERTED from circulating notes: real game data decodes
 * as `color -= (4 - d)` (d=0 decreases by 4), verified on MI1/MI2 strips.
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
      // RLE emits `reps` ADDITIONAL pixels — the next iteration's auto-write
      // supplies one more, so the op contributes 1 + reps in total.
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
