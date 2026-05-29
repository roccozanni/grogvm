import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../object/loader';
import type { LoadedRoom } from '../room/loader';
import { NUM_SLOTS, UnknownOpcodeError, Vm, type OpcodeHandler } from './vm';

function makeVm(handlers: Record<number, OpcodeHandler> = {}): Vm {
  return new Vm({
    numVariables: 32,
    numBitVariables: 64,
    handlers: new Map(Object.entries(handlers).map(([k, h]) => [Number(k), h])),
  });
}

/** A trivial "stopObjectCode" — kills the slot. */
const stop: OpcodeHandler = (vm, slot) => {
  vm.annotate('stop');
  slot.kill();
};

/** A trivial "breakHere" — yields. */
const breakHere: OpcodeHandler = (vm, slot) => {
  vm.annotate('breakHere');
  slot.yield_();
};

/** A minimal LoadedRoom carrying just the objects a test needs. */
function roomWithObjects(
  id: number,
  objects: ReadonlyArray<LoadedObject>,
): LoadedRoom {
  return {
    id,
    width: 320,
    height: 200,
    numObjects: objects.length,
    palette: new Uint8Array(768),
    transparentIndex: null,
    indexed: new Uint8Array(0),
    stripMethods: [],
    zPlanes: [],
    entryScript: null,
    exitScript: null,
    localScripts: new Map(),
    objects: new Map(objects.map((o) => [o.objId, o])),
    walkBoxes: [],
    walkableMask: new Uint8Array(0),
  };
}

/** A LoadedObject with just an id + verb map (other fields stubbed). */
function objWithVerbs(
  objId: number,
  verbs: ReadonlyMap<number, Uint8Array>,
): LoadedObject {
  return {
    objId,
    cdhd: {
      objId,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      flags: 0,
      parent: 0,
      walkX: 0,
      walkY: 0,
      actorDir: 0,
    },
    imhd: { objId, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
    images: new Map(),
    name: `obj${objId}`,
    verbs,
  };
}

describe('Vm — startVerbScript', () => {
  it('starts a labelled slot from the verb bytecode', () => {
    const vm = makeVm();
    const code = new Uint8Array([0x48, 0x04, 0x00, 0xa0]);
    vm.loadedRoom = roomWithObjects(7, [objWithVerbs(42, new Map([[11, code]]))]);

    const slot = vm.startVerbScript(42, 11);
    expect(slot).not.toBeNull();
    expect(slot!.label).toBe('VERB-42-11');
    expect(slot!.scriptId).toBe(42);
    expect(slot!.room).toBe(7);
    expect(slot!.bytecode).toBe(code);
    expect(slot!.status).toBe('running');
  });

  it('seeds locals with [verb, obj, ...args]', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(50, new Map([[3, new Uint8Array([0xa0])]])),
    ]);

    const slot = vm.startVerbScript(50, 3, [99, 100])!;
    expect(slot.locals[0]).toBe(3); // verb
    expect(slot.locals[1]).toBe(50); // object
    expect(slot.locals[2]).toBe(99);
    expect(slot.locals[3]).toBe(100);
  });

  it('falls back to the default verb (0xFF)', () => {
    const vm = makeVm();
    const def = new Uint8Array([0xa0]);
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(42, new Map([[0xff, def]])),
    ]);

    const slot = vm.startVerbScript(42, 11);
    expect(slot!.bytecode).toBe(def);
    expect(slot!.label).toBe('VERB-42-11');
  });

  it('returns null when the object is not in the room', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, []);
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });

  it('returns null when no room is loaded', () => {
    const vm = makeVm();
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });

  it('returns null when the verb and default are both absent', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(42, new Map([[3, new Uint8Array([0xa0])]])),
    ]);
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });
});

describe('Vm — slot allocation', () => {
  it('startScript picks the first dead slot', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0]) });
    const b = vm.startScript({ scriptId: 2, bytecode: new Uint8Array([0]) });
    expect(a.slotIndex).toBe(0);
    expect(b.slotIndex).toBe(1);
  });

  it('throws when every slot is in use', () => {
    const vm = makeVm();
    for (let i = 0; i < NUM_SLOTS; i++) {
      vm.startScript({ scriptId: i + 1, bytecode: new Uint8Array([0]) });
    }
    expect(() =>
      vm.startScript({ scriptId: 99, bytecode: new Uint8Array([0]) }),
    ).toThrow();
  });
});

describe('Vm — step()', () => {
  it('dispatches one opcode per step and advances PC', () => {
    const vm = makeVm({ 0x00: stop });
    const slot = vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x00]) });
    expect(slot.pc).toBe(0);
    vm.step();
    // stop killed the slot; pc was advanced past the opcode then slot reset
    expect(slot.status).toBe('dead');
  });

  it('returns undefined when no slot is runnable', () => {
    expect(makeVm().step()).toBeUndefined();
  });

  it('halts on unknown opcode with a clear HaltInfo', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 7, bytecode: new Uint8Array([0xab]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.opcode).toBe(0xab);
    expect(vm.haltInfo!.scriptId).toBe(7);
    expect(vm.haltInfo!.pc).toBe(0);
    expect(vm.haltInfo!.reason).toContain('0xab');
    expect(vm.haltInfo!.reason).toContain('Unknown opcode');
  });

  it('halt embeds bytecode context centred on the failing opcode', () => {
    const vm = makeVm({ 0x80: breakHere });
    const code = new Uint8Array([0x80, 0x80, 0x80, 0xff, 0x80, 0x80, 0x80]);
    vm.startScript({ scriptId: 1, bytecode: code });
    while (!vm.isHalted && vm.step()) {
      // resume from each yield
      for (const s of vm.slots) s.resume();
    }
    expect(vm.haltInfo!.opcode).toBe(0xff);
    const ctx = vm.haltInfo!.bytecodeContext;
    expect(ctx[vm.haltInfo!.contextOpcodeOffset]).toBe(0xff);
  });

  it('halt is sticky — subsequent step() is a no-op', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0xff, 0x00]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.step()).toBeUndefined();
    expect(vm.haltInfo!.pc).toBe(0); // didn't move past the original halt
  });

  it('UnknownOpcodeError message contains the byte', () => {
    expect(new UnknownOpcodeError(0x4a).message).toContain('0x4a');
  });
});

describe('Vm — trace ring', () => {
  it('records dispatched opcodes in order', () => {
    const vm = makeVm({ 0x80: breakHere, 0x00: stop });
    vm.startScript({ scriptId: 5, bytecode: new Uint8Array([0x80, 0x80, 0x00]) });
    vm.step();
    for (const s of vm.slots) s.resume();
    vm.step();
    for (const s of vm.slots) s.resume();
    vm.step();
    const t = vm.trace;
    expect(t).toHaveLength(3);
    expect(t.map((e) => e.opcode)).toEqual([0x80, 0x80, 0x00]);
    expect(t.map((e) => e.pc)).toEqual([0, 1, 2]);
    expect(t.map((e) => e.mnemonic)).toEqual(['breakHere', 'breakHere', 'stop']);
    expect(t[0]!.scriptId).toBe(5);
  });

  it('overwrites oldest entries past capacity', () => {
    const vm = makeVm({ 0x80: breakHere });
    // 80 breakHere opcodes; capacity is 64, so newest 64 should remain.
    const code = new Uint8Array(80).fill(0x80);
    vm.startScript({ scriptId: 1, bytecode: code });
    while (!vm.isHalted) {
      const ran = vm.step();
      if (!ran) break;
      for (const s of vm.slots) s.resume();
    }
    const t = vm.trace;
    expect(t.length).toBe(64);
    // Oldest in the buffer is the 17th opcode (= pc 16).
    expect(t[0]!.pc).toBe(16);
    expect(t[t.length - 1]!.pc).toBe(79);
  });
});

describe('Vm — runUntilAllYield', () => {
  it('runs until every running slot yields or dies', () => {
    const vm = makeVm({ 0x80: breakHere, 0x00: stop });
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x80, 0x00]) });
    const steps = vm.runUntilAllYield();
    expect(steps).toBe(1);
    expect(vm.slots[0]!.status).toBe('yielded');
  });

  it('halts on runaway loop hitting the step cap', () => {
    // A handler that doesn't yield AND resets PC to 0 → infinite loop.
    const noYieldRewind: OpcodeHandler = (vm, slot) => {
      vm.annotate('nop');
      slot.pc = 0;
    };
    const vm = makeVm({ 0x01: noYieldRewind });
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x01]) });
    vm.runUntilAllYield(50);
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.reason).toContain('exceeded');
  });
});

describe('Vm — reset', () => {
  it('clears halt, slots, and trace', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0xff]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    vm.reset();
    expect(vm.isHalted).toBe(false);
    expect(vm.trace).toHaveLength(0);
    expect(vm.slots.every((s) => s.status === 'dead')).toBe(true);
  });

  it('clears mouseRoomX/Y', () => {
    const vm = makeVm();
    vm.mouseRoomX = 120;
    vm.mouseRoomY = 40;
    vm.reset();
    expect(vm.mouseRoomX).toBe(0);
    expect(vm.mouseRoomY).toBe(0);
  });

  it('clears sticky input hold flags', () => {
    const vm = makeVm();
    vm.input.leftHold = true;
    vm.input.rightHold = true;
    vm.reset();
    expect(vm.input.leftHold).toBe(false);
    expect(vm.input.rightHold).toBe(false);
  });
});

describe('Vm — beginTick', () => {
  /** beginTick writes to global 53 — use a var bank big enough so the
   *  write isn't silently absorbed by the OOB-leniency handler. */
  const makeWideVm = () =>
    new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map() });

  it('mirrors vm.cursor.userput into VAR_USERPUT', () => {
    const vm = makeWideVm();
    vm.cursor.userput = true;
    vm.beginTick();
    expect(vm.vars.readGlobal(Vm.VAR_USERPUT)).toBe(1);
    vm.cursor.userput = false;
    vm.beginTick();
    expect(vm.vars.readGlobal(Vm.VAR_USERPUT)).toBe(0);
  });
});

describe('Vm — enterRoom + ENCD/EXCD', () => {
  function fakeRoom(id: number, encd?: number[], excd?: number[]) {
    return {
      id,
      width: 8,
      height: 8,
      numObjects: 0,
      palette: new Uint8Array(768),
      transparentIndex: null,
      indexed: new Uint8Array(64),
      stripMethods: [],
      zPlanes: [],
      entryScript: encd ? new Uint8Array(encd) : null,
      exitScript: excd ? new Uint8Array(excd) : null,
      localScripts: new Map(),
      objects: new Map(),
      walkBoxes: [],
      walkableMask: new Uint8Array(0),
    };
  }

  it('updates currentRoom + VAR_ROOM + loadedRoom from the resolver', () => {
    const room = fakeRoom(7);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(7);
    expect(vm.currentRoom).toBe(7);
    expect(vm.vars.readGlobal(4)).toBe(7); // VAR_ROOM
    expect(vm.loadedRoom).toBe(room);
    expect(vm.lastRoomLoadError).toBeNull();
  });

  it('records the error and clears loadedRoom when the resolver throws', () => {
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => {
        throw new Error('no LOFF entry for room 0');
      },
    });
    vm.enterRoom(0);
    expect(vm.loadedRoom).toBeNull();
    expect(vm.lastRoomLoadError).toMatch(/no LOFF entry/);
    expect(vm.currentRoom).toBe(0);
  });

  it('starts the new room\'s ENCD as a labelled slot', () => {
    const room = fakeRoom(10, [0xa0]); // ENCD = stopObjectCode
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(10);
    const encd = vm.slots.find((s) => s.label === 'ENCD-10');
    expect(encd).toBeDefined();
    expect(encd!.status).toBe('running');
    expect(encd!.room).toBe(10);
    expect(Array.from(encd!.bytecode)).toEqual([0xa0]);
  });

  it('starts the previous room\'s EXCD when transitioning to a new room', () => {
    const a = fakeRoom(1, [0x80], [0xa0]); // ENCD breakHere; EXCD stopObjectCode
    const b = fakeRoom(2);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: (id) => (id === 1 ? a : b),
    });
    vm.enterRoom(1);
    // Sanity: ENCD-1 fired.
    expect(vm.slots.some((s) => s.label === 'ENCD-1')).toBe(true);
    vm.enterRoom(2);
    // EXCD-1 should now be queued (for the room we just left).
    expect(vm.slots.some((s) => s.label === 'EXCD-1')).toBe(true);
    expect(vm.loadedRoom).toBe(b);
  });

  it('does nothing extra when ENCD/EXCD are absent', () => {
    const room = fakeRoom(3); // no scripts
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(3);
    // Only system state should change; no labelled slots.
    expect(vm.slots.every((s) => s.label === '')).toBe(true);
  });
});
