import { describe, it, expect } from 'vitest';
import {
  slugFor,
  pageTitle,
  renderBody,
  routeForFile,
  composeIslandBody,
  ISLAND_MARKER,
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
