/**
 * Debug panel (pages/docs/engine/architecture.md §5): live VM inspection below
 * the Play canvas, driven off the same EngineSession. Always visible — GrogVM
 * is a learning tool, so VM internals are never hidden behind a toggle.
 *
 * Built on the reactive core: the panel DOM is constructed ONCE and updates
 * through signal-driven effects (see panels.ts) — never a per-tick subtree
 * rebuild. A `tick` signal refreshes the cheap header labels every frame; a
 * throttled `live` signal drives the heavier tables so camera-follow stays
 * smooth while playing, and refreshes them immediately when paused / stepping.
 */
import { signal, el, createRoot, onCleanup } from '../../reactive';
import type { EngineSession } from '../../../engine/session';
import type { Vm } from '../../../engine/vm/vm';
import type { ClickEvent } from '../input';
import {
  alertBanners,
  livePanelTabs,
  tabbedPanels,
  savesPanel,
  type InspectorTab,
  type LiveDeps,
  type RecentClick,
} from './panels';

const RECENT_CLICKS_CAP = 12;
/**
 * Live-table repaint cadence during play. Per-frame table updates jank
 * camera-follow, but refreshing only on pause leaves the inspector stale —
 * this bumps the heavy panels every LIVE_REPAINT_MS while playing (full-rate
 * when paused/stepping), at a cost the frame loop doesn't feel.
 */
const LIVE_REPAINT_MS = 250;

// Remembered active inspector tab (matches the grogvm:debug:* flag namespace
// in play.ts), so a reload reopens the panel you were last reading.
const TAB_KEY = 'grogvm:debug:tab';
function readTab(): string {
  try {
    return globalThis.localStorage?.getItem(TAB_KEY) ?? 'saves';
  } catch {
    return 'saves';
  }
}
function writeTab(id: string): void {
  try {
    globalThis.localStorage?.setItem(TAB_KEY, id);
  } catch {
    /* ignore — a missing localStorage just means the tab won't persist */
  }
}

export interface DebugPanel {
  readonly element: HTMLElement;
  /** Record a room click for the Input panel's history. */
  recordClick(e: ClickEvent, objId: number | null): void;
  /** Rebuild the Saves list — call after an external write (e.g. Quick save). */
  refreshSaves(): void;
  dispose(): void;
}

// saveKey namespaces this install's save slots (per-install UUID, so two
// language variants don't share); saveLabel prefixes exported-save filenames.
export function mountDebugPanel(session: EngineSession, saveKey: string, saveLabel: string): DebugPanel {
  let element!: HTMLElement;
  let recordClick: (e: ClickEvent, objId: number | null) => void = () => {};
  let refreshSaves: () => void = () => {};

  const dispose = createRoot((disposeRoot) => {
    const vm = (): Vm => session.vm; // accessor, not a captured ref (restore swaps it)
    const tickSig = signal(0); // current tickCount; bumps every frame
    const liveSig = signal(0); // heavy-table bump; throttled while playing
    const globalsShown = signal(64);
    const bitsShown = signal(256);
    const clicksSig = signal<readonly RecentClick[]>([]);

    let lastLiveAt = 0;
    const bumpLive = (): void => {
      lastLiveAt = performance.now();
      liveSig.set((n) => n + 1);
    };

    // The inspector observes the VM and changes nothing — driving the clock
    // lives in the headless tooling (spyglass, disgrogate, the integration
    // harness), not in a live play session. `tickSig` no longer drives a
    // visible counter; it survives only to timestamp clicks in the Input ring
    // (room id + dimensions moved into the Stage tab's Room section).

    // Surfaces "clicks that change nothing" (a script parked waiting on a var
    // the input never sets). Hidden until the watchdog fires; re-armed on a
    // VM swap (restore).
    const watchdogBanner = el('div', { class: 'vm-watchdog', style: { display: 'none' } });
    let wiredVm: Vm | null = null;
    const wireWatchdog = (v: Vm): void => {
      v.enableHangWatchdog((info) => {
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

    // Saves: rebuilt only on discrete actions (keeps the slot-name input focus).
    const savesHost = el('div', { class: 'vm-saves-host' });
    const repaintSaves = (): void => {
      savesHost.replaceChildren(
        savesPanel(
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
    refreshSaves = repaintSaves;

    const deps: LiveDeps = {
      vm,
      live: liveSig,
      idleReason: () => session.status().idleReason,
      recentClicks: clicksSig,
      globalsShown,
      bitsShown,
    };

    // Saves first — it's what a normal player reaches for; the VM-internals
    // tabs follow. Its rebuilds (on discrete save/load actions) stay walled off
    // from the other panes.
    const tabs: InspectorTab[] = [{ id: 'saves', label: 'Saves', build: () => savesHost }, ...livePanelTabs(deps)];

    element = el(
      'section',
      { class: 'vm-debug' },
      watchdogBanner,
      alertBanners(deps),
      tabbedPanels(tabs, { initialTab: readTab(), onTabChange: writeTab }),
    );

    const unsub = session.onFrame(() => {
      const st = session.status();
      tickSig.set(st.tickCount);
      const v = session.vm;
      if (v !== wiredVm) {
        wiredVm = v;
        watchdogBanner.style.display = 'none';
        wireWatchdog(v);
      }
      // Heavy tables: full-rate when paused/stepping, throttled while playing —
      // per-frame table updates jank camera-follow.
      if (!st.playing || performance.now() - lastLiveAt >= LIVE_REPAINT_MS) bumpLive();
    });
    onCleanup(unsub);

    recordClick = (e, objId): void => {
      const entry: RecentClick = { ...e, tickCount: tickSig.peek(), objId };
      clicksSig.set((prev) => [entry, ...prev].slice(0, RECENT_CLICKS_CAP));
    };

    repaintSaves();

    return disposeRoot;
  });

  return {
    element,
    recordClick: (e, objId) => recordClick(e, objId),
    refreshSaves: () => refreshSaves(),
    dispose,
  };
}
