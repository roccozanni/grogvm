import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../../object/loader';
import type { LoadedRoom } from '../../room/loader';
import { Vm } from '../vm';
import { SEED_OPCODES } from './index';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

/** A minimal LoadedRoom — only the fields the Phase 8 opcodes touch. */
function fakeRoom(id: number, width = 320): LoadedRoom {
  return {
    id,
    width,
    height: 200,
    numObjects: 0,
    palette: new Uint8Array(768),
    transparentIndex: null,
    indexed: new Uint8Array(0),
    stripMethods: [],
    zPlanes: [],
    entryScript: null,
    exitScript: null,
    localScripts: new Map(),
    objects: new Map(),
    walkBoxes: [],
    walkableMask: new Uint8Array(0), scaleSlots: [],
  };
}

function makeVm(resolveRoom?: (id: number) => LoadedRoom): Vm {
  return new Vm({
    numVariables: 800,
    numBitVariables: 2048,
    handlers: SEED_OPCODES,
    resolveRoom,
  });
}

/**
 * Run a single opcode in a fresh slot, then a stopObjectCode so the
 * slot dies — otherwise a non-yielding opcode leaves the slot
 * `running` and a later `step()` would re-dispatch the stale slot.
 */
function run(vm: Vm, code: Uint8Array): void {
  const slot = vm.startScript({ scriptId: 1, bytecode: bytes(...code, 0x00) });
  for (let i = 0; i < 100 && slot.status === 'running'; i++) vm.step();
}

describe('phase 8 — pseudoRoom (0xCC)', () => {
  it('maps high-bit aliases to the real room and ignores the rest', () => {
    const vm = makeVm();
    // realRoom=10, aliases 5 (0x85) and 7 (0x87); a plain 0x03 is ignored.
    run(vm, bytes(0xcc, 0x0a, 0x85, 0x03, 0x87, 0x00));
    expect(vm.pseudoRooms.get(5)).toBe(10);
    expect(vm.pseudoRooms.get(7)).toBe(10);
    expect(vm.pseudoRooms.has(3)).toBe(false);
    expect(vm.haltInfo).toBeNull();
  });

  it('enterRoom resolves a pseudo id to its physical room', () => {
    const resolved: number[] = [];
    const vm = makeVm((id) => {
      resolved.push(id);
      return fakeRoom(id);
    });
    vm.pseudoRooms.set(5, 10);
    vm.enterRoom(5);
    // Resources come from room 10; the logical room stays 5.
    expect(resolved).toContain(10);
    expect(vm.loadedRoom?.id).toBe(10);
    expect(vm.currentRoom).toBe(5);
  });

  it('enterRoom is identity for an unmapped id', () => {
    const vm = makeVm((id) => fakeRoom(id));
    vm.enterRoom(33);
    expect(vm.loadedRoom?.id).toBe(33);
    expect(vm.currentRoom).toBe(33);
  });
});

describe('phase 8 — systemOps (0x98)', () => {
  it('records restart / pause / quit without halting', () => {
    for (const [sub, expected] of [
      [0x01, 'restart'],
      [0x02, 'pause'],
      [0x03, 'quit'],
    ] as const) {
      const vm = makeVm();
      run(vm, bytes(0x98, sub));
      expect(vm.systemRequest).toBe(expected);
      expect(vm.haltInfo).toBeNull();
    }
  });

  it('leaves systemRequest null for an unknown subop', () => {
    const vm = makeVm();
    run(vm, bytes(0x98, 0x07));
    expect(vm.systemRequest).toBeNull();
    expect(vm.haltInfo).toBeNull();
  });
});

describe('phase 8 — roomOps roomScroll (0x01)', () => {
  it('sets camera bounds (floored at half-screen) and clamps setCameraAt', () => {
    const vm = makeVm();
    vm.loadedRoom = fakeRoom(1, 640);
    // roomScroll min=200 max=400.
    run(vm, bytes(0x33, 0x01, 0xc8, 0x00, 0x90, 0x01));
    expect(vm.roomScroll).toEqual({ min: 200, max: 400 });

    // setCameraAt 1000 → clamps to max 400.
    run(vm, bytes(0x32, 0xe8, 0x03));
    expect(vm.camera.x).toBe(400);
    // setCameraAt 0 → clamps to min 200.
    run(vm, bytes(0x32, 0x00, 0x00));
    expect(vm.camera.x).toBe(200);
  });

  it('floors min at 160 (half the 320-wide screen)', () => {
    const vm = makeVm();
    vm.loadedRoom = fakeRoom(1, 640);
    // roomScroll min=10 max=50 → both floored to 160.
    run(vm, bytes(0x33, 0x01, 0x0a, 0x00, 0x32, 0x00));
    expect(vm.roomScroll).toEqual({ min: 160, max: 160 });
  });

  it('clears roomScroll on room change', () => {
    const vm = makeVm((id) => fakeRoom(id, 640));
    vm.loadedRoom = fakeRoom(1, 640);
    run(vm, bytes(0x33, 0x01, 0xc8, 0x00, 0x90, 0x01));
    expect(vm.roomScroll).not.toBeNull();
    vm.enterRoom(2);
    expect(vm.roomScroll).toBeNull();
  });
});

describe('phase 8 — roomOps setPalColor (0x04)', () => {
  it('writes the RGB triple into the live room CLUT', () => {
    const vm = makeVm();
    vm.loadedRoom = fakeRoom(1);
    // setPalColor (10,20,30) → slot 5. sub2=0x00 (idx as direct byte).
    run(vm, bytes(0x33, 0x04, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00, 0x00, 0x05));
    const pal = vm.loadedRoom.palette;
    expect([pal[15], pal[16], pal[17]]).toEqual([10, 20, 30]);
    expect(vm.haltInfo).toBeNull();
  });

  it('records a persistent UI override when no room is loaded', () => {
    const vm = makeVm();
    // setPalColor (10,20,30) → slot 5, with no room loaded (MI1 boot
    // palette scripts run before the first room).
    run(vm, bytes(0x33, 0x04, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00, 0x00, 0x05));
    expect(vm.haltInfo).toBeNull();
    expect(vm.uiPaletteOverrides.get(5)).toEqual([10, 20, 30]);
  });

  it('re-applies UI overrides on top of each room CLUT on load', () => {
    const room = fakeRoom(7);
    room.palette[15] = 99; // slot 5 starts as the room's own value
    const vm = makeVm(() => room);
    // No room yet → records the override for slot 5.
    run(vm, bytes(0x33, 0x04, 0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00, 0x00, 0x05));
    vm.enterRoom(7); // room loads, then the override is re-applied
    expect([room.palette[15], room.palette[16], room.palette[17]]).toEqual([10, 20, 30]);
  });
});

describe('phase 8 — roomOps screenEffect (0x0A)', () => {
  it('splits the operand into switchRoomEffect (low) / switchRoomEffect2 (high)', () => {
    const vm = makeVm();
    // screenEffect 0x8180 → in=0x80 (128), out=0x81 (129) — MI1's
    // pre-loadRoom transition idiom.
    run(vm, bytes(0x33, 0x0a, 0x80, 0x81));
    expect(vm.screenEffect.switchRoomEffect).toBe(0x80);
    expect(vm.screenEffect.switchRoomEffect2).toBe(0x81);
    expect(vm.screenEffect.requestFadeIn).toBe(false);
    expect(vm.haltInfo).toBeNull();
  });

  it('treats operand 0 as a fade-in trigger, leaving the effect numbers unchanged', () => {
    const vm = makeVm();
    run(vm, bytes(0x33, 0x0a, 0x81, 0x81)); // sets in=out=129
    run(vm, bytes(0x33, 0x0a, 0x00, 0x00)); // fade-in trigger
    expect(vm.screenEffect.switchRoomEffect).toBe(0x81);
    expect(vm.screenEffect.switchRoomEffect2).toBe(0x81);
    expect(vm.screenEffect.requestFadeIn).toBe(true);
  });

  it('reset() clears the screen effect state', () => {
    const vm = makeVm();
    run(vm, bytes(0x33, 0x0a, 0x80, 0x81));
    run(vm, bytes(0x33, 0x0a, 0x00, 0x00));
    vm.reset();
    expect(vm.screenEffect).toEqual({
      switchRoomEffect: 0,
      switchRoomEffect2: 0,
      requestFadeIn: false,
    });
  });
});

describe('phase 8 — dialog escape codes (substitutions)', () => {
  // print actor=255 (system) → SO_TEXTSTRING with the given body bytes.
  function systemPrint(...body: number[]): Vm {
    const vm = makeVm();
    run(vm, bytes(0x14, 0xff, 0x0f, ...body, 0x00));
    return vm;
  }

  it('0x04 inserts a variable value in decimal', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(50, 7);
    // "X=" + \xff\x04 <var 50>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0x58, 0x3d, 0xff, 0x04, 0x32, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('X=7');
  });

  it('0x07 inserts the contents of a string resource', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(60, 3);
    vm.strings.set(3, bytes(0x48, 0x69)); // "Hi"
    // \xff\x07 <var 60 → string id 3>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0xff, 0x07, 0x3c, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('Hi');
  });

  it('0x08 inserts an object name', () => {
    const obj: LoadedObject = {
      objId: 42,
      cdhd: { objId: 42, x: 0, y: 0, width: 0, height: 0, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
      imhd: { objId: 42, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
      images: new Map(),
      name: 'sword',
      verbs: new Map(),
    };
    const vm = makeVm();
    vm.loadedRoom = { ...fakeRoom(1), objects: new Map([[42, obj]]) };
    vm.vars.writeGlobal(70, 42);
    // \xff\x08 <var 70 → obj 42>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0xff, 0x08, 0x46, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('sword');
  });

  it('still strips a deferred code (0x0A actor name) without emitting', () => {
    const vm = systemPrint(0x68, 0x69, 0xff, 0x0a, 0x01, 0x00); // "hi" + actor-name code
    expect(vm.systemText?.text).toBe('hi');
    expect(vm.haltInfo).toBeNull();
  });

  it('newline code (0x01) still maps to \\n', () => {
    const vm = systemPrint(0x41, 0xff, 0x01, 0x42); // "A" \n "B"
    expect(vm.systemText?.text).toBe('A\nB');
  });
});

describe('drawObject (0x05) — animated background fixtures', () => {
  // Two single-frame objects sharing one bounding box — MI1's idiom for an
  // animation frame pair (e.g. the SCUMM Bar chandelier pirate, objs 357/358).
  function objAt(objId: number, x: number, y: number, w: number, h: number): LoadedObject {
    return {
      objId,
      cdhd: {} as never,
      imhd: { objId, x, y, width: w, height: h } as never,
      images: new Map(),
      name: '',
      verbs: [],
    } as unknown as LoadedObject;
  }

  it('cycling two same-box objects keeps only the latest queued (no pile-up)', () => {
    const vm = makeVm();
    const room = fakeRoom(1);
    (room.objects as Map<number, LoadedObject>).set(357, objAt(357, 32, 120, 40, 24));
    (room.objects as Map<number, LoadedObject>).set(358, objAt(358, 32, 120, 40, 24));
    vm.loadedRoom = room;

    run(vm, bytes(0x05, 0x66, 0x01, 0xff)); // drawObject 358 (0x0166)
    expect([...vm.objectDrawQueue]).toEqual([358]);
    run(vm, bytes(0x05, 0x65, 0x01, 0xff)); // drawObject 357 — evicts 358
    expect([...vm.objectDrawQueue]).toEqual([357]);
    run(vm, bytes(0x05, 0x66, 0x01, 0xff)); // back to 358 — evicts 357
    expect([...vm.objectDrawQueue]).toEqual([358]);
  });

  it('does not evict a distinct object at a different box', () => {
    const vm = makeVm();
    const room = fakeRoom(1);
    (room.objects as Map<number, LoadedObject>).set(357, objAt(357, 32, 120, 40, 24));
    (room.objects as Map<number, LoadedObject>).set(400, objAt(400, 200, 50, 16, 16));
    vm.loadedRoom = room;

    run(vm, bytes(0x05, 0x65, 0x01, 0xff)); // drawObject 357
    run(vm, bytes(0x05, 0x90, 0x01, 0xff)); // drawObject 400 (0x0190) — different box
    expect([...vm.objectDrawQueue].sort((a, b) => a - b)).toEqual([357, 400]);
  });

  it('a bare draw reveals a hidden object (sets state to 1, SCUMM default)', () => {
    // Dialog close-ups (room 58) hide every scenery object via setState 0 at
    // ENCD, then reveal a piece with a bare drawObject — which must flip it
    // back to state 1, not leave it hidden.
    const vm = makeVm();
    const room = fakeRoom(1);
    (room.objects as Map<number, LoadedObject>).set(674, objAt(674, 100, 0, 8, 8));
    vm.loadedRoom = room;
    vm.objectStates.set(674, 0); // hidden by the room's ENCD
    run(vm, bytes(0x05, 0xa2, 0x02, 0xff)); // bare drawObject 674 (0x02A2)
    expect(vm.objectStates.get(674)).toBe(1); // revealed
  });

  it('SO_AT (subop 1) consumes exactly x,y — not the following opcode', () => {
    // v5 drawObject has ONE subop, not a 0xFF-terminated list. A `… at x,y`
    // followed by setState (room 58 ENCD) must read the two coords and stop,
    // so the next opcode (setState 0x07) decodes cleanly. The old loop ran on
    // and mis-read 0x07 as a bogus drawObject subop → halt.
    const vm = makeVm();
    const room = fakeRoom(1);
    (room.objects as Map<number, LoadedObject>).set(674, objAt(674, 100, 0, 8, 8));
    vm.loadedRoom = room;
    // drawObject 674 (0x02A2) at x=100 y=0 ; setState 674 state=0 ; stop.
    run(
      vm,
      bytes(0x05, 0xa2, 0x02, 0x01, 0x64, 0x00, 0x00, 0x00, 0x07, 0xa2, 0x02, 0x00),
    );
    expect(vm.haltInfo).toBeNull();
    expect([...vm.objectDrawQueue]).toContain(674);
    expect(vm.objectStates.get(674)).toBe(0); // setState ran, wasn't swallowed
  });
});

describe('enterRoom — room-local scripts stop on room change', () => {
  it('kills room-local + verb scripts, spares globals and ENCD/EXCD', () => {
    const vm = makeVm((id) => fakeRoom(id));
    // breakHere then jump back to it — a yielded ambient loop.
    const loop = bytes(0x80, 0x18, 0xfd, 0xff);
    const local = vm.startScript({ scriptId: 210, bytecode: loop, room: 28 });
    const verb = vm.startScript({ scriptId: 333, bytecode: loop, room: 28, label: 'VERB-333-8' });
    const glob = vm.startScript({ scriptId: 17, bytecode: loop, room: 0 });
    vm.step(); // let them yield at breakHere

    vm.enterRoom(82);

    expect(local.status).toBe('dead'); // room-local #210 stopped
    expect(verb.status).toBe('dead'); // object/verb script stopped
    expect(glob.status).not.toBe('dead'); // global survives the room change
  });
});
