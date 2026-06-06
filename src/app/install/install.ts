import type { App } from '../library/app';
import { addGame, findGameByHash } from '../../platform/storage/games';
import { detectGame, identifyVariant, INDEX_FILENAME } from '../../platform/detect';

export function renderInstall(app: App, error?: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'install';
  container.innerHTML = `
    <header>
      <h1>Install game</h1>
      <p class="subtitle">Point me at a directory containing the game files.</p>
    </header>
    <main></main>
  `;

  const main = container.querySelector('main')!;

  if (error) {
    const errBox = document.createElement('div');
    errBox.className = 'error';
    errBox.textContent = error;
    main.appendChild(errBox);
  }

  const pick = document.createElement('button');
  pick.className = 'primary';
  pick.textContent = 'Choose directory…';
  pick.addEventListener('click', () => {
    void pickDirectory(app);
  });
  main.appendChild(pick);

  const cancel = document.createElement('button');
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => app.navigate({ kind: 'library' }));
  main.appendChild(cancel);

  return container;
}

async function pickDirectory(app: App): Promise<void> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    app.navigate({
      kind: 'install',
      error: `Could not open directory: ${(err as Error).message}`,
    });
    return;
  }

  const filenames = await readFilenames(handle);
  const detected = detectGame(filenames);

  if (!detected) {
    app.navigate({
      kind: 'install',
      error:
        `"${handle.name}" doesn't look like a supported game directory. ` +
        `Expected MONKEY.000 + MONKEY.001 (MI1) or MONKEY2.000 + MONKEY2.001 (MI2).`,
    });
    return;
  }

  const indexBytes = await readIndexBytes(handle, INDEX_FILENAME[detected.gameId]);
  if (!indexBytes) {
    app.navigate({
      kind: 'install',
      error: `Could not read ${INDEX_FILENAME[detected.gameId]} in "${handle.name}".`,
    });
    return;
  }
  const { contentHash, variant } = await identifyVariant(indexBytes);

  // Dedup on content, not gameId: EN and IT are both MI1 but hash differently,
  // so they coexist; only the literal same copy is rejected.
  const existing = await findGameByHash(contentHash);
  if (existing) {
    app.navigate({
      kind: 'install',
      error:
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

  app.navigate({ kind: 'library' });
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
