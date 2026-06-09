import type { App } from './app';
import { installGame } from '../install/install';
import { listGames, removeGame, type StoredGame } from '../../platform/storage/games';
import { deleteAllSaves } from '../../platform/storage/savegames';
import { playHref, exploreHref } from '../../platform/routing/routing';

// Page chrome is prose in pages/library.md; this island renders only the
// interactive widget (game list + Install button).
export function renderLibrary(app: App, flash?: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'library';

  if (flash) {
    const flashBox = document.createElement('div');
    flashBox.className = 'flash';
    flashBox.textContent = flash;
    container.appendChild(flashBox);
  }

  const listContainer = document.createElement('div');
  listContainer.textContent = 'Loading…';
  container.appendChild(listContainer);

  listGames()
    .then((games) => {
      listContainer.replaceWith(renderGameList(app, games));
    })
    .catch((err: Error) => {
      listContainer.textContent = `Error loading games: ${err.message}`;
    });

  return container;
}

function renderGameList(app: App, games: StoredGame[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'game-list';

  if (games.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No games installed yet.';
    wrap.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    for (const game of games) {
      list.appendChild(renderGameRow(app, game));
    }
    wrap.appendChild(list);
  }

  const install = document.createElement('button');
  install.className = 'primary';
  install.textContent = 'Install game…';
  install.addEventListener('click', () => void installGame(app));
  wrap.appendChild(install);

  return wrap;
}

function renderGameRow(app: App, game: StoredGame): HTMLElement {
  const li = document.createElement('li');
  li.className = 'game-row';
  // The folder-permission re-grant happens on the destination page, where the
  // user gesture is available — see ../shared.ts.
  li.innerHTML = `
    <span class="name"></span>
    <span class="game-id"></span>
    <a class="play button">Play</a>
    <a class="explore button secondary">Explore</a>
    <button class="remove secondary">Remove</button>
  `;
  li.querySelector('.name')!.textContent = game.displayName;
  li.querySelector('.game-id')!.textContent = game.variant;
  li.querySelector<HTMLAnchorElement>('.play')!.href = playHref(game.id);
  li.querySelector<HTMLAnchorElement>('.explore')!.href = exploreHref(game.id);

  li.querySelector('.remove')!.addEventListener('click', () => {
    const ok = window.confirm(
      `Remove "${game.displayName}" (${game.variant}) from your library?\n\n` +
        `This also deletes its saved games in this browser. Your game files on ` +
        `disk are left untouched.`,
    );
    if (!ok) return;
    void (async () => {
      await removeGame(game.id);
      deleteAllSaves(game.id);
      app.navigate();
    })();
  });

  return li;
}
