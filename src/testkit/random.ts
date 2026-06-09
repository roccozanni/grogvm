/**
 * Seeded entropy source (mulberry32) for reproducible playthroughs — see
 * pages/docs/engine/harness.md §4. NOT the original DOS interpreter's RNG
 * (the bytecode doesn't define one): reproducible, not matching 1990 output.
 */

/** A deterministic `() => number` in `[0, 1)`; same seed → same stream. */
export function makeSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
