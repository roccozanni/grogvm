/**
 * Render the VM's loaded room to an indexed framebuffer / a PNG. The closures
 * below are the canonical `ComposeFrameInput` mappings — keep them in sync if
 * the compositor's contract changes.
 */
import { composeFrame } from '../engine/render/compositor';
import type { Vm } from '../engine/vm/vm';
import { writeIndexedPng, type IndexedImage } from './png';

const NEVER_CLIP_CLASS_BIT = 1 << 19; // SCUMM class 20 — actor draws in front of every z-plane.

export interface Screenshot {
  readonly width: number;
  readonly height: number;
  /** `width × height` palette indices — the composited frame. */
  readonly pixels: Uint8Array;
  /** The loaded room's palette (RGB triples). */
  readonly palette: Uint8Array;
}

export function screenshot(vm: Vm): Screenshot {
  const room = vm.loadedRoom;
  if (!room) throw new Error('screenshot: no room loaded (call enterRoom / restoreSave first)');

  const framebuffer = new Uint8Array(room.width * room.height);
  composeFrame({
    room,
    framebuffer,
    actors: vm.actors.inRoom(vm.currentRoom),
    getCostume: (id) => vm.getCostume(id),
    objectDrawQueue: vm.objectDrawQueue,
    getObjectState: (id) => vm.objectStates.get(id) ?? 1,
    getObjectPosition: (id) => vm.objectDrawPositions.get(id),
    isNeverClip: (id) => ((vm.objectClasses.get(id) ?? 0) & NEVER_CLIP_CLASS_BIT) !== 0,
  });

  return { width: room.width, height: room.height, pixels: framebuffer, palette: room.palette };
}

export function writeScreenshot(vm: Vm, path: string, opts: { scale?: number } = {}): void {
  const shot = screenshot(vm);
  const image: IndexedImage = { ...shot, scale: opts.scale ?? 3 };
  writeIndexedPng(path, image);
}
