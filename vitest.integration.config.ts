import { defineConfig } from 'vitest/config';

// Integration playthroughs that drive the REAL game files (under games/) and
// the saved games (under saves/). Kept OUT of the default `npm test` (which is
// fast, synthetic, data-free) because they need the copyrighted bytes — run
// them with `npm run test:integration`. Each suite self-skips when its data
// isn't present, so this stays green on a fresh checkout too.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['integration/**/*.test.ts'],
  },
});
