import { describe, expect, it } from 'vitest';
import { parseSound } from './resource';

const oneShot = (jiffies: number) => ({ durationJiffies: jiffies, looping: false });

/** A SCUMM block: 4-char tag + big-endian size + payload. */
function chunk(tag: string, payload: readonly number[]): number[] {
  return [
    tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3),
    (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff, (payload.length >>> 8) & 0xff, payload.length & 0xff,
    ...payload,
  ];
}
const le24 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

/** A synthetic 24-byte CD-audio trigger naming `track`, one-shot unless `loop`. */
function cdTrigger(track: number, loop = false, startMsf: [number, number, number] = [0, 0, 0]): Uint8Array {
  const b = new Uint8Array(24);
  b[0] = 0x18;
  b[16] = track;
  b[17] = loop ? 0xff : 0x01;
  b.set(startMsf, 18);
  return b;
}

// An SBL (digitized) rendition timing 2.0 s (tc 156 → 10000 Hz, 20000 samples).
const SBL_2S = chunk('SBL ', [
  ...chunk('AUhd', [0, 0, 0x80]),
  ...chunk('AUdt', [0x01, ...le24(20002), 156, 0x00, ...new Array<number>(20000).fill(0x80)]),
]);
// A minimal MIDI body timing 0.5 s (480 ticks @ 500000µs ÷ 480 division).
const MIDI_HALFS = [
  ...chunk('MThd', [0, 0, 0, 1, 0x01, 0xe0]),
  ...chunk('MTrk', [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x83, 0x60, 0xff, 0x2f, 0x00]),
];
const ROL_HALFS = chunk('ROL ', MIDI_HALFS);
const ADL_HALFS = chunk('ADL ', MIDI_HALFS);
const SPK_HALFS = chunk('SPK ', MIDI_HALFS);
const sou = (...renditions: number[][]): Uint8Array => new Uint8Array(chunk('SOU ', renditions.flat()));

describe('parseSound — SOU container timing', () => {
  it('times an SBL (digitized) rendition', () => {
    expect(parseSound(sou(SBL_2S))).toMatchObject(oneShot(120));
  });

  it('times a ROL/ADL/SPK (MIDI) rendition', () => {
    expect(parseSound(sou(ROL_HALFS))).toMatchObject(oneShot(30));
  });

  it('times by the first listed rendition (the primary one)', () => {
    expect(parseSound(sou(SBL_2S, ROL_HALFS))).toMatchObject(oneShot(120));
    expect(parseSound(sou(ROL_HALFS, SBL_2S))).toMatchObject(oneShot(30));
  });

  it('is non-gating for a container with no recognized rendition', () => {
    expect(parseSound(sou(chunk('zzz ', [1, 2, 3])))).toMatchObject(oneShot(0));
  });
});

describe('parseSound — output rendition', () => {
  it('prefers the digitized SBL rendition regardless of listed order', () => {
    for (const payload of [sou(SBL_2S, ROL_HALFS), sou(ROL_HALFS, SBL_2S)]) {
      const r = parseSound(payload).rendition;
      expect(r).toMatchObject({ kind: 'pcm', rate: 10000 });
      expect(r.kind === 'pcm' && r.samples.length).toBe(20000);
    }
  });

  it('falls back ADL > ROL > SPK when no SBL is present', () => {
    expect(parseSound(sou(SPK_HALFS, ROL_HALFS, ADL_HALFS)).rendition).toMatchObject({ kind: 'midi', device: 'ADL' });
    expect(parseSound(sou(SPK_HALFS, ROL_HALFS)).rendition).toMatchObject({ kind: 'midi', device: 'ROL' });
    expect(parseSound(sou(SPK_HALFS)).rendition).toMatchObject({ kind: 'midi', device: 'SPK' });
  });

  it('CD triggers carry their track, both kinds', () => {
    expect(parseSound(cdTrigger(6)).rendition).toEqual({ kind: 'cd', track: 6, startSec: 0 });
    expect(parseSound(cdTrigger(16, true)).rendition).toEqual({ kind: 'cd', track: 16, startSec: 0 });
  });

  it('decodes a mid-track start position (binary MSF, 75 frames/s)', () => {
    // The #108 shape: track 17 from 1m 35s 48f = 95.64 s.
    const startSec = 60 + 35 + 48 / 75;
    const r = parseSound(cdTrigger(17, false, [1, 35, 48]), () => 10000);
    expect(r.rendition).toEqual({ kind: 'cd', track: 17, startSec });
    // One-shot gate length = remaining track, not the whole track.
    expect(r.durationJiffies).toBe(10000 - Math.round(startSec * 60));
  });

  it('clamps the gate to 0 when the start offset exceeds the track', () => {
    expect(parseSound(cdTrigger(17, false, [1, 35, 48]), () => 747).durationJiffies).toBe(0);
  });

  it('unrecognized payloads are silent', () => {
    expect(parseSound(null).rendition).toEqual({ kind: 'silent' });
    expect(parseSound(sou(chunk('zzz ', [1, 2, 3]))).rendition).toEqual({ kind: 'silent' });
  });
});

describe('parseSound — CD-audio trigger', () => {
  // Stand-in for the live FLAC/MP3-header lookup the VM performs per track.
  const cdJiffies = (track: number): number => (track === 6 ? 747 : 0);

  it('times a one-shot trigger via the CD-track resolver', () => {
    expect(parseSound(cdTrigger(6), cdJiffies)).toMatchObject(oneShot(747));
  });

  it('flags a looping trigger (byte 17 = 0xff) and never gates', () => {
    const r = parseSound(cdTrigger(16, true), cdJiffies);
    expect(r.looping).toBe(true);
    expect(r.durationJiffies).toBe(0);
  });

  it('is non-gating when no resolver is given or the track is unknown', () => {
    expect(parseSound(cdTrigger(6))).toMatchObject(oneShot(0));
    expect(parseSound(cdTrigger(99), cdJiffies)).toMatchObject(oneShot(0));
  });

  it('treats null/empty/garbage as a non-gating 0-jiffy sound', () => {
    expect(parseSound(null)).toMatchObject(oneShot(0));
    expect(parseSound(new Uint8Array(0))).toMatchObject(oneShot(0));
    expect(parseSound(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toMatchObject(oneShot(0));
  });
});
