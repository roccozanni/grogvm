// Entry for `/play/?game=<id>` — the player.
//
// Renders the clean Play surface (game canvas + overlays, built on the
// EngineSession). The Debug drawer (task 6) mounts alongside it next; the
// legacy combined view is deleted in task 7.
import '../styles.css';
import { renderPlay } from '../shell/player/play/play';
import { currentGameParam, homeHref } from '../shell/routing/routing';
import { mountPage, findInstalledByGameId, renderMissingGame, withReadPermission } from './shared';

mountPage((root) => {
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
      root.replaceChildren(renderPlay(game, () => location.assign(homeHref)));
    });
  })();
});
