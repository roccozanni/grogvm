/**
 * SCUMM v5 linear disassembler — the static consumer of the opcode
 * registry (opcodes/registry.ts), which the executing dispatcher also
 * reads, so operand layouts live exactly once. An undecodable byte
 * yields `aligned: false` and stops the sweep — misalignment is loud,
 * never silent garbage.
 */

import { OPCODE_DEFS } from './opcodes/index';
import { StaticReader, formatVarRef } from './opcodes/operands';

export { formatVarRef };

/** One decoded instruction. */
export interface DisasmInstruction {
  /** Byte offset of the opcode within the script. */
  readonly offset: number;
  /** The opcode byte (with param-mode bits). */
  readonly opcode: number;
  /** Decoded mnemonic + operands, e.g. `move g7 = 100`. */
  readonly text: string;
  /**
   * False when the decoder could not decode this byte (unknown opcode
   * or sub-op) — the sweep stops after the first such instruction.
   */
  readonly aligned: boolean;
}

/** Disassemble a whole script into a list of instructions. */
export function disassemble(bytecode: Uint8Array): DisasmInstruction[] {
  const out: DisasmInstruction[] = [];
  let p = 0;
  while (p < bytecode.length) {
    const offset = p;
    const opcode = bytecode[p]!;
    let text: string;
    let end = p + 1;
    try {
      const res = decodeInstruction(bytecode, opcode, p + 1);
      text = res.text;
      end = res.end;
    } catch (e) {
      text = `<<error: ${e instanceof Error ? e.message : String(e)}>>`;
    }
    const aligned = !text.includes('<<');
    out.push({ offset, opcode, text, aligned });
    if (!aligned) break;
    p = end;
  }
  return out;
}

/** Decode one instruction's text via the registry. */
function decodeInstruction(
  b: Uint8Array,
  opcode: number,
  start: number,
): { text: string; end: number } {
  const def = OPCODE_DEFS.get(opcode);
  if (!def) {
    throw new Error(`UNKNOWN 0x${opcode.toString(16)}`);
  }
  const r = new StaticReader(b, start);
  const text =
    def.kind === 'decoded'
      ? def.format(def.decode(r, opcode), opcode)
      : def.disasm(r, opcode, (op2, r2) => {
          const res = decodeInstruction(b, op2, r2.pc);
          r2.pc = res.end;
          return res.text;
        });
  return { text, end: r.pc };
}
