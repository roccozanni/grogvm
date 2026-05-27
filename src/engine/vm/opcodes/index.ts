/**
 * Seed opcode set for Phase 5.
 *
 * The goal is *not* to be comprehensive — it's to provide just enough
 * dispatch for the boot script to start executing and for any branch
 * we can reach to behave correctly. Anything we haven't written halts
 * the VM cleanly via the dispatcher's default-fail path.
 *
 * Opcodes are listed in family order. Each entry registers one or
 * more byte values (the base opcode plus parameter-mode variants).
 *
 * # Convention
 *
 * - Handlers consume their parameters from the slot's bytecode and
 *   advance `slot.pc` past them.
 * - Param-mode bits in the opcode byte select *value* parameters
 *   (immediate vs var-ref). The **destination** parameter of a write
 *   opcode (e.g. `setVar`'s first param) is always a raw var-ref
 *   word — no mode bit consulted.
 * - Every handler calls `vm.annotate(...)` with a short mnemonic so
 *   the trace ring and halt panel can render something meaningful.
 */

import {
  derefRead,
  isVarParam,
  readDestRef,
  readI16,
  readU8,
  readValue,
  readVarRef,
  writeRef,
} from '../params';
import type { ScriptSlot } from '../slot';
import type { OpcodeHandler, Vm } from '../vm';

const handlers = new Map<number, OpcodeHandler>();

function register(opcode: number, handler: OpcodeHandler): void {
  if (handlers.has(opcode)) {
    throw new Error(`opcode 0x${opcode.toString(16)} registered twice`);
  }
  handlers.set(opcode, handler);
}

// ─── 0x00  stopObjectCode ────────────────────────────────────────────
// End the current script. Kills the slot.
register(0x00, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0xA0  stopObjectCode (alias) ────────────────────────────────────
// Same opcode family, used by some scripts in MI1. Conservatively
// register it too — both forms appear in descumm output.
register(0xa0, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0x80  breakHere ─────────────────────────────────────────────────
// Yield to the scheduler. No parameters.
register(0x80, (vm, slot) => {
  vm.annotate('breakHere');
  slot.yield_();
});

// ─── 0x18  jumpRelative ──────────────────────────────────────────────
// Unconditional jump. Operand is a signed 16-bit displacement applied
// to the PC after reading it (i.e. relative to the byte AFTER the
// displacement word).
register(0x18, (vm, slot) => {
  const delta = readI16(slot);
  slot.pc += delta;
  vm.annotate(`jump ${delta >= 0 ? '+' : ''}${delta}`);
});

// ─── 0x1A  setVar ────────────────────────────────────────────────────
// Two params: dest var-ref word (always raw), value (immediate or var
// ref based on bit-7 of the opcode byte). Variant 0x9A has bit-7 set
// → source is a var ref.
function makeSetVar(label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot);
    const value = readValue(slot, vm.vars, isVarParam(opcode, 1));
    writeRef(dest, value, slot, vm.vars);
    vm.annotate(`${label} 0x${dest.toString(16)} = ${value}`);
  };
}
register(0x1a, makeSetVar('setVar'));
register(0x9a, makeSetVar('setVar'));

// ─── 0x46 / 0xC6  inc / dec ──────────────────────────────────────────
// Single var-ref param. In v5 these are *separate* opcodes — bit 7 is
// not a param-mode flag here, it selects increment vs decrement.
register(0x46, (vm, slot) => {
  const ref = readDestRef(slot);
  const cur = readValueAtRef(ref, slot, vm);
  writeRef(ref, cur + 1, slot, vm.vars);
  vm.annotate(`inc 0x${ref.toString(16)}`);
});
register(0xc6, (vm, slot) => {
  const ref = readDestRef(slot);
  const cur = readValueAtRef(ref, slot, vm);
  writeRef(ref, cur - 1, slot, vm.vars);
  vm.annotate(`dec 0x${ref.toString(16)}`);
});

function readValueAtRef(ref: number, slot: ScriptSlot, vm: Vm): number {
  return derefRead(ref, slot, vm.vars);
}

// ─── 0x5A / 0xDA  addVar ─────────────────────────────────────────────
function makeAddSub(sign: 1 | -1, label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot);
    const operand = readValue(slot, vm.vars, isVarParam(opcode, 1));
    const cur = derefRead(dest, slot, vm.vars);
    writeRef(dest, cur + sign * operand, slot, vm.vars);
    vm.annotate(`${label} 0x${dest.toString(16)} ${sign === 1 ? '+=' : '-='} ${operand}`);
  };
}
register(0x5a, makeAddSub(1, 'add'));
register(0xda, makeAddSub(1, 'add'));
register(0x3a, makeAddSub(-1, 'sub'));
register(0xba, makeAddSub(-1, 'sub'));

// ─── Conditional branches ───────────────────────────────────────────
// Family pattern: read X (var ref), read Y (value, param-mode bit on
// the OTHER side from setVar — varies opcode-by-opcode), then read
// i16 displacement. Jump if condition is FALSE (skip the "then"
// branch). SCUMM v5 convention is "jump if NOT condition".

function makeCmp(
  label: string,
  cmp: (a: number, b: number) => boolean,
): OpcodeHandler {
  return (vm, slot, opcode) => {
    const a = readVarRef(slot, vm.vars);
    const b = readValue(slot, vm.vars, isVarParam(opcode, 1));
    const delta = readI16(slot);
    const taken = !cmp(a, b);
    if (taken) slot.pc += delta;
    vm.annotate(
      `${label}(${a}, ${b}) → ${cmp(a, b) ? 'continue' : `jump ${delta >= 0 ? '+' : ''}${delta}`}`,
    );
  };
}

// 0x48 / 0xC8 — isEqual: jump if NOT equal (skip the then-branch)
register(0x48, makeCmp('isEqual', (a, b) => a === b));
register(0xc8, makeCmp('isEqual', (a, b) => a === b));

// 0x08 / 0x88 — isNotEqual: jump if equal
register(0x08, makeCmp('isNotEqual', (a, b) => a !== b));
register(0x88, makeCmp('isNotEqual', (a, b) => a !== b));

// 0x04 / 0x84 — isGreaterEqual: jump if a < b
register(0x04, makeCmp('isGE', (a, b) => a >= b));
register(0x84, makeCmp('isGE', (a, b) => a >= b));

// 0x44 / 0xC4 — isLess: jump if a >= b
register(0x44, makeCmp('isLess', (a, b) => a < b));
register(0xc4, makeCmp('isLess', (a, b) => a < b));

// 0x78 / 0xF8 — isGreater: jump if a <= b
register(0x78, makeCmp('isGreater', (a, b) => a > b));
register(0xf8, makeCmp('isGreater', (a, b) => a > b));

// 0x38 / 0xB8 — isLessEqual: jump if a > b
register(0x38, makeCmp('isLE', (a, b) => a <= b));
register(0xb8, makeCmp('isLE', (a, b) => a <= b));

// ─── 0x28  equalZero / 0xA8  notEqualZero ────────────────────────────
// Test a single var against 0, conditional jump.
register(0x28, (vm, slot) => {
  const a = readVarRef(slot, vm.vars);
  const delta = readI16(slot);
  if (a !== 0) slot.pc += delta;
  vm.annotate(`equalZero(${a}) → ${a === 0 ? 'continue' : `jump ${delta}`}`);
});
register(0xa8, (vm, slot) => {
  const a = readVarRef(slot, vm.vars);
  const delta = readI16(slot);
  if (a === 0) slot.pc += delta;
  vm.annotate(`notEqualZero(${a}) → ${a !== 0 ? 'continue' : `jump ${delta}`}`);
});

// ─── 0x2E  delay ─────────────────────────────────────────────────────
// 3-byte immediate (24-bit LE tick count). Without a real tick clock
// in Phase 5, treat it as a `breakHere`.
register(0x2e, (vm, slot) => {
  const a = readU8(slot);
  const b = readU8(slot);
  const c = readU8(slot);
  const ticks = a | (b << 8) | (c << 16);
  slot.yield_();
  vm.annotate(`delay ${ticks} (stub: breakHere)`);
});

export const SEED_OPCODES: ReadonlyMap<number, OpcodeHandler> = handlers;
