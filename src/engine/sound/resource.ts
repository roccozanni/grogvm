/** SOUN payload → playback-timing descriptor. Formats: pages/docs/scumm/sound.md §2. */

import { midiDurationJiffies, sblDurationJiffies } from './duration';

export interface SoundResource {
  /** Finite playback length in jiffies (1/60 s); 0 if looping or unknown. */
  readonly durationJiffies: number;
  /** True → plays until explicitly stopped (never gates a wait). */
  readonly looping: boolean;
}

/** A looping or unknown-length sound — never holds a wait. */
const NON_GATING: SoundResource = { durationJiffies: 0, looping: false };

const CD_TRIGGER_TRACK = 16;
const CD_TRIGGER_LOOP = 17;
const CD_TRIGGER_LOOP_FLAG = 0xff;

const tag = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const be32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/**
 * Anything null/empty/unrecognized yields a non-gating 0-jiffy resource so a
 * busy-wait can never hang. `cdTrackJiffies` resolves a CD track's length
 * (consulted only for one-shot CD triggers; missing/0 stays non-gating).
 */
export function parseSound(
  soundPayload: Uint8Array | null,
  cdTrackJiffies?: (track: number) => number,
): SoundResource {
  if (!soundPayload || soundPayload.length < 8) return NON_GATING;

  // CD-audio trigger: a 24-byte command, not a SOU container.
  if (soundPayload[0] === 0x18 && tag(soundPayload, 0) !== 'SOU ') {
    if (soundPayload.length <= CD_TRIGGER_LOOP) return NON_GATING;
    const looping = soundPayload[CD_TRIGGER_LOOP] === CD_TRIGGER_LOOP_FLAG;
    if (looping) return { durationJiffies: 0, looping: true };
    const track = soundPayload[CD_TRIGGER_TRACK]!;
    return { durationJiffies: cdTrackJiffies?.(track) ?? 0, looping: false };
  }

  if (tag(soundPayload, 0) !== 'SOU ') return NON_GATING;

  // SOU container: walk its device renditions (exclusive-size blocks) and
  // time the first recognized one — the primary rendition for this sound.
  let p = 8; // after the SOU header
  const end = soundPayload.length;
  while (p + 8 <= end) {
    const t = tag(soundPayload, p);
    const size = be32(soundPayload, p + 4);
    const payloadStart = p + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > end) break;
    const body = soundPayload.subarray(payloadStart, payloadEnd);
    if (t === 'SBL ') {
      return { durationJiffies: sblDurationJiffies(body), looping: false };
    }
    if (t === 'ROL ' || t === 'ADL ' || t === 'SPK ') {
      return { durationJiffies: midiDurationJiffies(body), looping: false };
    }
    p = payloadEnd;
  }
  return NON_GATING;
}
