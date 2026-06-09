import type { App } from '../library/app';
import { addGame, findGameByHash } from '../../platform/storage/games';
import { detectGame, identifyVariant, INDEX_FILENAME } from '../../platform/detect';

// Must run straight off the click: showDirectoryPicker needs the user gesture.
// A cancelled picker is a silent no-op; other failures flash on the library.
export async function installGame(app: App): Promise<void> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    app.navigate({ flash: `Could not open directory: ${(err as Error).message}` });
    return;
  }

  const filenames = await readFilenames(handle);
  const detected = detectGame(filenames);

  if (!detected) {
    app.navigate({
      flash:
        `"${handle.name}" doesn't look like a supported game directory. ` +
        `Expected MONKEY.000 + MONKEY.001 (MI1) or MONKEY2.000 + MONKEY2.001 (MI2).`,
    });
    return;
  }

  const indexBytes = await readIndexBytes(handle, INDEX_FILENAME[detected.gameId]);
  if (!indexBytes) {
    app.navigate({ flash: `Could not read ${INDEX_FILENAME[detected.gameId]} in "${handle.name}".` });
    return;
  }
  const { contentHash, variant } = await identifyVariant(indexBytes);

  // Dedup on content, not gameId: EN and IT are both MI1 but hash differently,
  // so they coexist; only the literal same copy is rejected.
  const existing = await findGameByHash(contentHash);
  if (existing) {
    app.navigate({
      flash:
        `That exact copy is already installed as "${existing.variant}" ` +
        `(source: "${existing.directoryHandle.name}"). Remove it first to re-install.`,
    });
    return;
  }

  await addGame({
    gameId: detected.gameId,
    displayName: detected.displayName,
    contentHash,
    variant,
    directoryHandle: handle,
  });

  app.navigate();
}

async function readIndexBytes(
  handle: FileSystemDirectoryHandle,
  indexName: string,
): Promise<Uint8Array | null> {
  const target = indexName.toUpperCase();
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file' && name.toUpperCase() === target) {
      return new Uint8Array(await (await entry.getFile()).arrayBuffer());
    }
  }
  return null;
}

async function readFilenames(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') names.push(name);
  }
  return names;
}
