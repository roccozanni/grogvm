// Player island — `/play?game=<id>`, the game canvas + Debug drawer.
import '../../styles/player.css';
import { renderPlay } from './play/play';
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
        root.replaceChildren(renderPlay(game, () => location.assign(libraryHref)));
      });
    })();
  });
}
