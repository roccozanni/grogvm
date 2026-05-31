import { renderLibrary } from './library/library';
import { renderInstall } from './install/install';

// Controller for the `/` page only: the library and the in-page install flow.
// The player and explorer are now separate pages (/play/, /explore/), reached
// by link — see src/pages/ and ARCHITECTURE.md §7 / §11 Q11.
export type Screen =
  | { kind: 'library'; flash?: string }
  | { kind: 'install'; error?: string };

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
        this.root.appendChild(renderLibrary(this, this.screen.flash));
        break;
      case 'install':
        this.root.appendChild(renderInstall(this, this.screen.error));
        break;
    }
  }
}
