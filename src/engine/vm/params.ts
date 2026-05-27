/**
 * SCUMM v5 parameter decoding.
 *
 * # Opcode byte
 *
 * Each opcode is a single byte split into two parts:
 *
 *   ┌────┬────┬────┬────┬────┬────┬────┬────┐
 *   │ a  │ b  │ c  │           op           │
 *   └────┴────┴────┴────┴────┴────┴────┴────┘
 *     7    6    5    4    3    2    1    0
 *
 *   - bits 0..4 — the *opcode family* (32 family slots).
 *   - bits 5..7 — *parameter mode flags* (a, b, c) indicating which
 *     of up to three parameters is a **variable reference** instead
 *     of an **immediate**:
 *       bit 7 (0x80) → param 1 is a var-ref
 *       bit 6 (0x40) → param 2 is a var-ref
 *       bit 5 (0x20) → param 3 is a var-ref
 *
 *   In practice each handler decides which bits matter for its
 *   family. Some opcodes (e.g. `setVar` = 0x1A) treat param 1 as a
 *   destination var-ref unconditionally and only use bit 7 to choose
 *   the source mode of param 2. Don't over-generalize — let handlers
 *   pull what they need.
 *
 * # Variable reference word
 *
 * When a parameter is a var-ref, the next two bytes are a u16 LE
 * "reference word" whose top bits select the variable scope:
 *
 *   - `0x8000` set        → **local** variable; index = low byte
 *   - `0x4000` set        → **bit-var**;  index = bits 0..13
 *   - neither set         → **global** variable; index = bits 0..13
 *
 * (Some SCUMM versions add a third "indexed" / array-deref scope on
 * `0x2000`. We deliberately leave that unimplemented in Phase 5 — the
 * loud-fail behavior at the dispatcher level will catch it the first
 * time the boot script uses it, and we'll add the case then.)
 */

import type { ScriptSlot } from './slot';
import { VariableError, type Variables } from './variables';

export class ParamError extends Error {
  constructor(detail: string) {
    super(`Param decode error: ${detail}`);
    this.name = 'ParamError';
  }
}

/** Is this param a var-ref (true) or an immediate (false)? */
export function isVarParam(opcode: number, paramIndex: 1 | 2 | 3): boolean {
  const mask = 0x80 >>> (paramIndex - 1);
  return (opcode & mask) !== 0;
}

/** Read a u8 from the bytecode at the slot's PC and advance. */
export function readU8(slot: ScriptSlot): number {
  if (slot.pc + 1 > slot.bytecode.length) {
    throw new ParamError(
      `u8 read past end of bytecode (pc=${slot.pc}, len=${slot.bytecode.length})`,
    );
  }
  return slot.bytecode[slot.pc++]!;
}

/** Read a u16 LE from the bytecode at the slot's PC and advance. */
export function readU16(slot: ScriptSlot): number {
  if (slot.pc + 2 > slot.bytecode.length) {
    throw new ParamError(
      `u16 read past end of bytecode (pc=${slot.pc}, len=${slot.bytecode.length})`,
    );
  }
  const v = slot.bytecode[slot.pc]! | (slot.bytecode[slot.pc + 1]! << 8);
  slot.pc += 2;
  return v;
}

/** Read an i16 LE from the bytecode at the slot's PC and advance. */
export function readI16(slot: ScriptSlot): number {
  const v = readU16(slot);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/**
 * Read a value parameter: either a u16 immediate or a dereferenced
 * variable, depending on the opcode's param-mode bit.
 */
export function readValue(
  slot: ScriptSlot,
  vars: Variables,
  asVar: boolean,
): number {
  if (asVar) return readVarRef(slot, vars);
  return readU16(slot);
}

/**
 * Read a var-reference word and dereference it. Always advances PC by 2.
 */
export function readVarRef(slot: ScriptSlot, vars: Variables): number {
  const ref = readU16(slot);
  return derefRead(ref, slot, vars);
}

/**
 * Read a var-reference word *as a destination* — returns the
 * reference word itself, with PC advanced. The caller writes the
 * value via `writeRef` after computing it.
 */
export function readDestRef(slot: ScriptSlot): number {
  return readU16(slot);
}

/** Read the variable at `ref`. Throws on unknown scope bits. */
export function derefRead(
  ref: number,
  slot: ScriptSlot,
  vars: Variables,
): number {
  if (ref & 0x8000) {
    const index = ref & 0x00ff;
    if (index >= slot.locals.length) {
      throw new ParamError(
        `local var index ${index} out of range [0, ${slot.locals.length})`,
      );
    }
    return slot.locals[index]!;
  }
  if (ref & 0x4000) {
    return vars.readBit(ref & 0x3fff);
  }
  if (ref & 0x2000) {
    throw new ParamError(
      `indexed/array var reference 0x${ref.toString(16)} — not implemented in Phase 5`,
    );
  }
  return vars.readGlobal(ref & 0x1fff);
}

/** Write `value` to the variable at `ref`. */
export function writeRef(
  ref: number,
  value: number,
  slot: ScriptSlot,
  vars: Variables,
): void {
  if (ref & 0x8000) {
    const index = ref & 0x00ff;
    if (index >= slot.locals.length) {
      throw new ParamError(
        `local var index ${index} out of range [0, ${slot.locals.length})`,
      );
    }
    slot.locals[index] = value | 0;
    return;
  }
  if (ref & 0x4000) {
    vars.writeBit(ref & 0x3fff, value ? 1 : 0);
    return;
  }
  if (ref & 0x2000) {
    throw new ParamError(
      `indexed/array var reference 0x${ref.toString(16)} — not implemented in Phase 5`,
    );
  }
  vars.writeGlobal(ref & 0x1fff, value);
}

/** Re-export so callers don't need a second import for the storage error type. */
export { VariableError };
