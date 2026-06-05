// Content-page presentation: the HTML shell + chrome wrapped around generated
// markdown. Pure strings, primitives only — `site` imports neither engine,
// platform, nor build.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Wrap rendered body HTML in the full site document (nav, <head>, /site.css). */
export function renderHtmlPage(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(opts.title)} — GrogVM</title>
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

/** The `/docs/` landing page body: a title + a list linking each doc. */
export function renderDocsIndex(pages: ReadonlyArray<{ route: string; title: string }>): string {
  const items = pages
    .map((p) => `      <li><a href="${p.route}">${escapeHtml(p.title)}</a></li>`)
    .join('\n');
  return `<h1>Documentation</h1>\n    <ul class="doc-list">\n${items}\n    </ul>`;
}
