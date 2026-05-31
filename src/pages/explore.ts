// Entry for `/explore/?game=<id>` — the resource explorer.
//
// TEMPORARY (Phase 10): renders the legacy `renderPlayer` (which contains the
// room / costume / charset / block-tree browsers). Task 4 replaces this with a
// dedicated, session-free Explorer surface; task 7 deletes the legacy view.
// The page scaffold (boot, ?game= resolve, permission gate) stays.
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
