/**
 * Real audio output behind the `AudioBackend` seam: Web Audio for digitized
 * PCM, an `HTMLAudioElement` per CD track. See pages/docs/engine/audio.md.
 */
import {
  type ActiveSoundInfo,
  type AudioBackend,
  SilentTimingBackend,
  type SoundSnapshot,
} from '../../engine/sound/backend';
import type { SoundResource } from '../../engine/sound/resource';

/** Resolves a CD track number to its `TrackN.{fla,mp3}` File; null when absent. */
export type CdTrackFileResolver = (track: number) => Promise<File | null>;

interface Voice {
  stop(): void;
  setMuted?(muted: boolean): void;
  /** Per-jiffy virtual-clock tick while the sound is still running. */
  tick?(jiffies: number): void;
  /** Tab hidden/shown: output freezes with the VM clock (rAF stops with the tab). */
  suspend?(): void;
  resume?(): void;
}

/** Re-check media position against the virtual clock once a second... */
const SYNC_CHECK_JIFFIES = 60;
/** ...and only seek when off by more than normal playback jitter. */
const DRIFT_TOLERANCE_SEC = 0.35;

/**
 * The wrapped `SilentTimingBackend` stays the single timing authority —
 * `isRunning`, saves, and gating behave exactly as the silent build; output
 * is a side effect, and the per-jiffy sweep kills any voice the virtual
 * clock has expired (so skip / fast-forward can't leave audio dangling).
 *
 * Always STARTS MUTED: browsers refuse audible output before a user gesture
 * anyway, and the unmute click is that gesture. Mute never stops playback —
 * voices keep progressing silently (`el.muted`, zero master gain), and a CD
 * voice's media position is DERIVED from the virtual clock, not from when
 * playback physically began. Whatever starts late (file fetch, late unmute)
 * or drifts (a hidden tab freezes the VM clock while the element keeps
 * rolling) gets seeked back to the position the script timeline implies.
 */
export class WebAudioBackend implements AudioBackend {
  private readonly timing = new SilentTimingBackend();
  private readonly ctx = new AudioContext();
  private readonly master: GainNode;
  /** Decoded-and-resampled buffer per sound id (SOUN data is immutable); null = unplayable. */
  private readonly pcmCache = new Map<number, AudioBuffer | null>();
  private readonly voices = new Map<number, Voice>();
  private music: number | null = null;
  private muted = true;

  // A hidden tab stops rAF, freezing the VM clock — freeze output with it,
  // so a background tab is silent and returning resumes in sync (no seek).
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      void this.ctx.suspend().catch(() => {});
      for (const v of this.voices.values()) v.suspend?.();
    } else {
      void this.ctx.resume().catch(() => {});
      for (const v of this.voices.values()) v.resume?.();
    }
  };

  constructor(private readonly cdTrackFile: CdTrackFileResolver) {
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.master.gain.value = muted ? 0 : 1;
    // User-initiated unmute is a gesture context — the one reliable place to
    // lift a suspended context on browsers without the policy API.
    if (!muted) void this.ctx.resume().catch(() => {});
    for (const v of this.voices.values()) v.setMuted?.(muted);
  }

  startSound(id: number, res: SoundResource): void {
    this.timing.startSound(id, res);
    this.startVoice(id, res, res.looping);
  }

  startMusic(id: number, res: SoundResource): void {
    this.timing.startMusic(id, res);
    if (this.music !== null && this.music !== id) this.stopVoice(this.music);
    this.music = id;
    this.startVoice(id, res, true);
  }

  stopSound(id: number): void {
    this.timing.stopSound(id);
    this.stopVoice(id);
    if (this.music === id) this.music = null;
  }

  stopMusic(): void {
    this.timing.stopMusic();
    if (this.music !== null) {
      this.stopVoice(this.music);
      this.music = null;
    }
  }

  stopAll(): void {
    this.timing.stopAll();
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.music = null;
  }

  isRunning(id: number): boolean {
    return this.timing.isRunning(id);
  }

  // Timing is the authority on what's active; whether a kind is audible here
  // (PCM/CD play, MIDI/silent don't — see startVoice) is the panel's to flag.
  inspect(): readonly ActiveSoundInfo[] {
    return this.timing.inspect();
  }

  advance(jiffies: number): void {
    this.timing.advance(jiffies);
    for (const [id, v] of [...this.voices]) {
      if (!this.timing.isRunning(id)) this.stopVoice(id);
      else v.tick?.(jiffies);
    }
  }

  serialize(): SoundSnapshot {
    return this.timing.serialize();
  }

  /** Restored sounds stay inaudible until the game next starts one — the
   *  snapshot stores ids, not renditions (music returns on the next room change). */
  restore(snap: SoundSnapshot): void {
    for (const id of [...this.voices.keys()]) this.stopVoice(id);
    this.music = null;
    this.timing.restore(snap);
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopAll();
    void this.ctx.close().catch(() => {});
  }

  private startVoice(id: number, res: SoundResource, loop: boolean): void {
    this.stopVoice(id);
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    const r = res.rendition;
    if (r.kind === 'pcm') {
      const voice = this.startPcm(id, r.samples, r.rate, loop);
      if (voice) this.voices.set(id, voice);
    } else if (r.kind === 'cd') {
      this.voices.set(id, this.startCd(r.track, r.startSec, loop));
    }
    // 'midi' (the ADL-only effects) and 'silent': timed but inaudible — the
    // OPL2 synthesis phase lands here.
  }

  private stopVoice(id: number): void {
    this.voices.get(id)?.stop();
    this.voices.delete(id);
  }

  private startPcm(id: number, samples: Uint8Array, rate: number, loop: boolean): Voice | null {
    const buffer = this.pcmBuffer(id, samples, rate);
    if (!buffer) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    src.connect(this.master);
    src.start();
    return {
      stop() {
        try {
          src.stop();
        } catch {
          /* already ended */
        }
        src.disconnect();
      },
    };
  }

  private pcmBuffer(id: number, samples: Uint8Array, rate: number): AudioBuffer | null {
    let buffer = this.pcmCache.get(id);
    if (buffer === undefined) {
      buffer = this.decodePcm(samples, rate);
      this.pcmCache.set(id, buffer);
    }
    return buffer;
  }

  /**
   * 8-bit unsigned PCM → Float32, linear-resampled to the context rate: the
   * Web Audio spec only guarantees buffer rates ≥ 8000 Hz, and MI1's SBL
   * sounds run ~6849 Hz.
   */
  private decodePcm(samples: Uint8Array, rate: number): AudioBuffer | null {
    const n = Math.max(1, Math.round((samples.length * this.ctx.sampleRate) / rate));
    let buffer: AudioBuffer;
    try {
      buffer = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    } catch {
      return null;
    }
    const out = buffer.getChannelData(0);
    const step = rate / this.ctx.sampleRate;
    for (let i = 0; i < n; i++) {
      const pos = i * step;
      const i0 = Math.min(Math.floor(pos), samples.length - 1);
      const i1 = Math.min(i0 + 1, samples.length - 1);
      const frac = pos - i0;
      const s0 = (samples[i0]! - 128) / 128;
      const s1 = (samples[i1]! - 128) / 128;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return buffer;
  }

  private startCd(track: number, startSec: number, loop: boolean): Voice {
    let el: HTMLAudioElement | null = null;
    let url: string | null = null;
    let cancelled = false;
    let elapsedJiffies = 0;
    let sinceSync = 0;

    // Where the virtual clock says the track should be: the trigger's cue
    // point (#108: track 17's lookout segment) plus virtual time elapsed
    // since startSound, wrapped for loops.
    const virtualPos = (): number => {
      const pos = startSec + elapsedJiffies / 60;
      const dur = el && Number.isFinite(el.duration) ? el.duration : Infinity;
      return loop && pos >= dur ? pos % dur : pos;
    };
    const syncToVirtual = (): void => {
      if (!el || !Number.isFinite(el.duration)) return; // metadata pending — the pre-set cue below covers the start
      if (Math.abs(el.currentTime - virtualPos()) > DRIFT_TOLERANCE_SEC) el.currentTime = virtualPos();
    };
    // A refusal here can only be transient (voices start muted; unmuting is
    // a gesture) — the setMuted(false) retry below is the recovery path.
    // The ended-guard keeps a resume from restarting a finished one-shot.
    const tryPlay = (): void => {
      if (!el || el.ended) return;
      void el.play().then(syncToVirtual, () => {});
    };
    void this.cdTrackFile(track).then((file) => {
      if (cancelled || !file) return;
      url = URL.createObjectURL(file);
      el = new Audio(url);
      el.loop = loop;
      el.muted = this.muted;
      // Pre-metadata this sets the spec's default playback start position.
      if (startSec > 0) el.currentTime = startSec;
      tryPlay();
    });
    return {
      stop() {
        cancelled = true;
        el?.pause();
        if (url) URL.revokeObjectURL(url);
        el = null;
      },
      setMuted(muted: boolean) {
        if (!el) return;
        el.muted = muted;
        if (!muted) {
          syncToVirtual();
          void el.play().then(syncToVirtual, () => {});
        }
      },
      tick(jiffies: number) {
        elapsedJiffies += jiffies;
        sinceSync += jiffies;
        if (sinceSync < SYNC_CHECK_JIFFIES) return;
        sinceSync = 0;
        if (el && !el.paused) syncToVirtual();
      },
      suspend() {
        el?.pause();
      },
      resume() {
        tryPlay();
      },
    };
  }
}
