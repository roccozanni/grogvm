import { describe, it, expect } from 'vitest';
import { slugFor, pageTitle, renderBody, routeForFile } from './generate';

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
