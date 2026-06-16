/**
 * Restore must rebuild the real output voices the snapshot can't carry —
 * the regression for "no sound until the next room change after a load".
 * Web Audio isn't in the test environment, so we stub the slice the PCM
 * path touches (no CD: that needs HTMLAudioElement + object URLs).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SoundResource } from '../../engine/sound/resource';
import { WebAudioBackend } from './web-audio-backend';

class FakeBufferSource {
  buffer: unknown = null;
  loop = false;
  /** Each `start(when, offset)` recorded, so a test can read the resume offset. */
  readonly starts: Array<[number, number]> = [];
  connect(): void {}
  disconnect(): void {}
  start(when = 0, offset = 0): void {
    this.starts.push([when, offset]);
  }
  stop(): void {}
}

class FakeAudioContext {
  state = 'running';
  sampleRate = 22050;
  destination = {};
  /** Every buffer source this context created, for assertions. */
  readonly sources: FakeBufferSource[] = [];
  constructor() {
    contexts.push(this);
  }
  createGain() {
    return { gain: { value: 0 }, connect(): void {} };
  }
  createBuffer(_channels: number, length: number, _rate: number) {
    return { duration: length / this.sampleRate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource();
    this.sources.push(s);
    return s;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Each `new AudioContext()`, newest last — `latest()` is the backend just built. */
let contexts: FakeAudioContext[] = [];
const latest = (): FakeAudioContext => contexts[contexts.length - 1]!;
/** Buffer sources that actually started playing (a real, audible voice). */
const playing = (ctx: FakeAudioContext): FakeBufferSource[] => ctx.sources.filter((s) => s.starts.length > 0);

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['AudioContext', 'document']) saved[k] = g[k];
  g.AudioContext = FakeAudioContext;
  g.document = { addEventListener(): void {}, removeEventListener(): void {}, hidden: false };
});
afterAll(() => {
  for (const k of ['AudioContext', 'document']) g[k] = saved[k];
});

// Long enough that the one-shot's resume offset (0.5 s) is well under the
// buffer length and never hits the clamp in startPcm.
const pcm = (jiffies: number, looping = false): SoundResource => ({
  durationJiffies: jiffies,
  looping,
  rendition: { kind: 'pcm', samples: new Uint8Array(8000), rate: 6849 },
});
const noCd = async (): Promise<File | null> => null;

describe('WebAudioBackend restore', () => {
  it('re-creates a real voice for each restored sound', () => {
    const a = new WebAudioBackend(noCd);
    a.startMusic(40, pcm(0, true)); // looping music
    a.startSound(5, pcm(120)); // one-shot effect
    const snap = a.serialize();

    const b = new WebAudioBackend(noCd);
    const ctx = latest();
    expect(playing(ctx)).toHaveLength(0); // nothing audible yet

    b.restore(snap, (id) => (id === 40 ? pcm(0, true) : pcm(120)));

    expect(playing(ctx)).toHaveLength(2); // both voices rebuilt — not waiting for a room change
    expect(b.isRunning(40)).toBe(true);
    expect(b.isRunning(5)).toBe(true);
  });

  it('resumes a restored one-shot from where it was saved', () => {
    const a = new WebAudioBackend(noCd);
    a.startSound(5, pcm(120));
    a.advance(30); // 30 of 120 jiffies elapsed → 90 remaining
    const snap = a.serialize();

    const b = new WebAudioBackend(noCd);
    b.restore(snap, () => pcm(120));

    const [, offset] = playing(latest())[0]!.starts[0]!;
    expect(offset).toBeCloseTo(0.5, 5); // elapsed 30 jiffies = 0.5 s into the buffer
  });

  it('restarts looping music from the top (offset 0)', () => {
    const a = new WebAudioBackend(noCd);
    a.startMusic(40, pcm(0, true));
    a.advance(600); // music never drains; elapsed time must not seek it
    const snap = a.serialize();

    const b = new WebAudioBackend(noCd);
    b.restore(snap, () => pcm(0, true));

    const src = playing(latest())[0]!;
    expect(src.loop).toBe(true);
    expect(src.starts[0]![1]).toBe(0);
  });
});
