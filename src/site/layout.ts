// Content-page presentation: the HTML shell + chrome wrapped around generated
// markdown. Pure strings, primitives only — `site` imports neither engine,
// platform, nor build.

const SITE = 'GrogVM';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** `<title>` text — suffix the site name, but don't repeat it for the home page. */
function titleTag(title: string): string {
  return escapeHtml(title === SITE ? SITE : `${title} — ${SITE}`);
}

/** Wrap rendered body HTML in the full site document (nav, <head>, /site.css). */
export function renderHtmlPage(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleTag(opts.title)}</title>
    <link rel="stylesheet" href="/site.css" />
  </head>
  <body>
    <header class="site-nav"><a href="/">GrogVM</a> · <a href="/docs/">Docs</a></header>
    <main class="content">
${opts.bodyHtml}
    </main>
  </body>
</html>
`;
}

/**
 * The shell for an *app* page: any markdown prose, the `#app` mount point, and
 * the entry script that hydrates the island. No site chrome or /site.css — app
 * pages bring their own styles via the entry. `entrySrc` is bundled by Vite.
 */
export function renderAppShell(opts: { title: string; entrySrc: string; bodyHtml?: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${titleTag(opts.title)}</title>
  </head>
  <body>
${opts.bodyHtml ?? ''}
    <div id="app"></div>
    <script type="module" src="${opts.entrySrc}"></script>
  </body>
</html>
`;
}

/** The `/docs/` landing page body: a title + a list linking each doc. */
export function renderDocsIndex(pages: ReadonlyArray<{ route: string; title: string }>): string {
  const items = pages
    .map((p) => `      <li><a href="${p.route}">${escapeHtml(p.title)}</a></li>`)
    .join('\n');
  return `<h1>Documentation</h1>\n    <ul class="doc-list">\n${items}\n    </ul>`;
}
