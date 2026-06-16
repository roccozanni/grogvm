// Vite plugin for the content pages (pages/*.md without a `script:`): static
// HTML served by middleware in dev, emitted into dist/ on build. Also owns the
// site-wide statics (/site.css, favicon, robots, sitemap, llms.txt, 404.html).
import type { Plugin } from 'vite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  loadPages,
  renderBody,
  routeToOutputPath,
  routeToMarkdownPath,
  publishMarkdown,
  llmsTxt,
  type Page,
} from './generate';
import { renderDocument, SITE, SITE_URL, DEFAULT_DESCRIPTION } from '../site/layout';
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
  const heroSvg = (): string => readFileSync(join(dirname(siteCssPath), 'grogvm.svg'), 'utf8');
  const ogImage = (): Buffer => readFileSync(join(dirname(siteCssPath), 'og.png'));
  const pageHtml = (page: Page): string =>
    renderDocument({
      title: page.title,
      route: page.route,
      description: page.description ?? undefined,
      index: !page.noindex,
      bodyHtml: renderBody(readFileSync(page.file, 'utf8'), page.file, pagesDir),
    });

  // Every indexable route (content + app islands), in stable order, for the
  // sitemap — noindex pages are omitted (listing a noindex URL is contradictory).
  const sitemap = (): string => {
    const urls = loadPages(pagesDir)
      .filter((p) => !p.noindex)
      .map((p) => `  <url><loc>${SITE_URL}${p.route}</loc></url>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  };

  const robots = (): string => `User-agent: *
Content-Signal: ai-train=no, search=yes, ai-input=yes
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

  // The /llms.txt navigation map for agents (llmstxt.org), linking the markdown
  // companion of each page.
  const llms = (): string =>
    llmsTxt(loadPages(pagesDir), { siteName: SITE, summary: DEFAULT_DESCRIPTION, siteUrl: SITE_URL });

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
        // Text responses carry charset=utf-8 — the content (em-dashes, arrows) is
        // UTF-8, and without the charset browsers fall back to Latin-1 (mojibake).
        const statics: Record<string, [string, () => string | Buffer]> = {
          '/site.css': ['text/css; charset=utf-8', siteCss],
          '/favicon.svg': ['image/svg+xml; charset=utf-8', favicon],
          '/grogvm.svg': ['image/svg+xml; charset=utf-8', heroSvg],
          '/og.png': ['image/png', ogImage],
          '/robots.txt': ['text/plain; charset=utf-8', robots],
          '/sitemap.xml': ['application/xml; charset=utf-8', sitemap],
          '/llms.txt': ['text/plain; charset=utf-8', llms],
        };
        const asset = raw ? statics[raw] : undefined;
        if (asset) {
          res.setHeader('Content-Type', asset[0]);
          res.end(asset[1]());
          return;
        }
        if (raw && raw.toLowerCase().endsWith('.md')) {
          const rel = raw.replace(/^\/+/, '').toLowerCase();
          const page = loadPages(pagesDir).find((p) => routeToMarkdownPath(p.route) === rel);
          if (page) {
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.end(publishMarkdown(readFileSync(page.file, 'utf8'), page.file, pagesDir));
            return;
          }
        }
        const url = normalize(req.url ?? '');
        const page = contentPages().find((p) => p.route === url);
        if (page) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
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
      const write = (rel: string, body: string | Buffer): void => {
        const path = join(outDir, rel);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      };
      write('site.css', siteCss());
      write('favicon.svg', favicon());
      write('grogvm.svg', heroSvg());
      write('og.png', ogImage());
      write('robots.txt', robots());
      write('sitemap.xml', sitemap());
      write('llms.txt', llms());
      write('404.html', notFoundHtml());
      for (const page of contentPages()) write(routeToOutputPath(page.route), pageHtml(page));
      // The markdown companion of every page (content + app) at `<page url>.md`.
      for (const page of loadPages(pagesDir))
        write(routeToMarkdownPath(page.route), publishMarkdown(readFileSync(page.file, 'utf8'), page.file, pagesDir));
    },
  };
}
