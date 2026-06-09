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
      const { script, description } = matter(source).data;
      return {
        slug,
        route: routeForFile(pagesDir, file),
        title: pageTitle(source, slug),
        description: typeof description === 'string' && description.trim() ? description.trim() : null,
        island: typeof script === 'string' ? script : null,
        file,
      };
    });
}
