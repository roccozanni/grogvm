import { renderLibrary } from './library';

// Controller for the `/` page: it renders the library and re-renders it after an
// install or remove. The player and explorer are separate pages (/play/,
// /explore/), reached by link — see pages/ and ARCHITECTURE.md §7 / §11 Q11.
// Installing opens the directory picker directly off the button (see install.ts),
// so there's no second screen — only a flash for the occasional error.
export class App {
  constructor(private readonly root: HTMLElement) {}

  start(): void {
    this.render();
  }

  /** Re-render the library, optionally with a flash message (e.g. an install error). */
  navigate(opts: { flash?: string } = {}): void {
    this.render(opts.flash);
  }

  private render(flash?: string): void {
    this.root.replaceChildren(renderLibrary(this, flash));
  }
}
