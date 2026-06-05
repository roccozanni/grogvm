// Explorer island — `/explore?game=<id>`, the session-free resource browser.
import '../../styles/base.css';
import '../../styles/explorer.css';
import { renderExplorer } from './explorer';
import { currentGameParam, libraryHref } from '../../platform/routing/routing';
import { mountPage, findInstalledByGameId, renderMissingGame, withReadPermission } from '../shared';

export function mount(root: HTMLElement): void {
  mountPage(root, () => {
    void (async () => {
      const raw = currentGameParam();
      if (!raw) {
        renderMissingGame(root, 'No game specified. Open one from the library.');
        return;
      }
      const game = await findInstalledByGameId(raw);
      if (!game) {
        renderMissingGame(root, `No installed game “${raw}”. Install it from the library.`);
        return;
      }
      withReadPermission(root, game, () => {
        root.replaceChildren(renderExplorer(game, () => location.assign(libraryHref)));
      });
    })();
  });
}
