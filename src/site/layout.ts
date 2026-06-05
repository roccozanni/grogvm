// The shared HTML shell wrapped around every page — content (home, docs) and
// app (library, explore, play) alike. One document, one nav, one /site.css.
// Pure strings, primitives only — `site` imports neither engine, platform, nor
// build.

const SITE = 'GrogVM';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** `<title>` text — suffix the site name, but don't repeat it for the home page. */
function titleTag(title: string): string {
  return escapeHtml(title === SITE ? SITE : `${title} — ${SITE}`);
}

/**
 * Render a full page document. Content pages pass `bodyHtml` (rendered
 * markdown); app pages pass `entrySrc` to mount their island into `#app` (and
 * optionally `bodyHtml` for prose above it). Both get the same nav, frame, and
 * /site.css. `entrySrc` is bundled by Vite from the staging root.
 */
export function renderDocument(opts: { title: string; bodyHtml?: string; entrySrc?: string }): string {
  const mount = opts.entrySrc
    ? `      <div id="app"></div>\n      <script type="module" src="${opts.entrySrc}"></script>\n`
    : '';
  // `.content` is the shared frame; content pages add `.prose` for markdown
  // typography (app screens opt out so their dense layout stays untouched).
  const mainClass = opts.entrySrc ? 'content' : 'content prose';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleTag(opts.title)}</title>
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body>
    <header class="site-nav"><a href="/">GrogVM</a> · <a href="/library/">Library</a> · <a href="/docs/">Docs</a></header>
    <main class="${mainClass}">
${opts.bodyHtml ?? ''}
${mount}    </main>
  </body>
</html>
`;
}
