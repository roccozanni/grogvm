// Entry for `/play/?game=<id>` — the player.
//
// TEMPORARY (Phase 10): renders the legacy `renderPlayer` (the combined
// resource-browser + VM-inspector view). Tasks 5–6 replace this with the
// clean Play canvas + Debug drawer built on the EngineSession; task 7 deletes
// the legacy view. The page scaffold (boot, ?game= resolve, permission gate)
// stays.
import '../styles.css';
import { renderPlayer } from '../shell/player/player';
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
      root.replaceChildren(renderPlayer(game, () => location.assign(homeHref)));
    });
  })();
});
