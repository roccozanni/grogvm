// Vite plugin that turns docs/*.md into static content pages (§9 Phase 12).
// Dev: middleware renders /docs/* on request and reloads when docs/ or site/
// change. Build: emits dist/docs/**/index.html + dist/site.css after Vite's
// own (app) output. App pages are untouched — the two producers write into
// disjoint route namespaces (app owns /, /explore, /play; content owns /docs/*).
import type { Plugin } from 'vite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { listDocs, renderBody } from './generate';
import { renderHtmlPage, renderDocsIndex } from '../site/layout';

export interface DocsPluginOptions {
  docsDir: string;
  siteCssPath: string;
}

export function docsPlugin({ docsDir, siteCssPath }: DocsPluginOptions): Plugin {
  let outDir = 'dist';
  let isBuild = false;

  const siteCss = (): string => readFileSync(siteCssPath, 'utf8');

  const indexHtml = (): string =>
    renderHtmlPage({ title: 'Documentation', bodyHtml: renderDocsIndex(listDocs(docsDir)) });

  const pageHtml = (slug: string): string | null => {
    const doc = listDocs(docsDir).find((d) => d.slug === slug);
    if (!doc) return null;
    return renderHtmlPage({ title: doc.title, bodyHtml: renderBody(readFileSync(doc.file, 'utf8')) });
  };

  return {
    name: 'grogvm-docs',

    configResolved(config) {
      outDir = config.build.outDir;
      isBuild = config.command === 'build';
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!.replace(/index\.html$/, '');
        if (url === '/site.css') {
          res.setHeader('Content-Type', 'text/css');
          res.end(siteCss());
          return;
        }
        if (url === '/docs' || url === '/docs/') {
          res.setHeader('Content-Type', 'text/html');
          res.end(indexHtml());
          return;
        }
        const m = /^\/docs\/([a-z0-9-]+)\/?$/.exec(url);
        const html = m ? pageHtml(m[1]!) : null;
        if (html) {
          res.setHeader('Content-Type', 'text/html');
          res.end(html);
          return;
        }
        next();
      });

      const reload = (file: string): void => {
        if (file.startsWith(docsDir) || file.startsWith(dirname(siteCssPath))) {
          server.ws.send({ type: 'full-reload', path: '*' });
        }
      };
      server.watcher.on('change', reload);
      server.watcher.on('add', reload);
      server.watcher.on('unlink', reload);
    },

    // Runs after Vite has written the app build — append the content pages.
    closeBundle() {
      if (!isBuild) return;
      const write = (rel: string, body: string): void => {
        const path = join(outDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      };
      write('site.css', siteCss());
      write('docs/index.html', indexHtml());
      for (const doc of listDocs(docsDir)) write(`docs/${doc.slug}/index.html`, pageHtml(doc.slug)!);
    },
  };
}
