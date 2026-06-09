// Vite plugin for the content pages (pages/*.md without a `script:`): static
// HTML served by middleware in dev, emitted into dist/ on build. Also owns the
// site-wide statics (/site.css, favicon, robots, sitemap, 404.html).
import type { Plugin } from 'vite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadPages, renderBody, routeToOutputPath, type Page } from './generate';
import { renderDocument, SITE_URL } from '../site/layout';
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
  const favicon = (): string => readFileSync(join(dirname(siteCssPath), 'favicon.svg'), 'utf8');
  const pageHtml = (page: Page): string =>
    renderDocument({
      title: page.title,
      route: page.route,
      description: page.description ?? undefined,
      bodyHtml: renderBody(readFileSync(page.file, 'utf8'), page.file, pagesDir),
    });

  // Every real route (content + app islands), in stable order, for the sitemap.
  const sitemap = (): string => {
    const urls = loadPages(pagesDir)
      .map((p) => `  <url><loc>${SITE_URL}${p.route}</loc></url>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  };

  const robots = (): string => `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

  const notFoundHtml = (): string =>
    renderDocument({
      title: 'Not found',
      route: '/404.html',
      description: 'That page isn’t here.',
      index: false,
      bodyHtml: `<h1>Lost in the swamp</h1>
<p>That page isn’t here. Head back to the <a href="/">home page</a>, the
<a href="/library/">library</a>, or the <a href="/docs/">documentation</a>.</p>`,
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
        const statics: Record<string, [string, () => string]> = {
          '/site.css': ['text/css', siteCss],
          '/favicon.svg': ['image/svg+xml', favicon],
          '/robots.txt': ['text/plain', robots],
          '/sitemap.xml': ['application/xml', sitemap],
        };
        const asset = raw ? statics[raw] : undefined;
        if (asset) {
          res.setHeader('Content-Type', asset[0]);
          res.end(asset[1]());
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

    // Runs after Vite has written the app build — appends the static content
    // pages and the site-wide files.
    closeBundle() {
      if (!isBuild) return;
      const write = (rel: string, body: string): void => {
        const path = join(outDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      };
      write('site.css', siteCss());
      write('favicon.svg', favicon());
      write('robots.txt', robots());
      write('sitemap.xml', sitemap());
      write('404.html', notFoundHtml());
      for (const page of contentPages()) write(routeToOutputPath(page.route), pageHtml(page));
    },
  };
}
