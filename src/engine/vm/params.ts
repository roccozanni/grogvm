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
 * "reference word" whose top bits select the variable scope (matching
 * ScummVM v5 conventions):
 *
 *   - `0x8000` set        → **bit-var**;  index = bits 0..14
 *   - `0x4000` set        → **local** variable; index = low 12 bits
 *   - `0x2000` set        → **indexed/array** access — another word
 *                            follows (its own var-or-immediate mode);
 *                            the final index is `(ref & ~0x2000) + offset`
 *   - none of the above   → **global** variable; index = bits 0..12
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
 * Read a value parameter: either a SIGNED i16 immediate or a dereferenced
 * variable, depending on the opcode's param-mode bit. v5 direct words are
 * signed (see {@link readVarOrWord}); this reader feeds setVar / add / sub and
 * every comparison, so reading it unsigned silently corrupts negative
 * immediates — `move v = -1` would store 65535, `add v, -1` would add 65534,
 * `isEqual v, -1` would compare against 65535. Self-consistent until a var holds
 * a *true* negative (e.g. a `sub` underflow) or crosses the signed `readVarOrWord`
 * path, at which point comparisons mismatch. Kept in lock-step with
 * `readVarOrWord` so both immediate readers agree.
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
 * Like {@link readVarRef} but also returns the resolved ref word.
 * Used by diagnostic-rich opcode handlers (currently the comparison
 * family) so the trace can label *which* variable a script polled —
 * critical for figuring out why a wait loop never releases.
 */
export function readVarRefWithRef(
  slot: ScriptSlot,
  vars: Variables,
): { readonly ref: number; readonly value: number } {
  const ref = resolveIndexedRef(readU16(slot), slot, vars);
  return { ref, value: derefRead(ref, slot, vars) };
}

/**
 * Render a (post-`resolveIndexedRef`) ref word as a human-readable
 * label. The encoding (already documented in the file header):
 *   bit 15 (0x8000) → bit-var
 *   bit 14 (0x4000) → local var
 *   else            → global var
 * Indexed (0x2000) bit is already cleared by `resolveIndexedRef`.
 */
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
 * Read a SCUMM "var-or-direct byte" parameter — when `paramIndex`'s
 * mode bit is set on `modeByte`, the next two bytes are a var-ref word
 * (dereferenced); otherwise the next byte is a direct u8 immediate.
 *
 * Used for multi-subop opcodes (cursorCommand, stringOps, roomOps, …)
 * where the *subop byte itself* carries per-arg mode flags — same
 * bit positions as on the main opcode (0x80 = arg1, 0x40 = arg2,
 * 0x20 = arg3).
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
 * Read a SCUMM "var-or-direct word" parameter. Variable form reads a
 * dereffed var-ref word (2 bytes); direct form reads a SIGNED i16 LE
 * immediate — v5 direct words are signed (like jump offsets), so e.g.
 * `0xFFFE` is the sentinel `-2`, not 65534. Reading it unsigned silently
 * broke signed comparisons: the insult-duel loss signal `startScript 74
 * [65534]` (= -2) was stored as 65534, so `#74`'s `isGreater L0 val=0`
 * scored every lost exchange as a WIN (you could never lose a swordfight).
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
 * Read a v5 word-vararg list — a sequence of `(markerByte, u16 value)`
 * pairs terminated by `0xFF`. Each marker's `0x80` bit selects var-ref
 * vs immediate for its value, exactly like a subop's arg mode. Returns
 * the decoded values in order.
 *
 * Used by opcodes like cursorCommand's `charsetColor` subop and the
 * various `*List` argument forms.
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
