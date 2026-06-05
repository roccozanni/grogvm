// Pure markdown→HTML helpers for the content pipeline (§9 Phase 12). No Vite,
// no DOM — string in, string out — so the slug/title/link logic is Node-tested.
import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DocMeta {
  slug: string; //  'scumm-v5-room'
  route: string; // '/docs/scumm-v5-room/'
  title: string;
  file: string; //  absolute source path
}

/** `docs/SCUMM-V5-ROOM.md` → `scumm-v5-room`. */
export function slugFor(filename: string): string {
  return filename.replace(/^.*[/\\]/, '').replace(/\.md$/i, '').toLowerCase();
}

const md: MarkdownIt = new MarkdownIt({ html: true, linkify: true });

// Rewrite inter-doc links so they resolve as routes: `FOO.md#x` → `/docs/foo/#x`.
const renderToken = (
  tokens: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[0],
  idx: number,
  options: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[2],
  self: Parameters<NonNullable<typeof md.renderer.rules.link_open>>[4],
): string => self.renderToken(tokens, idx, options);
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const href = tokens[idx]!.attrGet('href');
  // Only rewrite *relative* doc links — skip schemes (https:, mailto:) and
  // absolute paths (/, //) so external links survive untouched.
  const relative = href && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(href);
  const m = relative ? /^([^#?]+)\.md(#.*)?$/i.exec(href!) : null;
  if (m) tokens[idx]!.attrSet('href', `/docs/${slugFor(m[1]!)}/${m[2] ?? ''}`);
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
export function renderBody(source: string): string {
  return md.render(matter(source).content);
}

/** List the publishable docs (every `*.md` except a home `index.md`), sorted. */
export function listDocs(docsDir: string): DocMeta[] {
  return readdirSync(docsDir)
    .filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== 'index.md')
    .sort()
    .map((f) => {
      const slug = slugFor(f);
      const file = join(docsDir, f);
      return { slug, route: `/docs/${slug}/`, title: pageTitle(readFileSync(file, 'utf8'), slug), file };
    });
}
