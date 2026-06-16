import { defineConfig } from 'vitest/config';

// Integration playthroughs that drive the REAL game files (builds discovered
// under games/; see integration/catalog.ts) and the saved games (under
// saves/). Kept OUT of the default `npm test` (which is
// fast, synthetic, data-free) because they need the copyrighted bytes — run
// them with `npm run test:integration` (every installed variant), narrowing to
// one with `GROGVM_GAME_SELECTOR`. Each suite parameterizes over the selected
// builds and REQUIRES at least one to match: no game data, or a selector that
// matches nothing, fails the run (requireBuilds throws) rather than passing as a
// green no-op. CI runs only the synthetic suite + build, never this, so a
// checkout without the game bytes never hits that failure.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
    // (Default reporter. The beats carry `ctx.annotate(...)` progress notes — e.g.
    // the swordfight insults/comebacks/wins — but the default reporter hides
    // annotations on passing tests, so surface them ad-hoc with
    // `npm run test:integration -- --reporter=verbose` when you want them.)
  },
});
