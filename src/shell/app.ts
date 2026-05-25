import { renderLibrary } from './library/library';
import { renderInstall } from './install/install';
import { renderPlayer } from './player/player';
import type { StoredGame } from './storage/games';

export type Screen =
  | { kind: 'library' }
  | { kind: 'install'; error?: string }
  | { kind: 'player'; game: StoredGame };

export class App {
  private screen: Screen = { kind: 'library' };

  constructor(private readonly root: HTMLElement) {}

  start(): void {
    this.render();
  }

  navigate(next: Screen): void {
    this.screen = next;
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();
    switch (this.screen.kind) {
      case 'library':
        this.root.appendChild(renderLibrary(this));
        break;
      case 'install':
        this.root.appendChild(renderInstall(this, this.screen.error));
        break;
      case 'player':
        this.root.appendChild(renderPlayer(this, this.screen.game));
        break;
    }
  }
}
