/** The clock seam (pages/docs/engine/session.md §1). */
export interface Clock {
  /** Begin invoking `onTick(nowMs)` until {@link stop}. `nowMs` is a monotonic ms timestamp. */
  start(onTick: (nowMs: number) => void): void;
  /** Safe to call when not started. */
  stop(): void;
}

/** Headless, deterministic clock — the caller drives time via {@link advance}. */
export class ManualClock implements Clock {
  private cb: ((nowMs: number) => void) | null = null;
  private now = 0;

  start(onTick: (nowMs: number) => void): void {
    this.cb = onTick;
  }

  stop(): void {
    this.cb = null;
  }

  /** Advance the clock by `deltaMs` and fire exactly one tick at the new time. */
  advance(deltaMs: number): void {
    this.now += deltaMs;
    this.cb?.(this.now);
  }

  /** True while a callback is armed (i.e. between start and stop). */
  get running(): boolean {
    return this.cb !== null;
  }

  /** Current virtual time in ms. */
  get time(): number {
    return this.now;
  }
}
