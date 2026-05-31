import { describe, it, expect } from 'vitest';
import { gameParam, playHref, exploreHref, homeHref } from './routing';

describe('gameParam', () => {
  it('extracts the game id', () => {
    expect(gameParam('?game=MI1')).toBe('MI1');
    expect(gameParam('?foo=1&game=MI2&bar=2')).toBe('MI2');
  });

  it('returns null when absent or empty', () => {
    expect(gameParam('')).toBeNull();
    expect(gameParam('?foo=1')).toBeNull();
    expect(gameParam('?game=')).toBeNull();
  });

  it('decodes percent-encoding', () => {
    expect(gameParam('?game=My%20Game')).toBe('My Game');
  });
});

describe('hrefs', () => {
  it('build path-based hrefs with the game in the query', () => {
    expect(playHref('MI1')).toBe('/play/?game=MI1');
    expect(exploreHref('MI1')).toBe('/explore/?game=MI1');
    expect(homeHref).toBe('/');
  });

  it('encodes special characters', () => {
    expect(playHref('a b')).toBe('/play/?game=a%20b');
    expect(exploreHref('a&b')).toBe('/explore/?game=a%26b');
  });
});
