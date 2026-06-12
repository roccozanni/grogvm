/**
 * The Play surface (pages/docs/engine/architecture.md §5): one canvas holding
 * the whole screen, plus a save/load/debug bar. Built on the EngineSession —
 * no VM internals here (that's the Debug drawer).
 */
import { Canvas2DRenderer } from '../../../platform/render/canvas2d';
import { createSession, type FrameInfo } from '../../../engine/session';
import { el } from '../../reactive';
import type { StoredGame } from '../../../platform/storage/games';
import { cdTrackFileResolver, loadSessionGame } from '../../../platform/storage/game-files';
import { WebAudioBackend } from '../../../platform/audio/web-audio-backend';
import { readSave, writeSave } from '../../../platform/storage/savegames';
import { mountPlayArea, type PlayAreaHandles } from '../play-area';
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
const SOUND_ON_SVG = `<svg viewBox="0 0 24 24" ${ICON_ATTRS}>
  <path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18 6a8.5 8.5 0 0 1 0 12" />
</svg>`;
const SOUND_OFF_SVG = `<svg viewBox="0 0 24 24" ${ICON_ATTRS}>
  <path d="M11 5 6 9H3v6h3l5 4z" /><line x1="16" y1="9" x2="22" y2="15" /><line x1="22" y1="9" x2="16" y2="15" />
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
  const audio = new WebAudioBackend(cdTrackFileResolver(game.directoryHandle));
  const session = createSession(sessionGame, renderer, clock, { autoPauseOnIdle: false, audio });

  // A hidden tab freezes the whole session (rAF stops the clock, audio
  // suspends with it) — surface that in the tab strip while it lasts.
  const baseTitle = document.title;
  document.addEventListener('visibilitychange', () => {
    document.title = document.hidden ? `⏸ ${baseTitle}` : baseTitle;
  });

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
    // The engine presents the full assembled screen; the shell canvas just
    // mirrors its dimensions. viewportWidth/roomHeight drive input mapping.
    const viewportW = frame.viewportWidth;
    const roomH = frame.roomHeight;
    screenW = frame.width;
    screenH = frame.height;
    screenCanvas.width = screenW;
    screenCanvas.height = screenH;
    screenCanvas.style.width = `${screenW * SCALE}px`;
    screenCanvas.style.height = `${screenH * SCALE}px`;
    // Resizing the canvas resets context state — re-apply the pixel-art flag.
    screenCtx.imageSmoothingEnabled = false;
    const play = mountPlayArea({
      vm: session.vm,
      ctx: screenCtx,
      roomWidth: viewportW,
      roomHeight: roomH,
      screenWidth: screenW,
      screenHeight: screenH,
      palette: frame.palette,
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
        // Paused: re-present so the engine-painted hover highlight tracks the
        // pointer. While playing the next frame picks the mouse VARs up anyway.
        if (!session.status().playing) session.present();
        refresh();
      },
      onLeftClick: (e) => {
        debug.recordClick(e, play.onScreenClick(e, 'left').objId);
        if (!session.status().playing) session.present();
        refresh();
      },
      onRightClick: (e) => {
        debug.recordClick(e, play.onScreenClick(e, 'right').objId);
        if (!session.status().playing) session.present();
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
    // Key on the BAND geometry, not screen dims: the screen is ~always
    // 320×200, but a 144→200 room-height change moves the input band split.
    if (
      !mounted ||
      mounted.width !== frame.viewportWidth ||
      mounted.height !== frame.roomHeight ||
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

  // Sound toggle — always starts muted (autoplay rules block sound pre-
  // gesture anyway; the unmute click IS the gesture). Mute keeps playback
  // rolling silently, so unmuting joins the music mid-stream on the virtual
  // clock. Icon-only: a text label made the controls bar wrap to two lines.
  const soundBtn = el('button', { class: 'secondary play-toggle' });
  const refreshSoundToggle = (): void => {
    const muted = audio.isMuted();
    soundBtn.replaceChildren(iconEl(muted ? SOUND_OFF_SVG : SOUND_ON_SVG));
    soundBtn.title = muted ? 'Unmute' : 'Mute';
    soundBtn.setAttribute('aria-label', soundBtn.title);
    // Highlighted while MUTED — the lit button is the "click me to unmute" cue.
    soundBtn.classList.toggle('is-on', muted);
  };
  soundBtn.addEventListener('click', () => {
    audio.setMuted(!audio.isMuted());
    refreshSoundToggle();
  });
  refreshSoundToggle();

  const gameGroup = el(
    'div',
    { class: 'play-controls-group play-controls-game' },
    el('button', { class: 'secondary', onClick: save }, iconEl(SAVE_ICON_SVG), 'Quick save'),
    el('button', { class: 'secondary', onClick: load }, iconEl(LOAD_ICON_SVG), 'Quick load'),
    soundBtn,
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
