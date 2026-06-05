import { describe, it, expect } from 'vitest';
import { pickHint } from './browser-support';

describe('pickHint', () => {
  it('returns brave-fs-api when Brave is missing the File System Access API', () => {
    expect(
      pickHint({
        missing: ['File System Access API (showDirectoryPicker)'],
        isBrave: true,
      }),
    ).toBe('brave-fs-api');
  });

  it('returns null when the browser is not Brave, even if the FS API is missing', () => {
    expect(
      pickHint({
        missing: ['File System Access API (showDirectoryPicker)'],
        isBrave: false,
      }),
    ).toBeNull();
  });

  it('returns null when Brave is missing something other than the FS API', () => {
    expect(
      pickHint({
        missing: ['IndexedDB'],
        isBrave: true,
      }),
    ).toBeNull();
  });

  it('still matches when Brave is missing multiple things including the FS API', () => {
    expect(
      pickHint({
        missing: ['IndexedDB', 'File System Access API (showDirectoryPicker)'],
        isBrave: true,
      }),
    ).toBe('brave-fs-api');
  });
});
