// Library island — the `/` (soon `/library`) screen plus the in-page install flow.
import { App } from './app';
import { mountPage } from '../shared';

export function mount(root: HTMLElement): void {
  mountPage(root, (r) => new App(r).start());
}
