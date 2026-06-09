/**
 * SCUMM v5 parameter decoding — opcode param-mode bits and the var-ref
 * scope word. Encoding details in pages/docs/scumm/opcodes.md.
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
 * Read a value parameter: SIGNED i16 immediate or dereferenced var, per the
 * opcode's param-mode bit. v5 direct words are signed — an unsigned read
 * silently corrupts negative immediates. Lock-step with {@link readVarOrWord}.
 */
export function readValue(
  slot: ScriptSlot,
  vars: Variables,
  asVar: boolean,
): number {
  if (asVar) return readVarRef(slot, vars);
  return readI16(slot);
}

/**
 * Read a var-reference word and dereference it. Always advances PC
 * past the ref (2 bytes), plus an extra word if the ref's bit 0x2000
 * is set (indexed/array access).
 */
export function readVarRef(slot: ScriptSlot, vars: Variables): number {
  const ref = resolveIndexedRef(readU16(slot), slot, vars);
  return derefRead(ref, slot, vars);
}

/**
 * Like {@link readVarRef} but also returns the resolved ref word, so the
 * trace can label which variable a script polled.
 */
export function readVarRefWithRef(
  slot: ScriptSlot,
  vars: Variables,
): { readonly ref: number; readonly value: number } {
  const ref = resolveIndexedRef(readU16(slot), slot, vars);
  return { ref, value: derefRead(ref, slot, vars) };
}

/** Render a (post-`resolveIndexedRef`) ref word as a human-readable label. */
export function formatRefLabel(ref: number): string {
  if (ref & 0x8000) return `bit#${ref & 0x7fff}`;
  if (ref & 0x4000) return `L${ref & 0x0fff}`;
  return `g${ref & 0x1fff}`;
}

/**
 * Read a var-reference word *as a destination* — returns the
 * (possibly indexed-resolved) ref, advancing PC past the ref and any
 * extra index word. The caller writes the value via `writeRef`.
 */
export function readDestRef(slot: ScriptSlot, vars?: Variables): number {
  const ref = readU16(slot);
  if (ref & 0x2000) {
    if (!vars) {
      throw new ParamError(
        `indexed var ref 0x${ref.toString(16)} requires vars`,
      );
    }
    return resolveIndexedRef(ref, slot, vars);
  }
  return ref;
}

/**
 * Resolve the "indexed" variant of a var ref: if bit 0x2000 is set,
 * read another word for the offset (with its own var-or-immediate
 * mode) and add it to the base index. Returns the final ref with the
 * 0x2000 bit cleared.
 */
function resolveIndexedRef(
  ref: number,
  slot: ScriptSlot,
  vars: Variables,
): number {
  if (!(ref & 0x2000)) return ref;
  const indexWord = readU16(slot);
  const offset =
    indexWord & 0x2000
      ? derefRead(indexWord & ~0x2000, slot, vars)
      : indexWord & 0xfff;
  return (ref & ~0x2000) + offset;
}

/** Read the variable at `ref`. */
export function derefRead(
  ref: number,
  slot: ScriptSlot,
  vars: Variables,
): number {
  if (ref & 0x8000) {
    return vars.readBit(ref & 0x7fff);
  }
  if (ref & 0x4000) {
    const index = ref & 0x0fff;
    if (index >= slot.locals.length) {
      throw new ParamError(
        `local var index ${index} out of range [0, ${slot.locals.length})`,
      );
    }
    return slot.locals[index]!;
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
    vars.writeBit(ref & 0x7fff, value ? 1 : 0);
    return;
  }
  if (ref & 0x4000) {
    const index = ref & 0x0fff;
    if (index >= slot.locals.length) {
      throw new ParamError(
        `local var index ${index} out of range [0, ${slot.locals.length})`,
      );
    }
    slot.locals[index] = value | 0;
    return;
  }
  vars.writeGlobal(ref & 0x1fff, value);
}

/**
 * Read a "var-or-direct byte" parameter: var-ref word when `paramIndex`'s
 * mode bit is set on `modeByte` (the subop byte carries the same mode-bit
 * positions as the main opcode), else a direct u8.
 */
export function readVarOrByte(
  modeByte: number,
  paramIndex: 1 | 2 | 3,
  slot: ScriptSlot,
  vars: Variables,
): number {
  if (isVarParam(modeByte, paramIndex)) {
    return readVarRef(slot, vars);
  }
  return readU8(slot);
}

/**
 * Read a "var-or-direct word" parameter. The direct form is a SIGNED i16 —
 * v5 direct words are signed, so `0xFFFE` is `-2`, not 65534; an unsigned
 * read breaks every signed comparison downstream.
 */
export function readVarOrWord(
  modeByte: number,
  paramIndex: 1 | 2 | 3,
  slot: ScriptSlot,
  vars: Variables,
): number {
  if (isVarParam(modeByte, paramIndex)) {
    return readVarRef(slot, vars);
  }
  return readI16(slot);
}

/**
 * Read a v5 word-vararg list — `(markerByte, u16 value)` pairs terminated
 * by `0xFF`; each marker's `0x80` bit selects var-ref vs immediate.
 */
export function readWordVararg(
  slot: ScriptSlot,
  vars: Variables,
): number[] {
  const out: number[] = [];
  while (true) {
    const marker = readU8(slot);
    if (marker === 0xff) break;
    out.push(readVarOrWord(marker, 1, slot, vars));
  }
  return out;
}

/** Re-export so callers don't need a second import for the storage error type. */
export { VariableError };
