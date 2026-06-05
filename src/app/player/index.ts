// Player island — `/play?game=<id>`, the game canvas + Debug drawer.
import '../../styles/player.css';
import { renderPlay } from './play/play';
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
        root.replaceChildren(renderPlay(game, () => location.assign(libraryHref)));
      });
    })();
  });
}
