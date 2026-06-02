import { describe, expect, it } from 'vitest';
import { Vm } from '../vm';
import { SEED_OPCODES } from './index';

function makeVm(): Vm {
  return new Vm({
    numVariables: 800,
    numBitVariables: 2048,
    handlers: SEED_OPCODES,
  });
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
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

  it('setCursorImage (0x0A) consumes two direct-byte args', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x0a, 0x01, 0x02) });
    vm.step();
    expect(slot.pc).toBe(4);
  });

  it('setCursorHotspot (0x0B) consumes three direct-byte args', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x0b, 0x01, 0x05, 0x06) });
    vm.step();
    expect(slot.pc).toBe(5);
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
      walkableMask: new Uint8Array(0), scaleSlots: [],
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
      walkableMask: new Uint8Array(0), scaleSlots: [],
    };
    // findObject(50, 50) — both immediate (opcode 0x35, no mode bits set)
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x35,
        0x00, 0x40,          // dest = local 0
        0x32, 0x00,          // x = 50 imm
        0x32, 0x00,          // y = 50 imm
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
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
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

  it('isSoundRunning always returns 0 (audio stubbed)', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7c, 0x00, 0x00, 0x09) });
    vm.step();
    expect(vm.vars.readGlobal(0)).toBe(0);
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
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
    };
    vm.startScript({ scriptId: 1, bytecode: bytes(0x25, 0x63, 0x00, 0x00) });
    vm.step();
    // Leave the room: the live object table no longer knows the item.
    vm.loadedRoom = null;
    expect(vm.objectName(99)).toBe('the rubber chicken');
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
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
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
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
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

  it('setState queues a current-room object for redraw (so an opened door renders)', () => {
    const vm = makeVm();
    // A loaded room with object 42 (has a state-1 image).
    vm.loadedRoom = {
      id: 1, width: 0, height: 0, numObjects: 1, palette: new Uint8Array(768),
      transparentIndex: null, indexed: new Uint8Array(0), stripMethods: [],
      zPlanes: [], entryScript: null, exitScript: null, localScripts: new Map(),
      objects: new Map([[42, { objId: 42, images: new Map([[1, {}]]) }]]),
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
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
      walkBoxes: [], walkableMask: new Uint8Array(0), scaleSlots: [],
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
