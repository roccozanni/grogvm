// Entry for `/explore/?game=<id>` — the resource explorer.
//
// Renders the session-free Explorer (room / costume / charset / block-tree
// browsers; no VM, no EngineSession). The browser code still physically lives
// in the legacy player file and is re-exported via shell/explorer/ until task
// 7 relocates it — see shell/explorer/explorer.ts.
import '../styles.css';
import { renderExplorer } from '../shell/explorer/explorer';
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
      root.replaceChildren(renderExplorer(game, () => location.assign(homeHref)));
    });
  })();
});
