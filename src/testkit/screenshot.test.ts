/**
 * Tests the screenshot helper against a synthetic VM with a hand-built room —
 * no game data, runs everywhere. Verifies it composites the loaded room's
 * background into the returned framebuffer and that writeScreenshot lands a
 * decodable, correctly-scaled PNG on disk.
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
  const vm = new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map() });
  vm.loadedRoom = room;
  if (room) vm.currentRoom = room.id;
  return vm;
}

describe('screenshot', () => {
  it('returns the loaded room background as an indexed framebuffer', () => {
    const room = makeRoom(4, 3, 1);
    const shot = screenshot(makeVm(room));
    expect([shot.width, shot.height]).toEqual([4, 3]);
    expect([...shot.pixels]).toEqual(Array(12).fill(1));
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
    expect(png.readUInt32BE(16)).toBe(8); // 4 × scale 2
    expect(png.readUInt32BE(20)).toBe(6); // 3 × scale 2
  });
});
