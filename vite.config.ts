import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { contentPlugin } from './src/build/content-plugin';
import { writeAppPages, appPageInputs } from './src/build/app-pages';

// One page model (ARCHITECTURE.md §8, §11 Q13): every page is markdown under
// `pages/`, and its file path is its URL (`pages/index.md` → `/`,
// `pages/docs/scumm/room.md` → `/docs/scumm/room/`). Pages with a
// `script:` are *app* pages — the generator stages a real HTML entry + entry.ts
// under `.generated/` (gitignored) so Vite bundles the island; pages without one
// are static content emitted by `contentPlugin`. Both land in a single `dist/`
// over disjoint routes — refresh-safe, crawler-indexable, no server. App game
// ids still ride in `?game=` (client-only).
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const pagesDir = entry('./pages');
const stagingRoot = entry('./.generated');

// Stage the app-page entries now so they exist as Vite inputs (build) and are
// served by `root` (dev). contentPlugin re-stages on edits during dev.
writeAppPages(pagesDir, stagingRoot);

export default defineConfig({
  root: stagingRoot,
  plugins: [contentPlugin({ pagesDir, siteCssPath: entry('./src/site/site.css'), stagingRoot })],
  server: {
    port: 5173,
  },
  build: {
    // `outDir` sits outside `root`, so `emptyOutDir` is required. Content pages
    // are appended by contentPlugin's closeBundle after this app build is written.
    outDir: entry('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: appPageInputs(pagesDir, stagingRoot),
    },
  },
});
