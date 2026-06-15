// @vitest-environment happy-dom
/**
 * The reactive debug panels (panels.ts) against a hand-rolled fake VM — no
 * engine boot, no session. Pins what the conversion to the reactive core has
 * to preserve: panels build ONCE and update in place (the anim <details> keeps
 * its open state across a repaint; var cells are reused, not rebuilt), the
 * conditional banners toggle, and the click ring rides its own signal.
 */
import { describe, it, expect } from 'vitest';
import { signal, createRoot, type Signal } from '../../reactive';
import { livePanels, type LiveDeps, type RecentClick } from './panels';
import type { Vm } from '../../../engine/vm/vm';

type Limb = { active: boolean; finished: boolean; start: number; cursor: number; length: number; noLoop: boolean };
const limb = (over: Partial<Limb> = {}): Limb => ({
  active: false,
  finished: false,
  start: 0,
  cursor: 0,
  length: 1,
  noLoop: false,
  ...over,
});

function fakeActor(over: Record<string, unknown> = {}): unknown {
  return {
    id: 3,
    room: 1,
    costume: 5,
    x: 100,
    y: 50,
    isMoving: false,
    visible: true,
    walkTarget: null,
    facing: 'S',
    scale: 255,
    anim: { animId: 0, limbs: [limb(), limb()] },
    ...over,
  };
}

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

function mount(vm: Vm): Harness {
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
  return { host: livePanels(deps), tick, idle, clicks, globalsShown };
}

const bump = (h: Harness): void => h.tick.set((n) => n + 1);

describe('livePanels — structure', () => {
  it('renders every section', () => {
    createRoot(() => {
      const { host } = mount(fakeVm());
      expect(host.querySelector('.vm-input-panel')).not.toBeNull();
      expect(host.querySelector('.vm-actors')).not.toBeNull();
      expect(host.querySelector('.vm-slots')).not.toBeNull();
      expect(host.querySelector('.vm-trace')).not.toBeNull();
      expect(host.querySelector('.vm-var-grid')).not.toBeNull();
      expect(host.querySelector('.vm-bit-grid')).not.toBeNull();
    });
  });
});

describe('actor anim <details>', () => {
  it('keeps its open state across a repaint (the bug the rebuild caused)', () => {
    createRoot(() => {
      const animating = fakeActor({ anim: { animId: 2, limbs: [limb({ active: true, cursor: 1, length: 4 })] } });
      const vm = fakeVm({ actors: { all: () => [animating], capacity: 13, get: () => null } });
      const h = mount(vm);

      const details = h.host.querySelector('details') as HTMLDetailsElement;
      expect(details).not.toBeNull();
      expect(details.style.display).toBe('');
      details.open = true; // user expands it

      bump(h); // a frame ticks by

      // Same element, still open — not a fresh node that snapped shut.
      expect(h.host.querySelector('details')).toBe(details);
      expect(details.open).toBe(true);
    });
  });

  it('hides the <details> when no actor is animating', () => {
    createRoot(() => {
      const vm = fakeVm({ actors: { all: () => [fakeActor()], capacity: 13, get: () => null } });
      const { host } = mount(vm);
      expect((host.querySelector('details') as HTMLDetailsElement).style.display).toBe('none');
    });
  });
});

describe('globals grid', () => {
  it('reuses cells and updates values in place rather than rebuilding', () => {
    createRoot(() => {
      const vm = fakeVm();
      const h = mount(vm);
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
