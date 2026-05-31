/**
 * Debug panel (ARCHITECTURE.md §7, Q8) — live VM inspection below the Play
 * canvas, driven off the SAME EngineSession. **Always visible**: webscumm is a
 * learning tool, so the VM internals are never hidden behind a toggle.
 *
 * Controls (play / pause / step / rate / run-to-idle / warp / reboot) call the
 * session. The inspection panels (slot table, globals / bits grids, trace,
 * actor table, input panel, halt) and the full saves panel are REUSED from the
 * legacy `vm-inspector.ts` via a session-backed `InspectorState` — the loop
 * fields it once owned are stubbed (the session owns the loop now) and the
 * display fields are refreshed each frame.
 *
 * TEMPORARY (Phase 10): the panel renderers still live in the soon-to-be-
 * deleted `vm-inspector.ts`; they relocate into this folder in task 7 (same
 * deferred-move pattern as the Explorer in task 4).
 */
import { signal, bindText, el, createRoot, onCleanup } from '../../reactive';
import type { EngineSession } from '../../../engine/session';
import type { GameId } from '../../install/detect';
import type { ClickEvent } from '../input';
import {
  renderLive,
  renderSavesPanel,
  type InspectorState,
  type RecentClick,
} from '../vm-inspector';

const RECENT_CLICKS_CAP = 12;
const RATE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120];

export interface DebugPanel {
  readonly element: HTMLElement;
  /** Record a room click for the Input panel's history. */
  recordClick(e: ClickEvent, objId: number | null): void;
  dispose(): void;
}

export function mountDebugPanel(session: EngineSession, gameId: GameId): DebugPanel {
  // InspectorState backing the reused panels. Loop-internal fields are stubbed
  // (the session owns the loop); the meaningful display fields are refreshed
  // from session state each frame.
  const state: InspectorState = {
    vm: session.vm,
    globalsShown: 64,
    bitsShown: 256,
    playing: false,
    rafId: null,
    tickCount: 0,
    lastIdleFingerprint: null,
    idleStreak: 0,
    idleReason: null,
    showWalkOverlay: false,
    warpRoomId: 1,
    tickRateHz: 60,
    lastTickAt: 0,
    recentClicks: [],
    lastPalette: null,
    lastTransparentIndex: null,
    mountedFrame: null,
  };

  let element!: HTMLElement;
  let recordClick: (e: ClickEvent, objId: number | null) => void = () => {};

  const dispose = createRoot((disposeRoot) => {
    const tickSig = signal(0);
    const playingSig = signal(false);
    const roomSig = signal('');

    // Live panels: full rebuild per frame (matches the legacy inspector; the
    // tables have no critical click targets).
    const live = el('div', { class: 'vm-live' });
    const repaintLive = (): void => {
      state.vm = session.vm;
      live.replaceChildren(renderLive(state, repaintLive));
    };

    // Saves: rebuilt only on discrete actions (keeps the slot-name input focus).
    const saves = el('div', { class: 'vm-saves-host' });
    const repaintSaves = (): void => {
      saves.replaceChildren(
        renderSavesPanel(
          state,
          gameId,
          (label) => session.snapshot(label),
          (snap) => {
            session.restore(snap);
            repaintSaves();
          },
          repaintSaves,
        ),
      );
    };

    // Controls (wired straight to the session).
    const playBtn = el('button', {
      class: 'secondary',
      onClick: () => {
        // Pausing stops the clock, so no onFrame follows to refresh the label
        // — sync the signal here too.
        if (session.status().playing) session.pause();
        else session.play();
        playingSig.set(session.status().playing);
      },
    });
    bindText(playBtn, () => (playingSig() ? '⏸ Pause' : '▶ Play'));

    const roomLabel = el('span', { class: 'vm-room-label' });
    bindText(roomLabel, () => roomSig());

    const counter = el('span', { class: 'vm-tick-counter' });
    bindText(counter, () => `tick ${tickSig()}`);

    const rate = el(
      'select',
      {
        class: 'vm-rate',
        onChange: (e: Event) => session.setRate(Number((e.target as HTMLSelectElement).value)),
      },
      ...RATE_STEPS.map((hz) => el('option', { value: String(hz) }, `${hz} Hz`)),
    );
    rate.value = '60';

    const warpInput = el('input', { type: 'number', class: 'vm-warp-input', value: '1' });
    const controls = el(
      'div',
      { class: 'vm-controls' },
      playBtn,
      el('button', { class: 'secondary', onClick: () => session.step() }, 'Step'),
      el('button', { class: 'secondary', onClick: () => session.skipCutscene() }, 'Run to idle'),
      el('span', { class: 'vm-rate-label' }, 'rate '),
      rate,
      el('span', { class: 'vm-warp-label' }, 'room '),
      warpInput,
      el(
        'button',
        { class: 'secondary', onClick: () => session.enterRoom(Number(warpInput.value) || 0) },
        'Warp',
      ),
      el('button', { class: 'secondary', onClick: () => session.reboot() }, 'Reboot'),
      roomLabel,
      counter,
    );

    element = el(
      'section',
      { class: 'vm-debug' },
      el('h2', { class: 'vm-debug-heading' }, 'VM inspector'),
      controls,
      saves,
      live,
    );

    // Per-frame refresh: live label updates + rebuild the panels.
    const unsub = session.onFrame(() => {
      const st = session.status();
      state.tickCount = st.tickCount;
      state.idleReason = st.idleReason;
      state.playing = st.playing;
      state.tickRateHz = st.tickRateHz;
      tickSig.set(st.tickCount);
      playingSig.set(st.playing);
      const vm = session.vm;
      roomSig.set(`room ${vm.currentRoom}${vm.loadedRoom ? ` (${vm.loadedRoom.width}×${vm.loadedRoom.height})` : ' — none loaded'}`);
      repaintLive();
    });
    onCleanup(unsub);

    recordClick = (e, objId): void => {
      const entry: RecentClick = { ...e, tickCount: state.tickCount, objId };
      state.recentClicks.unshift(entry);
      if (state.recentClicks.length > RECENT_CLICKS_CAP) state.recentClicks.length = RECENT_CLICKS_CAP;
      repaintLive();
    };

    // Initial paint.
    repaintSaves();
    repaintLive();

    return disposeRoot;
  });

  return {
    element,
    recordClick: (e, objId) => recordClick(e, objId),
    dispose,
  };
}
