/**
 * Playback-duration readers for the two SOUN formats whose length lives
 * inside MONKEY.001: digitized PCM (`SBL`) and standard MIDI (`ROL`/`ADL`/
 * `SPK`). Both return a length in jiffies (1/60 s) — what the silent timing
 * backend counts down so `isSoundRunning` reports truthfully for a sound's
 * real span. CD-trigger sounds (durations in separate `TrackN.fla` files) are
 * timed by {@link flacDurationJiffies}, also here.
 *
 * Block sizing in SOUN is mixed and both conventions are exercised here:
 *   - SCUMM containers (`SOUN`/`SOU `/`SBL `/`ROL `/`ADL `/`SPK `) carry a
 *     big-endian size that INCLUDES the 8-byte tag+size header.
 *   - The inner audio/MIDI chunks (`AUhd`/`AUdt`/`MDhd`/`MThd`/`MTrk`) carry
 *     a big-endian size of the payload ONLY (standard MIDI / Creative-AU
 *     convention).
 * Verified against MI1 sounds #28 (SBL) and #50 (MIDI).
 */

const JIFFY_HZ = 60;
const secToJiffies = (sec: number): number => Math.round(sec * JIFFY_HZ);

/**
 * Duration (jiffies) of a FLAC stream, read from its STREAMINFO metadata
 * block — `totalSamples / sampleRate`. Only the header is needed (the first
 * ~42 bytes), so callers pass a partial read of the file rather than the
 * whole thing. Returns 0 for a non-FLAC / truncated header so a missing CD
 * track can't hang a wait.
 *
 * MI1 (CD-DOS-VGA) ships its redbook music as `TrackN.fla` (real FLAC); the
 * 24-byte CD-trigger sounds name a track whose length lives only in these
 * files (see `parseSound`).
 */
export function flacDurationJiffies(header: Uint8Array): number {
  if (header.length < 26) return 0;
  if (tag(header, 0) !== 'fLaC') return 0;
  // metadata block header at byte 4 (1 flag/type byte + 3 length); the first
  // block is STREAMINFO. Its packed sample-rate/sample-count field starts at
  // byte 18 (after min/max block size + min/max frame size).
  const p = 18;
  const sampleRate = (header[p]! << 12) | (header[p + 1]! << 4) | (header[p + 2]! >> 4);
  if (sampleRate === 0) return 0;
  // 36-bit total samples: low nibble of header[p+3] then header[p+4..p+7].
  const totalSamples =
    (header[p + 3]! & 0xf) * 2 ** 32 +
    header[p + 4]! * 2 ** 24 +
    (header[p + 5]! << 16) +
    (header[p + 6]! << 8) +
    header[p + 7]!;
  return secToJiffies(totalSamples / sampleRate);
}

// MPEG audio frame fields. Sample rates and samples-per-frame depend on the
// MPEG version + layer in the 4-byte frame header.
const MP3_SAMPLE_RATES: Record<number, readonly [number, number, number]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};
// MPEG1 / MPEG2 Layer III bitrates (kbps), indexed by the 4-bit bitrate field.
const MP3_BITRATES_L3_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_L3_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * Duration (jiffies) of an MP3 stream from its header. The accurate path is
 * the Xing/Info tag in the first frame, whose frame count gives
 * `frames × samplesPerFrame / sampleRate` for both VBR and CBR (the EN MI1
 * `TrackN.mp3` rips carry an `Info` tag). Falls back to a CBR estimate
 * (`audioBytes × 8 / bitrate`, needing `fileSize`) when no Xing/Info is
 * present. Returns 0 if no frame header is found within `data` (e.g. a large
 * ID3v2 tag pushed the first frame past the partial read) — non-gating, safe.
 */
export function mp3DurationJiffies(data: Uint8Array, fileSize: number): number {
  // Skip an ID3v2 tag (syncsafe size at bytes 6..9) to reach the audio.
  let off = 0;
  if (data.length >= 10 && tag(data, 0) === 'ID3') {
    off = 10 + (((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) | ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f));
  }
  // Find the first frame sync (11 set bits: 0xFF followed by 0b111x_xxxx).
  let i = off;
  while (i + 4 <= data.length && !(data[i] === 0xff && (data[i + 1]! & 0xe0) === 0xe0)) i++;
  if (i + 4 > data.length) return 0;

  const verBits = (data[i + 1]! >> 3) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (data[i + 1]! >> 1) & 0x3; // 1=LIII, 2=LII, 3=LI
  const brIndex = (data[i + 2]! >> 4) & 0xf;
  const srIndex = (data[i + 2]! >> 2) & 0x3;
  const rates = MP3_SAMPLE_RATES[verBits];
  if (!rates || layerBits === 0 || srIndex === 3 || brIndex === 0 || brIndex === 15) return 0;
  const sampleRate = rates[srIndex]!;
  const mpeg1 = verBits === 3;
  const samplesPerFrame = layerBits === 3 ? 384 : layerBits === 2 ? 1152 : mpeg1 ? 1152 : 576;

  // Xing (VBR) / Info (CBR) tag carries the total frame count — exact for both.
  for (let j = i + 4; j < Math.min(data.length - 8, i + 200); j++) {
    const t = tag(data, j);
    if (t === 'Xing' || t === 'Info') {
      const flags = be32(data, j + 4);
      if (flags & 0x1) {
        const frames = be32(data, j + 8);
        if (frames > 0) return secToJiffies((frames * samplesPerFrame) / sampleRate);
      }
      break;
    }
  }

  // CBR fallback (Layer III only): audio bytes ÷ bitrate. Needs the file size.
  if (layerBits !== 1 || !fileSize) return 0;
  const kbps = (mpeg1 ? MP3_BITRATES_L3_MPEG1 : MP3_BITRATES_L3_MPEG2)[brIndex]!;
  if (!kbps) return 0;
  return secToJiffies((fileSize - i) / ((kbps * 1000) / 8));
}

/**
 * Duration (jiffies) of a CD-audio track file from its header, dispatching on
 * content: FLAC (`fLaC` magic) → {@link flacDurationJiffies}, otherwise MP3
 * → {@link mp3DurationJiffies}. `fileSize` is only used for the MP3 CBR
 * fallback. Returns 0 for anything unrecognized (non-gating).
 */
export function audioDurationJiffies(header: Uint8Array, fileSize: number): number {
  if (header.length >= 4 && tag(header, 0) === 'fLaC') return flacDurationJiffies(header);
  return mp3DurationJiffies(header, fileSize);
}

const tag = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const be32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Locate the first payload-sized inner chunk with `wantTag` in `[start, end)`,
 * walking the EXCLUSIVE-size convention. Returns its payload range or null.
 */
function findChunk(
  b: Uint8Array,
  start: number,
  end: number,
  wantTag: string,
): { start: number; end: number } | null {
  let p = start;
  while (p + 8 <= end) {
    const t = tag(b, p);
    const size = be32(b, p + 4);
    const payloadStart = p + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > end) return null;
    if (t === wantTag) return { start: payloadStart, end: payloadEnd };
    p = payloadEnd;
  }
  return null;
}

/**
 * Duration of a digitized `SBL` block. Its `AUdt` chunk wraps a Creative
 * Voice (VOC) block-1: type byte, 24-bit LE length, a time-constant, a
 * codec byte, then 8-bit unsigned PCM. The sample rate is read straight
 * from the time-constant (`1e6 / (256 - tc)`) — it is per-sound, not a
 * fixed assumption. (MI1's AUhd payload is a constant `00 00 80` whose
 * meaning we don't rely on.)
 */
export function sblDurationJiffies(sblPayload: Uint8Array): number {
  const audt = findChunk(sblPayload, 0, sblPayload.length, 'AUdt');
  if (!audt) return 0;
  const v = sblPayload;
  const o = audt.start;
  const blockType = v[o]!;
  if (blockType !== 0x01) return 0; // only block-1 (sound data) seen in MI1
  const vocLen = v[o + 1]! | (v[o + 2]! << 8) | (v[o + 3]! << 16); // 24-bit LE
  const timeConstant = v[o + 4]!;
  const sampleRate = 1_000_000 / (256 - timeConstant);
  const sampleBytes = vocLen - 2; // length covers tc + codec byte + PCM
  if (sampleBytes <= 0) return 0;
  return secToJiffies(sampleBytes / sampleRate);
}

/** Read a MIDI variable-length quantity at `pos`; returns value + bytes read. */
function readVlq(b: Uint8Array, pos: number): { value: number; len: number } {
  let value = 0;
  let len = 0;
  for (;;) {
    const byte = b[pos + len]!;
    value = (value << 7) | (byte & 0x7f);
    len++;
    if ((byte & 0x80) === 0) break;
  }
  return { value, len };
}

/** Seconds spanned by one `MTrk`, integrating over any tempo changes. */
function mtrkSeconds(b: Uint8Array, start: number, end: number, division: number): number {
  let pos = start;
  let seconds = 0;
  let tempo = 500_000; // µs per quarter note (MIDI default = 120 BPM)
  let running = 0;
  while (pos < end) {
    const dt = readVlq(b, pos);
    pos += dt.len;
    // The delta elapses under the CURRENT tempo; a tempo change in this
    // event only affects later deltas.
    seconds += (dt.value * (tempo / 1_000_000)) / division;

    let status = b[pos]!;
    if (status & 0x80) pos++;
    else status = running; // running status — reuse, data byte not consumed yet
    if (status < 0xf0) running = status;

    if (status === 0xff) {
      const type = b[pos++]!;
      const meta = readVlq(b, pos);
      pos += meta.len;
      if (type === 0x51 && meta.value === 3) {
        tempo = (b[pos]! << 16) | (b[pos + 1]! << 8) | b[pos + 2]!;
      }
      pos += meta.value;
      if (type === 0x2f) break; // end of track
    } else if (status === 0xf0 || status === 0xf7) {
      const sys = readVlq(b, pos);
      pos += sys.len + sys.value;
    } else {
      const hi = status & 0xf0;
      pos += hi === 0xc0 || hi === 0xd0 ? 1 : 2;
    }
  }
  return seconds;
}

/**
 * Duration of a standard-MIDI block (`ROL`/`ADL`/`SPK` payload), taken as
 * the longest of its `MTrk` chunks. `MThd` gives ticks-per-quarter; each
 * `MTrk`'s delta times are integrated against the tempo map.
 */
export function midiDurationJiffies(midiPayload: Uint8Array): number {
  const mthd = findChunk(midiPayload, 0, midiPayload.length, 'MThd');
  if (!mthd) return 0;
  const division = (midiPayload[mthd.start + 4]! << 8) | midiPayload[mthd.start + 5]!;
  if (division === 0 || division & 0x8000) return 0; // SMPTE division — unused in MI1
  let longest = 0;
  let p = mthd.end;
  for (;;) {
    const mtrk = findChunk(midiPayload, p, midiPayload.length, 'MTrk');
    if (!mtrk) break;
    longest = Math.max(longest, mtrkSeconds(midiPayload, mtrk.start, mtrk.end, division));
    p = mtrk.end;
  }
  return secToJiffies(longest);
}
