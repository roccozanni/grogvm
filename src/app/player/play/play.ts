/**
 * The Play surface (pages/docs/engine/architecture.md §5): one canvas holding
 * the whole screen, plus a save/load/debug bar. Built on the EngineSession —
 * no VM internals here (that's the Debug drawer).
 */
import { Canvas2DRenderer } from '../../../engine/render/canvas2d';
import { createSession, type FrameInfo } from '../../../engine/session';
import { VIEWPORT_W } from '../../../engine/graphics/viewport';
import { el } from '../../reactive';
import type { StoredGame } from '../../../platform/storage/games';
import { loadSessionGame } from '../../../platform/storage/game-files';
import { readSave, writeSave } from '../../../platform/storage/savegames';
import { mountPlayArea, SCREEN_HEIGHT, type PlayAreaHandles } from '../play-area';
import { mountScreenInput } from '../input';
import { mountDebugPanel } from '../debug/debug';
import { RafClock } from '../raf-clock';

const SCALE = 2.5;
const QUICK_SLOT = 'quicksave';

const WALK_PATHS_KEY = 'grogvm:debug:walk-paths';
const HIT_AREAS_KEY = 'grogvm:debug:hit-areas';
const ZPLANES_KEY = 'grogvm:debug:zplanes';

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

// Inline SVGs rather than emoji glyphs (code conventions ban emoji).
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

  // ONE visible canvas holds the whole screen (room slice on top, verb panel
  // below); created once, resized on room change.
  const screenCanvas = el('canvas', { class: 'vm-screen-canvas' }) as HTMLCanvasElement;
  const screenCtx = screenCanvas.getContext('2d')!;
  screenCtx.imageSmoothingEnabled = false;

  // The session composites into the renderer's OWN canvas, kept offscreen;
  // each frame it's blitted onto the screen canvas, leaving renderer +
  // compositor untouched. Initial size is a placeholder.
  const roomCanvas = document.createElement('canvas');
  const renderer = new Canvas2DRenderer(roomCanvas, 320, 200);
  const clock = new RafClock();
  const session = createSession(sessionGame, renderer, clock, { autoPauseOnIdle: false });

  const gameArea = el('div', { class: 'play-game' });
  // Current screen surface dimensions (native pixels), set on each remount.
  let screenW = 0;
  let screenH = 0;

  // Mutated in place by the toggle buttons and re-applied to the play area on
  // each remount.
  const overlayFlags = {
    walk: readFlag(WALK_PATHS_KEY),
    hit: readFlag(HIT_AREAS_KEY),
    zplane: readFlag(ZPLANES_KEY),
  };

  const debug = mountDebugPanel(session, game.id, `${game.gameId}-${game.variant}`);

  // Remount on a dimension change OR when the session swaps in a new VM
  // (quick-load / reboot): overlays + input capture a VM reference at mount,
  // and without re-binding they'd keep reading the discarded VM after a
  // restore — stale camera and dead clicks.
  let mounted: {
    width: number;
    height: number;
    vm: typeof session.vm;
    play: PlayAreaHandles;
    disposeInput: () => void;
  } | null = null;

  const remount = (frame: FrameInfo): void => {
    mounted?.disposeInput();
    // frame.width is the room camera-window (slice) width; the verb panel is
    // a 320-wide screen strip, so the screen is at least that wide.
    const viewportW = frame.width;
    const roomH = frame.height;
    screenW = Math.max(viewportW, VIEWPORT_W);
    // max() only grows past the fixed 320×200 screen for the pathological
    // room-taller-than-screen case, to avoid clipping.
    screenH = Math.max(roomH, SCREEN_HEIGHT);
    screenCanvas.width = screenW;
    screenCanvas.height = screenH;
    screenCanvas.style.width = `${screenW * SCALE}px`;
    screenCanvas.style.height = `${screenH * SCALE}px`;
    // Resizing the canvas resets context state — re-apply the pixel-art flag.
    screenCtx.imageSmoothingEnabled = false;
    const play = mountPlayArea({
      resourceFile: sessionGame.resourceFile,
      vm: session.vm,
      ctx: screenCtx,
      roomWidth: viewportW,
      roomHeight: roomH,
      screenWidth: screenW,
      screenHeight: screenH,
      palette: frame.palette,
      transparentIndex: frame.transparentIndex,
      debug: overlayFlags,
      onCommit: () => {},
    });
    const input = mountScreenInput({
      canvas: screenCanvas,
      vm: session.vm,
      viewportWidth: viewportW,
      screenWidth: screenW,
      roomHeight: roomH,
      screenHeight: screenH,
      onMove: (p) => {
        play.onPointerMove(p);
        refresh();
      },
      onLeftClick: (e) => {
        debug.recordClick(e, play.onScreenClick(e, 'left').objId);
        refresh();
      },
      onRightClick: (e) => {
        debug.recordClick(e, play.onScreenClick(e, 'right').objId);
        refresh();
      },
      onEscape: () => session.sendInput({ type: 'key', key: 'Escape' }),
      onSkipLine: () => session.sendInput({ type: 'key', key: '.' }),
    });
    gameArea.replaceChildren(screenCanvas);
    mounted = { width: viewportW, height: roomH, vm: session.vm, play, disposeInput: input.dispose };
  };

  // Clear, blit the room slice, paint the play-area layers. Runs every engine
  // frame AND every pointer move, so a stale crosshair never lingers.
  const refresh = (): void => {
    if (!mounted) return;
    screenCtx.clearRect(0, 0, screenW, screenH);
    screenCtx.drawImage(roomCanvas, 0, 0);
    mounted.play.redraw();
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
    refresh();
  });

  const save = (): void => {
    writeSave(game.id, QUICK_SLOT, session.snapshot(QUICK_SLOT));
  };
  const load = (): void => {
    const snap = readSave(game.id, QUICK_SLOT);
    if (!snap) return;
    session.restore(snap);
  };

  const gameGroup = el(
    'div',
    { class: 'play-controls-group play-controls-game' },
    el('button', { class: 'secondary', onClick: save }, iconEl(SAVE_ICON_SVG), 'Quick save'),
    el('button', { class: 'secondary', onClick: load }, iconEl(LOAD_ICON_SVG), 'Quick load'),
  );

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
    toggle('Z-planes', ZPLANES_KEY, () => overlayFlags.zplane, (v) => (overlayFlags.zplane = v)),
  );
  const controls = el('div', { class: 'play-controls' }, gameGroup, debugGroup);

  // .prose gives the title the content-page <h1> styling; the rest of the
  // screen stays outside it with its dense layout.
  const title = el(
    'div',
    { class: 'prose' },
    el('h1', {}, game.displayName, el('span', { class: 'play-variant' }, game.variant)),
  );

  // Debug panel sits BELOW the play area: beside the fixed-width canvas its
  // grids collapsed into a squeezed column.
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
