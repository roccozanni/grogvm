/**
 * The opcode registry: one `defineOp` per family carries opcode bytes,
 * operand decode, execution, and disassembly text — the executing
 * dispatcher and the disassembler both read this table, so operand
 * layouts cannot drift between them.
 */

import type { ScriptSlot } from '../slot';
import type { OpcodeHandler, Vm } from '../vm';
import { LiveReader, StaticReader, type OperandReader } from './operands';

export interface ExecCtx {
  readonly opcode: number;
  /** PC of the opcode byte itself (`wait` rewinds here). */
  readonly startPc: number;
}

export interface DecodedDef<D> {
  readonly kind: 'decoded';
  readonly name: string;
  readonly decode: (r: OperandReader, opcode: number) => D;
  readonly exec: (vm: Vm, slot: ScriptSlot, d: D, ctx: ExecCtx) => void;
  readonly format: (d: D, opcode: number) => string;
}

/**
 * Escape hatch for `expression`, whose stream interleaves nested opcode
 * execution with decoding: exec stays a streaming handler; `disasm`
 * decodes statically, recursing into full instructions via `nested`.
 */
export interface RawDef {
  readonly kind: 'raw';
  readonly name: string;
  readonly exec: OpcodeHandler;
  readonly disasm: (
    r: StaticReader,
    opcode: number,
    nested: (opcode: number, r: StaticReader) => string,
  ) => string;
}

export type OpDef = DecodedDef<unknown> | RawDef;

const table = new Map<number, OpDef>();

/** The registry, keyed by opcode byte — the disassembler's lookup table. */
export const OPCODE_DEFS: ReadonlyMap<number, OpDef> = table;

function registerDef(name: string, opcodes: readonly number[], def: OpDef): void {
  for (const op of opcodes) {
    if (table.has(op)) {
      throw new Error(`opcode 0x${op.toString(16)} registered twice (${name})`);
    }
    table.set(op, def);
  }
}

export function defineOp<D>(def: {
  name: string;
  opcodes: readonly number[];
  decode: (r: OperandReader, opcode: number) => D;
  exec: (vm: Vm, slot: ScriptSlot, d: D, ctx: ExecCtx) => void;
  format: (d: D, opcode: number) => string;
}): void {
  registerDef(def.name, def.opcodes, {
    kind: 'decoded',
    name: def.name,
    decode: def.decode,
    exec: def.exec,
    format: def.format,
  } as OpDef);
}

export function defineRawOp(def: {
  name: string;
  opcodes: readonly number[];
  exec: OpcodeHandler;
  disasm: RawDef['disasm'];
}): void {
  registerDef(def.name, def.opcodes, {
    kind: 'raw',
    name: def.name,
    exec: def.exec,
    disasm: def.disasm,
  });
}

/** Compose the registry into the dispatcher's `Map<opcode, OpcodeHandler>`. */
export function buildSeedOpcodes(): ReadonlyMap<number, OpcodeHandler> {
  const out = new Map<number, OpcodeHandler>();
  for (const [op, def] of table) {
    out.set(op, compose(def));
  }
  return out;
}

function compose(def: OpDef): OpcodeHandler {
  if (def.kind === 'raw') return def.exec;
  return (vm, slot, opcode) => {
    const ctx: ExecCtx = { opcode, startPc: slot.pc - 1 };
    const d = def.decode(new LiveReader(slot, vm.vars), opcode);
    def.exec(vm, slot, d, ctx);
  };
}
