import { describe, expect, it } from 'vitest';
import { Vm } from '../../engine/vm/vm';
import {
  clientToRoomCoords,
  mountVmFrameInput,
  type ClickEvent,
  type RoomPoint,
} from './input';

const VAR_VIRT_MOUSE_X = 20;
const VAR_VIRT_MOUSE_Y = 21;
const VAR_MOUSE_X = 44;
const VAR_MOUSE_Y = 45;

function makeVm(): Vm {
  return new Vm({ numVariables: 64, numBitVariables: 64, handlers: new Map() });
}

/**
 * Minimal stand-in for HTMLCanvasElement. We only use the methods the
 * input module touches: addEventListener / removeEventListener /
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

describe('clientToRoomCoords', () => {
  it('translates 2× CSS scale: client (200, 100) → room (100, 50) when rect starts at (0, 0)', () => {
    const p = clientToRoomCoords({
      clientX: 200,
      clientY: 100,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      roomWidth: 320,
      roomHeight: 200,
    });
    expect(p).toEqual({ roomX: 100, roomY: 50 });
  });

  it('respects a non-zero rect offset (canvas not in the top-left)', () => {
    const p = clientToRoomCoords({
      clientX: 250, // rect.left=50, so localX=200, scaleX=2 → 100
      clientY: 130, // rect.top=30, so localY=100, scaleY=2 → 50
      canvasRect: { left: 50, top: 30, width: 640, height: 400 },
      roomWidth: 320,
      roomHeight: 200,
    });
    expect(p).toEqual({ roomX: 100, roomY: 50 });
  });

  it('derives scale from the rect — survives a CSS-scale change', () => {
    const p = clientToRoomCoords({
      clientX: 320, // 3× scale, room=320 → canvasW=960; localX=320, scale=3 → 106.66 → 106
      clientY: 0,
      canvasRect: { left: 0, top: 0, width: 960, height: 600 },
      roomWidth: 320,
      roomHeight: 200,
    });
    expect(p.roomX).toBe(106);
  });

  it('adds cameraX so room coords reflect horizontal scroll', () => {
    const p = clientToRoomCoords({
      clientX: 200,
      clientY: 0,
      // 2× scale on a 500-wide world so localX = clientX / 2.
      canvasRect: { left: 0, top: 0, width: 1000, height: 400 },
      roomWidth: 500,
      roomHeight: 200,
      cameraX: 40,
    });
    // localX = 100, +cameraX 40 = 140
    expect(p.roomX).toBe(140);
  });

  it('clamps clicks above-left to (0, 0)', () => {
    const p = clientToRoomCoords({
      clientX: -50,
      clientY: -10,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      roomWidth: 320,
      roomHeight: 200,
    });
    expect(p).toEqual({ roomX: 0, roomY: 0 });
  });

  it('clamps clicks below-right to (roomW-1, roomH-1)', () => {
    const p = clientToRoomCoords({
      clientX: 10_000,
      clientY: 10_000,
      canvasRect: { left: 0, top: 0, width: 640, height: 400 },
      roomWidth: 320,
      roomHeight: 200,
    });
    expect(p).toEqual({ roomX: 319, roomY: 199 });
  });

  it('handles a degenerate 0×0 rect without dividing by zero', () => {
    expect(() =>
      clientToRoomCoords({
        clientX: 10,
        clientY: 10,
        canvasRect: { left: 0, top: 0, width: 0, height: 0 },
        roomWidth: 320,
        roomHeight: 200,
      }),
    ).not.toThrow();
  });
});

describe('mountVmFrameInput — pointermove', () => {
  it('writes vm.mouseRoomX/Y + VAR_MOUSE_X/Y + VAR_VIRT_MOUSE_X/Y', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
    });

    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));

    expect(vm.mouseRoomX).toBe(100);
    expect(vm.mouseRoomY).toBe(50);
    expect(vm.vars.readGlobal(VAR_MOUSE_X)).toBe(100);
    expect(vm.vars.readGlobal(VAR_MOUSE_Y)).toBe(50);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_X)).toBe(100);
    expect(vm.vars.readGlobal(VAR_VIRT_MOUSE_Y)).toBe(50);
  });

  it('invokes onMove for each pointermove', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const moves: RoomPoint[] = [];
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
      onMove: (p) => moves.push(p),
    });

    canvas.dispatch('pointermove', makeEvent({ clientX: 10, clientY: 20 }));
    canvas.dispatch('pointermove', makeEvent({ clientX: 30, clientY: 40 }));

    expect(moves).toEqual([
      { roomX: 5, roomY: 10 },
      { roomX: 15, roomY: 20 },
    ]);
  });
});

describe('mountVmFrameInput — pointerdown', () => {
  it('button=0 → onLeftClick with room coords + modifiers', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    const right: ClickEvent[] = [];
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
      onLeftClick: (e) => left.push(e),
      onRightClick: (e) => right.push(e),
    });

    canvas.dispatch(
      'pointerdown',
      makeEvent({ clientX: 100, clientY: 60, button: 0, shiftKey: true }),
    );

    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({
      roomX: 50,
      roomY: 30,
      button: 'left',
      modifiers: { shift: true, ctrl: false, alt: false, meta: false },
    });
    expect(right).toHaveLength(0);
  });

  it('button=2 → onRightClick (v5 look-at shortcut)', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const left: ClickEvent[] = [];
    const right: ClickEvent[] = [];
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
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
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
      onLeftClick: (e) => left.push(e),
      onRightClick: (e) => right.push(e),
    });

    canvas.dispatch('pointerdown', makeEvent({ clientX: 100, clientY: 60, button: 1 }));

    expect(left).toHaveLength(0);
    expect(right).toHaveLength(0);
  });
});

describe('mountVmFrameInput — contextmenu', () => {
  it('preventDefaults the browser menu so right-click is usable', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
    });

    let prevented = false;
    canvas.dispatch('contextmenu', makeEvent({ preventDefault: () => (prevented = true) }));

    expect(prevented).toBe(true);
  });
});

describe('mountVmFrameInput — dispose', () => {
  it('removes every listener so a replaced canvas leaks none', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    const mounted = mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 320,
      roomHeight: 200,
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

describe('mountVmFrameInput — cameraX wiring', () => {
  it('uses the live cameraX from the getter (per-event lookup)', () => {
    const vm = makeVm();
    const canvas = new FakeCanvas();
    // 2× scale on a 500-wide world, so localX = clientX / 2.
    canvas.rect = { left: 0, top: 0, width: 1000, height: 400 };
    let cameraX = 0;
    mountVmFrameInput({
      canvas: canvas as unknown as HTMLCanvasElement,
      vm,
      roomWidth: 500,
      roomHeight: 200,
      getCameraX: () => cameraX,
    });

    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));
    expect(vm.mouseRoomX).toBe(100);

    cameraX = 40;
    canvas.dispatch('pointermove', makeEvent({ clientX: 200, clientY: 100 }));
    expect(vm.mouseRoomX).toBe(140);
  });
});
