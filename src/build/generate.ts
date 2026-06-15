// Pure markdown→HTML helpers for the content pipeline. No Vite, no DOM —
// string in, string out — so the slug/title/link logic is Node-tested.
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

export interface Page {
  slug: string; //   'room'
  route: string; //  '/', '/library/', '/docs/scumm/room/'
  title: string;
  description: string | null; // frontmatter `description` → meta/OG; else site default
  island: string | null; // frontmatter `script` (e.g. 'app/library') → app page; else content
  noindex: boolean; // frontmatter `noindex: true` → meta robots noindex + dropped from the sitemap
  file: string; //   absolute source path
}

/** `pages/docs/scumm/room.md` → `room` (the file's basename, lowercased). */
export function slugFor(filename: string): string {
  return filename.replace(/^.*[/\\]/, '').replace(/\.md$/i, '').toLowerCase();
}

const md: MarkdownIt = new MarkdownIt({ html: true, linkify: true });

// Relative `.md` links between docs resolve to the target file's route (the
// site-wide "URL = file path" rule). `currentFile`/`pagesDir` ride in
// markdown-it's env; without them a .md href is left alone.
const renderToken = (
  tokens: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[0],
  idx: number,
  options: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[2],
  self: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[4],
): string => self.renderToken(tokens, idx, options);
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx]!.attrGet('href');
  // Skip schemes (https:, mailto:) and absolute paths (/, //) — only relative
  // .md links between docs get resolved.
  const isRelative = href && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(href);
  const m = isRelative ? /^(.+\.md)(#.*)?$/i.exec(href!) : null;
  const { currentFile, pagesDir } = env as { currentFile?: string; pagesDir?: string };
  if (m && currentFile && pagesDir) {
    const target = resolve(dirname(currentFile), m[1]!);
    tokens[idx]!.attrSet('href', `${routeForFile(pagesDir, target)}${m[2] ?? ''}`);
  }
  return renderToken(tokens, idx, options, self);
};

/** Page title: frontmatter `title`, else first `# H1`, else the slug. */
export function pageTitle(source: string, slug: string): string {
  const { data, content } = matter(source);
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const h1 = /^#\s+(.+?)\s*$/m.exec(content);
  return h1 ? h1[1]! : slug;
}

/** Render a markdown document's body to HTML (frontmatter stripped). */
export function renderBody(source: string, currentFile?: string, pagesDir?: string): string {
  return md.render(matter(source).content, { currentFile, pagesDir });
}

/**
 * Authored (on its own line) in an app page's markdown to say where the
 * island's `#app` div goes; markdown-it passes it through verbatim.
 */
export const ISLAND_MARKER = '<!--island-->';

/**
 * Prose segments wrap in `.prose` for the shared typography; the `#app` mount
 * lands at the marker (or after the prose) and stays OUTSIDE `.prose` so the
 * island keeps its own dense layout.
 */
export function composeIslandBody(renderedHtml: string): string {
  const i = renderedHtml.indexOf(ISLAND_MARKER);
  const before = i === -1 ? renderedHtml : renderedHtml.slice(0, i);
  const after = i === -1 ? '' : renderedHtml.slice(i + ISLAND_MARKER.length);
  const prose = (html: string): string =>
    html.trim() ? `<div class="prose">\n${html.trim()}\n</div>\n` : '';
  return `${prose(before)}<div id="app"></div>\n${prose(after)}`;
}

/** `/` → `index.html`, `/docs/x/` → `docs/x/index.html`. */
export function routeToOutputPath(route: string): string {
  const clean = route.replace(/^\/+|\/+$/g, '');
  return clean === '' ? 'index.html' : `${clean}/index.html`;
}

/**
 * The markdown companion published beside each page: append `.md` to the page
 * path (`/docs/scumm/room/` → `docs/scumm/room.md`, `/docs/` → `docs.md`, `/` →
 * `index.md`) — the "append .md to the URL" convention.
 */
export function routeToMarkdownPath(route: string): string {
  const clean = route.replace(/^\/+|\/+$/g, '');
  return clean === '' ? 'index.md' : `${clean}.md`;
}

/**
 * The markdown body to publish at `<page url>.md`: the source verbatim, except
 * relative `.md` links are rewritten to absolute `.md` URLs. A page can publish
 * at a different directory depth than its source (a directory index like
 * `docs/index.md` lands at `/docs.md`), so relative targets would otherwise
 * resolve from the wrong base. This is the markdown analog of the HTML build's
 * link rule — md links to md, so the published corpus is self-consistent.
 * Fenced code blocks are left untouched.
 */
export function publishMarkdown(source: string, file: string, pagesDir: string): string {
  let inFence = false;
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/(\]\()([^)\s]+?)(\s+"[^"]*")?(\))/g, (whole, open, target, title, close) => {
        const m = /^([^#]+\.md)(#.*)?$/i.exec(target);
        // Skip schemes (https:, mailto:) and absolute paths — only relative .md links.
        if (!m || /^([a-z][a-z0-9+.-]*:|\/)/i.test(target)) return whole;
        const route = routeForFile(pagesDir, resolve(dirname(file), m[1]!));
        return `${open}/${routeToMarkdownPath(route)}${m[2] ?? ''}${title ?? ''}${close}`;
      });
    })
    .join('\n');
}

/**
 * The `/llms.txt` navigation map (llmstxt.org): an H1 with the site name, a
 * blockquote summary, then `##` sections of `- [title](url): description` links.
 * Every link points at the page's markdown companion (`<page url>.md`), as the
 * spec recommends. Doc pages are grouped; app tools and anything uncategorised
 * fall to the skippable `Optional` section, so no page is silently dropped.
 */
export function llmsTxt(
  pages: Page[],
  { siteName, summary, siteUrl }: { siteName: string; summary: string; siteUrl: string },
): string {
  const byRoute = new Map(pages.map((p) => [p.route, p]));
  const link = (p: Page): string =>
    `- [${p.title}](${siteUrl}/${routeToMarkdownPath(p.route)})${p.description ? `: ${p.description}` : ''}`;

  const sections: Array<{ title: string; pages: Page[] }> = [
    {
      title: 'Start here',
      pages: ['/', '/why/', '/how/', '/docs/'].map((r) => byRoute.get(r)).filter((p): p is Page => !!p),
    },
    { title: 'Engine — how GrogVM is built', pages: pages.filter((p) => p.route.startsWith('/docs/engine/')) },
    {
      title: 'SCUMM v5 reference — the reverse-engineered engine & file formats',
      pages: pages.filter((p) => p.route.startsWith('/docs/scumm/')),
    },
    { title: 'Working method — how the work gets done', pages: pages.filter((p) => p.route.startsWith('/docs/agent/')) },
  ];
  const covered = new Set(sections.flatMap((s) => s.pages));
  const optional = pages.filter((p) => !covered.has(p));
  if (optional.length) sections.push({ title: 'Optional', pages: optional });

  const blocks = sections
    .filter((s) => s.pages.length)
    .map((s) => `## ${s.title}\n\n${s.pages.map(link).join('\n')}`)
    .join('\n\n');

  return `# ${siteName}

> ${summary}

Every page is also available as clean markdown — append \`.md\` to any page path
(e.g. \`/docs/scumm/room/\` → \`/docs/scumm/room.md\`). The links below point to
those markdown files.

${blocks}
`;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(full);
    return /\.md$/i.test(e.name) ? [full] : [];
  });
}

/**
 * The file's location IS its URL: `index.md` → `/`, `docs/index.md` → `/docs/`,
 * `docs/scumm/room.md` → `/docs/scumm/room/`.
 */
export function routeForFile(pagesDir: string, file: string): string {
  const rel = relative(pagesDir, file).replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
  if (rel === 'index') return '/';
  if (rel.endsWith('/index')) return `/${rel.slice(0, -'/index'.length)}/`;
  return `/${rel}/`;
}

export function loadPages(pagesDir: string): Page[] {
  return markdownFiles(pagesDir)
    .sort()
    .map((file) => {
      const source = readFileSync(file, 'utf8');
      const slug = slugFor(file);
      const { script, description, noindex } = matter(source).data;
      return {
        slug,
        route: routeForFile(pagesDir, file),
        title: pageTitle(source, slug),
        description: typeof description === 'string' && description.trim() ? description.trim() : null,
        island: typeof script === 'string' ? script : null,
        noindex: noindex === true,
        file,
      };
    });
}
