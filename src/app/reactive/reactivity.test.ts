import { describe, it, expect, vi } from 'vitest';
import {
  signal,
  effect,
  computed,
  batch,
  untracked,
  createRoot,
  onCleanup,
} from './reactivity';

describe('signal', () => {
  it('reads, writes, and peeks', () => {
    const s = signal(1);
    expect(s()).toBe(1);
    s.set(2);
    expect(s()).toBe(2);
    s.set((p) => p + 10);
    expect(s.peek()).toBe(12);
  });

  it('ignores Object.is-equal writes', () => {
    const s = signal(1);
    const runs = vi.fn();
    effect(() => {
      s();
      runs();
    });
    expect(runs).toHaveBeenCalledTimes(1);
    s.set(1); // equal — no notify
    expect(runs).toHaveBeenCalledTimes(1);
    s.set(2);
    expect(runs).toHaveBeenCalledTimes(2);
  });
});

describe('effect', () => {
  it('runs immediately and re-runs on dependency change', () => {
    const s = signal(0);
    const seen: number[] = [];
    effect(() => seen.push(s()));
    s.set(1);
    s.set(2);
    expect(seen).toEqual([0, 1, 2]);
  });

  it('only re-runs for signals it actually read', () => {
    const a = signal(0);
    const b = signal(0);
    const runs = vi.fn();
    effect(() => {
      a();
      runs();
    });
    b.set(1); // not a dependency
    expect(runs).toHaveBeenCalledTimes(1);
    a.set(1);
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it('re-collects dependencies each run (conditional reads)', () => {
    const cond = signal(true);
    const a = signal('a');
    const b = signal('b');
    const seen: string[] = [];
    effect(() => seen.push(cond() ? a() : b()));
    expect(seen).toEqual(['a']);
    b.set('b2'); // b not yet a dep
    expect(seen).toEqual(['a']);
    cond.set(false); // now reads b, drops a
    expect(seen).toEqual(['a', 'b2']);
    a.set('a2'); // a no longer a dep
    expect(seen).toEqual(['a', 'b2']);
    b.set('b3');
    expect(seen).toEqual(['a', 'b2', 'b3']);
  });

  it('dispose stops further re-runs', () => {
    const s = signal(0);
    const runs = vi.fn();
    const dispose = effect(() => {
      s();
      runs();
    });
    s.set(1);
    expect(runs).toHaveBeenCalledTimes(2);
    dispose();
    s.set(2);
    expect(runs).toHaveBeenCalledTimes(2);
  });
});

describe('computed', () => {
  it('derives a value and updates when its sources change', () => {
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a() + b());
    expect(sum()).toBe(5);
    a.set(10);
    expect(sum()).toBe(13);
  });

  it('is itself trackable by effects', () => {
    const a = signal(1);
    const double = computed(() => a() * 2);
    const seen: number[] = [];
    effect(() => seen.push(double()));
    a.set(5);
    expect(seen).toEqual([2, 10]);
  });
});

describe('batch', () => {
  it('coalesces multiple writes into a single re-run', () => {
    const a = signal(0);
    const b = signal(0);
    const runs = vi.fn();
    effect(() => {
      a();
      b();
      runs();
    });
    expect(runs).toHaveBeenCalledTimes(1);
    batch(() => {
      a.set(1);
      b.set(1);
      a.set(2);
    });
    expect(runs).toHaveBeenCalledTimes(2); // one flush, not three
  });
});

describe('untracked', () => {
  it('reads without subscribing', () => {
    const a = signal(0);
    const b = signal(0);
    const runs = vi.fn();
    effect(() => {
      a();
      untracked(() => b());
      runs();
    });
    b.set(1); // read untracked — not a dep
    expect(runs).toHaveBeenCalledTimes(1);
    a.set(1);
    expect(runs).toHaveBeenCalledTimes(2);
  });
});

describe('ownership', () => {
  it('onCleanup runs before each re-run and on dispose', () => {
    const s = signal(0);
    const cleanups: number[] = [];
    const dispose = effect(() => {
      const v = s();
      onCleanup(() => cleanups.push(v));
    });
    expect(cleanups).toEqual([]);
    s.set(1); // cleanup for run with v=0 fires before re-run
    expect(cleanups).toEqual([0]);
    dispose(); // cleanup for run with v=1 fires on dispose
    expect(cleanups).toEqual([0, 1]);
  });

  it('createRoot disposes every effect created inside', () => {
    const s = signal(0);
    const runs = vi.fn();
    const dispose = createRoot((d) => {
      effect(() => {
        s();
        runs();
      });
      return d;
    });
    s.set(1);
    expect(runs).toHaveBeenCalledTimes(2);
    dispose();
    s.set(2);
    expect(runs).toHaveBeenCalledTimes(2); // owned effect torn down
  });

  it('disposes nested effects when the parent re-runs', () => {
    const outer = signal(0);
    const inner = signal(0);
    const innerRuns = vi.fn();
    effect(() => {
      outer();
      effect(() => {
        inner();
        innerRuns();
      });
    });
    expect(innerRuns).toHaveBeenCalledTimes(1);
    inner.set(1);
    expect(innerRuns).toHaveBeenCalledTimes(2);
    // Re-running the outer disposes the old inner effect and makes a new one.
    outer.set(1);
    expect(innerRuns).toHaveBeenCalledTimes(3);
    inner.set(2); // only the new inner effect should react (not the stale one)
    expect(innerRuns).toHaveBeenCalledTimes(4);
  });
});
