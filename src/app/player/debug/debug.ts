/**
 * Debug panel (pages/docs/engine/architecture.md §5): live VM inspection below
 * the Play canvas, driven off the same EngineSession. Always visible — GrogVM
 * is a learning tool, so VM internals are never hidden behind a toggle.
 */
import { signal, bindText, el, createRoot, onCleanup } from '../../reactive';
import type { EngineSession } from '../../../engine/session';
import type { ClickEvent } from '../input';
import {
  renderLive,
  renderSavesPanel,
  type InspectorState,
  type RecentClick,
} from './panels';

const RECENT_CLICKS_CAP = 12;
const RATE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120];

export interface DebugPanel {
  readonly element: HTMLElement;
  /** Record a room click for the Input panel's history. */
  recordClick(e: ClickEvent, objId: number | null): void;
  dispose(): void;
}

// saveKey namespaces this install's save slots (per-install UUID, so two
// language variants don't share); saveLabel prefixes exported-save filenames.
export function mountDebugPanel(
  session: EngineSession,
  saveKey: string,
  saveLabel: string,
): DebugPanel {
  // Loop-internal InspectorState fields are stubbed (the session owns the
  // loop); the display fields are refreshed from session state each frame.
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
          saveKey,
          saveLabel,
          (label) => session.snapshot(label),
          (snap) => {
            session.restore(snap);
            repaintSaves();
          },
          repaintSaves,
        ),
      );
    };

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

    // Surfaces "clicks that change nothing" (a script parked waiting on a var
    // the input never sets). Hidden until the watchdog fires.
    const watchdogBanner = el('div', { class: 'vm-watchdog', style: 'display:none' });
    let wiredVm: typeof session.vm | null = null;
    const wireWatchdog = (vm: typeof session.vm): void => {
      vm.enableHangWatchdog((info) => {
        const msg =
          `Hang watchdog: ${info.deadInputs} clicks in a row changed nothing ` +
          `in room ${info.room} — VAR_VERB_SCRIPT=${info.verbScript}, ` +
          `live scripts [${info.liveScripts.join(', ')}]. Input may be misrouted.`;
        // eslint-disable-next-line no-console
        console.warn('[GrogVM] ' + msg);
        watchdogBanner.textContent = '⚠ ' + msg;
        watchdogBanner.style.display = '';
      });
    };

    element = el(
      'section',
      { class: 'vm-debug' },
      el('h2', { class: 'vm-debug-heading' }, 'VM inspector'),
      watchdogBanner,
      controls,
      saves,
      live,
    );

    const unsub = session.onFrame(() => {
      const st = session.status();
      state.tickCount = st.tickCount;
      state.idleReason = st.idleReason;
      state.playing = st.playing;
      state.tickRateHz = st.tickRateHz;
      tickSig.set(st.tickCount);
      playingSig.set(st.playing);
      const vm = session.vm;
      // Re-attach the watchdog when the VM instance changes (reboot/restore).
      if (vm !== wiredVm) {
        wiredVm = vm;
        watchdogBanner.style.display = 'none';
        wireWatchdog(vm);
      }
      roomSig.set(`room ${vm.currentRoom}${vm.loadedRoom ? ` (${vm.loadedRoom.width}×${vm.loadedRoom.height})` : ' — none loaded'}`);
      // Rebuild the heavy tables (~350 DOM nodes) ONLY when paused/stepping —
      // doing it during play janks camera-follow. The cheap bindText labels
      // keep updating every frame.
      if (!st.playing) repaintLive();
    });
    onCleanup(unsub);

    recordClick = (e, objId): void => {
      const entry: RecentClick = { ...e, tickCount: state.tickCount, objId };
      state.recentClicks.unshift(entry);
      if (state.recentClicks.length > RECENT_CLICKS_CAP) state.recentClicks.length = RECENT_CLICKS_CAP;
      repaintLive();
    };

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
