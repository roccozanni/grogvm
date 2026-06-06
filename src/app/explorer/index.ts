// Explorer island — `/explore?game=<id>`, the session-free resource browser.
import '../../styles/explorer.css';
import { renderExplorer } from './explorer';
import { currentGameParam, libraryHref } from '../../platform/routing/routing';
import { mountPage, findInstalledById, renderMissingGame, withReadPermission } from '../shared';

export function mount(root: HTMLElement): void {
  mountPage(root, () => {
    void (async () => {
      const raw = currentGameParam();
      if (!raw) {
        renderMissingGame(root, 'No game specified. Open one from the library.');
        return;
      }
      const game = await findInstalledById(raw);
      if (!game) {
        renderMissingGame(root, `That game isn’t installed on this browser. Open it from the library.`);
        return;
      }
      withReadPermission(root, game, () => {
        root.replaceChildren(renderExplorer(game, () => location.assign(libraryHref)));
      });
    })();
  });
}
