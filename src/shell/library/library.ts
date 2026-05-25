import type { App } from '../app';
import { listGames, removeGame, type StoredGame } from '../storage/games';

export function renderLibrary(app: App): HTMLElement {
  const container = document.createElement('div');
  container.className = 'library';
  container.innerHTML = `
    <header>
      <h1>webscumm</h1>
      <p class="subtitle">your installed games</p>
    </header>
    <main></main>
  `;

  const main = container.querySelector('main')!;
  main.textContent = 'Loading…';

  listGames()
    .then((games) => {
      main.replaceChildren(renderGameList(app, games));
    })
    .catch((err: Error) => {
      main.textContent = `Error loading games: ${err.message}`;
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
  li.innerHTML = `
    <span class="name"></span>
    <span class="game-id"></span>
    <button class="play">Play</button>
    <button class="remove secondary">Remove</button>
  `;
  li.querySelector('.name')!.textContent = game.displayName;
  li.querySelector('.game-id')!.textContent = game.gameId;

  li.querySelector('.play')!.addEventListener('click', () => {
    app.navigate({ kind: 'player', game });
  });

  li.querySelector('.remove')!.addEventListener('click', () => {
    void (async () => {
      await removeGame(game.id);
      app.navigate({ kind: 'library' });
    })();
  });

  return li;
}
