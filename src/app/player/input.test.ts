import { describe, expect, it } from 'vitest';
import { Vm } from '../../engine/vm/vm';
import {
  clientToScreenCoords,
  mountScreenInput,
  type ClickEvent,
  type ScreenPoint,
} from './input';

const VAR_VIRT_MOUSE_X = 20;
const VAR_VIRT_MOUSE_Y = 21;
const VAR_MOUSE_X = 44;
const VAR_MOUSE_Y = 45;

// A 320×200 screen shown at 2× CSS scale, split into a 144-tall room playfield
// (rows 0..143) and a 56-tall verb panel (rows 144..199).
const SCREEN = { viewportWidth: 320, screenWidth: 320, roomHeight: 144, screenHeight: 200 };

function makeVm(): Vm {
  return new Vm({ numVariables: 64, numBitVariables: 64, handlers: new Map() });
}

/**
 * Minimal stand-in for HTMLCanvasElement. We only use the methods the input
 * module touches: addEventListener / removeEventListener /
 * getBoundingClientRect. Vitest runs in node — there's no real DOM.
 */
class FakeCanvas {
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  rect: { left: number; top: number; width: number; height: number } = {
    left: 0,
    top: 0,
    width: 640,
    height: 400,
  };
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect(): DOMRect {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height, x: this.rect.left, y: this.rect.top, toJSON: () => ({}) };
  }
  /** Fire a synthetic event through every registered listener. */
  dispatch(type: string, ev: Record<string, unknown>): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  /** Listener count, for disposer assertions. */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function makeEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    clientX: 0,
    clientY: 0,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => {},
    ...overrides,
  };
}

describe('clientToScreenCoords', () => {
  it('translates 2× CSS scale: client (200, 100) → canvas (100, 50)', () => {
    const p = clientToScreenCoords({
      clientX: 200,
      clientY: 100,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      screenWidth: 320,
      screenHeight: 200,
    });
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it('respects a non-zero rect offset (canvas not in the top-left)', () => {
    const p = clientToScreenCoords({
      clientX: 250, // rect.left=50, so localX=200, scaleX=2 → 100
      clientY: 130, // rect.top=30, so localY=100, scaleY=2 → 50
      canvasRect: { left: 50, top: 30, width: 640, height: 400 },
      screenWidth: 320,
      screenHeight: 200,
    });
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it('derives scale from the rect — survives a CSS-scale change', () => {
    const p = clientToScreenCoords({
      clientX: 320, // 3× scale, screen=320 → canvasW=960; localX=320, scale=3 → 106
      clientY: 0,
      canvasRect: { left: 0, top: 0, width: 960, height: 600 },
      screenWidth: 320,
      screenHeight: 200,
    });
    expect(p.x).toBe(106);
  });

  it('clamps above-left to (0, 0)', () => {
    const p = clientToScreenCoords({
      clientX: -50,
      clientY: -10,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      screenWidth: 320,
      screenHeight: 200,
    });
    expect(p).toEqual({ x: 0, y: 0 });
  });

  it('clamps below-right to (screenW-1, screenH-1)', () => {
    const p = clientToScreenCoords({
      clientX: 10_000,
      clientY: 10_000,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      screenWidth: 320,
      screenHeight: 200,
    });
    expect(p).toEqual({ x: 319, y: 199 });
  });

  it('handles a degenerate 0×0 rect without dividing by zero', () => {
    expect(() =>
      clientToScreenCoords({
        clientX: 10,
        clientY: 10,
        canvasRect: { left: 0, top: 0, width: 0, height: 0 },
        screenWidth: 320,
        screenHeight: 200,
      }),
    ).not.toThrow();
  });
});

describe('mountScreenInput — pointermove', () => {
  it('writes screen coords to 44/45 and room coords to 20/21 + vm.mouseRoom*', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    mountScreenInput({ canvas: canvas as unknown as HTMLCanvasElement, vm, ...SCREEN });

    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));

    // canvas (100, 50): room band, camera 0 → room == screen here.
    expect(vm.mouseRoomX).toBe(100);
    expect(vm.mouseRoomY).toBe(50);
    expect(vm.vars.readGlobal(VAR_MOUSE_X)).toBe(100);
    expect(vm.vars.readGlobal(VAR_MOUSE_Y)).toBe(50);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_X)).toBe(100);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_Y)).toBe(50);
  });

  it('over the verb panel, 44/45 carry the screen position #23 hit-tests', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    mountScreenInput({ canvas: canvas as unknown as HTMLCanvasElement, vm, ...SCREEN });

    // clientY 320 → canvas y 160 (verb band, ≥ roomHeight 144).
    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 320 }));

    // Screen y is mapped back to the script origin (144 + (160-144) = 160), so
    // #23 sees `g45 ≥ 152` and treats it as the inventory band.
    expect(vm.vars.readGlobal(VAR_MOUSE_X)).toBe(100);
    expect(vm.vars.readGlobal(VAR_MOUSE_Y)).toBe(160);
    // Room coords clamp to the playfield (the cursor is below it).
    expect(vm.mouseRoomY).toBe(143);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_Y)).toBe(143);
  });

  it('invokes onMove with the resolved screen point', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const moves: ScreenPoint[] = [];
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onMove: (p) => moves.push(p),
    });

    canvas.dispatch('pointermove', makeEvent({ clientX: 10, clientY: 20 }));
    canvas.dispatch('pointermove', makeEvent({ clientX: 30, clientY: 40 }));

    expect(moves).toEqual([
      { x: 5, y: 10, roomX: 5, roomY: 10, inVerbBand: false },
      { x: 15, y: 20, roomX: 15, roomY: 20, inVerbBand: false },
    ]);
  });
});

describe('mountScreenInput — pointerdown', () => {
  it('button=0 → onLeftClick with screen + room coords + modifiers', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    const right: ClickEvent[] = [];
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onLeftClick: (e) => left.push(e),
      onRightClick: (e) => right.push(e),
    });

    canvas.dispatch(
      'pointerdown',
      makeEvent({ clientX: 100, clientY: 60, button: 0, shiftKey: true }),
    );

    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      x: 50,
      y: 30,
      roomX: 50,
      roomY: 30,
      inVerbBand: false,
      button: 'left',
      modifiers: { shift: true, ctrl: false, alt: false, meta: false },
    });
    expect(right).toHaveLength(0);
  });

  it('syncs the mouse-coord vars to the click point before dispatch', () => {
    // The faithful floor-walk relies on MI1's verb-input script reading
    // VAR_MOUSE / VAR_VIRT_MOUSE at click time, so pointerdown must write them
    // even when no pointermove preceded it (touch / synthetic).
    const vm = makeVm();
    const canvas = new FakeCanvas();
    let varsAtDispatch = { mx: -1, my: -1, vmx: -1, vmy: -1 };
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onLeftClick: () => {
        varsAtDispatch = {
          mx: vm.vars.readGlobal(VAR_MOUSE_X),
          my: vm.vars.readGlobal(VAR_MOUSE_Y),
          vmx: vm.vars.readGlobal(VAR_VIRT_MOUSE_X),
          vmy: vm.vars.readGlobal(VAR_VIRT_MOUSE_Y),
        };
      },
    });

    canvas.dispatch('pointerdown', makeEvent({ clientX: 100, clientY: 60, button: 0 }));

    expect(varsAtDispatch).toEqual({ mx: 50, my: 30, vmx: 50, vmy: 30 });
    expect(vm.mouseRoomX).toBe(50);
    expect(vm.mouseRoomY).toBe(30);
  });

  it('flags a click in the verb band', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onLeftClick: (e) => left.push(e),
    });

    canvas.dispatch('pointerdown', makeEvent({ clientX: 100, clientY: 320, button: 0 }));

    expect(left[0]).toMatchObject({ x: 50, y: 160, inVerbBand: true });
  });

  it('button=2 → onRightClick (v5 look-at shortcut)', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    const right: ClickEvent[] = [];
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onLeftClick: (e) => left.push(e),
      onRightClick: (e) => right.push(e),
    });

    canvas.dispatch(
      'pointerdown',
      makeEvent({ clientX: 100, clientY: 60, button: 2, ctrlKey: true }),
    );

    expect(right).toHaveLength(1);
    expect(right[0]).toMatchObject({
      button: 'right',
      modifiers: { shift: false, ctrl: true, alt: false, meta: false },
    });
    expect(left).toHaveLength(0);
  });

  it('button=1 (middle) is ignored', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    const right: ClickEvent[] = [];
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
      onLeftClick: (e) => left.push(e),
      onRightClick: (e) => right.push(e),
    });

    canvas.dispatch('pointerdown', makeEvent({ clientX: 100, clientY: 60, button: 1 }));

    expect(left).toHaveLength(0);
    expect(right).toHaveLength(0);
  });
});

describe('mountScreenInput — contextmenu', () => {
  it('preventDefaults the browser menu so right-click is usable', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    mountScreenInput({ canvas: canvas as unknown as HTMLCanvasElement, vm, ...SCREEN });

    let prevented = false;
    canvas.dispatch('contextmenu', makeEvent({ preventDefault: () => (prevented = true) }));

    expect(prevented).toBe(true);
  });
});

describe('mountScreenInput — dispose', () => {
  it('removes every listener so a replaced canvas leaks none', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const mounted = mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      ...SCREEN,
    });

    expect(canvas.listenerCount('pointermove')).toBe(1);
    expect(canvas.listenerCount('pointerdown')).toBe(1);
    expect(canvas.listenerCount('contextmenu')).toBe(1);

    mounted.dispose();

    expect(canvas.listenerCount('pointermove')).toBe(0);
    expect(canvas.listenerCount('pointerdown')).toBe(0);
    expect(canvas.listenerCount('contextmenu')).toBe(0);
  });
});

describe('mountScreenInput — camera viewport wiring', () => {
  it('maps clicks through the live camera offset (320 viewport into a wider room)', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    // 320-wide viewport displayed at 2× → 640 CSS px.
    canvas.rect = { left: 0, top: 0, width: 640, height: 400 };
    mountScreenInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      viewportWidth: 320,
      screenWidth: 320,
      roomWidth: 500, // real room width (no room loaded → fallback for clamp)
      roomHeight: 144,
      screenHeight: 200,
    });

    // Camera centred at 160 → cameraLeft = clamp(160-160, 0, 500-320) = 0.
    vm.camera.x = 160;
    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));
    expect(vm.mouseRoomX).toBe(100); // localX = 200 / 2

    // Scroll right: centre 400 → cameraLeft = clamp(400-160, 0, 180) = 180.
    vm.camera.x = 400;
    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));
    expect(vm.mouseRoomX).toBe(280); // 100 + 180
  });
});
