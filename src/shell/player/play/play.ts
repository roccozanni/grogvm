/**
 * The Play surface (ARCHITECTURE.md §7) — the clean game: a 320×200-class
 * canvas fed by `session.onFrame`, the cursor / verb-bar / sentence / talk
 * overlays, and a minimal save / load / exit bar. Built on the EngineSession
 * (task 1); no VM internals here (that's the Debug drawer, task 6).
 *
 * The room background + actors + objects are composited by the SESSION and
 * presented to the frame canvas (Canvas2DRenderer). The overlays are the
 * existing `play-area.ts` (reused, reading `session.vm`); room input is the
 * existing `mountVmFrameInput`. Both are re-mounted only when the room's
 * dimensions change — the frame canvas element is reused so the renderer stays
 * bound to it and clicks don't drop.
 */
import { Canvas2DRenderer } from '../../../engine/render/canvas2d';
import { createSession, type FrameInfo } from '../../../engine/session';
import { el } from '../../reactive';
import type { StoredGame } from '../../storage/games';
import { loadSessionGame } from '../../storage/game-files';
import { readSave, writeSave } from '../../storage/savegames';
import { mountPlayArea, type PlayAreaHandles } from '../play-area';
import { mountVmFrameInput } from '../input';
import { mountDebugPanel } from '../debug/debug';
import { RafClock } from '../raf-clock';

const SCALE = 2;
const QUICK_SLOT = 'quicksave';

export function renderPlay(game: StoredGame, onBack: () => void): HTMLElement {
  const main = el('div', { class: 'play-main' }, el('div', { class: 'loading' }, 'Loading game files…'));
  const container = el('div', { class: 'play-screen' }, main);
  void mountGame(game, main, onBack);
  return container;
}

async function mountGame(game: StoredGame, main: HTMLElement, onBack: () => void): Promise<void> {
  let sessionGame;
  try {
    sessionGame = await loadSessionGame(game);
  } catch (err) {
    main.replaceChildren(errorBox((err as Error).message, onBack));
    return;
  }

  // Frame canvas: created once, the session presents into it and resizes it
  // as rooms change. Initial size is a placeholder; the first frame resizes.
  // Reuses the legacy `vm-frame-*` classes for the proven canvas-stacking CSS
  // (cursor overlay absolutely positioned over the frame).
  const frameCanvas = el('canvas', { class: 'vm-frame-canvas' });
  const renderer = new Canvas2DRenderer(frameCanvas, 320, 200);
  const clock = new RafClock();
  const session = createSession(sessionGame, renderer, clock, { autoPauseOnIdle: false });

  const gameArea = el('div', { class: 'play-game' });
  const stack = el('div', { class: 'vm-frame-stack' });
  const status = el('span', { class: 'play-status' });

  // The Debug panel shares this session (live VM inspection below the game,
  // always visible — it's a learning tool).
  const debug = mountDebugPanel(session, game.gameId);

  // Overlays are re-mounted on a dimension change (frame canvas is reused).
  let mounted: { width: number; height: number; play: PlayAreaHandles; disposeInput: () => void } | null = null;

  const remount = (frame: FrameInfo): void => {
    mounted?.disposeInput();
    // The stack's children are absolutely positioned (inset:0), so the stack
    // itself must carry the display size.
    stack.style.width = `${frame.width * SCALE}px`;
    stack.style.height = `${frame.height * SCALE}px`;
    frameCanvas.style.width = `${frame.width * SCALE}px`;
    frameCanvas.style.height = `${frame.height * SCALE}px`;
    const play = mountPlayArea({
      resourceFile: sessionGame.resourceFile,
      vm: session.vm,
      roomWidth: frame.width,
      roomHeight: frame.height,
      palette: frame.palette,
      transparentIndex: frame.transparentIndex,
      onCommit: () => {},
    });
    stack.replaceChildren(frameCanvas, play.cursorOverlay);
    const input = mountVmFrameInput({
      canvas: frameCanvas,
      vm: session.vm,
      roomWidth: frame.width,
      roomHeight: frame.height,
      onMove: () => play.onPointerMove(),
      onLeftClick: (e) => debug.recordClick(e, play.onRoomClick('left').objId),
      onRightClick: (e) => debug.recordClick(e, play.onRoomClick('right').objId),
      onEscape: () => session.sendInput({ type: 'key', key: 'Escape' }),
    });
    gameArea.replaceChildren(stack, play.verbBar);
    mounted = { width: frame.width, height: frame.height, play, disposeInput: input.dispose };
  };

  session.onFrame((frame) => {
    if (!mounted || mounted.width !== frame.width || mounted.height !== frame.height) remount(frame);
    mounted!.play.redraw();
  });

  const exit = (): void => {
    debug.dispose();
    session.dispose();
    onBack();
  };
  const save = (): void => {
    writeSave(game.gameId, QUICK_SLOT, session.snapshot(QUICK_SLOT));
    status.textContent = 'Quick-saved.';
  };
  const load = (): void => {
    const snap = readSave(game.gameId, QUICK_SLOT);
    if (!snap) {
      status.textContent = 'No quicksave yet.';
      return;
    }
    session.restore(snap);
    status.textContent = 'Quick-loaded.';
  };

  const bar = el(
    'div',
    { class: 'play-bar' },
    el('button', { class: 'secondary', onClick: exit }, '← Library'),
    el('button', { class: 'secondary', onClick: save }, 'Quick save'),
    el('button', { class: 'secondary', onClick: load }, 'Quick load'),
    status,
  );

  // Debug panel sits BELOW the play area (full width) so its panels/grids
  // have room — beside the fixed-width canvas they collapsed into a squeezed
  // column.
  main.replaceChildren(bar, gameArea, debug.element);

  // Present one frame immediately (populates the overlays), then run.
  session.step();
  session.play();
}

function errorBox(message: string, onBack: () => void): HTMLElement {
  return el(
    'div',
    { class: 'play-error' },
    el('p', {}, `Could not load the game: ${message}`),
    el('button', { class: 'secondary', onClick: onBack }, '← Library'),
  );
}
