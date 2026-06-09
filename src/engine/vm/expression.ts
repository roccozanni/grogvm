/**
 * SCUMM v5 `expression` opcode (0xAC) — a stack mini-VM embedded in the
 * opcode stream. Encoding in pages/docs/scumm/opcode-reference.md.
 */

import { isVarParam, readU16, readVarRef, readU8, readDestRef, writeRef } from './params';
import type { ScriptSlot } from './slot';
import type { Variables } from './variables';
import type { Vm } from './vm';

export class ExpressionError extends Error {
  constructor(detail: string) {
    super(`Expression error: ${detail}`);
    this.name = 'ExpressionError';
  }
}

/**
 * Evaluate one expression at the slot's current PC (the opcode byte already
 * consumed); on exit PC sits past the 0xFF terminator and the destination
 * is written. `vm` is needed only by subop 0x06 (nested opcode).
 */
export function evalExpression(slot: ScriptSlot, vars: Variables, vm: Vm | null = null): void {
  // The dest can be the indexed/array form (bit 0x2000) with a trailing
  // index word — readDestRef consumes it; reading a bare u16 desyncs the
  // PC on an indexed dest like `g221[L0] = …`.
  const dest = readDestRef(slot, vars);

  const stack: number[] = [];

  // Runaway guard — real expressions are a handful of subops.
  const MAX_SUBOPS = 1024;
  let stepsTaken = 0;

  while (true) {
    if (stepsTaken++ > MAX_SUBOPS) {
      throw new ExpressionError(
        `subop budget exceeded (${MAX_SUBOPS}) without hitting terminator`,
      );
    }
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x1f;
    switch (action) {
      case 0x01: {
        // push value — bit 7 of subop selects immediate vs var-ref.
        if (isVarParam(sub, 1)) {
          stack.push(readVarRef(slot, vars));
        } else {
          stack.push(readU16(slot));
        }
        break;
      }
      case 0x02: {
        const b = pop(stack);
        const a = pop(stack);
        stack.push((a + b) | 0);
        break;
      }
      case 0x03: {
        const b = pop(stack);
        const a = pop(stack);
        stack.push((a - b) | 0);
        break;
      }
      case 0x04: {
        const b = pop(stack);
        const a = pop(stack);
        stack.push(Math.imul(a, b));
        break;
      }
      case 0x05: {
        const b = pop(stack);
        const a = pop(stack);
        if (b === 0) throw new ExpressionError('divide by zero');
        // SCUMM uses signed integer truncating division.
        stack.push((a / b) | 0);
        break;
      }
      case 0x06: {
        // Dispatch the next byte as a main opcode, then push VAR_RESULT
        // (global #0) — v5's value-returning convention.
        if (!vm) {
          throw new ExpressionError(
            `nested opcode (subop 0x06) requires a Vm reference`,
          );
        }
        const nestedOp = readU8(slot);
        vm.dispatchInline(slot, nestedOp);
        stack.push(vars.readGlobal(0));
        break;
      }
      default:
        throw new ExpressionError(
          `unknown subop 0x${sub.toString(16).padStart(2, '0')}`,
        );
    }
  }

  if (stack.length !== 1) {
    throw new ExpressionError(
      `stack should hold exactly one value at terminator, got ${stack.length}`,
    );
  }
  writeRef(dest, stack[0]!, slot, vars);
}

function pop(stack: number[]): number {
  const v = stack.pop();
  if (v === undefined) throw new ExpressionError('pop from empty stack');
  return v;
}
