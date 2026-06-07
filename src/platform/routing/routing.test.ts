import { describe, it, expect } from 'vitest';
import { gameParam, playHref, exploreHref, libraryHref, roomParam, searchWithRoom } from './routing';

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

describe('roomParam', () => {
  it('parses the room id, ignoring other params', () => {
    expect(roomParam('?game=MI1&room=60')).toBe(60);
    expect(roomParam('?room=0')).toBe(0);
  });

  it('returns null when absent or non-numeric', () => {
    expect(roomParam('')).toBeNull();
    expect(roomParam('?game=MI1')).toBeNull();
    expect(roomParam('?room=abc')).toBeNull();
  });
});

describe('searchWithRoom', () => {
  it('sets room while preserving other params', () => {
    expect(searchWithRoom('?game=MI1', 60)).toBe('?game=MI1&room=60');
  });

  it('replaces an existing room', () => {
    expect(searchWithRoom('?game=MI1&room=5', 12)).toBe('?game=MI1&room=12');
  });
});

describe('hrefs', () => {
  it('build path-based hrefs with the install id in the query', () => {
    const id = '3f9a1c2e-0000-4000-8000-000000000000';
    expect(playHref(id)).toBe(`/play/?game=${id}`);
    expect(exploreHref(id)).toBe(`/explore/?game=${id}`);
    expect(libraryHref).toBe('/library/');
  });

  it('encodes special characters', () => {
    expect(playHref('a b')).toBe('/play/?game=a%20b');
    expect(exploreHref('a&b')).toBe('/explore/?game=a%26b');
  });
});
