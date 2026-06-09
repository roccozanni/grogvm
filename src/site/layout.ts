// The shared HTML shell wrapped around every page. Pure strings, primitives
// only — `site` imports neither engine, platform, nor build.

const SITE = 'GrogVM';
export const SITE_URL = 'https://grogvm.dev';
const DEFAULT_DESCRIPTION =
  'A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one ' +
  'behind The Secret of Monkey Island and Monkey Island 2 — running in the ' +
  'browser, with no server and no emulator.';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** `<title>` text — suffix the site name, but don't repeat it for the home page. */
function titleTag(title: string): string {
  return escapeHtml(title === SITE ? SITE : `${title} — ${SITE}`);
}

/**
 * Render a full page document. `entrySrc` (app pages only) loads the island
 * bundle; `route` drives the canonical + og:url; `index: false` marks a page
 * crawlers should skip (the 404).
 */
export function renderDocument(opts: {
  title: string;
  route: string;
  description?: string;
  bodyHtml?: string;
  entrySrc?: string;
  index?: boolean;
}): string {
  const mount = opts.entrySrc
    ? `      <script type="module" src="${opts.entrySrc}"></script>\n`
    : '';
  // Content pages add `.prose` for markdown typography; app pages wrap their
  // own prose blocks so the `#app` island stays outside `.prose`.
  const mainClass = opts.entrySrc ? 'content' : 'content prose';
  const description = escapeHtml(opts.description?.trim() || DEFAULT_DESCRIPTION);
  const url = escapeHtml(`${SITE_URL}${opts.route}`);
  const ogTitle = escapeHtml(opts.title === SITE ? SITE : opts.title);
  // The 404 is reachable but shouldn't be indexed or claim a canonical URL.
  const indexable = opts.index !== false;
  const discovery = indexable
    ? `    <link rel="canonical" href="${url}" />\n`
    : `    <meta name="robots" content="noindex" />\n`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleTag(opts.title)}</title>
    <meta name="description" content="${description}" />
${discovery}    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE}" />
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${ogTitle}" />
    <meta name="twitter:description" content="${description}" />
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body>
    <header class="site-nav"><a href="/">GrogVM</a> · <a href="/library/">Library</a> · <a href="/docs/">Docs</a></header>
    <main class="${mainClass}">
${opts.bodyHtml ?? ''}
${mount}    </main>
    <footer class="site-footer">
      Free software under <a href="https://www.gnu.org/licenses/gpl-3.0.html">GPL-3.0-or-later</a> ·
      <a href="https://github.com/roccozanni/grogvm">source</a> ·
      engine logic derived in part from <a href="https://www.scummvm.org/">ScummVM</a>
      (<a href="/docs/scummvm-cpp-exposure-audit/">provenance</a>) ·
      bring your own MI1 / MI2 — no game assets bundled ·
      <a href="/privacy/">privacy &amp; terms</a>
    </footer>
  </body>
</html>
`;
}
