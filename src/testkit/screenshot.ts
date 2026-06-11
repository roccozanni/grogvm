/**
 * Render the VM's full visible screen — room band, verb/inventory panel,
 * dialog and system text — to an indexed framebuffer / a PNG, through the
 * same pipeline the session presents (composeFrame → camera slice →
 * composeScreen). The closures below are the canonical input mappings —
 * keep them in sync with createSession's composeAndPresent if either
 * contract changes.
 */
import { VIEWPORT_W, viewportLeft } from '../engine/graphics/viewport';
import { composeFrame } from '../engine/render/compositor';
import { composeScreen, SCREEN_HEIGHT } from '../engine/render/screen';
import { VAR_MOUSE_X, VAR_MOUSE_Y } from '../engine/vm/vars';
import type { Vm } from '../engine/vm/vm';
import { writeIndexedPng, type IndexedImage } from './png';

const NEVER_CLIP_CLASS_BIT = 1 << 19; // SCUMM class 20 — actor draws in front of every z-plane.

// g107 = the verb armed by MI1's input script (#4); 11 (Walk-to) is the
// resting default, treated as "nothing armed". Mirrors createSession.
const G_ACTIVE_VERB = 107;
const VERB_WALK_TO = 11;

export interface Screenshot {
  readonly width: number;
  readonly height: number;
  /** `width × height` palette indices — the composed full screen. */
  readonly pixels: Uint8Array;
  /** The loaded room's palette (RGB triples). */
  readonly palette: Uint8Array;
}

export function screenshot(vm: Vm): Screenshot {
  const room = vm.loadedRoom;
  if (!room) throw new Error('screenshot: no room loaded (call enterRoom / restoreSave first)');

  const roomBuf = new Uint8Array(room.width * room.height);
  composeFrame({
    room,
    framebuffer: roomBuf,
    actors: vm.actors.inRoom(vm.currentRoom),
    getCostume: (id) => vm.getCostume(id),
    objectDrawQueue: vm.objectDrawQueue,
    getObjectState: (id) => vm.objectStates.get(id) ?? 1,
    getObjectPosition: (id) => vm.objectDrawPositions.get(id),
    isNeverClip: (id) => ((vm.objectClasses.get(id) ?? 0) & NEVER_CLIP_CLASS_BIT) !== 0,
    drawnBoxes: vm.drawnBoxes,
    screenWidth: room.width,
    screenHeight: room.height,
  });

  // Camera slice into the viewport band. No shake jitter: a still frame
  // captures the unshaken screen.
  const viewportW = Math.min(VIEWPORT_W, room.width);
  const cameraLeft = viewportLeft(vm.camera.x, room.width, viewportW);
  const band = new Uint8Array(viewportW * room.height);
  for (let y = 0; y < room.height; y++) {
    const src = y * room.width + cameraLeft;
    band.set(roomBuf.subarray(src, src + viewportW), y * viewportW);
  }

  const screenW = Math.max(viewportW, VIEWPORT_W);
  const screenH = Math.max(room.height, SCREEN_HEIGHT);
  const framebuffer = new Uint8Array(screenW * screenH);
  const armed = vm.vars.readGlobal(G_ACTIVE_VERB);
  composeScreen({
    roomBand: band,
    viewportWidth: viewportW,
    roomHeight: room.height,
    framebuffer,
    screenWidth: screenW,
    screenHeight: screenH,
    cameraLeft,
    verbs: [...vm.verbs.values()],
    isVerbArchived: (id) => vm.savedVerbStates.has(id),
    currentCharsetId: vm.currentCharset,
    getCharset: (id) => vm.getCharset(id),
    getRoom: (id) => vm.getRoom(id),
    activeDialog: vm.activeDialog,
    systemTexts: vm.systemTexts,
    getActor: (id) => (id >= 1 && id <= vm.actors.capacity ? vm.actors.get(id) : null),
    screenTop: vm.screen.top,
    charsetColorMap: vm.charsetColorMap,
    armedVerbId: armed > 0 && armed !== VERB_WALK_TO ? armed : null,
    mouse: { x: vm.vars.readGlobal(VAR_MOUSE_X), y: vm.vars.readGlobal(VAR_MOUSE_Y) },
    getObjectState: (id) => vm.objectStates.get(id),
  });

  return { width: screenW, height: screenH, pixels: framebuffer, palette: room.palette };
}

export function writeScreenshot(vm: Vm, path: string, opts: { scale?: number } = {}): void {
  const shot = screenshot(vm);
  const image: IndexedImage = { ...shot, scale: opts.scale ?? 3 };
  writeIndexedPng(path, image);
}
