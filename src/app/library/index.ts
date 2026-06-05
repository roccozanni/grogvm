// Library island — the `/library` screen plus the in-page install flow.
// Shared chrome + theme come from the linked /site.css (see src/site/site.css).
import { App } from './app';
import { mountPage } from '../shared';

export function mount(root: HTMLElement): void {
  mountPage(root, (r) => new App(r).start());
}
