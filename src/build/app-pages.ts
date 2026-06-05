// App-page staging (§9 Phase 12). App pages (docs/*.md with a `script:`) need
// Vite to bundle their island, so the generator writes a real HTML entry + a
// co-located entry.ts into a gitignored staging root that Vite uses as `root`.
// Content pages stay static (docs-plugin). The staging entry.ts mirrors the
// thin caller the old pages/**/index.ts used — just generated, not authored.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadPages, routeToOutputPath, renderBody, type Page } from './generate';
import { renderAppShell } from '../site/layout';
import { readFileSync } from 'node:fs';

const appPages = (docsDir: string): Page[] => loadPages(docsDir).filter((p) => p.island !== null);

/** `../` back to repo root from a staged page at `<root>/<route>/index.html`. */
function srcPrefix(route: string): string {
  const depth = routeToOutputPath(route).split('/').length; // 'library/index.html' → 2
  return '../'.repeat(depth);
}

function entrySource(page: Page): string {
  const prefix = srcPrefix(page.route);
  return `import '${prefix}src/styles/index.css';
import { mount } from '${prefix}src/${page.island}';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');
mount(root);
`;
}

/** Write each app page's HTML entry + entry.ts into the staging root. */
export function writeAppPages(docsDir: string, stagingRoot: string): void {
  for (const page of appPages(docsDir)) {
    const htmlPath = join(stagingRoot, routeToOutputPath(page.route));
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(join(dirname(htmlPath), 'entry.ts'), entrySource(page));
    const bodyHtml = renderBody(readFileSync(page.file, 'utf8')).trim();
    writeFileSync(
      htmlPath,
      renderAppShell({ title: page.title, entrySrc: './entry.ts', bodyHtml: bodyHtml || undefined }),
    );
  }
}

/** Rollup multi-page inputs keyed by slug → staged HTML path. */
export function appPageInputs(docsDir: string, stagingRoot: string): Record<string, string> {
  return Object.fromEntries(
    appPages(docsDir).map((p) => [p.slug, join(stagingRoot, routeToOutputPath(p.route))]),
  );
}
