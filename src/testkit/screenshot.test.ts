/**
 * Tests the screenshot helper against a synthetic VM with a hand-built room —
 * no game data, runs everywhere. Verifies it composes the FULL screen (room
 * band top-left, verb band below filled with the panel background) and that
 * writeScreenshot lands a decodable, correctly-scaled PNG on disk.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedRoom } from '../engine/room/loader';
import { Vm } from '../engine/vm/vm';
import { screenshot, writeScreenshot } from './screenshot';

function makeRoom(width: number, height: number, fill: number): LoadedRoom {
  const indexed = new Uint8Array(width * height);
  indexed.fill(fill);
  const palette = new Uint8Array(768);
  palette.set([0, 0, 0, 11, 22, 33], 0); // index 1 → a distinctive colour
  return {
    id: 7,
    width,
    height,
    numObjects: 0,
    palette,
    transparentIndex: null,
    indexed,
    stripMethods: [],
    zPlanes: [],
    entryScript: null,
    exitScript: null,
    localScripts: new Map(),
    objects: new Map(),
    walkBoxes: [],
    boxMatrix: [],
    scaleSlots: [],
  };
}

function makeVm(room: LoadedRoom | null): Vm {
  const vm = new Vm({ numVariables: 200, numBitVariables: 64, handlers: new Map() });
  vm.loadedRoom = room;
  if (room) vm.currentRoom = room.id;
  return vm;
}

describe('screenshot', () => {
  it('composes the full screen with the room band at the top-left', () => {
    const room = makeRoom(4, 3, 1);
    const shot = screenshot(makeVm(room));
    // Screen-sized output even for a tiny room: 320 wide, 200 tall.
    expect([shot.width, shot.height]).toEqual([320, 200]);
    // The 4×3 room band lands top-left; everything else is CLUT 0.
    let ones = 0;
    for (let y = 0; y < shot.height; y++) {
      for (let x = 0; x < shot.width; x++) {
        const px = shot.pixels[y * shot.width + x]!;
        if (x < 4 && y < 3) {
          expect(px).toBe(1);
          ones++;
        } else {
          expect(px).toBe(0);
        }
      }
    }
    expect(ones).toBe(12);
    expect(shot.palette).toBe(room.palette);
  });

  it('throws when no room is loaded', () => {
    expect(() => screenshot(makeVm(null))).toThrow(/no room loaded/);
  });

  it('writeScreenshot lands a decodable PNG scaled by the given factor', () => {
    const vm = makeVm(makeRoom(4, 3, 1));
    const path = join(tmpdir(), 'grogvm-screenshot-test.png');
    writeScreenshot(vm, path, { scale: 2 });

    const png = readFileSync(path);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IHDR width/height follow the 8-byte signature + 4-byte length + "IHDR".
    expect(png.readUInt32BE(16)).toBe(640); // 320 × scale 2
    expect(png.readUInt32BE(20)).toBe(400); // 200 × scale 2
  });
});
