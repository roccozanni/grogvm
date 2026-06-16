import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../library/app';
import { installGame } from './install';

function fakeDirectory(name: string, files: string[]): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries() {
      for (const file of files) {
        yield [file, { kind: 'file', name: file } as FileSystemFileHandle];
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

function pickerReturns(handle: FileSystemDirectoryHandle): void {
  (globalThis as unknown as { window: { showDirectoryPicker: typeof window.showDirectoryPicker } }).window = {
    showDirectoryPicker: vi.fn().mockResolvedValue(handle),
  };
}

function fakeApp(): App & { navigate: ReturnType<typeof vi.fn> } {
  return { navigate: vi.fn() } as unknown as App & { navigate: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
});

describe('installGame', () => {
  it('rejects MI2 data until the runtime supports it', async () => {
    pickerReturns(fakeDirectory('mi2', ['MONKEY2.000', 'MONKEY2.001']));
    const app = fakeApp();

    await installGame(app);

    expect(app.navigate).toHaveBeenCalledWith({
      flash: expect.stringContaining('MI2 support is planned'),
    });
  });

  it('describes only the supported MI1 filenames for unknown directories', async () => {
    pickerReturns(fakeDirectory('empty', ['readme.txt']));
    const app = fakeApp();

    await installGame(app);

    const flash = app.navigate.mock.calls[0]?.[0]?.flash;
    expect(flash).toContain('MONKEY.000 + MONKEY.001');
    expect(flash).not.toContain('MONKEY2');
  });
});
