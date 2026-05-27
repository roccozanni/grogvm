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

  it('0x1A targets a local var when the dest has bit 15 set', () => {
    const vm = makeVm();
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x1a, 0x03, 0x80, 0x2a, 0x00, 0x00),
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

describe('seed opcodes — boot prefix from real MI1', () => {
  it('runs the first four setVars of MI1 boot script cleanly, then halts on cursorCommand', () => {
    const vm = makeVm();
    // Verbatim opening bytes of MI1 boot script
    const boot = bytes(
      0x1a, 0x49, 0x00, 0x00, 0x00, // setVar 0x49 = 0
      0x1a, 0x3c, 0x00, 0x00, 0x00, // setVar 0x3c = 0
      0x1a, 0x33, 0x00, 0x01, 0x00, // setVar 0x33 = 1
      0x1a, 0x06, 0x00, 0x02, 0x00, // setVar 0x06 = 2
      0x2c, 0x02,                   // cursorCommand subop 0x02 (not implemented)
    );
    vm.startScript({ scriptId: 1, bytecode: boot });
    while (!vm.isHalted) {
      const ran = vm.step();
      if (!ran) break;
    }
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.opcode).toBe(0x2c);
    expect(vm.vars.readGlobal(0x49)).toBe(0);
    expect(vm.vars.readGlobal(0x3c)).toBe(0);
    expect(vm.vars.readGlobal(0x33)).toBe(1);
    expect(vm.vars.readGlobal(0x06)).toBe(2);
    expect(vm.trace.map((e) => e.mnemonic)).toEqual([
      'setVar 0x49 = 0',
      'setVar 0x3c = 0',
      'setVar 0x33 = 1',
      'setVar 0x6 = 2',
      '(unknown)',
    ]);
  });
});
