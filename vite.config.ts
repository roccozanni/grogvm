import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { docsPlugin } from './src/build/docs-plugin';

// Multi-page static build (ARCHITECTURE.md §7, §11 Q11). Each page is a real
// HTML entry → real static file → refresh-safe + crawler-indexable with no
// server. The game id rides in `?game=` (client-only), so these stay static.
//
// The HTML entries live under `pages/` (not the repo root), so Vite's `root`
// points there. The served URLs are unchanged — `pages/` is the doc root, so
// `pages/index.html` → `/`, `pages/explore/index.html` → `/explore/`, etc.
//
// `docsPlugin` (§9 Phase 12) renders the content pages from `docs/*.md`: the
// app pages above are bundled by Vite, the /docs/* pages are generated. They
// merge into one `dist/` over disjoint routes. (Stage 3 folds the app pages
// into markdown too, retiring `pages/`.)
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: entry('./pages'),
  plugins: [
    docsPlugin({ docsDir: entry('./docs'), siteCssPath: entry('./src/site/site.css') }),
  ],
  server: {
    port: 5173,
  },
  build: {
    // `outDir` is resolved relative to `root`; keep the build at the repo-root
    // `dist/`. `emptyOutDir` is required since it sits outside `root`.
    outDir: entry('./dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: entry('./pages/index.html'), //         /          → library
        explore: entry('./pages/explore/index.html'), // /explore/  → resource explorer
        play: entry('./pages/play/index.html'), //     /play/     → player
      },
    },
  },
});
