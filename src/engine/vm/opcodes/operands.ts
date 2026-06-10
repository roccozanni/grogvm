/**
 * Operand readers shared by the executing dispatcher (live: derefs vars,
 * advances the slot PC) and the disassembler (static: labels var-refs,
 * never derefs). Encoding: pages/docs/scumm/opcodes.md.
 */

import {
  isVarParam,
  ParamError,
  readDestRef,
  readI16,
  readU8,
  readU16,
  readVarOrByte,
  readVarOrWord,
  readVarRefWithRef,
  readWordVararg,
  formatRefLabel,
} from '../params';
import type { ScriptSlot } from '../slot';
import type { Variables } from '../variables';

/**
 * One decoded value operand. `value` is real in live mode; in static mode
 * only when `known` (immediates). Interpolates as `label` in templates.
 */
export interface Val {
  readonly value: number;
  readonly known: boolean;
  readonly label: string;
}

/** A result/destination var-ref. `ref` is writeRef-able in live mode only. */
export interface DestRef {
  readonly ref: number;
  readonly label: string;
}

function val(value: number, known: boolean, label: string): Val {
  return { value, known, label, toString: () => label } as Val;
}

function dest(ref: number, label: string): DestRef {
  return { ref, label, toString: () => label } as DestRef;
}

/** The operand vocabulary an opcode's `decode` is written against. */
export interface OperandReader {
  u8(): number;
  u16(): number;
  i16(): number;
  /** Var-or-byte value; mode bit `paramIndex` taken from `modeByte`. */
  p8(modeByte: number, paramIndex: 1 | 2 | 3): Val;
  /** Var-or-word value (signed immediate). */
  p16(modeByte: number, paramIndex: 1 | 2 | 3): Val;
  /** A bare var-ref operand (always a var read, no mode bit). */
  variable(): Val;
  /** A result/destination var-ref (indexed form folded in live mode). */
  dest(): DestRef;
  /** 0xFF-terminated var-or-word list. */
  varargs(): Val[];
  /** Escape-aware SCUMM string to NUL — raw bytes, escapes included. */
  scummString(): Uint8Array;
  /** Verbatim bytes to NUL, no escape awareness (stringOps/roomOps literals). */
  rawString(): Uint8Array;
}

/**
 * Render a (possibly indexed) var-ref word: `g7`, `L3`, `bit#12`, with a
 * `[...]` suffix for the indexed (0x2000) form; `next` supplies the extra
 * word the indexed form carries.
 */
export function formatVarRef(word: number, next?: () => number): string {
  let suffix = '';
  if (word & 0x2000 && next) {
    const off = next();
    suffix = off & 0x2000 ? `[${formatVarRef(off & ~0x2000, next)}]` : `[${off & 0x1fff}]`;
    word &= ~0x2000;
  }
  if (word & 0x8000) return `bit#${word & 0x7fff}${suffix}`;
  if (word & 0x4000) return `L${word & 0x0fff}${suffix}`;
  return `g${word & 0x1fff}${suffix}`;
}

/** Render bytes for display: printable ASCII verbatim, else `\xNN`. */
export function renderBytes(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i]!;
    out += x >= 32 && x < 127 ? String.fromCharCode(x) : `\\x${x.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * Scan a SCUMM string to its 0x00 terminator: a 0xFF/0xFE escape with code
 * >= 4 carries a 2-byte argument that may itself contain 0x00, so a naive
 * scan-to-NUL truncates. Returns the payload (terminator excluded) and the
 * cursor position just past it.
 */
export function scanScummString(b: Uint8Array, p: number): { payload: Uint8Array; end: number } {
  const start = p;
  while (p < b.length) {
    const c = b[p]!;
    if (c === 0x00) return { payload: b.slice(start, p), end: p + 1 };
    if (c === 0xff || c === 0xfe) {
      const code = b[p + 1] ?? 0;
      p += code >= 4 ? 4 : 2;
      continue;
    }
    p++;
  }
  throw new ParamError('SCUMM string: missing 0x00 terminator');
}

function scanRawString(b: Uint8Array, p: number): { payload: Uint8Array; end: number } {
  const start = p;
  while (p < b.length && b[p] !== 0x00) p++;
  if (p >= b.length) throw new ParamError('string: missing 0x00 terminator');
  return { payload: b.slice(start, p), end: p + 1 };
}

/** Live reader: operands come off the slot's PC, var-refs deref for real. */
export class LiveReader implements OperandReader {
  constructor(
    private readonly slot: ScriptSlot,
    private readonly vars: Variables,
  ) {}

  u8(): number {
    return readU8(this.slot);
  }
  u16(): number {
    return readU16(this.slot);
  }
  i16(): number {
    return readI16(this.slot);
  }
  p8(modeByte: number, paramIndex: 1 | 2 | 3): Val {
    const v = readVarOrByte(modeByte, paramIndex, this.slot, this.vars);
    return val(v, true, `${v}`);
  }
  p16(modeByte: number, paramIndex: 1 | 2 | 3): Val {
    const v = readVarOrWord(modeByte, paramIndex, this.slot, this.vars);
    return val(v, true, `${v}`);
  }
  variable(): Val {
    const { ref, value } = readVarRefWithRef(this.slot, this.vars);
    return val(value, true, formatRefLabel(ref));
  }
  dest(): DestRef {
    const ref = readDestRef(this.slot, this.vars);
    return dest(ref, formatRefLabel(ref));
  }
  varargs(): Val[] {
    return readWordVararg(this.slot, this.vars).map((v) => val(v, true, `${v}`));
  }
  scummString(): Uint8Array {
    const { payload, end } = scanScummString(this.slot.bytecode, this.slot.pc);
    this.slot.pc = end;
    return payload;
  }
  rawString(): Uint8Array {
    const { payload, end } = scanRawString(this.slot.bytecode, this.slot.pc);
    this.slot.pc = end;
    return payload;
  }
}

/**
 * Static reader: a bounds-checked cursor over raw bytes. Var operands are
 * never dereferenced — they yield `known: false` with a formatted label.
 */
export class StaticReader implements OperandReader {
  pc: number;

  constructor(
    private readonly b: Uint8Array,
    start: number,
  ) {
    this.pc = start;
  }

  u8(): number {
    if (this.pc + 1 > this.b.length) {
      throw new ParamError(`u8 read past end (pc=${this.pc}, len=${this.b.length})`);
    }
    return this.b[this.pc++]!;
  }
  u16(): number {
    if (this.pc + 2 > this.b.length) {
      throw new ParamError(`u16 read past end (pc=${this.pc}, len=${this.b.length})`);
    }
    const v = this.b[this.pc]! | (this.b[this.pc + 1]! << 8);
    this.pc += 2;
    return v;
  }
  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  p8(modeByte: number, paramIndex: 1 | 2 | 3): Val {
    if (isVarParam(modeByte, paramIndex)) return this.variable();
    const v = this.u8();
    return val(v, true, `${v}`);
  }
  p16(modeByte: number, paramIndex: 1 | 2 | 3): Val {
    if (isVarParam(modeByte, paramIndex)) return this.variable();
    const v = this.i16();
    return val(v, true, `${v}`);
  }
  variable(): Val {
    const label = formatVarRef(this.u16(), () => this.u16());
    return val(0, false, label);
  }
  dest(): DestRef {
    const word = this.u16();
    const label = word & 0x2000 ? formatVarRef(word, () => this.u16()) : formatVarRef(word);
    return dest(word, label);
  }
  varargs(): Val[] {
    const out: Val[] = [];
    while (true) {
      const marker = this.u8();
      if (marker === 0xff) break;
      out.push(this.p16(marker, 1));
    }
    return out;
  }
  scummString(): Uint8Array {
    const { payload, end } = scanScummString(this.b, this.pc);
    this.pc = end;
    return payload;
  }
  rawString(): Uint8Array {
    const { payload, end } = scanRawString(this.b, this.pc);
    this.pc = end;
    return payload;
  }
}
