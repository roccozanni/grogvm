import { describe, it, expect } from 'vitest';
import { slugFor, pageTitle, renderBody } from './generate';

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
  it('renders markdown to HTML and strips frontmatter', () => {
    const html = renderBody('---\ntitle: x\n---\n# Hi\n\ntext');
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('title: x');
  });
  it('rewrites inter-doc .md links to /docs/<slug>/ routes', () => {
    expect(renderBody('[smap](SCUMM-V5-SMAP.md)')).toContain('href="/docs/scumm-v5-smap/"');
  });
  it('preserves the anchor on rewritten links', () => {
    expect(renderBody('[x](FOO.md#section)')).toContain('href="/docs/foo/#section"');
  });
  it('leaves external links untouched', () => {
    expect(renderBody('[ext](https://example.com/a.md)')).toContain('href="https://example.com/a.md"');
  });
});
