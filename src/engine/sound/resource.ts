/** SOUN payload → playback descriptor: timing + output rendition. Formats: pages/docs/scumm/sound.md §2. */

import { midiDurationJiffies, sblDurationJiffies, sblPcm } from './duration';

/** What an output backend plays for a sound; timing is independent (see {@link parseSound}). */
export type SoundRendition =
  | { readonly kind: 'pcm'; readonly samples: Uint8Array; readonly rate: number }
  | { readonly kind: 'midi'; readonly device: 'ADL' | 'ROL' | 'SPK'; readonly data: Uint8Array }
  | { readonly kind: 'cd'; readonly track: number; readonly startSec: number }
  | { readonly kind: 'silent' };

export interface SoundResource {
  /** Finite playback length in jiffies (1/60 s); 0 if looping or unknown. */
  readonly durationJiffies: number;
  /** True → plays until explicitly stopped (never gates a wait). */
  readonly looping: boolean;
  readonly rendition: SoundRendition;
}

const SILENT: SoundRendition = { kind: 'silent' };

/** A looping or unknown-length sound — never holds a wait. */
const NON_GATING: SoundResource = { durationJiffies: 0, looping: false, rendition: SILENT };

const CD_TRIGGER_TRACK = 16;
const CD_TRIGGER_LOOP = 17;
const CD_TRIGGER_START = 18;
const CD_TRIGGER_BYTES = 24;
const CD_TRIGGER_LOOP_FLAG = 0xff;

const tag = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const be32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Anything null/empty/unrecognized yields a non-gating 0-jiffy resource so a
 * busy-wait can never hang. `cdTrackJiffies` resolves a CD track's length
 * (consulted only for one-shot CD triggers; missing/0 stays non-gating).
 *
 * Timing comes from the FIRST recognized rendition (the primary one); the
 * output rendition is picked independently by hardware preference — the two
 * can be different blocks of the same sound (see pages/docs/engine/audio.md).
 */
export function parseSound(
  soundPayload: Uint8Array | null,
  cdTrackJiffies?: (track: number) => number,
): SoundResource {
  if (!soundPayload || soundPayload.length < 8) return NON_GATING;

  // CD-audio trigger: a 24-byte command, not a SOU container.
  if (soundPayload[0] === 0x18 && tag(soundPayload, 0) !== 'SOU ') {
    if (soundPayload.length < CD_TRIGGER_BYTES) return NON_GATING;
    const track = soundPayload[CD_TRIGGER_TRACK]!;
    // Bytes 18-20: start position in the track, binary MSF (75 frames/s).
    // Only #108 uses it — track 17 from 1:35.64, the lookout cue that follows
    // the title segment of the same track.
    const startSec =
      soundPayload[CD_TRIGGER_START]! * 60 +
      soundPayload[CD_TRIGGER_START + 1]! +
      soundPayload[CD_TRIGGER_START + 2]! / 75;
    const rendition: SoundRendition = { kind: 'cd', track, startSec };
    if (soundPayload[CD_TRIGGER_LOOP] === CD_TRIGGER_LOOP_FLAG) {
      return { durationJiffies: 0, looping: true, rendition };
    }
    const trackJiffies = cdTrackJiffies?.(track) ?? 0;
    const durationJiffies = Math.max(0, trackJiffies - Math.round(startSec * 60));
    return { durationJiffies, looping: false, rendition };
  }

  if (tag(soundPayload, 0) !== 'SOU ') return NON_GATING;

  // SOU container: walk its device renditions (exclusive-size blocks),
  // timing the first recognized one and collecting the rest for output.
  let p = 8; // after the SOU header
  const end = soundPayload.length;
  let durationJiffies: number | null = null;
  const renditions = new Map<string, Uint8Array>();
  while (p + 8 <= end) {
    const t = tag(soundPayload, p);
    const size = be32(soundPayload, p + 4);
    const payloadStart = p + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > end) break;
    const body = soundPayload.subarray(payloadStart, payloadEnd);
    if (!renditions.has(t)) renditions.set(t, body);
    if (durationJiffies === null) {
      if (t === 'SBL ') durationJiffies = sblDurationJiffies(body);
      else if (t === 'ROL ' || t === 'ADL ' || t === 'SPK ') durationJiffies = midiDurationJiffies(body);
    }
    p = payloadEnd;
  }
  return { durationJiffies: durationJiffies ?? 0, looping: false, rendition: pickRendition(renditions) };
}

// Output preference mirrors a SoundBlaster-equipped DOS machine: digitized
// when present, else AdLib — NOT the listed order (ROL-first sounds always
// carry an SBL sibling in MI1; MT-32 synthesis is never needed).
function pickRendition(renditions: ReadonlyMap<string, Uint8Array>): SoundRendition {
  const sbl = renditions.get('SBL ');
  if (sbl) {
    const pcm = sblPcm(sbl);
    if (pcm) return { kind: 'pcm', samples: pcm.samples, rate: pcm.rate };
  }
  for (const device of ['ADL', 'ROL', 'SPK'] as const) {
    const data = renditions.get(`${device} `);
    if (data) return { kind: 'midi', device, data };
  }
  return SILENT;
}
