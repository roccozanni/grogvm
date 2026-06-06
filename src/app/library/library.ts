import type { App } from './app';
import { installGame } from '../install/install';
import { listGames, removeGame, type StoredGame } from '../../platform/storage/games';
import { deleteAllSaves } from '../../platform/storage/savegames';
import { playHref, exploreHref } from '../../platform/routing/routing';

// The page chrome — title, intro, the "Your installed games" heading — is prose
// authored in pages/library.md; this island renders only the interactive widget
// (the game list + Install button) into the page's #app mount.
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
  // Play / Explore are real links to the /play/ and /explore/ pages (the game
  // id rides in ?game=). The folder permission re-grant happens on the
  // destination page (it needs a user gesture there) — see pages/shared.ts.
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
    // Removing forgets the install (IndexedDB record + folder handle) and clears
    // its in-browser saves — but never touches the files on disk. Spell that out
    // so the prompt is clear about what's lost and what isn't.
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
