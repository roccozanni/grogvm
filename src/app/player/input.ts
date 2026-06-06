/**
 * Shell-side input adapter for the unified play screen.
 *
 * The room slice and the verb/inventory panel share ONE canvas — rows
 * `0..roomHeight-1` are the room camera window, rows `roomHeight..` are the
 * verb panel (a 320-wide screen strip). This module owns that canvas's pointer
 * + keyboard listeners, translates browser events into a {@link ScreenPoint},
 * mirrors the cursor into the VM's mouse state + the coord VARs MI1's scripts
 * poll, and dispatches click / Escape / skip-line events to the caller.
 *
 * # Coordinate semantics
 *
 * One client→canvas transform unscales the CSS zoom against the canvas's real
 * on-screen rect (so a CSS change can't silently break input). From the
 * canvas-native point we derive two coordinate spaces, matching SCUMM:
 *
 * - **screen** (`VAR_MOUSE_X/Y`, 44/45) — the 320×200 single-screen model the
 *   scripts think in. `x` is the canvas column; `y` is the row, with the verb
 *   panel mapped back to its script origin (144+). This is what the hover
 *   poller #23 hit-tests: `g45 ≥ 152, g44 ≥ 160` ⇒ over the inventory.
 * - **room** (`VAR_VIRT_MOUSE_X/Y`, 20/21, and `vm.mouseRoom*`) — world space:
 *   `screenX + cameraLeft`, clamped to the real room. The verb-input script #4
 *   reads these to walk ego to a floor click.
 *
 * Because 44/45 now carry the *true* screen position on every move — including
 * the verb band — #23 sees the inventory exactly as it did on the original's
 * single 320×200 screen, with no shell-side coordinate bridging.
 */

import type { Vm } from '../../engine/vm/vm';
import { viewportLeft } from '../../engine/graphics/viewport';

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
   * The canvas's bounding rect in client space — typically
   * `canvas.getBoundingClientRect()`. We derive the CSS scale from
   * width / height instead of trusting a constant, so a CSS tweak doesn't
   * silently break input.
   */
  readonly canvasRect: { left: number; top: number; width: number; height: number };
  /** Canvas native width (the full screen surface, ≥ the room slice width). */
  readonly screenWidth: number;
  /** Canvas native height (room playfield + verb panel). */
  readonly screenHeight: number;
}

/**
 * Translate a browser-space `(clientX, clientY)` to canvas-native pixels,
 * clamped to the surface. Pure helper — keep it that way so the test suite can
 * cover it without a DOM.
 */
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

// Engine variable indices we write from the input layer (SCUMM v5 wiki):
// 44/45 are the screen-space cursor coords scripts poll most often; 20/21 are
// the virtual (room-space) versions. They diverge once the camera scrolls.
const VAR_VIRT_MOUSE_X = 20;
const VAR_VIRT_MOUSE_Y = 21;
const VAR_MOUSE_X = 44;
const VAR_MOUSE_Y = 45;

/**
 * Script-screen y of the verb panel top. The verb panel is drawn directly
 * below the room playfield (at canvas row `roomHeight`); MI1 places its verbs
 * in screen-space starting here, and #23's inventory band is `y ≥ 152`. With
 * the usual 144-tall playfield the canvas row already equals the script row;
 * this keeps the screen y correct even when the room height differs.
 */
const VERB_BAR_START_Y = 144;

export interface MountScreenInputArgs {
  readonly canvas: HTMLCanvasElement;
  readonly vm: Vm;
  /** Native room-slice width (the camera viewport). */
  readonly viewportWidth: number;
  /**
   * Fallback room width used only before a room loads (for the click clamp).
   * The real room width is read live from the VM. Defaults to `viewportWidth`.
   */
  readonly roomWidth?: number;
  /** Full screen canvas native width (≥ viewportWidth). */
  readonly screenWidth: number;
  /** Room playfield height; rows ≥ this are the verb panel band. */
  readonly roomHeight: number;
  /** Full screen canvas native height (roomHeight + verb panel height). */
  readonly screenHeight: number;
  /** Notified every pointermove with the resolved screen point. */
  readonly onMove?: (p: ScreenPoint) => void;
  /** Left-click handler. Bound semantics ("use the current verb") live with the caller. */
  readonly onLeftClick?: (e: ClickEvent) => void;
  /** Right-click handler. The v5 convention treats this as the "Look at" shortcut. */
  readonly onRightClick?: (e: ClickEvent) => void;
  /**
   * Escape was pressed — the v5 `abortCutscene` shortcut. Bound on the window
   * (the canvas isn't focusable) so it fires regardless of focus.
   */
  readonly onEscape?: () => void;
  /** The skip-line key (`.`) was pressed — advance past the current speech line. */
  readonly onSkipLine?: () => void;
}

export interface MountedInput {
  readonly dispose: () => void;
}

/**
 * Attach pointer + keyboard listeners to the unified play canvas. Returns a
 * disposer the caller MUST run when the canvas is replaced or unmounted.
 *
 * Pointer events (not mouse events) so drag-from-canvas behaves sensibly under
 * modern pointer-capture semantics.
 */
export function mountScreenInput(args: MountScreenInputArgs): MountedInput {
  const { canvas, vm } = args;

  const point = (ev: { clientX: number; clientY: number }): ScreenPoint => {
    // Read room width + camera live: rooms (and the camera) change without an
    // input re-mount, and the same clamped `cameraLeft` the frame slice uses
    // keeps clicks aligned with the on-screen pixels.
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

  // Push the resolved point into the VM's mouse state + the coord VARs scripts
  // poll: screen-space into 44/45, room-space into 20/21 (and vm.mouseRoom*).
  const writeMouse = (p: ScreenPoint): void => {
    const screenY = p.inVerbBand ? VERB_BAR_START_Y + (p.y - args.roomHeight) : p.y;
    vm.mouseRoomX = p.roomX;
    vm.mouseRoomY = p.roomY;
    vm.vars.writeGlobal(VAR_MOUSE_X, p.x);
    vm.vars.writeGlobal(VAR_MOUSE_Y, screenY);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_X, p.roomX);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_Y, p.roomY);
  };

  const onMove = (ev: PointerEvent): void => {
    const p = point(ev);
    writeMouse(p);
    args.onMove?.(p);
  };

  const onDown = (ev: PointerEvent): void => {
    // Browser button values: 0=left, 1=middle, 2=right. Middle is ignored.
    const button = ev.button === 2 ? 'right' : ev.button === 0 ? 'left' : null;
    if (!button) return;
    if (button === 'left') vm.input.leftHold = true;
    else vm.input.rightHold = true;
    const p = point(ev);
    // The click point is authoritative — sync the mouse vars to it before
    // dispatching so the input script reads the exact click even if no
    // pointermove preceded it (touch / synthetic input).
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
    // Pointer left the canvas — clear holds so a press that started here
    // doesn't persist when the user releases off-canvas.
    vm.input.leftHold = false;
    vm.input.rightHold = false;
  };

  const onContextMenu = (ev: MouseEvent): void => {
    // Right-click is meaningful (the v5 "Look at" shortcut) — suppress the
    // browser menu so it's usable.
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
