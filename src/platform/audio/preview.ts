/**
 * One-at-a-time sound auditioner for the Explorer: plays a parsed
 * `SoundResource` directly (digitized PCM buffer or the CD track file),
 * outside any VM/session. The triggering click is the user gesture, so no
 * mute dance — see pages/docs/engine/audio.md for the session model.
 * (FM/ADL synthesis is parked on the `parked/audio-synth` branch.)
 */
import type { SoundResource } from '../../engine/sound/resource';
import type { CdTrackFileResolver } from './web-audio-backend';
import { resampledBuffer } from './resample';

/** A preview can audibly play digitized (PCM) and CD-track sounds. */
export function isPreviewable(res: SoundResource): boolean {
  const r = res.rendition;
  return r.kind === 'pcm' || r.kind === 'cd';
}

export class SoundPreview {
  /** Reassigned by the panel; reports which key is playing (null = stopped). */
  onChange: (playing: number | null) => void = () => {};

  private ctx: AudioContext | null = null;
  private current: { key: number; stop: () => void } | null = null;

  constructor(private readonly cdTrackFile: CdTrackFileResolver) {}

  /** Start `key` (stopping whatever plays), or stop it if already playing. */
  toggle(key: number, res: SoundResource): void {
    if (this.current?.key === key) {
      this.stop();
      return;
    }
    this.stop();
    const stop = this.start(key, res);
    if (stop) {
      this.current = { key, stop };
      this.onChange(key);
    }
  }

  stop(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    current.stop();
    this.onChange(null);
  }

  private start(key: number, res: SoundResource): (() => void) | null {
    const r = res.rendition;
    if (r.kind === 'pcm') {
      return this.startBuffer(
        key,
        resampledBuffer(this.audioCtx(), r.samples.length, r.rate, (i) => (r.samples[i]! - 128) / 128),
        res.looping,
        null,
      );
    }
    if (r.kind === 'cd') return this.startCd(key, r.track, r.startSec, res.looping);
    return null;
  }

  private startBuffer(
    key: number,
    buffer: AudioBuffer | null,
    loop: boolean,
    loopRegion: { start: number; end: number } | null,
  ): (() => void) | null {
    if (!buffer) return null;
    const ctx = this.audioCtx();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    if (loop && loopRegion) {
      src.loopStart = loopRegion.start;
      src.loopEnd = loopRegion.end;
    }
    src.connect(ctx.destination);
    src.onended = () => this.endedBy(key);
    src.start();
    return () => {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already ended */
      }
      src.disconnect();
    };
  }

  private startCd(key: number, track: number, startSec: number, loop: boolean): () => void {
    let el: HTMLAudioElement | null = null;
    let url: string | null = null;
    let cancelled = false;
    void this.cdTrackFile(track).then((file) => {
      if (cancelled) return;
      if (!file) {
        this.endedBy(key);
        return;
      }
      url = URL.createObjectURL(file);
      el = new Audio(url);
      el.loop = loop;
      if (startSec > 0) el.currentTime = startSec;
      el.addEventListener('ended', () => this.endedBy(key));
      void el.play().catch(() => this.endedBy(key));
    });
    return () => {
      cancelled = true;
      el?.pause();
      if (url) URL.revokeObjectURL(url);
      el = null;
    };
  }

  /** Natural end (or an unplayable resolve) — clear state without re-stopping. */
  private endedBy(key: number): void {
    if (this.current?.key !== key) return;
    this.current = null;
    this.onChange(null);
  }

  private audioCtx(): AudioContext {
    this.ctx ??= new AudioContext();
    return this.ctx;
  }
}
