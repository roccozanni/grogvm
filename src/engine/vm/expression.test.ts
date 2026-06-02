import { describe, expect, it } from 'vitest';
import { ExpressionError, evalExpression } from './expression';
import { ScriptSlot } from './slot';
import { Variables } from './variables';

function setup(bytes: number[]) {
  const vars = new Variables({ numVariables: 32, numBitVariables: 64 });
  const slot = new ScriptSlot(0);
  slot.start({ scriptId: 1, bytecode: new Uint8Array(bytes) });
  return { vars, slot };
}

// Encoded as a stream starting at PC=0 of the slot's bytecode: a
// dest var-ref word followed by the subop stream. evalExpression
// reads from that PC; tests assert on the resulting var value.

function destBytes(ref: number): number[] {
  return [ref & 0xff, (ref >>> 8) & 0xff];
}
function pushImm(v: number): number[] {
  return [0x01, v & 0xff, (v >>> 8) & 0xff];
}
function pushVar(ref: number): number[] {
  // push with bit 7 set → operand is a var-ref word, dereferenced.
  return [0x81, ref & 0xff, (ref >>> 8) & 0xff];
}
const ADD = [0x02];
const SUB = [0x03];
const MUL = [0x04];
const DIV = [0x05];
const END = [0xff];

describe('evalExpression', () => {
  it('writes a single immediate to dest', () => {
    const dest = 0x0007;
    const { vars, slot } = setup([...destBytes(dest), ...pushImm(42), ...END]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(7)).toBe(42);
  });

  it('reads from a var when subop is 0x02 push-var', () => {
    const { vars, slot } = setup([...destBytes(0x0008), ...pushVar(0x0007), ...END]);
    vars.writeGlobal(7, 999);
    evalExpression(slot, vars);
    expect(vars.readGlobal(8)).toBe(999);
  });

  it('add: stacks left-to-right, pops b then a', () => {
    // 10 + 3 → 13. Order: push 10, push 3, add.
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(10),
      ...pushImm(3),
      ...ADD,
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(13);
  });

  it('sub: pops in the right order (a - b, not b - a)', () => {
    // 10 - 3 → 7
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(10),
      ...pushImm(3),
      ...SUB,
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(7);
  });

  it('mul', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(6),
      ...pushImm(7),
      ...MUL,
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(42);
  });

  it('div: truncates toward zero', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(10),
      ...pushImm(3),
      ...DIV,
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(3);
  });

  it('div: throws on divide-by-zero', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(5),
      ...pushImm(0),
      ...DIV,
      ...END,
    ]);
    expect(() => evalExpression(slot, vars)).toThrow(ExpressionError);
  });

  it('handles a nested compound expression: (a + b) * c', () => {
    // ((10 + 3) * 2) → 26. RPN: 10 3 + 2 *.
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(10),
      ...pushImm(3),
      ...ADD,
      ...pushImm(2),
      ...MUL,
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(26);
  });

  it('mixes immediate + var operands', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushVar(0x0005),
      ...pushImm(10),
      ...ADD,
      ...END,
    ]);
    vars.writeGlobal(5, 32);
    evalExpression(slot, vars);
    expect(vars.readGlobal(1)).toBe(42);
  });

  it('writes to a local var dest when bit 14 is set', () => {
    const { vars, slot } = setup([
      ...destBytes(0x4003),
      ...pushImm(77),
      ...END,
    ]);
    evalExpression(slot, vars);
    expect(slot.locals[3]).toBe(77);
  });

  it('writes to an INDEXED (array) dest, consuming the index word', () => {
    // Regression: an expression dest can be an indexed var-ref (bit 0x2000),
    // e.g. MI1 room 30 #205's `g221[L0] = ...`. The base word is followed by
    // an index word that MUST be consumed, or the subop reader desyncs and
    // hits a stray byte ("unknown subop 0x00"). Here: base g5 (0x2005) +
    // var index L0 — with L0 = 2 the dest resolves to g7.
    const vars = new Variables({ numVariables: 32, numBitVariables: 64 });
    const slot = new ScriptSlot(0);
    // index word 0x6000 = indexed(0x2000) | local(0x4000) | L0 → deref L0.
    slot.start({
      scriptId: 1,
      bytecode: new Uint8Array([0x05, 0x20, 0x00, 0x60, ...pushImm(42), ...END]),
      args: [2], // locals[0] = 2
    });
    evalExpression(slot, vars);
    expect(vars.readGlobal(7)).toBe(42);
  });

  it('throws on unknown subop', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(1),
      0x1f, // unknown action (low-5 bits)
      ...END,
    ]);
    expect(() => evalExpression(slot, vars)).toThrow(ExpressionError);
  });

  it('throws on subop 0x06 (nested opcode) — not implemented yet', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(1),
      0x06,
      ...END,
    ]);
    expect(() => evalExpression(slot, vars)).toThrow(/nested opcode/);
  });

  it('throws when the stream ends without a result on stack', () => {
    const { vars, slot } = setup([...destBytes(0x0001), ...END]);
    expect(() => evalExpression(slot, vars)).toThrow(ExpressionError);
  });

  it('throws on pop-from-empty', () => {
    const { vars, slot } = setup([
      ...destBytes(0x0001),
      ...pushImm(5),
      ...ADD, // needs 2 operands, only 1 on stack
      ...END,
    ]);
    expect(() => evalExpression(slot, vars)).toThrow(ExpressionError);
  });

  it('throws when the subop budget is exceeded (malformed stream)', () => {
    const malformed = [...destBytes(0x0001)];
    for (let i = 0; i < 2000; i++) malformed.push(...pushImm(1));
    // No 0xFF terminator → budget exhausted
    const { vars, slot } = setup(malformed);
    expect(() => evalExpression(slot, vars)).toThrow(ExpressionError);
  });
});
