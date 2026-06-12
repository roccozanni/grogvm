/**
 * Sound-duration coverage against the REAL game files — the format coverage
 * the synthetic engine tests (`src/engine/sound/*.test.ts`) can't provide:
 * that the actual SOUN resources and `TrackN.*` CD-audio files parse to the
 * expected playback lengths. Mirrors exactly what `bootGame` wires up
 * (`loadSound` → `parseSound`, with CD-track durations from
 * `readCdTrackDurations`).
 *
 * Runs **once** against whatever build `DATA_DIR` points to, autodetecting the
 * variant the way the browser does — hashing `MONKEY.000` (`identifyVariant`)
 * and looking the expected durations up in `KNOWN_SOUND_DURATIONS`. So the
 * same suite covers the IT (FLAC tracks) and EN (MP3 tracks) releases; the
 * in-resource SBL/MIDI sounds (#28, #50) time identically, only the CD-track
 * lengths differ by encoding. Data-gated, so it self-skips on a fresh checkout.
 *
 * Wait-gated ids: SBL #28 (~2.7 s), MIDI #50 (~4.8 s), one-shot CD triggers
 * #104–107 (track 6) and #117 (track 7); #116/#118/#123 are looping CD music
 * (non-gating).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadScummV5, readCdTrackDurations } from '../../src/testkit/scummv5';
import { parseSound, type SoundResource } from '../../src/engine/sound/resource';
import { loadSound } from '../../src/engine/vm/scripts';
import { identifyVariant } from '../../src/platform/detect';
import { DATA_DIR, hasGame, KNOWN_SOUND_DURATIONS, type SoundDurations } from './game';

describe.skipIf(!hasGame())('MI1 — sound durations (real files)', () => {
  let dur: (id: number) => SoundResource;
  let expected: SoundDurations;

  beforeAll(async () => {
    const { res, index, loff } = loadScummV5(DATA_DIR);
    const cd = readCdTrackDurations(DATA_DIR);
    dur = (id) => parseSound(loadSound(res, index, loff, id), (track) => cd.get(track) ?? 0);

    const { contentHash, variant } = await identifyVariant(new Uint8Array(readFileSync(`${DATA_DIR}/MONKEY.000`)));
    const known = KNOWN_SOUND_DURATIONS[contentHash];
    if (!known) {
      throw new Error(`No KNOWN_SOUND_DURATIONS for variant "${variant}" (${contentHash}) at ${DATA_DIR}`);
    }
    expected = known;
  });

  it('times the digitized SBL gate #28 from its VOC time-constant', () => {
    expect(dur(28)).toMatchObject({
      durationJiffies: expected.sbl28,
      looping: false,
      rendition: { kind: 'pcm' },
    });
  });

  it('times the standard-MIDI gate #50 from tempo × ticks, but plays its SBL rendition', () => {
    // #50 is ROL-first ([ROL SBL ADL]): the gate length comes from the ROL
    // piece while the output rendition is the digitized sibling.
    expect(dur(50)).toMatchObject({
      durationJiffies: expected.midi50,
      looping: false,
      rendition: { kind: 'pcm' },
    });
  });

  it('times one-shot CD-trigger gates from the track length', () => {
    for (const id of [104, 105, 106, 107]) {
      expect(dur(id)).toMatchObject({
        durationJiffies: expected.track6,
        looping: false,
        rendition: { kind: 'cd', track: 6 },
      });
    }
    expect(dur(117)).toMatchObject({
      durationJiffies: expected.track7,
      looping: false,
      rendition: { kind: 'cd', track: 7 },
    });
  });

  it('#108 cues track 17 mid-track — the lookout segment after the title segment', () => {
    // Same track as the title theme (#110), entered at 1m 35s 48f (binary
    // MSF): #110 spans the whole track, #108 only the remainder.
    const startSec = 60 + 35 + 48 / 75;
    expect(dur(110).rendition).toEqual({ kind: 'cd', track: 17, startSec: 0 });
    expect(dur(108).rendition).toEqual({ kind: 'cd', track: 17, startSec });
    expect(dur(108).durationJiffies).toBe(
      Math.max(0, dur(110).durationJiffies - Math.round(startSec * 60)),
    );
    expect(dur(108).durationJiffies).toBeGreaterThan(0);
  });

  it('flags looping CD music as non-gating (#116/#118/#123)', () => {
    for (const id of [116, 118, 123]) {
      expect(dur(id).looping).toBe(true);
      expect(dur(id).durationJiffies).toBe(0);
      expect(dur(id).rendition.kind).toBe('cd');
    }
  });

  it('rendition coverage: 62 digitized, the known 15 ADL-only, nothing else', () => {
    // The ADL-only effects (no digitized sibling) await the OPL2 phase — a
    // NEW midi-only id or a pcm-count drop is a rendition-extraction regression.
    const adlOnly = new Set([4, 5, 30, 32, 36, 45, 48, 59, 60, 66, 68, 70, 74, 76, 98]);
    let pcmCount = 0;
    for (let id = 0; id < 100; id++) {
      const r = dur(id).rendition;
      if (r.kind === 'pcm') pcmCount++;
      if (r.kind === 'midi') {
        expect(adlOnly, `sound #${id} unexpectedly midi-only (device ${r.device})`).toContain(id);
        expect(r.device).toBe('ADL');
      }
    }
    expect(pcmCount).toBe(62);
    for (const id of adlOnly) expect(dur(id).rendition.kind).toBe('midi');
  });
});
