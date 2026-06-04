/**
 * Seeded entropy source for reproducible playthroughs. The engine's
 * `getRandomNumber` opcode draws from an injectable source (see
 * `VmInit.random`); the app uses `Math.random` for live play, while the
 * integration playthrough injects one of these so a scripted run is
 * bit-for-bit identical every time — a regression net you run each
 * session can't be flaky.
 *
 * This is `mulberry32` — a small, well-distributed 32-bit PRNG. It is
 * NOT bit-identical to the original DOS interpreter's RNG (the bytecode
 * doesn't define one), so "faithful" here means *reproducible across
 * runs*, not *matching 1990 output*. Lives in `testkit/` (test-only); the
 * engine never imports it.
 */

/**
 * A deterministic `() => number` in `[0, 1)`, seeded by `seed`. Same seed
 * → same stream. Suitable for {@link bootScummV5}'s `random` argument.
 */
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
