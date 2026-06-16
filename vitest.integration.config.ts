import { defineConfig } from 'vitest/config';

// Integration playthroughs that drive the REAL game files (under games/ by
// default, or wherever $GROG_GAME_DIR points) and the saved games (under
// saves/). Kept OUT of the default `npm test` (which is
// fast, synthetic, data-free) because they need the copyrighted bytes — run
// them with `npm run test:integration`. Each suite self-skips when its data
// isn't present, so this stays green on a fresh checkout too.
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
