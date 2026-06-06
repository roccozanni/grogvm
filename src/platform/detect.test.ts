import { describe, it, expect } from 'vitest';
import { detectGame, identifyVariant } from './detect';

describe('detectGame', () => {
  it('detects MI1 from MONKEY.000 + MONKEY.001', () => {
    expect(detectGame(['MONKEY.000', 'MONKEY.001'])).toEqual({
      gameId: 'MI1',
      displayName: 'The Secret of Monkey Island',
    });
  });

  it('detects MI2 from MONKEY2.000 + MONKEY2.001', () => {
    expect(detectGame(['MONKEY2.000', 'MONKEY2.001'])).toEqual({
      gameId: 'MI2',
      displayName: "Monkey Island 2: LeChuck's Revenge",
    });
  });

  it('is case-insensitive', () => {
    expect(detectGame(['monkey.000', 'monkey.001'])?.gameId).toBe('MI1');
    expect(detectGame(['Monkey2.000', 'monkey2.001'])?.gameId).toBe('MI2');
  });

  it('returns null when only one of MI1\'s files is present', () => {
    expect(detectGame(['MONKEY.000'])).toBeNull();
    expect(detectGame(['MONKEY.001'])).toBeNull();
  });

  it('returns null for an empty directory', () => {
    expect(detectGame([])).toBeNull();
  });

  it('returns null for unrelated files', () => {
    expect(detectGame(['readme.txt', 'install.exe'])).toBeNull();
  });

  it('ignores extra files alongside MI1 data', () => {
    expect(
      detectGame(['MONKEY.000', 'MONKEY.001', 'track02.fla', 'readme.txt'])?.gameId,
    ).toBe('MI1');
  });

  it('does not confuse MI1 with MI2 when both look-alike names appear', () => {
    expect(detectGame(['MONKEY2.000', 'MONKEY2.001'])?.gameId).toBe('MI2');
  });
});

describe('identifyVariant', () => {
  it('hashes the index bytes with SHA-256 (hex)', async () => {
    // Known SHA-256 of the ASCII bytes "abc".
    const { contentHash } = await identifyVariant(new TextEncoder().encode('abc'));
    expect(contentHash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('labels an unknown release by hash prefix', async () => {
    const { variant } = await identifyVariant(new TextEncoder().encode('abc'));
    expect(variant).toBe('variant ba7816b');
  });

  it('gives different copies different hashes (so EN and IT stay distinct)', async () => {
    const a = await identifyVariant(new TextEncoder().encode('english'));
    const b = await identifyVariant(new TextEncoder().encode('italiano'));
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
