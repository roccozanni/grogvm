import type { App } from './app';
import { listGames, removeGame, type StoredGame } from '../../platform/storage/games';
import { playHref, exploreHref } from '../../platform/routing/routing';

export function renderLibrary(app: App, flash?: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'library';
  container.innerHTML = `
    <header>
      <h1>GrogVM</h1>
      <p class="subtitle">your installed games</p>
    </header>
    <main></main>
  `;

  const main = container.querySelector('main')!;

  if (flash) {
    const flashBox = document.createElement('div');
    flashBox.className = 'flash';
    flashBox.textContent = flash;
    main.appendChild(flashBox);
  }

  const listContainer = document.createElement('div');
  listContainer.textContent = 'Loading…';
  main.appendChild(listContainer);

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
  install.addEventListener('click', () => app.navigate({ kind: 'install' }));
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
  li.querySelector('.game-id')!.textContent = game.gameId;
  li.querySelector<HTMLAnchorElement>('.play')!.href = playHref(game.gameId);
  li.querySelector<HTMLAnchorElement>('.explore')!.href = exploreHref(game.gameId);

  li.querySelector('.remove')!.addEventListener('click', () => {
    void (async () => {
      await removeGame(game.id);
      app.navigate({ kind: 'library' });
    })();
  });

  return li;
}
