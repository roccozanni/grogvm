import { describe, it, expect } from 'vitest';
import {
  slugFor,
  pageTitle,
  renderBody,
  routeForFile,
  routeToMarkdownPath,
  publishMarkdown,
  llmsTxt,
  composeIslandBody,
  ISLAND_MARKER,
  type Page,
} from './generate';

describe('routeForFile (file path = route)', () => {
  const root = '/repo/pages';
  it('maps index.md at the root to /', () => {
    expect(routeForFile(root, '/repo/pages/index.md')).toBe('/');
  });
  it('maps a top-level page to /<name>/', () => {
    expect(routeForFile(root, '/repo/pages/library.md')).toBe('/library/');
  });
  it('maps a nested index.md to the directory route', () => {
    expect(routeForFile(root, '/repo/pages/docs/index.md')).toBe('/docs/');
  });
  it('maps a deeply nested page and lowercases the whole path', () => {
    expect(routeForFile(root, '/repo/pages/docs/scumm/Room.md')).toBe('/docs/scumm/room/');
  });
});

describe('slugFor', () => {
  it('lowercases the filename and drops the .md extension', () => {
    expect(slugFor('SCUMM-V5-ROOM.md')).toBe('scumm-v5-room');
  });
  it('strips any leading directory', () => {
    expect(slugFor('/abs/docs/PATHFINDING.md')).toBe('pathfinding');
  });
});

describe('pageTitle', () => {
  it('prefers frontmatter title', () => {
    expect(pageTitle('---\ntitle: Custom Title\n---\n# Heading\n', 'slug')).toBe('Custom Title');
  });
  it('falls back to the first H1', () => {
    expect(pageTitle('# The Heading\n\nbody', 'slug')).toBe('The Heading');
  });
  it('falls back to the slug when there is neither', () => {
    expect(pageTitle('just body, no heading', 'my-slug')).toBe('my-slug');
  });
});

describe('renderBody', () => {
  const root = '/repo/pages';
  const from = '/repo/pages/docs/scumm/room.md'; // a doc under docs/scumm/

  it('renders markdown to HTML and strips frontmatter', () => {
    const html = renderBody('---\ntitle: x\n---\n# Hi\n\ntext');
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('title: x');
  });
  it('rewrites a sibling .md link to its route (URL = file path)', () => {
    expect(renderBody('[smap](smap.md)', from, root)).toContain('href="/docs/scumm/smap/"');
  });
  it('resolves a parent-dir .md link to the right route', () => {
    expect(renderBody('[pf](../pathfinding.md)', from, root)).toContain('href="/docs/pathfinding/"');
  });
  it('preserves the anchor on rewritten links', () => {
    expect(renderBody('[x](boot.md#vars)', from, root)).toContain('href="/docs/scumm/boot/#vars"');
  });
  it('leaves external links untouched', () => {
    expect(renderBody('[ext](https://example.com/a.md)', from, root)).toContain(
      'href="https://example.com/a.md"',
    );
  });
  it('leaves .md links untouched without file context', () => {
    expect(renderBody('[x](smap.md)')).toContain('href="smap.md"');
  });
});

describe('routeToMarkdownPath (append .md to the page path)', () => {
  it('publishes the home page at index.md', () => {
    expect(routeToMarkdownPath('/')).toBe('index.md');
  });
  it('appends .md to a top-level page', () => {
    expect(routeToMarkdownPath('/library/')).toBe('library.md');
  });
  it('appends .md to a directory-index route (no trailing /index)', () => {
    expect(routeToMarkdownPath('/docs/')).toBe('docs.md');
  });
  it('appends .md to a deeply nested page', () => {
    expect(routeToMarkdownPath('/docs/scumm/room/')).toBe('docs/scumm/room.md');
  });
});

describe('publishMarkdown (relative .md links → absolute .md URLs)', () => {
  const root = '/repo/pages';
  const room = '/repo/pages/docs/scumm/room.md';
  const docsIndex = '/repo/pages/docs/index.md';

  it('rewrites a sibling .md link to its absolute .md URL', () => {
    expect(publishMarkdown('[smap](smap.md)', room, root)).toBe('[smap](/docs/scumm/smap.md)');
  });
  it('resolves a parent-dir .md link', () => {
    expect(publishMarkdown('[pf](../pathfinding.md)', room, root)).toBe('[pf](/docs/pathfinding.md)');
  });
  it('resolves a child link from a directory-index page (the base-shift case)', () => {
    // docs/index.md publishes to /docs.md, so the raw relative link would
    // otherwise resolve from the root — it must become absolute.
    expect(publishMarkdown('[arch](engine/architecture.md)', docsIndex, root)).toBe(
      '[arch](/docs/engine/architecture.md)',
    );
  });
  it('preserves the anchor on rewritten links', () => {
    expect(publishMarkdown('[x](boot.md#vars)', room, root)).toBe('[x](/docs/scumm/boot.md#vars)');
  });
  it('leaves external links untouched', () => {
    expect(publishMarkdown('[ext](https://example.com/a.md)', room, root)).toBe(
      '[ext](https://example.com/a.md)',
    );
  });
  it('leaves absolute-path links untouched', () => {
    expect(publishMarkdown('[a](/docs/scumm/smap/)', room, root)).toBe('[a](/docs/scumm/smap/)');
  });
  it('leaves non-.md links untouched', () => {
    expect(publishMarkdown('![pic](diagram.png)', room, root)).toBe('![pic](diagram.png)');
  });
  it('keeps frontmatter and leaves .md links inside fenced code untouched', () => {
    const src = '---\ntitle: x\n---\n```\n[c](smap.md)\n```\n[a](smap.md)';
    expect(publishMarkdown(src, room, root)).toBe(
      '---\ntitle: x\n---\n```\n[c](smap.md)\n```\n[a](/docs/scumm/smap.md)',
    );
  });
});

describe('llmsTxt (the /llms.txt navigation map)', () => {
  const page = (over: Partial<Page>): Page => ({
    slug: 'x',
    route: '/x/',
    title: 'X',
    description: null,
    island: null,
    noindex: false,
    file: '/repo/pages/x.md',
    ...over,
  });
  const pages: Page[] = [
    page({ route: '/docs/scumm/room/', title: 'ROOM' }),
    page({ route: '/docs/engine/architecture/', title: 'Architecture' }),
    page({ route: '/docs/', title: 'Documentation', description: 'How it is built.' }),
    page({ route: '/', title: 'GrogVM', description: 'A SCUMM v5 engine.' }),
    page({ route: '/why/', title: 'Why' }),
    page({ route: '/library/', title: 'Library', island: 'app/library', description: 'Install a game.' }),
    page({ route: '/privacy/', title: 'Privacy' }),
  ];
  const out = llmsTxt(pages, { siteName: 'GrogVM', summary: 'Sum.', siteUrl: 'https://grogvm.dev' });

  it('opens with the H1 site name and a blockquote summary', () => {
    expect(out.startsWith('# GrogVM\n\n> Sum.\n')).toBe(true);
  });
  it('links each page to its markdown companion, with the description when present', () => {
    expect(out).toContain('- [GrogVM](https://grogvm.dev/index.md): A SCUMM v5 engine.');
    expect(out).toContain('- [ROOM](https://grogvm.dev/docs/scumm/room.md)\n');
  });
  it('groups docs under their section headings', () => {
    expect(out).toMatch(/## Engine[^\n]*\n\n- \[Architecture\]\(https:\/\/grogvm\.dev\/docs\/engine\/architecture\.md\)/);
    expect(out).toContain('## SCUMM v5 reference');
  });
  it('sends app tools and uncategorised pages to a skippable Optional section', () => {
    const optional = out.slice(out.indexOf('## Optional'));
    expect(optional).toContain('- [Library](https://grogvm.dev/library.md): Install a game.');
    expect(optional).toContain('- [Privacy](https://grogvm.dev/privacy.md)');
  });
  it('lists every page exactly once', () => {
    const links = out.match(/^- \[/gm) ?? [];
    expect(links.length).toBe(pages.length);
  });
});

describe('composeIslandBody', () => {
  it('splits at the marker: prose wraps the parts, #app sits between them', () => {
    const out = composeIslandBody(`<h1>Library</h1>\n${ISLAND_MARKER}\n<p>footnote</p>`);
    expect(out).toBe(
      '<div class="prose">\n<h1>Library</h1>\n</div>\n' +
        '<div id="app"></div>\n' +
        '<div class="prose">\n<p>footnote</p>\n</div>\n',
    );
  });

  it('keeps the #app mount outside .prose', () => {
    const out = composeIslandBody(`<p>intro</p>\n${ISLAND_MARKER}`);
    // The mount is its own top-level div, never nested in a prose block.
    expect(out).toContain('</div>\n<div id="app"></div>');
    expect(out).not.toContain('<div class="prose">\n<div id="app">');
  });

  it('drops empty prose segments (no marker → just the prose then the mount)', () => {
    expect(composeIslandBody('<p>only intro</p>')).toBe(
      '<div class="prose">\n<p>only intro</p>\n</div>\n<div id="app"></div>\n',
    );
  });

  it('an empty body yields just the mount (play/explore full-bleed)', () => {
    expect(composeIslandBody('')).toBe('<div id="app"></div>\n');
  });
});
