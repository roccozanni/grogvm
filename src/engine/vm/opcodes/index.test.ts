import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../../object/loader';
import type { LoadedRoom } from '../../room/loader';
import { Vm } from '../vm';
import { SEED_OPCODES } from './index';
import { pickObject } from '../../object/hittest';

function makeVm(resolveRoom?: (id: number) => LoadedRoom): Vm {
  return new Vm({
    numVariables: 800,
    numBitVariables: 2048,
    handlers: SEED_OPCODES,
    resolveRoom,
  });
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

/** A minimal LoadedRoom — only the fields the room/draw opcodes touch. */
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
    boxMatrix: [], scaleSlots: [],
  };
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

describe('seed opcodes — flow', () => {
  it('0x00 stopObjectCode kills the slot', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x00) });
    vm.step();
    expect(slot.status).toBe('dead');
  });

  it('0x80 breakHere yields the slot', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.step();
    expect(slot.status).toBe('yielded');
  });

  it('0x42 chainScript kills the current slot and starts the new script', () => {
    // A global resolver returns a trivial body (just breakHere) for #7.
    const chained = bytes(0x80); // breakHere → yields, stays alive
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveGlobalScript: () => ({ bytecode: chained, room: 0 }),
    });
    // chainScript #7 (no args → immediate 0xFF terminator).
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x42, 0x07, 0xff) });
    const original = slot.slotIndex;
    expect(slot.scriptId).toBe(1);
    vm.step(); // run chainScript
    // The original script (#1) is gone — it was killed and the freed slot
    // is reused by the chained #7 (SCUMM runs it in the dying slot's place).
    expect(vm.slots.some((s) => s.status !== 'dead' && s.scriptId === 1)).toBe(false);
    const live = vm.slots.find((s) => s.status !== 'dead' && s.scriptId === 7);
    expect(live).toBeDefined();
    expect(live!.slotIndex).toBe(original);
  });

  it('0x0A startScript 0 is a silent no-op (not a global-script load)', () => {
    // The game hits `startScript 0` in ordinary play: MI1's hover poller #23
    // runs a per-actor handler via an indexed table that is 0 for actors with
    // no give/use script. Resolving id 0 as a global (DSCR slot 0 = unused,
    // room 0) would wrongly halt the VM (the give-pot crash), so id 0 must be
    // a no-op.
    let resolverCalls = 0;
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveGlobalScript: () => {
        resolverCalls++;
        throw new Error('should not resolve script 0');
      },
    });
    // startScript 0 (byte immediate), no args. Then breakHere so the caller
    // survives — proving execution continued past the no-op rather than halting.
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x0a, 0x00, 0xff, 0x80) });
    vm.step(); // run startScript 0
    expect(vm.haltInfo).toBeNull();
    expect(resolverCalls).toBe(0); // id 0 short-circuited before resolution
    vm.step(); // breakHere
    expect(slot.status).toBe('yielded'); // caller still alive
  });

  it('0x42 chainScript 0 stops the current slot and starts nothing', () => {
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveGlobalScript: () => {
        throw new Error('should not resolve script 0');
      },
    });
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x42, 0x00, 0xff) });
    vm.step();
    expect(vm.haltInfo).toBeNull();
    expect(slot.status).toBe('dead'); // current slot killed, no replacement
    expect(vm.slots.some((s) => s.status !== 'dead')).toBe(false);
  });

  it('0xC2 chainScript reads the script id from a var', () => {
    const chained = bytes(0x80);
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveGlobalScript: () => ({ bytecode: chained, room: 0 }),
    });
    vm.vars.writeGlobal(5, 9); // var 5 = script id 9
    // chainScript (var 5) : 0xC2, var ref 0x0005 (LE), then 0xFF args term.
    vm.startScript({ scriptId: 1, bytecode: bytes(0xc2, 0x05, 0x00, 0xff) });
    vm.step();
    expect(vm.slots.some((s) => s.status !== 'dead' && s.scriptId === 1)).toBe(false);
    expect(vm.slots.some((s) => s.status !== 'dead' && s.scriptId === 9)).toBe(true);
  });

  it('0xB7 startObject runs the verb script NESTED (sets g before the caller reads it)', () => {
    const vm = makeVm();
    // Verb-11 body: `move g100 = 777` then stopObjectCode. This stands in for
    // an inventory item's verb-91, which sets g376 to its icon object.
    const verb11 = bytes(0x1a, 0x64, 0x00, 0x09, 0x03, 0x00);
    vm.loadedRoom = {
      id: 7,
      objects: new Map([[42, { objId: 42, verbs: new Map([[11, verb11]]) }]]),
      localScripts: new Map(),
    } as never;
    // Caller: startObject(obj=42, script=11, no args). 0x37 = literal obj +
    // literal script; bytes obj16=42, script8=11, args terminator 0xFF.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x37, 0x2a, 0x00, 0x0b, 0xff, 0x00) });
    vm.step(); // run ONLY the startObject opcode
    // Nested: the verb body has already run to its stop, so g100 is set now —
    // not on some later scheduler tick. (Deferred, this would still be 0.)
    expect(vm.vars.readGlobal(100)).toBe(777);
  });

  it('0xB7 startObject runs a CARRIED inventory item verb script from its home room', () => {
    // Regression: MI1's inventory script #9 runs each carried item's verb-91
    // (the icon script: `g376 = <icon obj>`) via startObject, then reads g376.
    // The item is NOT in the current room, so resolving its code requires the
    // home-room fallback. Without it, startObject no-ops, g376 stays stale, and
    // every inventory slot drew the same wrong fallback icon (obj 1031).
    const verb91 = bytes(0x1a, 0x78, 0x01, 0xe4, 0x03, 0x00); // move g376 = 996; stop
    const homeRoom = {
      id: 41,
      objects: new Map([[566, { objId: 566, verbs: new Map([[91, verb91]]) }]]),
      localScripts: new Map(),
    } as never;
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveRoom: (id) => (id === 41 ? homeRoom : (() => { throw new Error('no room'); })()),
      resolveObjectRoom: (objId) => (objId === 566 ? 41 : null),
    });
    // Current room (7) does NOT contain object 566 — it's carried.
    vm.loadedRoom = { id: 7, objects: new Map(), localScripts: new Map() } as never;
    // startObject(obj=566, script=91, no args): 0x37 obj16=566(0x0236) script8=91 args-term.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x37, 0x36, 0x02, 0x5b, 0xff, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(376)).toBe(996);
  });

  it('getVerbEntryPoint (0x8B) answers for a carried item via its home room', () => {
    // #9 gates the startObject above on getVerbEntryPoint(item, 91) being
    // truthy. It must consult the home room too, or the gate reads 0 for every
    // carried item and the icon script never runs.
    const homeRoom = {
      id: 41,
      objects: new Map([[566, { objId: 566, verbs: new Map([[91, bytes(0x00)]]) }]]),
      localScripts: new Map(),
    } as never;
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveRoom: (id) => (id === 41 ? homeRoom : (() => { throw new Error('no room'); })()),
      resolveObjectRoom: (objId) => (objId === 566 ? 41 : null),
    });
    vm.loadedRoom = { id: 7, objects: new Map(), localScripts: new Map() } as never;
    // getVerbEntryPoint g0 = entry(obj=566, verb=91): 0x0B (immediate params)
    // dest g0, obj16=566(0x0236), verb16=91(0x005B), then stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0b, 0x00, 0x00, 0x36, 0x02, 0x5b, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(1);
  });

  it('0x18 jumpRelative applies a signed offset', () => {
    const vm = makeVm();
    // jump +4 over the next four bytes, land on stopObjectCode.
    const code = bytes(0x18, 0x04, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00);
    const slot = vm.startScript({ scriptId: 1, bytecode: code });
    vm.step(); // jump
    expect(slot.pc).toBe(7); // 1 (opcode) + 2 (delta read) + 4 (delta)
    vm.step(); // stopObjectCode
    expect(slot.status).toBe('dead');
  });
});

describe('seed opcodes — setVar', () => {
  it('0x1A writes immediate to global', () => {
    const vm = makeVm();
    // setVar global #7 = 100
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x1a, 0x07, 0x00, 0x64, 0x00, 0x00),
    });
    vm.step();
    expect(vm.vars.readGlobal(7)).toBe(100);
  });

  it('0x9A writes a var-ref source to a global', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(2, 555);
    // setVar global #5 = global #2
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x9a, 0x05, 0x00, 0x02, 0x00, 0x00),
    });
    vm.step();
    expect(vm.vars.readGlobal(5)).toBe(555);
  });

  it('0x1A targets a local var when the dest has bit 14 set', () => {
    const vm = makeVm();
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x1a, 0x03, 0x40, 0x2a, 0x00, 0x00),
    });
    vm.step();
    expect(slot.locals[3]).toBe(42);
  });
});

describe('seed opcodes — arithmetic', () => {
  it('0x46 inc and 0xC6 dec adjust by one', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(0, 10);
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x46, 0x00, 0x00, 0xc6, 0x00, 0x00, 0xc6, 0x00, 0x00),
    });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(11);
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(10);
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(9);
  });

  it('0x5A addVar and 0x3A subVar with immediate operand', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 50);
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x5a, 0x01, 0x00, 0x05, 0x00, 0x3a, 0x01, 0x00, 0x10, 0x00),
    });
    vm.step();
    expect(vm.vars.readGlobal(1)).toBe(55);
    vm.step();
    expect(vm.vars.readGlobal(1)).toBe(39);
  });

  it('0x1B multiply and 0x5B divide with immediate operand (signed, truncating)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 50);
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x1b, 0x01, 0x00, 0x03, 0x00, // multiply g1 *= 3 → 150
        0x5b, 0x01, 0x00, 0x04, 0x00, // divide   g1 /= 4 → 37 (trunc)
        0x1b, 0x01, 0x00, 0xfe, 0xff, // multiply g1 *= -2 (0xFFFE signed) → -74
      ),
    });
    vm.step();
    expect(vm.vars.readGlobal(1)).toBe(150);
    vm.step();
    expect(vm.vars.readGlobal(1)).toBe(37);
    vm.step();
    expect(vm.vars.readGlobal(1)).toBe(-74);
  });

  it('0x5B divide by zero halts loudly', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 10);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x5b, 0x01, 0x00, 0x00, 0x00) });
    vm.step();
    expect(vm.haltInfo!.reason).toMatch(/divide by zero/);
  });
});

describe('seed opcodes — getActorWidth (0x6C) + actorOps width', () => {
  it('actorOps SO_ACTOR_WIDTH stores the width; getActorWidth reads it back', () => {
    const vm = makeVm();
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x13, 0x03, 0x10, 0x40, 0xff, // actorOps a=3 { width=64 }
        0x6c, 0x00, 0x00, 0x03, // getActorWidth g0 = width(actor 3)
        0xa0, // stopObjectCode
      ),
    });
    vm.step();
    expect(vm.actors.get(3).width).toBe(64);
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(64);
  });

  it('getActorWidth on an unconfigured actor returns the default (24)', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x6c, 0x00, 0x00, 0x05) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(24);
  });
});

describe('seed opcodes — drawBox (0x3F)', () => {
  it('records a box and consumes the 11-byte immediate form (MI1 #130 credits clear)', () => {
    const vm = makeVm();
    // drawBox 0,0,319,199 color=0 then stopObjectCode. Layout: op, left(u16),
    // top(u16), modeByte(u8), right(u16), bottom(u16), color(var-or-byte).
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x3f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3f, 0x01, 0xc7, 0x00, 0x00, // drawBox …
        0x00, // stopObjectCode
      ),
    });
    vm.step();
    expect(vm.drawnBoxes).toEqual([{ left: 0, top: 0, right: 319, bottom: 199, color: 0 }]);
    while (!vm.isHalted && vm.step()) {}
    expect(vm.isHalted).toBe(false); // 11-byte size landed on the stop, no halt
  });
});

describe('seed opcodes — branches', () => {
  it('0x48 isEqual branch: equal continues, not-equal jumps', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(0, 5);
    // isEqual(var[0], 5) → continue (no jump)
    const code = bytes(0x48, 0x00, 0x00, 0x05, 0x00, 0x10, 0x00, 0x00);
    const slot = vm.startScript({ scriptId: 1, bytecode: code });
    vm.step();
    // PC advanced past opcode (1) + var ref (2) + value (2) + delta (2) = 7
    expect(slot.pc).toBe(7);
    expect(slot.bytecode[slot.pc]).toBe(0x00); // stopObjectCode follows
  });

  it('0x48 isEqual branch: not equal → jump taken', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(0, 7);
    const code = bytes(0x48, 0x00, 0x00, 0x05, 0x00, 0x10, 0x00, 0x00);
    const slot = vm.startScript({ scriptId: 1, bytecode: code });
    vm.step();
    expect(slot.pc).toBe(7 + 0x10);
  });

  it('0x28 equalZero branches when var != 0', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(0, 0);
    // equalZero(var[0]) → continue if true (var IS zero)
    const code = bytes(0x28, 0x00, 0x00, 0x10, 0x00, 0x00);
    const slot = vm.startScript({ scriptId: 1, bytecode: code });
    vm.step();
    // var is zero → don't jump
    expect(slot.pc).toBe(5);

    vm.vars.writeGlobal(0, 9);
    slot.pc = 0;
    vm.step();
    expect(slot.pc).toBe(5 + 0x10);
  });

  it('0xA8 notEqualZero branches when var == 0', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(0, 0);
    const code = bytes(0xa8, 0x00, 0x00, 0x10, 0x00, 0x00);
    const slot = vm.startScript({ scriptId: 1, bytecode: code });
    vm.step();
    expect(slot.pc).toBe(5 + 0x10);
  });
});

describe('seed opcodes — cursorCommand (0x2C)', () => {
  it('cursorOff / userputOff subops consume no args and advance one byte', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x02, 0x2c, 0x04, 0x00) });
    vm.step();
    expect(slot.pc).toBe(2);
    expect(vm.isHalted).toBe(false);
    vm.step();
    expect(slot.pc).toBe(4);
    expect(vm.isHalted).toBe(false);
  });

  it('initCharset (0x0D) consumes a direct-byte arg', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x0d, 0x03, 0x00) });
    vm.step();
    expect(slot.pc).toBe(3);
    expect(vm.isHalted).toBe(false);
  });

  it('initCharset with var-ref arg (subop bit 0x80) reads u16', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(7, 99);
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x2c, 0x8d, 0x07, 0x00, 0x00),
    });
    vm.step();
    expect(slot.pc).toBe(4); // opcode + subop + 2-byte var-ref
    expect(vm.isHalted).toBe(false);
  });

  it('cursor-image subops (0x0A/0x0B/0x0C) halt loudly — unmodelled, no MI1 use', () => {
    for (const sub of [0x0a, 0x0b, 0x0c]) {
      const vm = makeVm();
      vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, sub, 0x01, 0x02, 0x03) });
      vm.step();
      expect(vm.haltInfo!.reason).toMatch(/cursor-image subop .* not implemented/);
    }
  });

  it('charsetColor (0x0E) reads a word-vararg list terminated by 0xFF', () => {
    const vm = makeVm();
    // colors = [0x0001, 0x0002, 0x0003], then 0xFF terminator
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x2c, 0x0e,
        0x00, 0x01, 0x00, // marker 0x00 → direct, 0x0001
        0x00, 0x02, 0x00,
        0x00, 0x03, 0x00,
        0xff,
      ),
    });
    vm.step();
    expect(slot.pc).toBe(12);
    expect(vm.isHalted).toBe(false);
  });

  it('halts loudly on an unknown subop', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x1f) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.reason).toMatch(/cursorCommand: unknown subop/);
  });
});

describe('seed opcodes — expression (0xAC)', () => {
  it('dispatches through evalExpression and writes the result to dest', () => {
    const vm = makeVm();
    // 0xAC, dest=0x0001, push imm 7, push imm 5, add (subop 0x02), end → var[1] = 12
    const code = bytes(
      0xac,
      0x01, 0x00,
      0x01, 0x07, 0x00,
      0x01, 0x05, 0x00,
      0x02,
      0xff,
    );
    vm.startScript({ scriptId: 1, bytecode: code });
    vm.step();
    expect(vm.isHalted).toBe(false);
    expect(vm.vars.readGlobal(1)).toBe(12);
  });
});

describe('seed opcodes — delay', () => {
  it('0x2E consumes 3 bytes and yields the slot', () => {
    const vm = makeVm();
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x2e, 0x10, 0x27, 0x00, 0x00),
    });
    vm.step();
    expect(slot.pc).toBe(4);
    expect(slot.status).toBe('yielded');
  });
});

describe('seed opcodes — lights (0x70)', () => {
  it('sets VAR_CURRENT_LIGHTS from an immediate arg1 when arg3 == 0', () => {
    const vm = makeVm();
    // lights 7, 0, 0  → g9 = 7 (room-lit default)
    vm.startScript({ scriptId: 1, bytecode: bytes(0x70, 7, 0, 0) });
    vm.step();
    expect(vm.vars.readGlobal(9)).toBe(7);
  });

  it('reads arg1 as a var-ref when bit 0x80 is set (0xF0)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(50, 4);
    // lights g50, 0, 0  → g9 = value of g50 = 4
    vm.startScript({ scriptId: 1, bytecode: bytes(0xf0, 0x32, 0x00, 0, 0) });
    vm.step();
    expect(vm.vars.readGlobal(9)).toBe(4);
  });

  it('does NOT touch VAR_CURRENT_LIGHTS in flashlight mode (arg3 != 0)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(9, 7);
    // lights 0, 72, 1  → flashlight; g9 unchanged. Slot stays aligned
    // (3 operand bytes consumed) and runs to the trailing stop.
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x70, 0, 72, 1, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(9)).toBe(7);
    expect(slot.pc).toBe(4);
    vm.step();
    expect(slot.status).toBe('dead');
  });
});

describe('seed opcodes — startScript LSCR routing', () => {
  it('routes script ids >= 200 to the current room\'s localScripts', () => {
    const vm = makeVm();
    // Stub the current room with one LSCR (id 201). A breakHere keeps the
    // slot alive after the (now nested) startScript yields, so the routing
    // it landed on stays observable; stopObjectCode follows.
    const localBytecode = bytes(0x80, 0xa0); // breakHere; stopObjectCode
    (vm as unknown as { loadedRoom: object }).loadedRoom = {
      id: 5,
      width: 320,
      height: 200,
      numObjects: 0,
      palette: new Uint8Array(768),
      transparentIndex: null,
      indexed: new Uint8Array(320 * 200),
      stripMethods: [],
      zPlanes: [],
      entryScript: null,
      exitScript: null,
      localScripts: new Map([[201, localBytecode]]),
      objects: new Map(),
      walkBoxes: [],
      boxMatrix: [], scaleSlots: [],
    };
    (vm as unknown as { currentRoom: number }).currentRoom = 5;
    // bytecode: startScript #201 with no args
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0a, 201, 0xff) });
    vm.step();
    // The slot picker grabs the next dead slot for the LSCR; verify
    // it landed there with the right bytecode.
    const lscrSlot = vm.slots.find((s) => s.scriptId === 201);
    expect(lscrSlot).toBeDefined();
    expect(lscrSlot!.bytecode).toEqual(localBytecode);
    expect(lscrSlot!.room).toBe(5);
  });

  it('halts loudly if a local script id is requested but no room is loaded', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0a, 201, 0xff) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.reason).toMatch(/local script #201 not present/);
  });
});

describe('seed opcodes — boot prefix from real MI1', () => {
  it('runs setVars + cursorCommands + first stringOps loadString of MI1 boot script cleanly', () => {
    const vm = makeVm();
    // Verbatim opening bytes of MI1 boot script through the first
    // stringOps loadString call (verb label slot 0x16, 13 chars of '@').
    const boot = bytes(
      0x1a, 0x49, 0x00, 0x00, 0x00, // setVar 0x49 = 0
      0x1a, 0x3c, 0x00, 0x00, 0x00, // setVar 0x3c = 0
      0x1a, 0x33, 0x00, 0x01, 0x00, // setVar 0x33 = 1
      0x1a, 0x06, 0x00, 0x02, 0x00, // setVar 0x06 = 2
      0x2c, 0x02,                   // cursorCommand cursorOff
      0x2c, 0x04,                   // cursorCommand userputOff
      0x27, 0x01, 0x16,             // stringOps loadString id=0x16 ...
      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x00, // 13 '@' chars + NUL
      0x00,                         // stopObjectCode
    );
    vm.startScript({ scriptId: 1, bytecode: boot });
    while (!vm.isHalted) {
      const ran = vm.step();
      if (!ran) break;
    }
    expect(vm.isHalted).toBe(false);
    expect(vm.vars.readGlobal(0x49)).toBe(0);
    expect(vm.vars.readGlobal(0x3c)).toBe(0);
    expect(vm.vars.readGlobal(0x33)).toBe(1);
    expect(vm.vars.readGlobal(0x06)).toBe(2);
    // 13-byte string '@@@@@@@@@@@@@' stored at id 0x16
    const s = vm.strings.get(0x16)!;
    expect(s).toBeDefined();
    expect(s.length).toBe(13);
    for (const b of s) expect(b).toBe(0x40);
    expect(vm.trace.map((e) => e.mnemonic)).toEqual([
      'setVar 0x49 = 0',
      'setVar 0x3c = 0',
      'setVar 0x33 = 1',
      'setVar 0x6 = 2',
      'cursorCommand cursorOff',
      'cursorCommand userputOff',
      'stringOps loadString id=22 len=13',
      'stopObjectCode',
    ]);
  });

  it('loadString is escape-aware: a 0x00 inside a 0xFF escape arg is not the terminator (MI1 #154)', () => {
    const vm = makeVm();
    // loadString id=48 "in \xFF\x07?" then stopObjectCode. The 0xFF 0x07
    // (string-var substitution) carries a 2-byte arg whose 2nd byte is 0x00;
    // a raw scan-to-NUL would stop there, store a 6-byte string, and then run
    // the '?' (0x3F) byte as a phantom drawBox. Escape-aware reading skips the
    // arg, ends at the real NUL, and the stopObjectCode runs.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x27, 0x01, 0x30, // stringOps loadString id=48
        0x69, 0x6e, 0x20, 0xff, 0x07, 0x21, 0x00, 0x3f, 0x00, // "in \xFF\x07?" + NUL
        0x00, // stopObjectCode
      ),
    });
    while (!vm.isHalted && vm.step()) {}
    expect(vm.isHalted).toBe(false);
    // Stored bytes: i,n,space,0xFF,0x07,0x21,0x00,0x3F = 8 (escape + arg kept).
    expect(vm.strings.get(48)!.length).toBe(8);
    expect(vm.trace.map((e) => e.mnemonic)).toContain('stopObjectCode');
  });
});

describe('seed opcodes — cursorCommand state wiring', () => {
  it('cursorOn/cursorOff set vm.cursor.state 1/0 + mirror to VAR_CURSORSTATE', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x01, 0x2c, 0x02, 0x00) });
    vm.step(); // cursorOn
    expect(vm.cursor.state).toBe(1);
    expect(vm.vars.readGlobal(52)).toBe(1); // VAR_CURSORSTATE published
    vm.step(); // cursorOff
    expect(vm.cursor.state).toBe(0);
    expect(vm.vars.readGlobal(52)).toBe(0);
  });

  it('userputOn/userputOff set vm.cursor.userput 1/0 + mirror to VAR_USERPUT', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x03, 0x2c, 0x04, 0x00) });
    vm.step();
    expect(vm.cursor.userput).toBe(1);
    expect(vm.vars.readGlobal(53)).toBe(1); // VAR_USERPUT published
    vm.step();
    expect(vm.cursor.userput).toBe(0);
  });

  it('soft variants (0x05–0x08) increment/decrement the counters', () => {
    const vm = makeVm();
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x2c, 0x05, 0x2c, 0x07, 0x2c, 0x06, 0x2c, 0x08, 0x00),
    });
    vm.step(); // cursorSoftOn  → state 0→1
    expect(vm.cursor.state).toBe(1);
    vm.step(); // userputSoftOn → userput 0→1
    expect(vm.cursor.userput).toBe(1);
    vm.step(); // cursorSoftOff → state 1→0
    expect(vm.cursor.state).toBe(0);
    vm.step(); // userputSoftOff→ userput 1→0
    expect(vm.cursor.userput).toBe(0);
  });

  it('initCharset (subop 0x0D) writes vm.currentCharset', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x0d, 0x03, 0x00) });
    vm.step();
    expect(vm.currentCharset).toBe(3);
  });
});

describe('seed opcodes — actorOps init (SO_DEFAULT)', () => {
  it('init clears a stale forceClip (initActor resets the forced z-clip)', () => {
    // An actor reusing a slot left at alwaysZclip k by an earlier scene must
    // reset to "not forced" on init, or it stays masked behind ZP0k. Room 51
    // inits the Fettucini brothers with no zclip op and they must come to the
    // front; without this they kept forceClip=1 and drew behind the haystack.
    const vm = makeVm();
    vm.actors.get(3).forceClip = 1; // leftover alwaysZclip=1 from a prior scene
    // actorOps 3 { init }: 0x13 actor=3 (byte), subop 0x08 (SO_DEFAULT), 0xFF.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x13, 0x03, 0x08, 0xff, 0x00) });
    vm.step();
    expect(vm.actors.get(3).forceClip).toBe(0);
  });

  it('init clears a stuck ignoreBoxes + resets scale (initActor defaults)', () => {
    // A cutscene that set ignoreBoxes (the credits montage repurposes actors as
    // free-moving puppets) and was then ESC-skipped never runs its own
    // followBoxes; the actor's game-start init is what clears the stuck flag.
    // Left set, it froze perspective scaling across every room (the box rescale
    // bails on ignoreBoxes). initActor resets both to SCUMM's defaults.
    const vm = makeVm();
    const a = vm.actors.get(3);
    a.ignoreBoxes = true;
    a.scale = 100; // stuck small/large from a prior scene
    vm.startScript({ scriptId: 1, bytecode: bytes(0x13, 0x03, 0x08, 0xff, 0x00) });
    vm.step();
    expect(vm.actors.get(3).ignoreBoxes).toBe(false);
    expect(vm.actors.get(3).scale).toBe(0xff);
  });

  it('a later ignoreBoxes/scale subop still wins over the init reset', () => {
    // Room 51's cannon flight actor is `init; ...; ignoreBoxes; scale 255,255`
    // in one actorOps — the init reset must not clobber the explicit ops that
    // follow it in the same instruction.
    const vm = makeVm();
    // actorOps 3 { init(0x08); ignoreBoxes(0x14); scale 200,200 (0x11) }, 0xFF.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x13, 0x03, 0x08, 0x14, 0x11, 0xc8, 0xc8, 0xff, 0x00),
    });
    vm.step();
    expect(vm.actors.get(3).ignoreBoxes).toBe(true);
    expect(vm.actors.get(3).scale).toBe(200);
  });
});

describe('seed opcodes — verbOps state wiring', () => {
  it('subop 0x09 "new" creates an OFF slot (curmode 0)', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7a, 0x05, 0x09, 0xff, 0x00) });
    vm.step();
    const v = vm.verbs.get(5);
    expect(v).toBeDefined();
    // SO_VERB_NEW sets curmode 0 → off; a later SO_VERB_ON makes it visible.
    expect(v!.state).toBe('off');
    expect(v!.name).toBe('');
    expect(v!.x).toBe(0);
  });

  it('setName decodes plain ASCII; FF 01 → \\n; other FF NN stripped', () => {
    const vm = makeVm();
    // verbOps verb=2: setName "Open" + (FF 01 newline, 2-byte) + "Door"
    // + (FF 0E NN NN colour, 4-byte) + "!", terminated by 0x00, then
    // verbOps 0xFF terminator.
    const name = [
      0x4f, 0x70, 0x65, 0x6e,        // "Open"
      0xff, 0x01,                    // FF 01 — newline (2-byte sequence)
      0x44, 0x6f, 0x6f, 0x72,        // "Door"
      0xff, 0x0e, 0x05, 0x05,        // FF 0E 05 05 — colour change (4-byte; avoid 0x00 args)
      0x21,                          // "!"
      0x00,                          // NUL terminator
    ];
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x7a, 0x02, 0x02, ...name, 0xff, 0x00),
    });
    vm.step();
    const v = vm.verbs.get(2);
    expect(v!.name).toBe('Open\nDoor!');
  });

  it('setXY / setColor / setHiColor / setDimColor / setKey / on / off / dim / setCenter mutate the slot', () => {
    const vm = makeVm();
    // verbOps verb=1:
    //   new, setXY(100, 144), setColor(7), setHiColor(15), setDimColor(8), setKey(76), setCenter
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x7a, 0x01,
        0x09,                                  // new
        0x05, 0x64, 0x00, 0x90, 0x00,          // setXY 100, 144
        0x03, 0x07,                            // setColor 7
        0x04, 0x0f,                            // setHiColor 15
        0x10, 0x08,                            // setDimColor 8
        0x12, 0x4c,                            // setKey 76 (L)
        0x13,                                  // setCenter
        0x06,                                  // on (new starts off; flip on)
        0xff,
        0x00,
      ),
    });
    vm.step();
    const v = vm.verbs.get(1)!;
    expect(v.x).toBe(100);
    expect(v.y).toBe(144);
    expect(v.color).toBe(7);
    expect(v.hiColor).toBe(15);
    expect(v.dimColor).toBe(8);
    expect(v.key).toBe(76);
    expect(v.centered).toBe(true);
    expect(v.state).toBe('on');
  });

  it('setDim toggles state to dim; on / off flip back', () => {
    const vm = makeVm();
    // new, dim, off, on (across separate verbOps calls)
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x7a, 0x03, 0x09, 0xff,
        0x7a, 0x03, 0x11, 0xff,
        0x7a, 0x03, 0x07, 0xff,
        0x7a, 0x03, 0x06, 0xff,
        0x00,
      ),
    });
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('off'); // new → curmode 0 (off)
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('dim');
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('off');
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('on');
  });

  it('setImageInRoom (0x16) binds {obj, room} to the verb; setName clears it', () => {
    const vm = makeVm();
    // verbOps verb=200: setImageInRoom(obj=1031, room=99) — subop 0x16,
    // obj direct word (1031 = 0x0407), room direct byte (99 = 0x63) —
    // then setName "Hi" on the same verb (subop 0x02), one slot.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x7a, 0xc8, 0x16, 0x07, 0x04, 0x63, 0xff,
        0x7a, 0xc8, 0x02, 0x48, 0x69, 0x00, 0xff,
        0x00,
      ),
    });
    vm.step(); // setImageInRoom
    expect(vm.verbs.get(200)!.image).toEqual({ obj: 1031, room: 99 });
    vm.step(); // setName clears the image binding (text verb)
    expect(vm.verbs.get(200)!.image).toBeNull();
    expect(vm.verbs.get(200)!.name).toBe('Hi');
  });

  it('setImage (0x01) binds the object in the current room', () => {
    const vm = makeVm();
    vm.currentRoom = 7;
    // verbOps verb=200: setImage(obj=42) — subop 0x01, obj direct word.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x7a, 0xc8, 0x01, 0x2a, 0x00, 0xff, 0x00),
    });
    vm.step();
    expect(vm.verbs.get(200)!.image).toEqual({ obj: 42, room: 7 });
  });

  it('findObject (0xf5) returns 0 when no room loaded, writes dest, advances PC by 7', () => {
    const vm = makeVm();
    // 0xf5 (bits 7+6 set) — x is var-ref to g20 (=10), y is var-ref to g21 (=50)
    vm.vars.writeGlobal(20, 10);
    vm.vars.writeGlobal(21, 50);
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0xf5,
        0x00, 0x40,          // dest = local 0
        0x14, 0x00,          // x = var-ref g20
        0x15, 0x00,          // y = var-ref g21
        0x00,                // stopObjectCode
      ),
    });
    const slot = vm.slots.find((s) => s.status === 'running')!;
    vm.step();
    expect(slot.locals[0]).toBe(0); // no room → 0
    expect(slot.pc).toBe(7);
  });

  it('findObject reads loadedRoom.objects via pickObject + drawQueue order', () => {
    const vm = makeVm();
    // Stub a single-object room: object id 42, CDHD bbox at (0,0)..(80,80) px.
    vm.loadedRoom = {
      id: 1,
      width: 320,
      height: 200,
      numObjects: 1,
      palette: new Uint8Array(768),
      transparentIndex: null,
      indexed: new Uint8Array(64000),
      stripMethods: [],
      zPlanes: [],
      entryScript: null,
      exitScript: null,
      localScripts: new Map(),
      objects: new Map([
        [
          42,
          {
            objId: 42,
            cdhd: {
              objId: 42,
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              flags: 0,
              parent: 0,
              walkX: 0,
              walkY: 0,
              actorDir: 0,
            },
            imhd: { objId: 42, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
            images: new Map(),
            name: 'thing',
            verbs: new Map(),
          },
        ],
      ]),
      walkBoxes: [],
      boxMatrix: [], scaleSlots: [],
    };
    // findObject(50, 50) — both immediate (opcode 0x35, no mode bits set).
    // Immediates are var-or-BYTE (opcode-reference.md), not words.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x35,
        0x00, 0x40,          // dest = local 0
        0x32,                // x = 50 imm
        0x32,                // y = 50 imm
        0x00,                // stopObjectCode
      ),
    });
    const slot = vm.slots.find((s) => s.status === 'running')!;
    vm.step();
    expect(slot.locals[0]).toBe(42);
  });

  it('delete removes the verb slot entirely', () => {
    const vm = makeVm();
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x7a, 0x07, 0x09, 0xff, 0x7a, 0x07, 0x08, 0xff, 0x00),
    });
    vm.step(); // verbOps 7 new
    expect(vm.verbs.has(7)).toBe(true);
    vm.step(); // verbOps 7 delete
    expect(vm.verbs.has(7)).toBe(false);
  });
});

describe('room-entry opcodes', () => {
  it('actorSetClass sets, clears, and resets object class bits', () => {
    const vm = makeVm();
    // Three setClass ops on obj 17 + stopObjectCode, stepped one opcode
    // at a time:
    //   setClass(17, [0xA0])  — 0x80|32 → SET class 32 → bit 31
    //   setClass(17, [0x20])  — no 0x80 → CLEAR class 32
    //   setClass(17, [0x00])  — class 0 → reset all
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x5d, 0x11, 0x00, 0x01, 0xa0, 0x00, 0xff,
        0x5d, 0x11, 0x00, 0x01, 0x20, 0x00, 0xff,
        0x5d, 0x11, 0x00, 0x01, 0x00, 0x00, 0xff,
        0xa0,
      ),
    });
    vm.step();
    expect(vm.objectClasses.get(17)).toBe((1 << 31) >>> 0);
    vm.step();
    expect(vm.objectClasses.get(17)).toBe(0);
    vm.step();
    expect(vm.objectClasses.get(17)).toBe(0);
  });

  it('getObjectState / getObjectOwner read back into a result var', () => {
    const vm = makeVm();
    vm.objectStates.set(42, 3);
    vm.objectOwners.set(42, 5);
    // getObjectState g0 = state(42); getObjectOwner g1 = owner(42).
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x0f, 0x00, 0x00, 0x2a, 0x00, 0x10, 0x01, 0x00, 0x2a, 0x00),
    });
    vm.step();
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(3);
    expect(vm.vars.readGlobal(1)).toBe(5);
  });

  it('getObjectOwner defaults a room object to OF_OWNER_ROOM (15), absent → 0', () => {
    const vm = makeVm();
    // A minimal loaded room containing object 42 (no explicit owner entry).
    vm.loadedRoom = {
      id: 1, width: 0, height: 0, numObjects: 1, palette: new Uint8Array(768),
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[42, { objId: 42 }]]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    } as never;
    // Present in the room, no explicit owner → owned by the room (15). This is
    // what MI1's sentence script #2 gates the walk-to-object approach on.
    expect(vm.getObjectOwner(42)).toBe(15);
    // Not in the room → nobody (0).
    expect(vm.getObjectOwner(99)).toBe(0);
    // An explicit owner (pickup / setOwnerOf) always wins, even for a room obj.
    vm.objectOwners.set(42, 3);
    expect(vm.getObjectOwner(42)).toBe(3);
  });

  it('getActorX reads the actor position into a result var (p16 actor)', () => {
    const vm = makeVm();
    const a = vm.actors.get(5);
    a.room = 1;
    a.x = 120;
    a.y = 80;
    // getActorX g0 = x(actor 5) — 0x43, dest word, actor word.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x43, 0x00, 0x00, 0x05, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(120);
  });

  it('getActorFacing returns the old-direction integer (0=W 1=E 2=S 3=N)', () => {
    const vm = makeVm();
    const a = vm.actors.get(5);
    a.room = 1;
    a.facing = 'E';
    // getActorFacing g0 = facing(actor 5) — 0x63, dest word, actor p8.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x63, 0x00, 0x00, 0x05) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(1);
    expect(vm.haltInfo).toBeNull();
  });

  it('getActorCostume reads the actor costume id into a result var', () => {
    const vm = makeVm();
    const a = vm.actors.get(5);
    a.room = 1;
    a.costume = 7;
    // getActorCostume g0 = costume(actor 5) — 0x71, dest word, actor immediate
    // byte (bit 0x80 clear; the 0xf1 variant reads the actor from a var-ref).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x71, 0x00, 0x00, 0x05) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(7);
    expect(vm.haltInfo).toBeNull();
  });

  it('roomOps roomIntensity scales the live palette from the base CLUT', () => {
    const vm = makeVm();
    const palette = new Uint8Array(768);
    // Live palette starts blacked out (as setPalColor would leave it); the
    // base CLUT holds the real colours roomIntensity restores from.
    const base = new Uint8Array(768);
    base[0] = 200; base[1] = 100; base[2] = 50; // entry 0
    base[3] = 80; base[4] = 40; base[5] = 20; // entry 1
    (vm as unknown as { loadedRoom: object }).loadedRoom = {
      id: 63, width: 320, height: 200, numObjects: 0, palette,
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null,
      localScripts: new Map(), objects: new Map(), walkBoxes: [],
      boxMatrix: [], scaleSlots: [],
    };
    vm.basePalette = base;
    // roomOps roomIntensity scale=255 range=0..1 — restore to full. Two steps:
    // the roomOps opcode, then the stopObjectCode that retires the slot.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x33, 0x08, 255, 0, 1, 0xa0) });
    vm.step();
    vm.step();
    expect([...palette.slice(0, 6)]).toEqual([200, 100, 50, 80, 40, 20]);
    // scale=128 ≈ half intensity (floor(v*128/255)).
    vm.startScript({ scriptId: 2, bytecode: bytes(0x33, 0x08, 128, 0, 0, 0xa0) });
    vm.step();
    vm.step();
    expect([...palette.slice(0, 3)]).toEqual([100, 50, 25]);
    expect(vm.haltInfo).toBeNull();
  });

  it('roomOps setRGBRoomIntensity scales per channel from base, clamping >255', () => {
    const vm = makeVm();
    const palette = new Uint8Array(768);
    const base = new Uint8Array(768);
    base[0] = 200; base[1] = 100; base[2] = 50; // entry 0
    base[3] = 80; base[4] = 40; base[5] = 20; // entry 1
    (vm as unknown as { loadedRoom: object }).loadedRoom = {
      id: 29, width: 320, height: 200, numObjects: 0, palette,
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null,
      localScripts: new Map(), objects: new Map(), walkBoxes: [],
      boxMatrix: [], scaleSlots: [],
    };
    vm.basePalette = base;
    // setRGBRoomIntensity (50,50,500) range 0..1: dim R/G to ~20%, boost B ~2x.
    // sub2=0x00 → lo,hi direct bytes. 500 = 0x01F4.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x33, 0x0b, 0x32, 0x00, 0x32, 0x00, 0xf4, 0x01, 0x00, 0x00, 0x01, 0xa0),
    });
    vm.step();
    vm.step();
    // entry0 (200,100,50): R=200*50/255=39, G=100*50/255=19, B=50*500/255=98
    // entry1 (80,40,20):   R=15, G=7, B=20*500/255=39
    expect([...palette.slice(0, 6)]).toEqual([39, 19, 98, 15, 7, 39]);

    // (900,900,900) on entry 0 — rescales from BASE; R/G overflow → clamp 255.
    vm.startScript({
      scriptId: 2,
      bytecode: bytes(0x33, 0x0b, 0x84, 0x03, 0x84, 0x03, 0x84, 0x03, 0x00, 0x00, 0x00, 0xa0),
    });
    vm.step();
    vm.step();
    // entry0: R=200*900/255=705→255, G=100*900/255=352→255, B=50*900/255=176
    expect([...palette.slice(0, 3)]).toEqual([255, 255, 176]);
    expect(vm.haltInfo).toBeNull();
  });

  it('roomOps shakeOn/shakeOff toggles vm.shakeEnabled', () => {
    const vm = makeVm();
    expect(vm.shakeEnabled).toBe(false);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x33, 0x05, 0x33, 0x06, 0xa0) });
    vm.step(); // shakeOn
    expect(vm.shakeEnabled).toBe(true);
    vm.step(); // shakeOff
    expect(vm.shakeEnabled).toBe(false);
    expect(vm.haltInfo).toBeNull();
  });

  it('unmodelled section-B opcodes halt loudly when hit (no MI1 use)', () => {
    const cases: Array<[string, number[], RegExp]> = [
      ['roomOps saveLoad', [0x33, 0x09, 0x00, 0x00], /saveLoad .* not implemented/],
      ['roomOps saveString', [0x33, 0x0d, 0x00, 0x00], /saveString .* not implemented/],
      ['roomOps loadString', [0x33, 0x0e, 0x00, 0x00], /loadString .* not implemented/],
      ['matrixOp setBoxScale', [0x30, 0x02, 0x01, 0x02], /setBoxScale.* not implemented/],
      // A well-formed vararg list ([42]) — the shape decodes, the exec halts.
      ['soundKludge', [0x4c, 0x01, 0x2a, 0x00, 0xff], /soundKludge .* not implemented/],
    ];
    for (const [label, code, re] of cases) {
      const vm = makeVm();
      vm.startScript({ scriptId: 1, bytecode: bytes(...code) });
      vm.step();
      expect(vm.haltInfo, label).not.toBeNull();
      expect(vm.haltInfo!.reason, label).toMatch(re);
    }
  });

  // isSoundRunning g0 = sound #9; each case on a fresh VM (single step).
  const pollSound9 = (vm: Vm): number => {
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7c, 0x00, 0x00, 0x09) });
    vm.step();
    return vm.vars.readGlobal(0);
  };

  it('isSoundRunning reads 0 for a sound that is not playing', () => {
    expect(pollSound9(makeVm())).toBe(0);
  });

  it('isSoundRunning reads 1 while a sound plays and 0 once it drains', () => {
    const playing = makeVm();
    playing.audio.startSound(9, { durationJiffies: 2, looping: false });
    expect(pollSound9(playing)).toBe(1);

    const drained = makeVm();
    drained.audio.startSound(9, { durationJiffies: 2, looping: false });
    drained.audio.advance(2);
    expect(pollSound9(drained)).toBe(0);
  });

  it('startSound resolves a duration via the backend and records VAR_LAST_SOUND (23)', () => {
    // #9 resolves to a one-shot CD trigger for track 6; its duration comes
    // from the up-front cdTrackDurations map (read from the FLAC headers).
    const trigger = new Uint8Array(24);
    trigger[0] = 0x18;
    trigger[16] = 6;
    trigger[17] = 0x01;
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: SEED_OPCODES,
      resolveSound: (id) => (id === 9 ? trigger : null),
      cdTrackDurations: new Map([[6, 120]]),
    });
    // startSound #9 (0x1c, p8=9).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x1c, 0x09) });
    vm.step();
    expect(vm.audio.isRunning(9)).toBe(true);
    expect(vm.vars.readGlobal(23)).toBe(9);
  });

  it('stopSound clears the backend entry', () => {
    const vm = makeVm();
    vm.audio.startSound(9, { durationJiffies: 100, looping: false });
    // stopSound #9 (0x3c, p8=9).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x3c, 0x09) });
    vm.step();
    expect(vm.audio.isRunning(9)).toBe(false);
  });

  it('stopScript kills slots running the given script id', () => {
    const vm = makeVm();
    const victim = vm.startScript({ scriptId: 99, bytecode: bytes(0x80, 0x00) });
    victim.yield_();
    // stopScript #99.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x62, 0x63) });
    vm.step();
    expect(victim.status).toBe('dead');
  });

  it('stopScript 0 stops the CURRENT script (o5_stopScript: script 0 -> stopObjectCode)', () => {
    const vm = makeVm();
    // stopScript 0 ; setVar g0 = 1. If 0 were a no-op the slot would run on
    // and set g0; faithfully it self-terminates and the setVar never runs.
    // (This is the guard #4 uses to ignore a click on the sentence line #100.)
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x62, 0x00, 0x1a, 0x00, 0x00, 0x01, 0x00) });
    vm.step();
    expect(slot.status).toBe('dead');
    expect(vm.vars.readGlobal(0)).toBe(0);
  });
});

describe('inventory subsystem', () => {
  it('getInventoryCount (0x31) counts objects owned by the actor', () => {
    const vm = makeVm();
    vm.objectOwners.set(10, 7);
    vm.objectOwners.set(11, 7);
    vm.objectOwners.set(12, 3); // owned by someone else
    // getInventoryCount g0 = count(actor 7) — dest g0, actor 7 direct.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x31, 0x00, 0x00, 0x07) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(2);
  });

  it('getInventoryCount (0xb1) reads the actor from a var', () => {
    const vm = makeVm();
    vm.objectOwners.set(10, 7);
    vm.vars.writeGlobal(50, 7);
    // dest g0, actor = var-ref g50.
    vm.startScript({ scriptId: 1, bytecode: bytes(0xb1, 0x00, 0x00, 0x32, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(1);
  });

  it('getInventoryCount returns 0 for an actor that owns nothing', () => {
    const vm = makeVm();
    vm.objectOwners.set(10, 7);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x31, 0x00, 0x00, 0x09) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0);
  });

  it('findInventory (0x3d) returns the index-th owned object in pickup order', () => {
    const vm = makeVm();
    vm.objectOwners.set(10, 7);
    vm.objectOwners.set(11, 7);
    // findInventory g0 = owner 7, index 2 → 11 (second inserted).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x3d, 0x00, 0x00, 0x07, 0x02) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(11);
  });

  it('findInventory returns 0 when the index is out of range', () => {
    const vm = makeVm();
    vm.objectOwners.set(10, 7);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x3d, 0x00, 0x00, 0x07, 0x05) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0);
  });

  it('pickupObject (0x25) gives the object to ego, sets state 1, draws the taken patch', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 4); // VAR_EGO = actor 4
    // pickupObject object=99, room=0 (current).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x25, 0x63, 0x00, 0x00) });
    vm.step();
    expect(vm.objectOwners.get(99)).toBe(4);
    expect(vm.objectStates.get(99)).toBe(1);
    // SCUMM marks the object for redraw (putState 1 + markObjectRectAsDirty):
    // MI1 bakes pickable items into the room background, and the state-1 image
    // is the patch that erases the baked-in item once taken — so after pickup
    // the object must be DRAWN, not dropped, or the item lingers on screen.
    expect(vm.objectDrawQueue.has(99)).toBe(true);
    expect(vm.inventoryCount(4)).toBe(1);
    // SCUMM putClass(obj, kObjectClassUntouchable, 1): a taken object's room
    // hit-box must stop responding. Class 32 → bit 31.
    expect((vm.objectClasses.get(99) ?? 0) & (1 << 31)).not.toBe(0);
  });

  it('pickupObject makes the room hit-test (findObject) skip the taken object', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 4); // VAR_EGO
    vm.loadedRoom = {
      id: 33, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([
        [99, {
          objId: 99,
          // CDHD box in 8-px units: [40,56) x [40,56) → contains (50,50).
          cdhd: { objId: 99, x: 5, y: 5, width: 2, height: 2, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
          imhd: { objId: 99, numImages: 1, flags: 0, x: 40, y: 40, width: 16, height: 16 },
          images: new Map(), name: 'the meat', verbs: new Map(),
        }],
      ]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    };
    // Same hit-test predicate findObject uses (Untouchable = class 32 / bit 31).
    const at = (x: number, y: number) =>
      pickObject({
        objects: vm.loadedRoom!.objects,
        x, y,
        isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
      });
    expect(at(50, 50)).toBe(99); // interactable before pickup

    // Pick it up, then the same spot must hit nothing (now Untouchable).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x25, 0x63, 0x00, 0x00) });
    vm.step();
    expect(at(50, 50)).toBe(null); // hit area gone after pickup
  });

  it('pickupObject snapshots the object name so it survives leaving the room', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 4); // VAR_EGO
    vm.loadedRoom = {
      id: 33, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([
        [99, {
          objId: 99,
          cdhd: { objId: 99, x: 0, y: 0, width: 0, height: 0, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
          imhd: { objId: 99, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
          images: new Map(), name: 'the rubber chicken',
          verbs: new Map(),
        }],
      ]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    };
    vm.startScript({ scriptId: 1, bytecode: bytes(0x25, 0x63, 0x00, 0x00) });
    vm.step();
    // Leave the room: the live object table no longer knows the item.
    vm.loadedRoom = null;
    expect(vm.objectName(99)).toBe('the rubber chicken');
  });

  it('setObjectName (0x54) renames an object in place, consuming the trailing string', () => {
    const vm = makeVm();
    // setObjectName obj=99 name="500 pieces"; stop. The name is a
    // NUL-terminated string that must be consumed, or the byte after it
    // decodes as a bogus opcode (the "Unknown opcode 0x54" halt).
    const name = [...'500 pieces'].map((c) => c.charCodeAt(0));
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x54, 0x63, 0x00, ...name, 0x00, 0x00),
    });
    const slot = vm.slots.find((s) => s.status === 'running')!;
    vm.step(); // setObjectName — must land the PC on the 0x00 stop, not mid-string
    vm.step(); // the 0x00 stop
    expect(vm.haltInfo).toBeNull(); // no "Unknown opcode 0x54" desync
    expect(slot.status).toBe('dead');
    expect(vm.objectName(99)).toBe('500 pieces');
  });

  it('setObjectName overrides the room OBNA and the pickup snapshot', () => {
    const vm = makeVm();
    vm.inventoryNames.set(99, 'the rubber chicken');
    const name = [...'a chicken with a pulley'].map((c) => c.charCodeAt(0));
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x54, 0x63, 0x00, ...name, 0x00, 0x00),
    });
    vm.step();
    expect(vm.objectName(99)).toBe('a chicken with a pulley');
  });

  it('actorFromPos (0xd5) reads both coords as vars, returns the actor under them, advances PC by 7', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(20, 100);
    vm.vars.writeGlobal(21, 50);
    // An actor drawn over (100,50) in the current room.
    vm.currentRoom = 7;
    const actor = vm.actors.get(3);
    actor.room = 7;
    actor.visible = true;
    actor.drawBounds = { left: 90, top: 40, right: 110, bottom: 60 };
    // 0xd5: dest local0, x = var g20, y = var g21 (MI1 #23's form).
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0xd5, 0x00, 0x40, 0x14, 0x00, 0x15, 0x00, 0x00),
    });
    const slot = vm.slots.find((s) => s.status === 'running')!;
    vm.step();
    expect(slot.locals[0]).toBe(3);
    expect(slot.pc).toBe(7);
  });

  it('getVerbEntryPoint (0x0b) → 1 when the object has the verb, 0 otherwise', () => {
    const vm = makeVm();
    vm.loadedRoom = {
      id: 1, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([
        [42, {
          objId: 42,
          cdhd: { objId: 42, x: 0, y: 0, width: 0, height: 0, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
          imhd: { objId: 42, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
          images: new Map(), name: 'thing',
          verbs: new Map([[8, new Uint8Array([0x00])]]),
        }],
      ]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    };
    // getVerbEntryPoint g0 = (obj 42, verb 8) → 1; g1 = (obj 42, verb 9) → 0.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x0b, 0x00, 0x00, 0x2a, 0x00, 0x08, 0x00,
        0x0b, 0x01, 0x00, 0x2a, 0x00, 0x09, 0x00,
        0x00,
      ),
    });
    vm.step();
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(1);
    expect(vm.vars.readGlobal(1)).toBe(0);
  });

  it('getVerbEntryPoint → 1 for ANY verb when the object has the 0xFF default verb (MI1 room-78 exit)', () => {
    // SCUMM's getVerbEntrypoint matches the exact verb OR verb 0xFF (the
    // object's default action). MI1's "uscita" exits carry verb 0xFF
    // (loadRoomWithEgo); the player clicks with the walk-to verb 11, and
    // sentence script #2's `getVerbEntryPoint(exit, 11)` must read truthy
    // (via the 0xFF fallback) to take the run-the-verb branch → the exit
    // opens. Without the fallback it read 0 → walk-only → "can't leave".
    const vm = makeVm();
    vm.loadedRoom = {
      id: 78, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([
        [857, {
          objId: 857,
          cdhd: { objId: 857, x: 0, y: 0, width: 0, height: 0, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
          imhd: { objId: 857, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
          images: new Map(), name: "l'uscita",
          // verbs 90 + 0xFF (default) — NO verb 11.
          verbs: new Map([[90, new Uint8Array([0x00])], [0xff, new Uint8Array([0x00])]]),
        }],
      ]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    } as never;
    // getVerbEntryPoint g0 = (obj 857, verb 11): exit lacks 11 but has 0xFF → 1.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0b, 0x00, 0x00, 0x59, 0x03, 0x0b, 0x00, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(1);
  });

  it('actorFromPos (0x15) reads direct coords as words (p16), returns 0 when no actor is hit, advances PC by 7', () => {
    const vm = makeVm();
    // 0x15: dest local0, x = 50 (word), y = 60 (word). Per the opcode
    // reference the coords are p16 — byte reads would misalign PC to 5.
    // No actors placed, so the hit-test returns 0.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x15, 0x00, 0x40, 0x32, 0x00, 0x3c, 0x00, 0x00),
    });
    const slot = vm.slots.find((s) => s.status === 'running')!;
    vm.step();
    expect(slot.locals[0]).toBe(0);
    expect(slot.pc).toBe(7);
  });
});

describe('getDist + ifClassOfIs', () => {
  function roomWithObj(objId: number, x8: number, y8: number, walkX = 0, walkY = 0) {
    return {
      id: 1, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[objId, {
        objId,
        cdhd: { objId, x: x8, y: y8, width: 0, height: 0, flags: 0, parent: 0, walkX, walkY, actorDir: 0 },
        imhd: { objId, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
        images: new Map(), name: 'thing', verbs: new Map(),
      }]]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    };
  }

  it('getDist (0x34) → Chebyshev distance to an object WALK-TO point (not its image)', () => {
    const vm = makeVm();
    // Image at (80,80)px but walk-to at (40,40). getDist must measure to the
    // walk-to point — the spot walkActorToObject sends the ego — so an actor
    // that walked up to the object reads as close, not "too far" (the room-33
    // SCUMM Bar door bug). Image pos here would give max(70,60)=70.
    vm.loadedRoom = roomWithObj(50, 10, 10, 40, 40) as never;
    const a = vm.actors.get(1);
    a.x = 10; a.y = 20;
    // getDist g0 = dist(actor (10,20), walk-to (40,40)) → max(30,20) = 30.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x34, 0x00, 0x00, 0x01, 0x00, 0x32, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(30);
  });

  it('getDist → 0xFF when an id cannot be resolved', () => {
    const vm = makeVm();
    // No room loaded → object 50 unresolvable → 0xFF.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x34, 0x00, 0x00, 0x01, 0x00, 0x32, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0xff);
  });

  it('getDist → 0 for a HELD inventory item (holder position, not "far")', () => {
    const vm = makeVm();
    // Obj 50 is in ego's (actor 1) inventory — owner = ego, NOT a placed room
    // object. SCUMM's getObjectOrActorXY resolves a held item to its holder's
    // position, so getDist(ego, item) = dist(ego, ego) = 0 → reachable, and #2's
    // proximity gate lets the verb run. Regression for the "Apri" + meat bug:
    // before the WIO_INVENTORY case the item resolved as a missing room object
    // → 0xFF, so every verb on a held item aborted with "Non riesco ad arrivarci".
    vm.currentRoom = 5;
    const a = vm.actors.get(1);
    a.room = 5; a.x = 100; a.y = 80;
    vm.objectOwners.set(50, 1);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x34, 0x00, 0x00, 0x01, 0x00, 0x32, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0);
  });

  it('getDist → 0xFF for an item held by an actor in another room', () => {
    const vm = makeVm();
    // A held item whose holder isn't in the current room has no resolvable
    // position (getObjectOrActorXY returns -1) → 0xFF. Matches SCUMM.
    vm.currentRoom = 5;
    const a = vm.actors.get(1);
    a.room = 9; a.x = 100; a.y = 80; // holder elsewhere
    vm.objectOwners.set(50, 1);
    vm.startScript({ scriptId: 1, bytecode: bytes(0x34, 0x00, 0x00, 0x01, 0x00, 0x32, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0xff);
  });

  it('ifClassOfIs (0x1d) continues when the object is in the class', () => {
    const vm = makeVm();
    vm.objectClasses.set(17, 1 << 15); // class 16 set (bit 15)
    // ifClassOfIs(obj 17, [class 16 must-be-in = 0x90]) skip+5 ; setVar g1=99 ; stop
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x1d, 0x11, 0x00, 0x01, 0x90, 0x00, 0xff, 0x05, 0x00,
        0x1a, 0x01, 0x00, 0x63, 0x00,
        0x00,
      ),
    });
    vm.step(); // ifClassOfIs → condition true → no jump
    vm.step(); // setVar runs
    expect(vm.vars.readGlobal(1)).toBe(99);
  });

  it('ifClassOfIs jumps (skips the body) when the object lacks the class', () => {
    const vm = makeVm();
    // obj 17 has no classes → condition false → jump over the setVar.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x1d, 0x11, 0x00, 0x01, 0x90, 0x00, 0xff, 0x05, 0x00,
        0x1a, 0x01, 0x00, 0x63, 0x00,
        0x00,
      ),
    });
    vm.step(); // ifClassOfIs → false → jump +5 past setVar
    vm.step(); // lands on stopObjectCode
    expect(vm.vars.readGlobal(1)).toBe(0);
  });
});

describe('getActorWalkBox (0x7B)', () => {
  function box(id: number, x0: number, y0: number, x1: number, y1: number, mask = 1) {
    return { id, ulx: x0, uly: y0, urx: x1, ury: y0, lrx: x1, lry: y1, llx: x0, lly: y1, mask, flags: 0 };
  }
  function roomWithBoxes(boxes: unknown[]) {
    return {
      id: 29, width: 320, height: 144, numObjects: 0,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(), objects: new Map(),
      walkBoxes: boxes, boxMatrix: [], scaleSlots: [],
    } as never;
  }

  it('returns the id of the box the actor stands in (not the old 0 stub)', () => {
    // Regression: the stub returned 0, so MI1 room 29's reveal script #200
    // looped `while (getActorWalkBox(ego) < 5)` forever and never cleared the
    // black entry cover (obj 383) — the voodoo-lady room's black rectangle.
    const vm = makeVm();
    vm.loadedRoom = roomWithBoxes([box(0, -32000, -32000, -32000, -32000), box(6, 256, 112, 391, 130)]);
    const a = vm.actors.get(1);
    a.x = 346; a.y = 123; // inside box 6
    // getActorWalkBox g5 = box(actor 1): 0x7B dest g5 (0x0005), actor byte 1, stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7b, 0x05, 0x00, 0x01, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(5)).toBe(6);
  });

  it('returns 0 when no room/boxes are loaded', () => {
    const vm = makeVm();
    vm.actors.get(1).x = 100;
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7b, 0x05, 0x00, 0x01, 0x00) });
    vm.step();
    expect(vm.vars.readGlobal(5)).toBe(0);
  });
});

describe('actor placement + room-transition opcodes (boot→lookout fixes)', () => {
  it('putActorInRoom (0x2D) sets the actor room, distinct from walkActorToActor (0x0D)', () => {
    const vm = makeVm();
    vm.actors.get(3).room = 1;
    // 0x2D putActorInRoom actor=3 room=38, then stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2d, 0x03, 0x26, 0xa0) });
    vm.step();
    expect(vm.actors.get(3).room).toBe(38);
    expect(vm.currentRoom).toBe(0); // assigning a room does not load it
  });

  it('walkActorToActor (0x0D) does NOT change the actor room (it is a different op)', () => {
    const vm = makeVm();
    const a = vm.actors.get(1);
    a.room = 5;
    const b = vm.actors.get(2);
    b.room = 5;
    b.x = 40;
    b.y = 50;
    // 0x0D walkActorToActor walker=1 walkee=2 dist=4 — 3 operands (vs
    // putActorInRoom's 2), then stop. Room must stay 5.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0d, 0x01, 0x02, 0x04, 0xa0) });
    vm.step();
    expect(vm.actors.get(1).room).toBe(5);
    expect(vm.slots[0]!.pc).toBe(4); // consumed opcode + 3 operand bytes
  });

  it('putActor (0x01) keeps the actor existing room, not currentRoom', () => {
    const vm = makeVm();
    vm.actors.get(3).room = 38; // e.g. just placed by putActorInRoom
    // 0x01 putActor actor=3 x=10 y=20, then stop.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x01, 0x03, 0x0a, 0x00, 0x14, 0x00, 0xa0),
    });
    vm.step();
    expect(vm.actors.get(3).room).toBe(38); // kept, not clobbered to 0
    expect(vm.actors.get(3).x).toBe(10);
    expect(vm.actors.get(3).y).toBe(20);
  });

  it('putActorAtObject (0x0E) snaps the actor onto the object walk-to point, keeps its room', () => {
    const vm = makeVm();
    const a = vm.actors.get(3);
    a.room = 35; a.x = 0; a.y = 0;
    // Object 50: image at (10,10)px, walk-to at (88,120). putActorAtObject
    // must land the actor on the WALK-TO point (88,120), not the image.
    vm.loadedRoom = {
      id: 35, width: 320, height: 200, numObjects: 1,
      palette: new Uint8Array(768), transparentIndex: null,
      indexed: new Uint8Array(0), stripMethods: [], zPlanes: [],
      entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[50, {
        objId: 50,
        cdhd: { objId: 50, x: 10, y: 10, width: 0, height: 0, flags: 0, parent: 0, walkX: 88, walkY: 120, actorDir: 0 },
        imhd: { objId: 50, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
        images: new Map(), name: 'thing', verbs: new Map(),
      }]]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    } as never;
    // 0x0E putActorAtObject actor=3 obj=50 (byte actor, word obj), then stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0e, 0x03, 0x32, 0x00, 0xa0) });
    vm.step();
    expect(vm.actors.get(3).x).toBe(88);
    expect(vm.actors.get(3).y).toBe(120);
    expect(vm.actors.get(3).room).toBe(35); // kept, not clobbered
    expect(vm.isHalted).toBe(false);
  });

  it('putActorAtObject falls back to (240,120) when the object is not in the room', () => {
    const vm = makeVm();
    const a = vm.actors.get(3);
    a.room = 35;
    // No room loaded → object 50 unresolvable → SCUMM fallback (240,120).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x0e, 0x03, 0x32, 0x00, 0xa0) });
    vm.step();
    expect(vm.actors.get(3).x).toBe(240);
    expect(vm.actors.get(3).y).toBe(120);
    expect(vm.isHalted).toBe(false);
  });

  it('getActorMoving (0x56) writes 1 while walking, 0 at rest — no halt', () => {
    const vm = makeVm();
    const a = vm.actors.get(3);
    // 0x56 getActorMoving dest=g100 (var ref 0x0064 LE) actor=3, then stop.
    a.isMoving = true;
    const s1 = vm.startScript({ scriptId: 1, bytecode: bytes(0x56, 0x64, 0x00, 0x03, 0xa0) });
    while (s1.status === 'running') vm.step();
    expect(vm.vars.readGlobal(100)).toBe(1);

    a.isMoving = false;
    const s2 = vm.startScript({ scriptId: 2, bytecode: bytes(0x56, 0x64, 0x00, 0x03, 0xa0) });
    while (s2.status === 'running') vm.step();
    expect(vm.vars.readGlobal(100)).toBe(0);
    expect(vm.haltInfo).toBeNull();
  });

  it('actorFollowCamera (0x52) loads the followed actor room when it differs', () => {
    const vm = makeVm();
    vm.actors.get(3).room = 38;
    // 0x52 actorFollowCamera actor=3, then stop. currentRoom (0) != 38.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x52, 0x03, 0xa0) });
    vm.step();
    expect(vm.currentRoom).toBe(38); // entered the actor's room
  });

  it('animateActor 0xD1 reads both actor and anim as vars', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(10, 3); // actor id
    // anim 251 = set-direction-immediately pseudo-anim (248-251), dir 3 →
    // facing N. A pseudo-anim just snaps facing, observable without a loaded
    // costume, so it confirms both operands were dereferenced as vars.
    vm.vars.writeGlobal(11, 251);
    vm.actors.get(3).room = 1;
    vm.actors.get(3).facing = 'S';
    // 0xD1 animateActor actor=var10 anim=var11, then stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0xd1, 0x0a, 0x00, 0x0b, 0x00, 0xa0) });
    vm.step();
    expect(vm.actors.get(3).facing).toBe('N');
  });

  it('animateActor maps its operand to a chore record (anim*4 + dir)', () => {
    const vm = makeVm();
    // Stub costume: an all-zero anim table is enough — startAnim records
    // the requested record index even with no real anim data.
    const stub = {
      header: {
        numAnim: 32, format: 0x58, paletteSize: 16, palette: new Uint8Array(16),
        animCmdOffset: 0, limbOffsets: new Array(16).fill(0), animOffsets: new Array(32).fill(0),
        mirrorFlag: false,
      },
      payload: new Uint8Array(0),
    };
    vm.getCostume = (() => stub) as unknown as typeof vm.getCostume;
    const a = vm.actors.get(3);
    a.room = 1; a.costume = 1; a.facing = 'S'; // dir S = 2
    // 0x11 animateActor actor=3 anim=4 (both immediate). The Mêlée clouds'
    // value: it must resolve to record 4*4 + 2 = 18, NOT the raw 4 (a
    // no-draw command).
    vm.startScript({ scriptId: 1, bytecode: bytes(0x11, 0x03, 0x04, 0xa0) });
    vm.step();
    expect(a.anim.animId).toBe(18);
  });
});

describe('intro-cutscene opcodes', () => {
  it('setOwnerOf sets the object owner (round-trips via getObjectOwner)', () => {
    const vm = makeVm();
    // setOwnerOf obj=42 owner=5; getObjectOwner g0 = owner(42); stop.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x29, 0x2a, 0x00, 0x05, 0x10, 0x00, 0x00, 0x2a, 0x00, 0xa0),
    });
    vm.step();
    vm.step();
    expect(vm.objectOwners.get(42)).toBe(5);
    expect(vm.vars.readGlobal(0)).toBe(5);
  });

  it('setOwnerOf refreshes the inventory panel, keeping the page (arg 0)', () => {
    // The panel re-lays only when the inventory script runs; a consumed item
    // (setOwnerOf away from ego) must not linger in the visible slots. The
    // script is run with arg 0 — keep the current page — unlike pickupObject,
    // which passes 1 (snap to the end so the new item shows).
    const invRuns: number[] = [];
    const vm = new Vm({
      numVariables: 800,
      numBitVariables: 2048,
      handlers: new Map([
        ...SEED_OPCODES,
        [0x01, (v: Vm, s: { locals: Int32Array; kill(): void }) => { invRuns.push(s.locals[0]!); s.kill(); }],
      ]) as typeof SEED_OPCODES,
      resolveGlobalScript: () => ({ bytecode: bytes(0x01), room: 0 }),
    });
    vm.vars.writeGlobal(34, 9); // VAR_INVENTORY_SCRIPT
    // setOwnerOf obj=42 owner=0 (a consumption); stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x29, 0x2a, 0x00, 0x00, 0xa0) });
    for (let i = 0; i < 10; i++) vm.step();
    expect(invRuns).toEqual([0]);
  });

  it('setState queues a current-room object for redraw (so an opened door renders)', () => {
    const vm = makeVm();
    // A loaded room with object 42 (has a state-1 image).
    vm.loadedRoom = {
      id: 1, width: 0, height: 0, numObjects: 1, palette: new Uint8Array(768),
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[42, { objId: 42, images: new Map([[1, {}]]) }]]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    } as never;
    expect(vm.objectDrawQueue.has(42)).toBe(false);
    // setState obj=42 state=1 (0x07 = both direct: obj word, state byte), stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x07, 0x2a, 0x00, 0x01, 0xa0) });
    while (vm.slots.find((s) => s.scriptId === 1 && s.runnable)) vm.step();
    expect(vm.objectStates.get(42)).toBe(1);
    expect(vm.objectDrawQueue.has(42)).toBe(true); // SCUMM marks it dirty → redraws
    // An object not in the room is tracked but not queued (can't be drawn).
    vm.startScript({ scriptId: 2, bytecode: bytes(0x07, 0x63, 0x00, 0x01, 0xa0) });
    while (vm.slots.find((s) => s.scriptId === 2 && s.runnable)) vm.step();
    expect(vm.objectStates.get(99)).toBe(1);
    expect(vm.objectDrawQueue.has(99)).toBe(false);
  });

  it('entering a room queues objects already in a drawable state (door stays open)', () => {
    // A room whose object 42 carries a state-1 image.
    const room = {
      id: 7, width: 0, height: 0, numObjects: 1, palette: new Uint8Array(768),
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[42, { objId: 42, images: new Map([[1, {}]]) }]]),
      walkBoxes: [], boxMatrix: [], scaleSlots: [],
    };
    const vm = new Vm({
      numVariables: 800, numBitVariables: 2048, handlers: SEED_OPCODES,
      resolveRoom: () => room as never,
    });
    // Object 42 left in state 1 (e.g. an opened door) from earlier play.
    vm.objectStates.set(42, 1);
    vm.enterRoom(7);
    // Auto-queued from its persisted state, so it renders on (re-)entry —
    // even though enterRoom clears the queue first.
    expect(vm.objectDrawQueue.has(42)).toBe(true);
  });

  it('faceActor turns the actor toward a target actor (east)', () => {
    const vm = makeVm();
    const a = vm.actors.get(1);
    a.room = 1;
    a.x = 100;
    a.y = 100;
    const b = vm.actors.get(2);
    b.room = 1;
    b.x = 200;
    b.y = 100; // due east
    // faceActor actor=1 target=2 (0x09 = both direct), stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x09, 0x01, 0x02, 0x00, 0xa0) });
    vm.step();
    expect(vm.actors.get(1).facing).toBe('E');
  });

  it('loadRoomWithEgo enters the room and assigns ego to it', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 1); // VAR_EGO = actor 1
    vm.actors.get(1).room = 0;
    // loadRoomWithEgo obj=42 room=7 x=-1 (no walk) y=0; stop.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x24, 0x2a, 0x00, 0x07, 0xff, 0xff, 0x00, 0x00, 0xa0),
    });
    vm.step();
    expect(vm.currentRoom).toBe(7);
    expect(vm.actors.get(1).room).toBe(7);
  });

  it('loadRoomWithEgo 0xE4 reads both obj and room as var-refs (MI1 #121)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 1); // VAR_EGO = actor 1
    vm.vars.writeGlobal(5, 42); // obj id
    vm.vars.writeGlobal(6, 7); // room id
    vm.actors.get(1).room = 0;
    // 0xE4 = both param-mode bits set: obj=g5 (var word), room=g6 (var word),
    // x=-1 (no walk), y=0; stop. A mode mis-read would land the room on the
    // wrong byte and never reach room 7.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0xe4, 0x05, 0x00, 0x06, 0x00, 0xff, 0xff, 0x00, 0x00, 0xa0),
    });
    vm.step();
    expect(vm.currentRoom).toBe(7);
    expect(vm.actors.get(1).room).toBe(7);
  });
});

describe('saveRestoreVerbs (0xAB) — cutscene verb hide/restore', () => {
  function makeVerb(vm: Vm, id: number, state: 'on' | 'dim' | 'off' | 'deleted'): void {
    vm.verbs.set(id, {
      id, name: '', color: 1, hiColor: 1, dimColor: 1, backColor: 0,
      x: 0, y: 0, key: 0, charset: 0, centered: false, image: null, state,
    });
  }

  it('save (sub 1) hides verbs in range and remembers their prior state', () => {
    const vm = makeVm();
    makeVerb(vm, 5, 'on');
    makeVerb(vm, 6, 'dim');
    makeVerb(vm, 99, 'on'); // out of range — untouched
    // saveRestoreVerbs sub=1 [5..6] mode=1
    vm.startScript({ scriptId: 1, bytecode: bytes(0xab, 0x01, 5, 6, 1) });
    vm.step();
    expect(vm.verbs.get(5)!.state).toBe('off');
    expect(vm.verbs.get(6)!.state).toBe('off');
    expect(vm.verbs.get(99)!.state).toBe('on');
    expect(vm.savedVerbStates.get(5)).toBe('on');
    expect(vm.savedVerbStates.get(6)).toBe('dim');
  });

  it('restore (sub 2) brings saved verbs back to their prior state', () => {
    const vm = makeVm();
    makeVerb(vm, 5, 'on');
    makeVerb(vm, 6, 'dim');
    vm.startScript({ scriptId: 1, bytecode: bytes(0xab, 0x01, 5, 6, 1, 0xab, 0x02, 5, 6, 1) });
    vm.step(); // save
    vm.step(); // restore
    expect(vm.verbs.get(5)!.state).toBe('on');
    expect(vm.verbs.get(6)!.state).toBe('dim');
    expect(vm.savedVerbStates.size).toBe(0);
  });

  it('delete (sub 3) removes verbs in range', () => {
    const vm = makeVm();
    makeVerb(vm, 5, 'on');
    vm.startScript({ scriptId: 1, bytecode: bytes(0xab, 0x03, 5, 5, 1) });
    vm.step();
    expect(vm.verbs.get(5)!.state).toBe('deleted');
  });
});

describe('pseudoRoom (0xCC)', () => {
  it('maps high-bit aliases by their raw value and ignores the rest', () => {
    const vm = makeVm();
    // realRoom=10; aliases keep their raw byte as the key (0x85=133, 0x87=135)
    // — the game references pseudo rooms by that literal (MI1's forest cycles
    // VAR_ROOM through 201–220, not 73–92). A plain 0x03 (no high bit) is
    // ignored.
    run(vm, bytes(0xcc, 0x0a, 0x85, 0x03, 0x87, 0x00));
    expect(vm.pseudoRooms.get(0x85)).toBe(10);
    expect(vm.pseudoRooms.get(0x87)).toBe(10);
    expect(vm.pseudoRooms.has(3)).toBe(false);
    expect(vm.haltInfo).toBeNull();
  });

  it('enterRoom loads an existing room directly, ignoring its pseudo alias', () => {
    // A room that physically exists must load its OWN data even if the
    // pseudoRoom table happens to alias the same id. The alias is a fallback,
    // not an override. (In MI1 the two never collide — pseudo ids are ≥ 128
    // and real rooms ≤ 99 — but the precedence is still asserted here.)
    const resolved: number[] = [];
    const vm = makeVm((id) => {
      resolved.push(id);
      return fakeRoom(id);
    });
    vm.pseudoRooms.set(5, 10);
    vm.enterRoom(5);
    expect(vm.loadedRoom?.id).toBe(5); // its own resources, not 10's
    expect(resolved).not.toContain(10); // the alias wasn't consulted
    expect(vm.currentRoom).toBe(5);
  });

  it('enterRoom falls back to the pseudo alias when the room does not exist', () => {
    // A logical id with no physical room (MI1's forest maze: 218 → 58)
    // resolves through the alias. The resolver throws for the missing id,
    // succeeds for the alias.
    const resolved: number[] = [];
    const vm = makeVm((id) => {
      resolved.push(id);
      if (id === 218) throw new Error('room 218 not present');
      return fakeRoom(id);
    });
    vm.pseudoRooms.set(218, 58);
    vm.enterRoom(218);
    expect(vm.loadedRoom?.id).toBe(58); // fell back to the alias
    expect(vm.currentRoom).toBe(218); // logical id unchanged
    expect(vm.haltInfo).toBeNull();
  });

  it('enterRoom is identity for an unmapped id', () => {
    const vm = makeVm((id) => fakeRoom(id));
    vm.enterRoom(33);
    expect(vm.loadedRoom?.id).toBe(33);
    expect(vm.currentRoom).toBe(33);
  });
});

describe('systemOps (0x98)', () => {
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

describe('roomOps roomScroll (0x01)', () => {
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

describe('roomOps setPalColor (0x04)', () => {
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

describe('roomOps screenEffect (0x0A)', () => {
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

describe('dialog escape codes (substitutions)', () => {
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

  it('0x05 inserts a verb name (id read from a var)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(80, 7);
    vm.verbs.set(7, { id: 7, name: 'Usa', color: 0, hiColor: 0, dimColor: 0, backColor: 0, x: 0, y: 0, key: 0, charset: 0, centered: false, image: null, state: 'on' });
    // \xff\x05 <var 80 → verb id 7>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0xff, 0x05, 0x50, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('Usa');
  });

  it('0x06 inserts an object name (id read from a var)', () => {
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
    // \xff\x06 <var 70 → obj 42>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0xff, 0x06, 0x46, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('sword');
  });

  it('0x07 inserts a string resource by DIRECT id (not via a var)', () => {
    const vm = makeVm();
    vm.strings.set(3, bytes(0x48, 0x69)); // string resource 3 = "Hi"
    // \xff\x07 <string id 3, used directly — addStringToStack(num)>
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x14, 0xff, 0x0f, 0xff, 0x07, 0x03, 0x00, 0x00),
    });
    vm.step();
    expect(vm.systemText?.text).toBe('Hi');
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

  it('reverts an overdrawn same-box object to state 0 (the erased frame is hidden)', () => {
    // The prison rat-hole loop (room 31 #207) cycles a hole's three same-box
    // frames by re-picking a random one whose state is 0 and drawing it; if a
    // drawn frame never reverts, all three latch at state 1 and the picker spins
    // forever. Overdrawing one same-box object erases the previous, so the
    // erased one's state must drop back to 0.
    const vm = makeVm();
    const room = fakeRoom(1);
    (room.objects as Map<number, LoadedObject>).set(411, objAt(411, 96, 72, 16, 16));
    (room.objects as Map<number, LoadedObject>).set(412, objAt(412, 96, 72, 16, 16));
    vm.loadedRoom = room;

    run(vm, bytes(0x05, 0x9b, 0x01, 0xff)); // drawObject 411 (0x019b)
    expect(vm.objectStates.get(411)).toBe(1);
    run(vm, bytes(0x05, 0x9c, 0x01, 0xff)); // drawObject 412 — evicts + erases 411
    expect(vm.objectStates.get(412)).toBe(1);
    expect(vm.objectStates.get(411)).toBe(0); // the overdrawn frame is hidden again
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
