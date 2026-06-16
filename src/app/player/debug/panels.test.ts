// @vitest-environment happy-dom
/**
 * The reactive debug panels (panels.ts) against a hand-rolled fake VM — no
 * engine boot, no session. Pins what the conversion to the reactive core has
 * to preserve: panels build ONCE and update in place (var cells are reused,
 * not rebuilt), the conditional banners toggle, the click ring rides its own
 * signal, and the tabs show one pane at a time without rebuilding.
 */
import { describe, it, expect } from 'vitest';
import { signal, createRoot, el, type Signal } from '../../reactive';
import { alertBanners, livePanelTabs, tabbedPanels, type LiveDeps, type RecentClick } from './panels';
import type { Vm } from '../../../engine/vm/vm';

function fakeVm(over: Record<string, unknown> = {}): Vm {
  const globals = new Array<number>(128).fill(0);
  return {
    currentRoom: 1,
    loadedRoom: { id: 1, width: 320, height: 144 },
    haltInfo: null,
    systemRequest: null,
    currentCharset: 4,
    mouseRoomX: 10,
    mouseRoomY: 20,
    screenEffect: { switchRoomEffect: 0, switchRoomEffect2: 0, requestFadeIn: false },
    input: { leftHold: false, rightHold: false },
    cursor: { state: 1, userput: 1 },
    verbs: new Map(),
    slots: [],
    trace: [],
    actors: { all: () => [], capacity: 13, get: () => null },
    audio: { inspect: () => [] },
    vars: {
      globals,
      numBits: 8,
      readGlobal: (i: number) => globals[i] ?? 0,
      readBit: () => 0,
    },
    ...over,
  } as unknown as Vm;
}

interface Harness {
  host: HTMLElement;
  tick: Signal<number>;
  idle: Signal<string | null>;
  clicks: Signal<readonly RecentClick[]>;
  globalsShown: Signal<number>;
}

function mount(vm: Vm, initialTab = 'exec'): Harness {
  const tick = signal(0);
  const idle = signal<string | null>(null);
  const clicks = signal<readonly RecentClick[]>([]);
  const globalsShown = signal(64);
  const bitsShown = signal(256);
  const deps: LiveDeps = {
    vm: () => vm,
    live: () => tick(),
    idleReason: () => idle(),
    recentClicks: () => clicks(),
    globalsShown,
    bitsShown,
  };
  // Mirror the production composition (debug.ts): the conditional alerts above
  // the tab strip, Saves first, then the live panels grouped into tabs. The
  // opening tab is a parameter so a test can probe a pane whose live updates
  // are gated on visibility (default 'exec', independent of the prod default).
  const tabs = [{ id: 'saves', label: 'Saves', build: () => el('div', { class: 'vm-saves-host' }) }, ...livePanelTabs(deps)];
  const host = el('div', {}, alertBanners(deps), tabbedPanels(tabs, { initialTab, onTabChange: () => {} }));
  return { host, tick, idle, clicks, globalsShown };
}

const bump = (h: Harness): void => h.tick.set((n) => n + 1);
const showTab = (h: Harness, label: string): void =>
  ([...h.host.querySelectorAll('.vm-tab')].find((t) => t.textContent === label) as HTMLButtonElement).click();

describe('livePanels — structure', () => {
  it('renders every section', () => {
    createRoot(() => {
      const { host } = mount(fakeVm());
      expect(host.querySelector('.vm-input-panel')).not.toBeNull();
      expect(host.querySelector('.vm-actors')).not.toBeNull();
      expect(host.querySelector('.vm-sounds')).not.toBeNull();
      expect(host.querySelector('.vm-slots')).not.toBeNull();
      expect(host.querySelector('.vm-trace')).not.toBeNull();
      expect(host.querySelector('.vm-var-grid')).not.toBeNull();
      expect(host.querySelector('.vm-bit-grid')).not.toBeNull();
    });
  });
});

describe('tabbed layout', () => {
  it('shows only the active pane and switches without rebuilding the panels', () => {
    createRoot(() => {
      const { host } = mount(fakeVm());
      // Default tab (exec) is visible; the others start hidden.
      expect(host.querySelector('#vm-pane-exec')!.hasAttribute('hidden')).toBe(false);
      expect(host.querySelector('#vm-pane-state')!.hasAttribute('hidden')).toBe(true);

      const slotsBefore = host.querySelector('.vm-slots'); // lives in the exec pane
      const stateTab = [...host.querySelectorAll('.vm-tab')].find((t) => t.textContent === 'State') as HTMLButtonElement;
      stateTab.click();

      // State pane shows, exec hides — same nodes, just toggled (not rebuilt).
      expect(host.querySelector('#vm-pane-state')!.hasAttribute('hidden')).toBe(false);
      expect(host.querySelector('#vm-pane-exec')!.hasAttribute('hidden')).toBe(true);
      expect(stateTab.getAttribute('aria-selected')).toBe('true');
      expect(host.querySelector('.vm-slots')).toBe(slotsBefore);
    });
  });

  it('keeps the halt + idle alerts out of the tabs (always visible)', () => {
    createRoot(() => {
      const { host } = mount(fakeVm());
      const alerts = host.querySelector('.vm-alerts')!;
      expect(alerts.querySelector('.vm-halt')).not.toBeNull();
      expect(alerts.querySelector('.vm-idle-banner')).not.toBeNull();
      // Not buried inside a tab pane.
      expect(host.querySelector('.vm-tabpane .vm-halt')).toBeNull();
      expect(host.querySelector('.vm-tabpane .vm-idle-banner')).toBeNull();
    });
  });

  it('freezes a hidden pane and repaints it fresh on reveal', () => {
    createRoot(() => {
      const vm = fakeVm();
      const h = mount(vm, 'exec'); // State pane starts hidden → gated off
      const cell5 = (): string =>
        h.host.querySelectorAll('.vm-var-grid .var-cell')[5]!.querySelector('.var-val')!.textContent!;
      expect(cell5()).toBe('0');

      vm.vars.globals[5] = 42;
      bump(h);
      expect(cell5()).toBe('0'); // hidden pane did NOT repaint

      showTab(h, 'State'); // reveal → catches up to the live VM in one repaint
      expect(cell5()).toBe('42');
    });
  });
});

describe('globals grid', () => {
  it('reuses cells and updates values in place rather than rebuilding', () => {
    createRoot(() => {
      const vm = fakeVm();
      const h = mount(vm, 'state'); // State pane visible so its live updates aren't gated off
      const grid = h.host.querySelector('.vm-var-grid')!;
      expect(grid.querySelectorAll('.var-cell').length).toBe(64);

      const valBefore = grid.querySelectorAll('.var-cell')[5]!.querySelector('.var-val');
      vm.vars.globals[5] = 42;
      bump(h);

      const cell5 = grid.querySelectorAll('.var-cell')[5]!;
      expect(cell5.querySelector('.var-val')).toBe(valBefore); // same node, reused
      expect(valBefore!.textContent).toBe('42');
      expect(cell5.classList.contains('var-nonzero')).toBe(true);
    });
  });

  it('"show more" grows the persistent cell set', () => {
    createRoot(() => {
      const h = mount(fakeVm()); // globals length 128, showing 64
      const wrap = h.host.querySelector('.vm-var-grid')!.parentElement!;
      const more = wrap.querySelector('button') as HTMLButtonElement;
      expect(more.style.display).toBe('');
      more.click();
      expect(wrap.querySelectorAll('.var-cell').length).toBe(128);
      expect(more.style.display).toBe('none'); // all shown now
    });
  });
});

describe('conditional banners + click ring', () => {
  it('toggles the idle banner on the idleReason signal', () => {
    createRoot(() => {
      const h = mount(fakeVm());
      const banner = h.host.querySelector('.vm-idle-banner') as HTMLElement;
      expect(banner.style.display).toBe('none');
      h.idle.set('engine settled');
      expect(banner.style.display).toBe('');
      expect(banner.textContent).toContain('engine settled');
    });
  });

  it('shows the click placeholder, then lists clicks when the signal updates', () => {
    createRoot(() => {
      const h = mount(fakeVm());
      expect(h.host.querySelector('.vm-input-clicks-host .vm-empty')).not.toBeNull();
      h.clicks.set([
        {
          button: 'left',
          x: 0,
          y: 0,
          screenY: 0,
          roomX: 12,
          roomY: 34,
          inVerbBand: false,
          modifiers: { shift: true, ctrl: false, alt: false, meta: false },
          tickCount: 9,
          objId: 7,
        },
      ]);
      const li = h.host.querySelector('.vm-input-clicks li')!;
      expect(li.textContent).toContain('tick 9');
      expect(li.textContent).toContain('obj #7');
      expect(li.textContent).toContain('Shift');
    });
  });
});

describe('sound panel', () => {
  const sound = (over: Record<string, unknown> = {}): unknown => ({
    id: 1,
    kind: 'pcm',
    total: 120,
    looping: false,
    isMusic: false,
    ...over,
  });

  it('shows the empty state when nothing is playing', () => {
    createRoot(() => {
      const { host } = mount(fakeVm());
      const panel = host.querySelector('.vm-sounds')!;
      expect(panel.querySelector('h3')!.textContent).toBe('Sound (0 active)');
      expect((panel.querySelector('.vm-empty') as HTMLElement).style.display).toBe('');
      expect((panel.querySelector('table') as HTMLElement).style.display).toBe('none');
    });
  });

  it('lists active sounds, music first, with their length', () => {
    createRoot(() => {
      const sounds = [
        sound({ id: 5, kind: 'pcm', total: 120 }),
        sound({ id: 9, kind: 'cd', looping: true, total: 0, isMusic: true }),
      ];
      const vm = fakeVm({ audio: { inspect: () => sounds } });
      const { host } = mount(vm);
      const rows = host.querySelectorAll('.vm-sounds tbody tr');
      expect(rows.length).toBe(2);
      // Music sorts first and carries the badge.
      expect(rows[0]!.classList.contains('sound-music')).toBe(true);
      expect(rows[0]!.querySelector('.sound-music-badge')!.textContent).toBe('music');
      expect(rows[0]!.textContent).toContain('looping');
      // The one-shot PCM shows its full duration (120 jiffies = 2.0s), not a countdown.
      expect(rows[1]!.textContent).toContain('2.0s');
    });
  });

  it('flags MIDI/silent renditions disabled and shows the device', () => {
    createRoot(() => {
      const vm = fakeVm({ audio: { inspect: () => [sound({ kind: 'midi', device: 'ADL' })] } });
      const { host } = mount(vm);
      const row = host.querySelector('.vm-sounds tbody tr')!;
      expect(row.classList.contains('sound-disabled')).toBe(true);
      expect(row.textContent).toContain('adl');
      expect(row.textContent).toContain('disabled (not implemented)');
    });
  });

  it('shows a restored sound as restored, with no known length', () => {
    createRoot(() => {
      const vm = fakeVm({ audio: { inspect: () => [sound({ kind: 'unknown', total: 0 })] } });
      const { host } = mount(vm);
      const cells = host.querySelectorAll('.vm-sounds tbody tr td');
      expect(cells[2]!.textContent).toBe('restored');
      expect(cells[3]!.textContent).toBe('—'); // length unknown after restore (snapshot carries none)
    });
  });
});

describe('halt panel', () => {
  it('appears only when the VM has halted', () => {
    createRoot(() => {
      const vm = fakeVm({
        haltInfo: {
          reason: 'unknown opcode',
          slotIndex: 2,
          scriptId: 130,
          pc: 0x1a,
          opcode: 0xff,
          bytecodeContext: new Uint8Array([0x01, 0xff, 0x02]),
          contextOpcodeOffset: 1,
          trace: [],
        },
      });
      const h = mount(vm);
      const halt = h.host.querySelector('.vm-halt') as HTMLElement;
      expect(halt.style.display).toBe('');
      expect(halt.textContent).toContain('HALTED — unknown opcode');
      expect(halt.querySelector('.hex-cell.hex-here')!.textContent).toBe('ff');
    });
  });
});
