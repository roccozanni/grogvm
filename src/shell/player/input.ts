/**
 * Shell-side input adapter for the VM frame canvas.
 *
 * Translates browser pointer events into **native room coordinates**
 * (pre-CSS-scale, post-camera-offset), updates the VM's mouse state,
 * mirrors it into VAR_MOUSE_X/Y + VAR_VIRT_MOUSE_X/Y, and dispatches
 * left / right click events to caller-provided handlers.
 *
 * # Why a separate module
 *
 * Phase 6 has the inspector painting the canvas every frame and
 * teardown / re-render is destructive. The mount returns a disposer
 * so the inspector can cleanly release listeners when the canvas
 * element is replaced (which happens on every repaint right now —
 * the inspector uses `replaceChildren`).
 *
 * # Coordinate semantics
 *
 * The canvas's bounding rect gives us the actual on-screen size; we
 * derive the scale factor from that rather than hard-coding the 2×
 * convention, so the helper survives a CSS change. CameraX (the
 * left-edge of the viewport in world coords) is added after unscale
 * so the room x is correct once horizontal scrolling exists. The
 * camera is fixed at 0 today.
 *
 * # VARs written each pointermove
 *
 * - 44 / 45 — `VAR_MOUSE_X` / `VAR_MOUSE_Y` (screen-space; equals
 *   room coords today because there's no camera scroll).
 * - 20 / 21 — `VAR_VIRT_MOUSE_X` / `VAR_VIRT_MOUSE_Y` (always room
 *   coords).
 */

import type { Vm } from '../../engine/vm/vm';

export interface ModifierKeys {
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export interface RoomPoint {
  /** Native room x (post-CSS-unscale, post-camera-add), integer, clamped to [0, roomWidth-1]. */
  readonly roomX: number;
  /** Native room y, integer, clamped to [0, roomHeight-1]. */
  readonly roomY: number;
}

export interface ClickEvent extends RoomPoint {
  readonly button: 'left' | 'right';
  readonly modifiers: ModifierKeys;
}

export interface ClientToRoomArgs {
  readonly clientX: number;
  readonly clientY: number;
  /**
   * The canvas's bounding rect in client space — typically obtained
   * from `canvas.getBoundingClientRect()`. We use width / height to
   * derive the CSS scale instead of trusting a constant, so a CSS
   * tweak doesn't silently break input.
   */
  readonly canvasRect: { left: number; top: number; width: number; height: number };
  readonly roomWidth: number;
  readonly roomHeight: number;
  /** Left edge of the viewport in world coords. Defaults to 0. */
  readonly cameraX?: number;
}

/**
 * Translate a browser-space `(clientX, clientY)` to native room
 * coordinates. Pure helper — keep it that way so the test suite can
 * cover it without a DOM.
 */
export function clientToRoomCoords(args: ClientToRoomArgs): RoomPoint {
  const { clientX, clientY, canvasRect, roomWidth, roomHeight, cameraX = 0 } = args;
  // Avoid divide-by-zero if a 0×0 rect ever sneaks in (the canvas
  // briefly has no layout during teardown).
  const scaleX = canvasRect.width > 0 ? canvasRect.width / roomWidth : 1;
  const scaleY = canvasRect.height > 0 ? canvasRect.height / roomHeight : 1;
  const localX = (clientX - canvasRect.left) / scaleX;
  const localY = (clientY - canvasRect.top) / scaleY;
  const worldX = Math.floor(localX) + cameraX;
  const worldY = Math.floor(localY);
  return {
    roomX: Math.max(0, Math.min(roomWidth - 1, worldX)),
    roomY: Math.max(0, Math.min(roomHeight - 1, worldY)),
  };
}

// Engine variable indices we write from the input layer. Per the
// SCUMM v5 wiki: 44/45 are the screen-space cursor coords scripts
// poll most often; 20/21 are the virtual (room-space) versions.
// Today they're equal — they diverge once horizontal scrolling
// lands.
const VAR_VIRT_MOUSE_X = 20;
const VAR_VIRT_MOUSE_Y = 21;
const VAR_MOUSE_X = 44;
const VAR_MOUSE_Y = 45;

export interface MountInputArgs {
  readonly canvas: HTMLCanvasElement;
  readonly vm: Vm;
  readonly roomWidth: number;
  readonly roomHeight: number;
  /** Defaults to a constant 0. Wire this up when the camera lands. */
  readonly getCameraX?: () => number;
  /** Left-click handler. Bound semantics ("use the current verb") live with the caller. */
  readonly onLeftClick?: (e: ClickEvent) => void;
  /** Right-click handler. The v5 convention treats this as the "Look at" shortcut. */
  readonly onRightClick?: (e: ClickEvent) => void;
  /** Notified every pointermove with the resolved room coords. Inspector hook. */
  readonly onMove?: (p: RoomPoint) => void;
}

export interface MountedInput {
  readonly dispose: () => void;
}

/**
 * Attach pointer listeners to the VM frame canvas. Returns a disposer
 * the caller MUST run when the canvas is replaced or unmounted (the
 * inspector rebuilds DOM on every repaint).
 *
 * Pointer events (not mouse events) so drag-from-canvas behaves
 * sensibly under modern pointer capture semantics.
 */
export function mountVmFrameInput(args: MountInputArgs): MountedInput {
  const { canvas, vm } = args;

  const point = (ev: { clientX: number; clientY: number }): RoomPoint =>
    clientToRoomCoords({
      clientX: ev.clientX,
      clientY: ev.clientY,
      canvasRect: canvas.getBoundingClientRect(),
      roomWidth: args.roomWidth,
      roomHeight: args.roomHeight,
      cameraX: args.getCameraX?.() ?? 0,
    });

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

  const onMove = (ev: PointerEvent): void => {
    const p = point(ev);
    vm.mouseRoomX = p.roomX;
    vm.mouseRoomY = p.roomY;
    vm.vars.writeGlobal(VAR_MOUSE_X, p.roomX);
    vm.vars.writeGlobal(VAR_MOUSE_Y, p.roomY);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_X, p.roomX);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_Y, p.roomY);
    args.onMove?.(p);
  };

  const onDown = (ev: PointerEvent): void => {
    // Browser button values: 0=left, 1=middle, 2=right. We ignore
    // middle for now (panning could land here later).
    const button = ev.button === 2 ? 'right' : ev.button === 0 ? 'left' : null;
    if (!button) return;
    // Flip the sticky hold flag (diagnostic). The discrete click is
    // delivered via the onLeftClick / onRightClick callbacks below,
    // which route into the engine's click handling.
    if (button === 'left') vm.input.leftHold = true;
    else vm.input.rightHold = true;
    const p = point(ev);
    const evt: ClickEvent = { ...p, button, modifiers: modsOf(ev) };
    if (button === 'left') args.onLeftClick?.(evt);
    else args.onRightClick?.(evt);
  };

  const onUp = (ev: PointerEvent): void => {
    if (ev.button === 2) vm.input.rightHold = false;
    else if (ev.button === 0) vm.input.leftHold = false;
  };

  const onLeave = (): void => {
    // Pointer left the canvas — clear holds so a press that started
    // here doesn't persist when the user releases off-canvas.
    vm.input.leftHold = false;
    vm.input.rightHold = false;
  };

  const onContextMenu = (ev: MouseEvent): void => {
    // Right-click is meaningful in the room — suppress the browser
    // menu so the v5 "Look at" shortcut is usable.
    ev.preventDefault();
  };

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    dispose(): void {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
