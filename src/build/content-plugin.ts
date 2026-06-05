// Vite plugin for the content pages (§9 Phase 12). Content pages (pages/*.md
// without a `script:`) are static HTML wrapped in the site layout: served by
// middleware in dev, emitted into dist/ in build. App pages (with `script:`)
// are bundled by Vite from the staging root (see app-pages.ts) — this plugin
// only re-stages them on dev edits. The two producers write disjoint routes.
import type { Plugin } from 'vite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadPages, renderBody, routeToOutputPath, type Page } from './generate';
import { renderDocument } from '../site/layout';
import { writeAppPages } from './app-pages';

export interface ContentPluginOptions {
  pagesDir: string;
  siteCssPath: string;
  stagingRoot: string;
}

export function contentPlugin({ pagesDir, siteCssPath, stagingRoot }: ContentPluginOptions): Plugin {
  let outDir = 'dist';
  let isBuild = false;

  const contentPages = (): Page[] => loadPages(pagesDir).filter((p) => p.island === null);

  const siteCss = (): string => readFileSync(siteCssPath, 'utf8');
  const pageHtml = (page: Page): string =>
    renderDocument({
      title: page.title,
      bodyHtml: renderBody(readFileSync(page.file, 'utf8'), page.file, pagesDir),
    });

  const normalize = (url: string): string => {
    const u = url.split('?')[0]!.replace(/index\.html$/, '');
    return u === '/' ? u : u.endsWith('/') ? u : `${u}/`;
  };

  return {
    name: 'grogvm-content',

    configResolved(config) {
      outDir = config.build.outDir;
      isBuild = config.command === 'build';
    },

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = (req.url ?? '').split('?')[0];
        if (raw === '/site.css') {
          res.setHeader('Content-Type', 'text/css');
          res.end(siteCss());
          return;
        }
        const url = normalize(req.url ?? '');
        const page = contentPages().find((p) => p.route === url);
        if (page) {
          res.setHeader('Content-Type', 'text/html');
          res.end(pageHtml(page));
          return;
        }
        next(); // app pages + assets are Vite's
      });

      const onChange = (file: string): void => {
        if (file.startsWith(pagesDir) || file.startsWith(dirname(siteCssPath))) {
          writeAppPages(pagesDir, stagingRoot); // re-stage in case an app page's md changed
          server.ws.send({ type: 'full-reload', path: '*' });
        }
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },

    // Runs after Vite has written the app build — append the static content pages.
    closeBundle() {
      if (!isBuild) return;
      const write = (rel: string, body: string): void => {
        const path = join(outDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      };
      write('site.css', siteCss());
      for (const page of contentPages()) write(routeToOutputPath(page.route), pageHtml(page));
    },
  };
}
