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
    expect(dur(28)).toEqual({ durationJiffies: expected.sbl28, looping: false });
  });

  it('times the standard-MIDI gate #50 from tempo × ticks', () => {
    expect(dur(50)).toEqual({ durationJiffies: expected.midi50, looping: false });
  });

  it('times one-shot CD-trigger gates from the track length', () => {
    for (const id of [104, 105, 106, 107]) {
      expect(dur(id)).toEqual({ durationJiffies: expected.track6, looping: false });
    }
    expect(dur(117)).toEqual({ durationJiffies: expected.track7, looping: false });
  });

  it('flags looping CD music as non-gating (#116/#118/#123)', () => {
    for (const id of [116, 118, 123]) {
      expect(dur(id).looping).toBe(true);
      expect(dur(id).durationJiffies).toBe(0);
    }
  });
});
