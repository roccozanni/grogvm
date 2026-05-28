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
      'cursorCommand cursorOff (stub)',
      'cursorCommand userputOff (stub)',
      'stringOps loadString id=22 len=13',
      'stopObjectCode',
    ]);
  });
});
