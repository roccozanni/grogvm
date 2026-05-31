/**
 * A tiny fine-grained reactivity kernel — the one owned primitive the
 * rebuilt shell is allowed (ARCHITECTURE.md §7, Q9). No dependency, fully
 * unit-testable in Node. It exists to kill the old shell's hand-rolled
 * per-tick DOM diffing: bind a piece of DOM with `effect`, and only that
 * binding re-runs when a `signal` it read changes.
 *
 * Model (Solid-like, deliberately small):
 *   - `signal`   — a readable/writable reactive value.
 *   - `effect`   — runs now, re-runs when any signal it READ changes.
 *   - `computed` — a derived read-only value.
 *   - `batch` / `untracked` — coalesce writes / read without subscribing.
 *   - `createRoot` / `onCleanup` — ownership, so a component can dispose
 *     every effect it created in one call.
 *
 * Notification is synchronous (a write re-runs dependents immediately)
 * unless inside `batch`. Dependencies are re-collected on every run, so
 * conditional reads track correctly.
 */

export type Accessor<T> = () => T;

export interface Signal<T> {
  (): T;
  /** Write a new value (or an updater). No-op if `Object.is`-equal. */
  set(next: T | ((prev: T) => T)): void;
  /** Read without subscribing the current effect. */
  peek(): T;
}

interface SignalState<T> {
  value: T;
  observers: Set<Computation>;
}

/** An owner collects child computations + cleanups so it can dispose them. */
interface Owner {
  cleanups: Array<() => void>;
  children: Computation[];
}

interface Computation extends Owner {
  fn: () => void;
  deps: Set<SignalState<unknown>>;
  disposed: boolean;
}

let currentObserver: Computation | null = null;
let currentOwner: Owner | null = null;
let batchDepth = 0;
const pending = new Set<Computation>();

export function signal<T>(initial: T): Signal<T> {
  const state: SignalState<T> = { value: initial, observers: new Set() };

  const read = Object.assign(
    (): T => {
      if (currentObserver) {
        currentObserver.deps.add(state as SignalState<unknown>);
        state.observers.add(currentObserver);
      }
      return state.value;
    },
    {
      set(next: T | ((prev: T) => T)): void {
        const value =
          typeof next === 'function' ? (next as (prev: T) => T)(state.value) : next;
        if (Object.is(value, state.value)) return;
        state.value = value;
        const observers = [...state.observers];
        if (batchDepth > 0) {
          for (const o of observers) pending.add(o);
        } else {
          for (const o of observers) runComputation(o);
        }
      },
      peek: (): T => state.value,
    },
  );

  return read as Signal<T>;
}

export function effect(fn: () => void): () => void {
  const comp: Computation = {
    fn,
    deps: new Set(),
    cleanups: [],
    children: [],
    disposed: false,
  };
  currentOwner?.children.push(comp);
  runComputation(comp);
  return () => disposeComputation(comp);
}

export function computed<T>(fn: () => T): Accessor<T> {
  const state = signal<T>(undefined as T);
  effect(() => state.set(fn()));
  return () => state();
}

export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const toRun = [...pending];
      pending.clear();
      for (const comp of toRun) runComputation(comp);
    }
  }
}

export function untracked<T>(fn: () => T): T {
  const prev = currentObserver;
  currentObserver = null;
  try {
    return fn();
  } finally {
    currentObserver = prev;
  }
}

/**
 * Run `fn` inside a fresh ownership scope. Every effect created within is
 * owned by it; calling the passed `dispose` tears them all down. The home
 * for a component subtree's lifetime.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const owner: Owner = { cleanups: [], children: [] };
  const prevOwner = currentOwner;
  const prevObserver = currentObserver;
  currentOwner = owner;
  currentObserver = null;
  const dispose = (): void => {
    for (const child of owner.children) disposeComputation(child);
    owner.children.length = 0;
    for (const c of owner.cleanups) c();
    owner.cleanups.length = 0;
  };
  try {
    return fn(dispose);
  } finally {
    currentOwner = prevOwner;
    currentObserver = prevObserver;
  }
}

/** Register a cleanup with the current owner (an effect, or a root). Runs
 *  before the effect's next re-run and when the owner is disposed. */
export function onCleanup(fn: () => void): void {
  currentOwner?.cleanups.push(fn);
}

// ── internals ──────────────────────────────────────────────────────────

function runComputation(comp: Computation): void {
  if (comp.disposed) return;
  cleanup(comp);
  const prevObserver = currentObserver;
  const prevOwner = currentOwner;
  currentObserver = comp;
  currentOwner = comp;
  try {
    comp.fn();
  } finally {
    currentObserver = prevObserver;
    currentOwner = prevOwner;
  }
}

/** Run pending cleanups, dispose child computations, and unlink dependencies
 *  — everything that must reset before a re-run (or a dispose). */
function cleanup(comp: Computation): void {
  for (const c of comp.cleanups) c();
  comp.cleanups.length = 0;
  for (const child of comp.children) disposeComputation(child);
  comp.children.length = 0;
  for (const dep of comp.deps) dep.observers.delete(comp);
  comp.deps.clear();
}

function disposeComputation(comp: Computation): void {
  if (comp.disposed) return;
  comp.disposed = true;
  cleanup(comp);
}
