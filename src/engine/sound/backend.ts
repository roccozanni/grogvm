/**
 * The audio seam. The VM talks to an {@link AudioBackend} for everything
 * sound-related; the backend owns the active-sound map and is the single
 * authority on whether a sound is still playing — which is what the
 * `isSoundRunning` opcode polls to pace cutscenes and transitions.
 *
 * {@link SilentTimingBackend} is the one backend for now: it models timing
 * faithfully (counting down each sound's real {@link SoundResource}
 * duration) but produces no audio. A real-output backend
 * (`WebAudioBackend`) will implement the same interface in a later phase.
 */

import type { SoundResource } from './resource';

/** Backend-agnostic snapshot of the active-sound map, for savestate. */
export interface SoundSnapshot {
  /** `[soundId, remainingJiffies, looping]` per still-active sound. */
  readonly active: ReadonlyArray<[number, number, boolean]>;
}

export interface AudioBackend {
  /** Begin a sound effect; holds for `res.durationJiffies` (or until stopped if looping). */
  startSound(id: number, res: SoundResource): void;
  stopSound(id: number): void;
  /** Begin music — always treated as looping (runs until {@link stopMusic}/{@link stopAll}). */
  startMusic(id: number, res: SoundResource): void;
  stopMusic(): void;
  stopAll(): void;
  /** Whether `id` is still playing — the value `isSoundRunning` reads. */
  isRunning(id: number): boolean;
  /** Advance the clock by `jiffies`; the VM ticks this once per jiffy. */
  advance(jiffies: number): void;
  serialize(): SoundSnapshot;
  restore(snap: SoundSnapshot): void;
  dispose(): void;
}

interface ActiveSound {
  remaining: number;
  looping: boolean;
}

/**
 * Timing-faithful, silent backend. Tracks each playing sound's remaining
 * jiffies; `advance` drains non-looping sounds and drops them at zero, so
 * `isRunning` flips false exactly when the real sound would have ended.
 */
export class SilentTimingBackend implements AudioBackend {
  private readonly active = new Map<number, ActiveSound>();
  /** The single music slot — at most one music id plays at a time. */
  private music: number | null = null;

  startSound(id: number, res: SoundResource): void {
    this.active.set(id, { remaining: res.durationJiffies, looping: res.looping });
  }

  stopSound(id: number): void {
    this.active.delete(id);
    if (this.music === id) this.music = null;
  }

  startMusic(id: number, _res: SoundResource): void {
    if (this.music !== null) this.active.delete(this.music);
    this.music = id;
    this.active.set(id, { remaining: 0, looping: true });
  }

  stopMusic(): void {
    if (this.music !== null) {
      this.active.delete(this.music);
      this.music = null;
    }
  }

  stopAll(): void {
    this.active.clear();
    this.music = null;
  }

  isRunning(id: number): boolean {
    const s = this.active.get(id);
    return s !== undefined && (s.looping || s.remaining > 0);
  }

  advance(jiffies: number): void {
    for (const [id, s] of this.active) {
      if (s.looping) continue;
      s.remaining -= jiffies;
      if (s.remaining <= 0) this.active.delete(id);
    }
  }

  serialize(): SoundSnapshot {
    return {
      active: [...this.active].map(([id, s]) => [id, s.remaining, s.looping]),
    };
  }

  restore(snap: SoundSnapshot): void {
    this.active.clear();
    this.music = null;
    for (const [id, remaining, looping] of snap.active) {
      this.active.set(id, { remaining, looping });
      if (looping) this.music = id; // best-effort: the looping entry is the music slot
    }
  }

  dispose(): void {
    this.stopAll();
  }
}
