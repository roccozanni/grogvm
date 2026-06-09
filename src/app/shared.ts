/** Shared bootstrap helpers for the app islands. See pages/docs/engine/architecture.md. */
import { checkBrowserSupport, renderUnsupported } from '../platform/browser-support';
import { ensureReadPermission } from '../platform/storage/permission';
import { listGames, type StoredGame } from '../platform/storage/games';
import { libraryHref } from '../platform/routing/routing';

export function mountPage(root: HTMLElement, render: (root: HTMLElement) => void): void {
  const unsupported = checkBrowserSupport();
  if (unsupported) {
    root.appendChild(renderUnsupported(unsupported));
    return;
  }
  render(root);
}

export async function findInstalledById(installId: string): Promise<StoredGame | null> {
  const games = await listGames();
  return games.find((g) => g.id === installId) ?? null;
}

export function renderMissingGame(root: HTMLElement, message: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'page-message';
  const p = document.createElement('p');
  p.textContent = message;
  wrap.append(p, backLink());
  root.replaceChildren(wrap);
}

// File System Access grants don't persist across sessions, and the re-grant
// needs a user gesture a fresh page load doesn't have — hence the button.
export function withReadPermission(
  root: HTMLElement,
  game: StoredGame,
  onReady: () => void,
): void {
  void (async () => {
    if ((await game.directoryHandle.queryPermission({ mode: 'read' })) === 'granted') {
      onReady();
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'page-message';
    const p = document.createElement('p');
    p.textContent = `GrogVM needs permission to read “${game.directoryHandle.name}”.`;
    const grant = document.createElement('button');
    grant.className = 'primary';
    grant.textContent = 'Grant folder access';
    grant.addEventListener('click', () => {
      void (async () => {
        if (await ensureReadPermission(game.directoryHandle)) onReady();
        else p.textContent = `Permission denied for “${game.directoryHandle.name}”. Try again.`;
      })();
    });
    wrap.append(p, grant, backLink());
    root.replaceChildren(wrap);
  })();
}

function backLink(): HTMLAnchorElement {
  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = libraryHref;
  back.textContent = '← Library';
  return back;
}
