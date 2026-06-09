// App-page staging: pages/*.md with a `script:` need Vite to bundle their
// island, so the generator writes a real HTML entry + a co-located entry.ts
// into a gitignored staging root that Vite uses as `root`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadPages, routeToOutputPath, renderBody, composeIslandBody, type Page } from './generate';
import { renderDocument } from '../site/layout';
import { readFileSync } from 'node:fs';

const appPages = (pagesDir: string): Page[] => loadPages(pagesDir).filter((p) => p.island !== null);

/** `../` back to repo root from a staged page at `<root>/<route>/index.html`. */
function srcPrefix(route: string): string {
  const depth = routeToOutputPath(route).split('/').length; // 'library/index.html' → 2
  return '../'.repeat(depth);
}

function entrySource(page: Page): string {
  const prefix = srcPrefix(page.route);
  // The island imports its own scoped stylesheets (base + its screen), so the
  // entry only needs to hydrate — no styles barrel.
  return `import { mount } from '${prefix}src/${page.island}';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root element');
mount(root);
`;
}

export function writeAppPages(pagesDir: string, stagingRoot: string): void {
  for (const page of appPages(pagesDir)) {
    const htmlPath = join(stagingRoot, routeToOutputPath(page.route));
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(join(dirname(htmlPath), 'entry.ts'), entrySource(page));
    const bodyHtml = composeIslandBody(
      renderBody(readFileSync(page.file, 'utf8'), page.file, pagesDir),
    );
    writeFileSync(
      htmlPath,
      renderDocument({
        title: page.title,
        route: page.route,
        description: page.description ?? undefined,
        entrySrc: './entry.ts',
        bodyHtml,
      }),
    );
  }
}

/** Rollup multi-page inputs keyed by slug → staged HTML path. */
export function appPageInputs(pagesDir: string, stagingRoot: string): Record<string, string> {
  return Object.fromEntries(
    appPages(pagesDir).map((p) => [p.slug, join(stagingRoot, routeToOutputPath(p.route))]),
  );
}
