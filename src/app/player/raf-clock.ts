import type { Clock } from '../../engine/session';

/**
 * Shell-side Clock for the EngineSession (pages/docs/engine/session.md §1):
 * one `onTick` per animation frame, stamped with `performance.now()`.
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
