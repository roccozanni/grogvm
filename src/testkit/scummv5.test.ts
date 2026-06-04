/**
 * Tests for the SCUMM-v5 loader's data-presence check — done synthetically
 * against a temp dir with empty (non-copyrighted) dummy files, so they run
 * everywhere including CI. The full boot→drive path against real games lives
 * in the `integration/` suites (`npm run test:integration`); `loadScummV5`/
 * `bootScummV5`/`restoreSave` are exercised there, not re-tested here.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hasData } from './scummv5';

// A throwaway dir holding empty MONKEY.000/.001 — exercises the existence
// check without any game bytes.
const tmp = mkdtempSync(join(tmpdir(), 'grogvm-v5-'));
const withFiles = join(tmp, 'game');
mkdirSync(withFiles);
writeFileSync(join(withFiles, 'MONKEY.000'), '');
writeFileSync(join(withFiles, 'MONKEY.001'), '');
const empty = join(tmp, 'empty');
mkdirSync(empty);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('SCUMM-v5 loader — data presence', () => {
  it('hasData is true when both resource files exist', () => {
    expect(hasData(withFiles)).toBe(true);
  });

  it('hasData is false for a dir missing the files', () => {
    expect(hasData(empty)).toBe(false);
    expect(hasData(join(tmp, 'does-not-exist'))).toBe(false);
  });
});
