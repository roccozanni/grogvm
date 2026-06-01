/**
 * Shared bootstrap helpers for the multi-page entries (src/pages/*.ts).
 * Each page is a separate document (full page load), so these centralise the
 * boilerplate: browser-support gate, resolving the `?game=` install, and the
 * folder-permission re-grant.
 */
import { checkBrowserSupport, renderUnsupported } from '../shell/browser-support';
import { ensureReadPermission } from '../shell/storage/permission';
import { listGames, type StoredGame } from '../shell/storage/games';
import { homeHref } from '../shell/routing/routing';

/** Get the #app root, gating on browser support; calls `render(root)` if OK. */
export function mountPage(render: (root: HTMLElement) => void): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app root element');
  const unsupported = checkBrowserSupport();
  if (unsupported) {
    root.appendChild(renderUnsupported(unsupported));
    return;
  }
  render(root);
}

/** Resolve a `?game=` value (a GameId like "MI1") to its stored install. */
export async function findInstalledByGameId(rawGameId: string): Promise<StoredGame | null> {
  const games = await listGames();
  return games.find((g) => g.gameId === rawGameId) ?? null;
}

/** A "nothing to show here" message with a link back to the library. */
export function renderMissingGame(root: HTMLElement, message: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'page-message';
  const p = document.createElement('p');
  p.textContent = message;
  wrap.append(p, backLink());
  root.replaceChildren(wrap);
}

/**
 * Ensure read permission to the game's folder, then call `onReady`.
 *
 * Browsers don't persist File System Access grants across sessions, and
 * `requestPermission` needs a user gesture — which a fresh page load (after
 * navigating from a link) doesn't have. So: if already granted, proceed; else
 * show a button whose click provides the gesture for the re-grant.
 */
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
  back.href = homeHref;
  back.textContent = '← Library';
  return back;
}
