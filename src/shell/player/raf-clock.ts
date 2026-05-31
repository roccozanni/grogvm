import type { Clock } from '../../engine/session';

/**
 * Browser clock for the EngineSession: drives `onTick` once per
 * `requestAnimationFrame` with a `performance.now()` timestamp. This is the
 * shell-side `Clock` the engine never reaches for itself (ARCHITECTURE.md
 * §5.9, §11 Q10) — keeping `requestAnimationFrame` out of the engine.
 */
export class RafClock implements Clock {
  private rafId: number | null = null;

  start(onTick: (nowMs: number) => void): void {
    this.stop();
    const loop = (): void => {
      this.rafId = requestAnimationFrame(loop);
      onTick(performance.now());
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
