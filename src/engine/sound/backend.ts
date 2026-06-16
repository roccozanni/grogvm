/** The audio seam — single authority on "is this sound playing". See pages/docs/engine/audio.md. */

import type { SoundRendition, SoundResource } from './resource';

/** Backend-agnostic snapshot of the active-sound map, for savestate. */
export interface SoundSnapshot {
  /** `[soundId, remainingJiffies, looping]` per still-active sound. */
  readonly active: ReadonlyArray<[number, number, boolean]>;
}

/**
 * Re-acquires a sound's parsed descriptor by id. The snapshot stores ids,
 * not renditions, so an output backend needs this to rebuild its real voices
 * on {@link AudioBackend.restore}.
 */
export type SoundResourceResolver = (id: number) => SoundResource;

/**
 * One active sound as the live inspector sees it: what the VM *believes* is
 * playing. Read-only — derived from the same state {@link AudioBackend.isRunning}
 * reads, so observing it can never perturb timing. PCM/CD renditions are
 * audible; `midi` (the AdLib effects) and `silent` are timed but produce no
 * output yet (the panel flags them disabled). `kind` is `'unknown'` for a
 * sound restored from a save — the snapshot stores ids, not renditions.
 */
export interface ActiveSoundInfo {
  readonly id: number;
  readonly kind: SoundRendition['kind'] | 'unknown';
  /** MIDI device, when `kind === 'midi'`. */
  readonly device?: 'ADL' | 'ROL' | 'SPK';
  /** The sound's full length in jiffies (1/60 s); 0 when looping or unknown. */
  readonly total: number;
  readonly looping: boolean;
  /** The single music slot points at this id. */
  readonly isMusic: boolean;
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
  /** Read-only view of every active sound, for the live inspector. */
  inspect(): readonly ActiveSoundInfo[];
  /** Advance the clock by `jiffies`; the VM ticks this once per jiffy. */
  advance(jiffies: number): void;
  serialize(): SoundSnapshot;
  /**
   * Replace the active-sound map with `snap`. `resolve` re-acquires each
   * sound's rendition so an output backend can rebuild the real voices the
   * snapshot can't carry; a timing-only backend ignores it.
   */
  restore(snap: SoundSnapshot, resolve: SoundResourceResolver): void;
  dispose(): void;
}

interface ActiveSound {
  remaining: number;
  looping: boolean;
  /** Display-only; never read by timing. `'unknown'` after a restore. */
  kind: SoundRendition['kind'] | 'unknown';
  device?: 'ADL' | 'ROL' | 'SPK';
  /** Full length in jiffies, kept so the inspector shows duration (not a countdown). */
  total: number;
}

/** Pull the inspector's display fields off a sound's rendition. */
function renditionInfo(res: SoundResource): Pick<ActiveSound, 'kind' | 'device'> {
  const r = res.rendition;
  return r.kind === 'midi' ? { kind: 'midi', device: r.device } : { kind: r.kind };
}

/**
 * Timing-faithful, silent: counts down each sound's real duration so
 * `isRunning` flips false exactly when the real sound would have ended.
 */
export class SilentTimingBackend implements AudioBackend {
  private readonly active = new Map<number, ActiveSound>();
  /** The single music slot — at most one music id plays at a time. */
  private music: number | null = null;

  startSound(id: number, res: SoundResource): void {
    this.active.set(id, {
      remaining: res.durationJiffies,
      looping: res.looping,
      total: res.durationJiffies,
      ...renditionInfo(res),
    });
  }

  stopSound(id: number): void {
    this.active.delete(id);
    if (this.music === id) this.music = null;
  }

  startMusic(id: number, res: SoundResource): void {
    if (this.music !== null) this.active.delete(this.music);
    this.music = id;
    this.active.set(id, { remaining: 0, looping: true, total: 0, ...renditionInfo(res) });
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

  inspect(): readonly ActiveSoundInfo[] {
    const out: ActiveSoundInfo[] = [];
    for (const [id, s] of this.active) {
      out.push({ id, kind: s.kind, device: s.device, total: s.total, looping: s.looping, isMusic: this.music === id });
    }
    return out;
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
      // Timing only — the snapshot carries no rendition, so kind stays
      // 'unknown' here; an output backend re-resolves it to rebuild voices.
      this.active.set(id, { remaining, looping, kind: 'unknown', total: 0 });
      if (looping) this.music = id; // best-effort: the looping entry is the music slot
    }
  }

  dispose(): void {
    this.stopAll();
  }
}
