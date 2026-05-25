import type { App } from '../app';
import { addGame, findInstalledGame } from '../storage/games';
import { detectGame } from './detect';

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

  const existing = await findInstalledGame(detected.gameId);
  if (existing) {
    app.navigate({
      kind: 'install',
      error:
        `${detected.displayName} is already installed (source: "${existing.directoryHandle.name}"). ` +
        `Remove it from the library first if you want to install from a different directory.`,
    });
    return;
  }

  await addGame({
    gameId: detected.gameId,
    displayName: detected.displayName,
    directoryHandle: handle,
  });

  app.navigate({ kind: 'library' });
}

async function readFilenames(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file') names.push(name);
  }
  return names;
}
