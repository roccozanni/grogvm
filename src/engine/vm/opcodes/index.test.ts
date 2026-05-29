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

describe('seed opcodes — startScript LSCR routing', () => {
  it('routes script ids >= 200 to the current room\'s localScripts', () => {
    const vm = makeVm();
    // Stub the current room with one LSCR (id 201) that just returns.
    const localBytecode = bytes(0xa0); // stopObjectCode
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
      walkableMask: new Uint8Array(0),
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
  it('cursorOn/cursorOff toggle vm.cursor.visible', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x01, 0x2c, 0x02, 0x00) });
    vm.step(); // cursorOn
    expect(vm.cursor.visible).toBe(true);
    vm.step(); // cursorOff
    expect(vm.cursor.visible).toBe(false);
  });

  it('userputOn/userputOff toggle vm.cursor.userput', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x03, 0x2c, 0x04, 0x00) });
    vm.step();
    expect(vm.cursor.userput).toBe(true);
    vm.step();
    expect(vm.cursor.userput).toBe(false);
  });

  it('soft variants (0x05–0x08) write the same flags', () => {
    const vm = makeVm();
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x2c, 0x05, 0x2c, 0x07, 0x2c, 0x06, 0x2c, 0x08, 0x00),
    });
    vm.step(); // cursorSoftOn
    expect(vm.cursor.visible).toBe(true);
    vm.step(); // userputSoftOn
    expect(vm.cursor.userput).toBe(true);
    vm.step(); // cursorSoftOff
    expect(vm.cursor.visible).toBe(false);
    vm.step(); // userputSoftOff
    expect(vm.cursor.userput).toBe(false);
  });

  it('initCharset (subop 0x0D) writes vm.currentCharset', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x2c, 0x0d, 0x03, 0x00) });
    vm.step();
    expect(vm.currentCharset).toBe(3);
  });
});

describe('seed opcodes — verbOps state wiring', () => {
  it('subop 0x09 "new" creates an on slot with defaults', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0x7a, 0x05, 0x09, 0xff, 0x00) });
    vm.step();
    const v = vm.verbs.get(5);
    expect(v).toBeDefined();
    expect(v!.state).toBe('on');
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
    expect(vm.verbs.get(3)!.state).toBe('on');
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('dim');
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('off');
    vm.step();
    expect(vm.verbs.get(3)!.state).toBe('on');
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
      walkableMask: new Uint8Array(0),
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

  it('delete removes the slot and clears currentVerb if it was armed', () => {
    const vm = makeVm();
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x7a, 0x07, 0x09, 0xff, 0x7a, 0x07, 0x08, 0xff, 0x00),
    });
    vm.step();
    vm.currentVerb = 7;
    vm.step();
    expect(vm.verbs.has(7)).toBe(false);
    expect(vm.currentVerb).toBeNull();
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
    vm.vars.writeGlobal(11, 250); // anim id
    vm.actors.get(3).room = 1;
    // 0xD1 animateActor actor=var10 anim=var11, then stop.
    vm.startScript({ scriptId: 1, bytecode: bytes(0xd1, 0x0a, 0x00, 0x0b, 0x00, 0xa0) });
    vm.step();
    expect(vm.actors.get(3).anim.animId).toBe(250);
  });
});
