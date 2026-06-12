import { describe, expect, it } from 'vitest';
import {
  audioDurationJiffies,
  flacDurationJiffies,
  midiDurationJiffies,
  mp3DurationJiffies,
  sblDurationJiffies,
  sblPcm,
} from './duration';

/** A SCUMM/RIFF-style block: 4-char tag + big-endian size + payload. */
function chunk(tag: string, payload: readonly number[]): number[] {
  return [
    tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3),
    (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff,
    ...payload,
  ];
}
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** A minimal 42-byte FLAC header (STREAMINFO) with the given rate + sample count. */
function flacHeader(sampleRate: number, totalSamples: number): Uint8Array {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
  b[7] = 34; // STREAMINFO metadata block, payload length 34
  const p = 18; // packed sampleRate(20) | channels(3) | bps(5) | totalSamples(36)
  b[p] = (sampleRate >> 12) & 0xff;
  b[p + 1] = (sampleRate >> 4) & 0xff;
  b[p + 2] = (sampleRate & 0xf) << 4;
  b[p + 3] = (totalSamples / 2 ** 32) & 0xf;
  b[p + 4] = (totalSamples >>> 24) & 0xff;
  b[p + 5] = (totalSamples >>> 16) & 0xff;
  b[p + 6] = (totalSamples >>> 8) & 0xff;
  b[p + 7] = totalSamples & 0xff;
  return b;
}

/** A minimal MP3 header: one MPEG1-LayerIII-44100 frame + an Info/Xing tag. */
function mp3InfoHeader(frames: number, bitrateIndex = 9): Uint8Array {
  const b = new Uint8Array(64);
  b[0] = 0xff;
  b[1] = 0xfb; // MPEG1, Layer III, no CRC
  b[2] = (bitrateIndex << 4) | (0 << 2); // bitrate index, sampleRate index 0 = 44100
  b[3] = 0x44;
  b.set([0x49, 0x6e, 0x66, 0x6f], 36); // "Info" (CBR Xing) at the MPEG1-stereo offset
  b[43] = 0x01; // flags: frame count present
  b[44] = (frames >>> 24) & 0xff;
  b[45] = (frames >>> 16) & 0xff;
  b[46] = (frames >>> 8) & 0xff;
  b[47] = frames & 0xff;
  return b;
}

describe('flacDurationJiffies', () => {
  it('reads totalSamples / sampleRate from STREAMINFO', () => {
    expect(flacDurationJiffies(flacHeader(44100, 88200))).toBe(120); // 2.0 s
    expect(flacDurationJiffies(flacHeader(44100, 549192))).toBe(747); // MI1 CD track 6
  });

  it('returns 0 for non-FLAC or truncated input', () => {
    expect(flacDurationJiffies(new Uint8Array(8))).toBe(0);
    expect(flacDurationJiffies(new Uint8Array([1, 2, 3]))).toBe(0);
    expect(flacDurationJiffies(flacHeader(0, 1000))).toBe(0); // guard against /0
  });
});

describe('mp3DurationJiffies', () => {
  it('reads frames × samplesPerFrame / sampleRate from the Xing/Info tag', () => {
    // 478 frames × 1152 samples ÷ 44100 Hz ≈ 12.49 s (MI1 EN CD track 6).
    expect(mp3DurationJiffies(mp3InfoHeader(478), 0)).toBe(749);
  });

  it('falls back to a CBR estimate (audioBytes × 8 / bitrate) with no Xing/Info', () => {
    // 160 kbps frame, no Info tag, 160000-byte file → 8.0 s.
    const cbr = new Uint8Array([0xff, 0xfb, (10 << 4) | 0, 0x44]);
    expect(mp3DurationJiffies(cbr, 160000)).toBe(480);
  });

  it('returns 0 when no frame header is present', () => {
    expect(mp3DurationJiffies(new Uint8Array(64), 1000)).toBe(0);
  });
});

describe('audioDurationJiffies — dispatch by content', () => {
  it('routes FLAC vs MP3 by magic', () => {
    expect(audioDurationJiffies(flacHeader(44100, 549192), 0)).toBe(747); // FLAC track 6
    expect(audioDurationJiffies(mp3InfoHeader(478), 0)).toBe(749); // MP3 track 6
    expect(audioDurationJiffies(new Uint8Array([1, 2, 3, 4]), 0)).toBe(0);
  });
});

describe('sblDurationJiffies / sblPcm', () => {
  // tc 156 → 10000 Hz; VOC length 20002 → 20000 sample bytes → 2.0 s.
  const voc = [0x01, ...le24(20002), 156, 0x00, ...new Array<number>(20000).fill(0x80)];
  const sbl = new Uint8Array([...chunk('AUhd', [0, 0, 0x80]), ...chunk('AUdt', voc)]);

  it('reads the rate from the VOC time-constant (1e6 / (256 - tc))', () => {
    expect(sblDurationJiffies(sbl)).toBe(120);
  });

  it('exposes the raw samples + rate for output backends', () => {
    const pcm = sblPcm(sbl)!;
    expect(pcm.rate).toBe(10000);
    expect(pcm.samples.length).toBe(20000);
    expect(pcm.samples[0]).toBe(0x80);
  });

  it('clamps a declared length that overruns the AUdt chunk', () => {
    const overrun = [0x01, ...le24(50000), 156, 0x00, ...new Array<number>(100).fill(0x80)];
    const pcm = sblPcm(new Uint8Array(chunk('AUdt', overrun)))!;
    expect(pcm.samples.length).toBe(100);
  });

  it('returns 0 / null without an AUdt chunk', () => {
    expect(sblDurationJiffies(new Uint8Array(chunk('AUhd', [0, 0, 0x80])))).toBe(0);
    expect(sblPcm(new Uint8Array(chunk('AUhd', [0, 0, 0x80])))).toBeNull();
  });
});

describe('midiDurationJiffies', () => {
  it('integrates MTrk delta-times against the tempo map', () => {
    const mthd = chunk('MThd', [0, 0, 0, 1, 0x01, 0xe0]); // format 0, 1 track, division 480
    // delta 0 → Set-Tempo 500000µs/qn; delta 480 → End-of-Track.
    // 480 ticks × 500000µs ÷ 480 division = 0.5 s.
    const mtrk = chunk('MTrk', [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x83, 0x60, 0xff, 0x2f, 0x00]);
    expect(midiDurationJiffies(new Uint8Array([...mthd, ...mtrk]))).toBe(30);
  });

  it('returns 0 without an MThd', () => {
    expect(midiDurationJiffies(new Uint8Array(chunk('MTrk', [0xff, 0x2f, 0x00])))).toBe(0);
  });
});
