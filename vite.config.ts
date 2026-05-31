import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Multi-page static build (ARCHITECTURE.md §7, §11 Q11). Each page is a real
// HTML entry → real static file → refresh-safe + crawler-indexable with no
// server. The game id rides in `?game=` (client-only), so these stay static.
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: entry('./index.html'), //         /          → library
        explore: entry('./explore/index.html'), // /explore/  → resource explorer
        play: entry('./play/index.html'), //     /play/     → player
      },
    },
  },
});
