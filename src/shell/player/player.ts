import type { App } from '../app';
import type { StoredGame } from '../storage/games';

export function renderPlayer(app: App, game: StoredGame): HTMLElement {
  const container = document.createElement('div');
  container.className = 'player';
  container.innerHTML = `
    <header>
      <button class="back secondary">← Library</button>
      <h1></h1>
      <p class="subtitle"></p>
    </header>
    <main>
      <p>Player not implemented yet.</p>
      <p>Game id: <code class="gid"></code></p>
      <p>Source directory: <code class="dir"></code></p>
    </main>
  `;

  container.querySelector('h1')!.textContent = game.displayName;
  container.querySelector('.subtitle')!.textContent = `installed ${formatDate(game.installedAt)}`;
  container.querySelector('.gid')!.textContent = game.gameId;
  container.querySelector('.dir')!.textContent = game.directoryHandle.name;
  container.querySelector('.back')!.addEventListener('click', () => {
    app.navigate({ kind: 'library' });
  });

  return container;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}
