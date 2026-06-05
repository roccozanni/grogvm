import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { docsPlugin } from './src/build/docs-plugin';
import { writeAppPages, appPageInputs } from './src/build/app-pages';

// One page model (ARCHITECTURE.md §8, §11 Q13): every page is markdown in
// `docs/`. Pages with a `script:` are *app* pages — the generator stages a real
// HTML entry + entry.ts under `.pages/` (gitignored) so Vite bundles the island;
// pages without one are static content emitted by `docsPlugin`. Both land in a
// single `dist/` over disjoint routes — refresh-safe, crawler-indexable, no
// server. App game ids still ride in `?game=` (client-only).
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const docsDir = entry('./docs');
const stagingRoot = entry('./.pages');

// Stage the app-page entries now so they exist as Vite inputs (build) and are
// served by `root` (dev). docsPlugin re-stages on edits during dev.
writeAppPages(docsDir, stagingRoot);

export default defineConfig({
  root: stagingRoot,
  plugins: [docsPlugin({ docsDir, siteCssPath: entry('./src/site/site.css'), stagingRoot })],
  server: {
    port: 5173,
  },
  build: {
    // `outDir` sits outside `root`, so `emptyOutDir` is required. Content pages
    // are appended by docsPlugin's closeBundle after this app build is written.
    outDir: entry('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: appPageInputs(docsDir, stagingRoot),
    },
  },
});
