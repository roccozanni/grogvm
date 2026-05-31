/**
 * The clock seam (ARCHITECTURE.md §5.9, §11 Q10).
 *
 * The engine must run headless in Node, but `requestAnimationFrame` is a
 * browser API. So `EngineSession` never calls rAF itself — it arms an
 * injected `Clock`. The browser supplies a rAF-backed clock (shell-side,
 * written in a later Phase-10 task); tests and Node drivers use the
 * {@link ManualClock} here, which advances time by hand. This is what makes
 * the whole game loop deterministically testable.
 */
export interface Clock {
  /**
   * Begin invoking `onTick(nowMs)` repeatedly until {@link stop}. `nowMs`
   * is a monotonic millisecond timestamp (e.g. `performance.now()` in the
   * browser; whatever the test feeds in `ManualClock`). The session uses it
   * to throttle to a target tick rate and to batch ticks when the clock
   * cadence runs slower than the rate.
   */
  start(onTick: (nowMs: number) => void): void;
  /** Stop invoking the callback. Safe to call when not started. */
  stop(): void;
}

/**
 * Headless clock: the caller drives time explicitly via {@link advance}.
 * No rAF, no `Date.now` — fully deterministic, so a test can step the
 * session loop one controlled timestamp at a time.
 */
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
