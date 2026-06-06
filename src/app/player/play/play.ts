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
import type { StoredGame } from '../../../platform/storage/games';
import { loadSessionGame } from '../../../platform/storage/game-files';
import { readSave, writeSave } from '../../../platform/storage/savegames';
import { mountPlayArea, type PlayAreaHandles } from '../play-area';
import { mountVmFrameInput } from '../input';
import { mountDebugPanel } from '../debug/debug';
import { RafClock } from '../raf-clock';

const SCALE = 2.5;
const QUICK_SLOT = 'quicksave';

// Debug-overlay toggles persist across reloads and are NOT game-specific.
const WALK_PATHS_KEY = 'grogvm:debug:walk-paths';
const HIT_AREAS_KEY = 'grogvm:debug:hit-areas';

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? '1' : '0');
  } catch {
    /* ignore — a missing localStorage just means the toggle won't persist */
  }
}

// Inline glyphs for the play-bar buttons (no emoji — see code conventions).
// All stroke in currentColor so they inherit the button/bar text colour.
const ICON_ATTRS = `width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const SAVE_ICON_SVG = `<svg viewBox="0 0 24 24" ${ICON_ATTRS}>
  <path d="M4 4h13l3 3v13H4z" /><path d="M8 4v5h6V4" /><rect x="8" y="13" width="8" height="6" />
</svg>`;
const LOAD_ICON_SVG = `<svg viewBox="0 0 24 24" ${ICON_ATTRS}>
  <path d="M4 6h5l2 2h7v3H4z" /><path d="M4 11h17l-2 7H6z" />
</svg>`;
const BUG_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
  <line x1="10" y1="4" x2="11.5" y2="6.5" /><line x1="14" y1="4" x2="12.5" y2="6.5" />
  <circle cx="12" cy="7.5" r="1.8" />
  <ellipse cx="12" cy="14" rx="4" ry="5.5" />
  <line x1="8" y1="12" x2="4.5" y2="10.5" /><line x1="8" y1="14.5" x2="4" y2="14.5" /><line x1="8" y1="17" x2="4.5" y2="18.5" />
  <line x1="16" y1="12" x2="19.5" y2="10.5" /><line x1="16" y1="14.5" x2="20" y2="14.5" /><line x1="16" y1="17" x2="19.5" y2="18.5" />
</svg>`;

/** A span holding an inline SVG glyph, for use as button/label content. */
function iconEl(svg: string, className = 'btn-icon'): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = svg;
  return span;
}

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

  // Live debug-overlay state, restored from localStorage. Mutated in place by
  // the toggle buttons and re-applied to the play area (which is re-created on
  // each room change).
  const overlayFlags = {
    walk: readFlag(WALK_PATHS_KEY),
    hit: readFlag(HIT_AREAS_KEY),
  };

  // The Debug panel shares this session (live VM inspection below the game,
  // always visible — it's a learning tool).
  const debug = mountDebugPanel(session, game.id, game.variant);

  // Overlays are re-mounted on a dimension change OR when the session swaps in
  // a new VM (quick-load / reboot adopt a fresh VM). The overlays + input
  // capture a VM reference at mount; without re-binding they keep reading the
  // discarded VM after a restore — stale camera (offset object highlights) and
  // dead clicks (writes land on the old VM). Tracking the VM identity here
  // re-binds them even when the room dimensions are unchanged.
  let mounted: {
    width: number;
    height: number;
    vm: typeof session.vm;
    play: PlayAreaHandles;
    disposeInput: () => void;
  } | null = null;

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
      debug: overlayFlags,
      onCommit: () => {},
    });
    stack.replaceChildren(frameCanvas, play.debugOverlay, play.cursorOverlay);
    const input = mountVmFrameInput({
      canvas: frameCanvas,
      vm: session.vm,
      // frame.width is the camera VIEWPORT width (the canvas size); the real
      // room width + camera offset are read live from the VM inside the input.
      viewportWidth: frame.width,
      roomWidth: frame.width,
      roomHeight: frame.height,
      onMove: () => play.onPointerMove(),
      onLeftClick: (e) => debug.recordClick(e, play.onRoomClick('left').objId),
      onRightClick: (e) => debug.recordClick(e, play.onRoomClick('right').objId),
      onEscape: () => session.sendInput({ type: 'key', key: 'Escape' }),
      onSkipLine: () => session.sendInput({ type: 'key', key: '.' }),
    });
    gameArea.replaceChildren(stack, play.verbBar);
    mounted = { width: frame.width, height: frame.height, vm: session.vm, play, disposeInput: input.dispose };
  };

  session.onFrame((frame) => {
    if (
      !mounted ||
      mounted.width !== frame.width ||
      mounted.height !== frame.height ||
      mounted.vm !== session.vm
    ) {
      remount(frame);
    }
    mounted!.play.redraw();
  });

  const save = (): void => {
    writeSave(game.id, QUICK_SLOT, session.snapshot(QUICK_SLOT));
  };
  const load = (): void => {
    const snap = readSave(game.id, QUICK_SLOT);
    if (!snap) return;
    session.restore(snap);
  };

  // A control bar sits below the play area, split into two groups: "game"
  // actions (save/load and the like) on the left, "debug" toggles on the right.
  const gameGroup = el(
    'div',
    { class: 'play-controls-group play-controls-game' },
    el('button', { class: 'secondary', onClick: save }, iconEl(SAVE_ICON_SVG), 'Quick save'),
    el('button', { class: 'secondary', onClick: load }, iconEl(LOAD_ICON_SVG), 'Quick load'),
  );

  // A debug toggle: yellow when on, persisted, applied live to the play area.
  const toggle = (label: string, key: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const btn = el('button', { class: 'secondary play-toggle' }, iconEl(BUG_ICON_SVG), label);
    btn.classList.toggle('is-on', get());
    btn.addEventListener('click', () => {
      set(!get());
      writeFlag(key, get());
      btn.classList.toggle('is-on', get());
      mounted?.play.setDebugFlags(overlayFlags);
    });
    return btn;
  };
  const debugGroup = el(
    'div',
    { class: 'play-controls-group play-controls-debug' },
    toggle('Walk paths', WALK_PATHS_KEY, () => overlayFlags.walk, (v) => (overlayFlags.walk = v)),
    toggle('Hit areas', HIT_AREAS_KEY, () => overlayFlags.hit, (v) => (overlayFlags.hit = v)),
  );
  const controls = el('div', { class: 'play-controls' }, gameGroup, debugGroup);

  // Wrap the title in .prose so it gets the exact content-page <h1> styling
  // (the rest of the play screen stays outside .prose with its dense layout).
  const title = el(
    'div',
    { class: 'prose' },
    el('h1', {}, game.displayName, el('span', { class: 'play-variant' }, game.variant)),
  );

  // Debug panel sits BELOW the play area (full width) so its panels/grids
  // have room — beside the fixed-width canvas they collapsed into a squeezed
  // column.
  main.replaceChildren(title, gameArea, controls, debug.element);

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
