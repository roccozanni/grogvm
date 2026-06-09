import { renderLibrary } from './library';

// Controller for the library page; player and explorer are separate pages
// reached by link — see pages/docs/engine/architecture.md §3.
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
