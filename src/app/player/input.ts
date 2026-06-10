/**
 * Shell-side input adapter: canvas pointer/keyboard events → VM mouse state,
 * coord VARs, and click/Escape/skip callbacks. Script-side semantics:
 * pages/docs/scumm/input.md.
 */

import type { Vm } from '../../engine/vm/vm';
import { viewportLeft } from '../../engine/graphics/viewport';
import { VERB_BAR_START_Y } from '../../engine/render/screen';

export interface ModifierKeys {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export interface ScreenPoint {
  /** Canvas-native column (post-CSS-unscale), clamped to [0, screenWidth-1]. */
  readonly x: number;
  /** Canvas-native row, clamped to [0, screenHeight-1]. */
  readonly y: number;
  /**
   * Script-screen row (the VAR 45 space the engine's verb hit-test uses):
   * verb-band rows remap to `VERB_BAR_START_Y +`, room rows pass through.
   */
  readonly screenY: number;
  /** Room x = `x + cameraLeft`, clamped to [0, roomWidth-1]. */
  readonly roomX: number;
  /** Room y, clamped to [0, roomHeight-1]. */
  readonly roomY: number;
  /** True when the point is in the verb panel band (`y ≥ roomHeight`). */
  readonly inVerbBand: boolean;
}

export interface ClickEvent extends ScreenPoint {
  readonly button: 'left' | 'right';
  readonly modifiers: ModifierKeys;
}

export interface ClientToScreenArgs {
  readonly clientX: number;
  readonly clientY: number;
  /**
   * Typically `canvas.getBoundingClientRect()`. The CSS scale is derived from
   * this rect, not a constant, so a CSS tweak can't silently break input.
   */
  readonly canvasRect: { left: number; top: number; width: number; height: number };
  /** Canvas native width (the full screen surface, ≥ the room slice width). */
  readonly screenWidth: number;
  /** Canvas native height (room playfield + verb panel). */
  readonly screenHeight: number;
}

/** Browser client coords → canvas-native pixels, clamped to the surface. */
export function clientToScreenCoords(args: ClientToScreenArgs): { x: number; y: number } {
  const { clientX, clientY, canvasRect, screenWidth, screenHeight } = args;
  // Guard against a 0×0 rect (the canvas briefly has no layout during teardown).
  const scaleX = canvasRect.width > 0 ? canvasRect.width / screenWidth : 1;
  const scaleY = canvasRect.height > 0 ? canvasRect.height / screenHeight : 1;
  const x = Math.floor((clientX - canvasRect.left) / scaleX);
  const y = Math.floor((clientY - canvasRect.top) / scaleY);
  return {
    x: Math.max(0, Math.min(screenWidth - 1, x)),
    y: Math.max(0, Math.min(screenHeight - 1, y)),
  };
}

// 44/45 are the screen-space cursor coords; 20/21 the virtual (room-space)
// versions. They diverge once the camera scrolls.
const VAR_VIRT_MOUSE_X = 20;
const VAR_VIRT_MOUSE_Y = 21;
const VAR_MOUSE_X = 44;
const VAR_MOUSE_Y = 45;

export interface MountScreenInputArgs {
  readonly canvas: HTMLCanvasElement;
  readonly vm: Vm;
  /** Native room-slice width (the camera viewport). */
  readonly viewportWidth: number;
  /** Click-clamp fallback before a room loads; the live width comes from the VM. */
  readonly roomWidth?: number;
  /** Full screen canvas native width (≥ viewportWidth). */
  readonly screenWidth: number;
  /** Room playfield height; rows ≥ this are the verb panel band. */
  readonly roomHeight: number;
  /** Full screen canvas native height (roomHeight + verb panel height). */
  readonly screenHeight: number;
  readonly onMove?: (p: ScreenPoint) => void;
  readonly onLeftClick?: (e: ClickEvent) => void;
  readonly onRightClick?: (e: ClickEvent) => void;
  /** Bound on the window — the canvas isn't focusable. */
  readonly onEscape?: () => void;
  /** The skip-line key (`.`) was pressed. */
  readonly onSkipLine?: () => void;
}

export interface MountedInput {
  readonly dispose: () => void;
}

/**
 * Attach pointer + keyboard listeners to the play canvas. The returned disposer
 * MUST run when the canvas is replaced or unmounted.
 */
export function mountScreenInput(args: MountScreenInputArgs): MountedInput {
  const { canvas, vm } = args;

  const point = (ev: { clientX: number; clientY: number }): ScreenPoint => {
    // Room width + camera are read live (rooms change without a re-mount); the
    // same clamped cameraLeft the frame slice uses keeps clicks pixel-aligned.
    const roomWidth = vm.loadedRoom?.width ?? args.roomWidth ?? args.viewportWidth;
    const cameraLeft = viewportLeft(vm.camera.x, roomWidth, args.viewportWidth);
    const { x, y } = clientToScreenCoords({
      clientX: ev.clientX,
      clientY: ev.clientY,
      canvasRect: canvas.getBoundingClientRect(),
      screenWidth: args.screenWidth,
      screenHeight: args.screenHeight,
    });
    return {
      x,
      y,
      // With the usual 144-tall playfield the canvas row already equals the
      // script row; the remap keeps it correct when the room height differs.
      screenY: y >= args.roomHeight ? VERB_BAR_START_Y + (y - args.roomHeight) : y,
      roomX: Math.max(0, Math.min(roomWidth - 1, x + cameraLeft)),
      roomY: Math.max(0, Math.min(args.roomHeight - 1, y)),
      inVerbBand: y >= args.roomHeight,
    };
  };

  const modsOf = (ev: {
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }): ModifierKeys => ({
    shift: ev.shiftKey,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    meta: ev.metaKey,
  });

  const writeMouse = (p: ScreenPoint): void => {
    vm.mouseRoomX = p.roomX;
    vm.mouseRoomY = p.roomY;
    vm.vars.writeGlobal(VAR_MOUSE_X, p.x);
    vm.vars.writeGlobal(VAR_MOUSE_Y, p.screenY);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_X, p.roomX);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_Y, p.roomY);
  };

  const onMove = (ev: PointerEvent): void => {
    const p = point(ev);
    writeMouse(p);
    args.onMove?.(p);
  };

  const onDown = (ev: PointerEvent): void => {
    const button = ev.button === 2 ? 'right' : ev.button === 0 ? 'left' : null;
    if (!button) return;
    if (button === 'left') vm.input.leftHold = true;
    else vm.input.rightHold = true;
    const p = point(ev);
    // Sync mouse vars before dispatch so the input script reads the exact
    // click even when no pointermove preceded it (touch / synthetic input).
    writeMouse(p);
    const evt: ClickEvent = { ...p, button, modifiers: modsOf(ev) };
    if (button === 'left') args.onLeftClick?.(evt);
    else args.onRightClick?.(evt);
  };

  const onUp = (ev: PointerEvent): void => {
    if (ev.button === 2) vm.input.rightHold = false;
    else if (ev.button === 0) vm.input.leftHold = false;
  };

  const onLeave = (): void => {
    // A press that started here mustn't persist when released off-canvas.
    vm.input.leftHold = false;
    vm.input.rightHold = false;
  };

  const onContextMenu = (ev: MouseEvent): void => {
    // Right-click is the v5 "Look at" shortcut — suppress the browser menu.
    ev.preventDefault();
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && args.onEscape) {
      args.onEscape();
    } else if (ev.key === '.' && args.onSkipLine) {
      args.onSkipLine();
    }
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', onContextMenu);
  const keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null =
    typeof window !== 'undefined' ? window : null;
  keyTarget?.addEventListener('keydown', onKeyDown as EventListener);

  return {
    dispose(): void {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
      keyTarget?.removeEventListener('keydown', onKeyDown as EventListener);
    },
  };
}
