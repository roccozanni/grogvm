/**
 * SCUMM v5 expression opcode (0xAC) — a tiny stack-based mini-VM
 * embedded in the main opcode stream.
 *
 * Layout:
 *
 *   0xAC opcode
 *   u16   dest var-ref
 *   <subops, each starting with a u8 selector, until 0xFF>
 *   0xFF  terminator
 *
 * At terminator the single remaining stack value is written into the
 * destination variable.
 *
 * # Subop encoding
 *
 * The subop byte is split: bits 0..4 select the operation, bit 7
 * selects parameter mode for the push subop's value (var-ref vs
 * immediate u16). Same convention as the main opcode byte. The bits
 * 5/6 are unused for these subops.
 *
 *   `subop & 0x1F`    action
 *   --------------    -------------------------------------------------
 *   0x01              push value (next 2 bytes: u16 immediate, or var-
 *                     ref u16 when bit 7 of subop is set → byte 0x81)
 *   0x02              add — `push(pop() + pop())`
 *   0x03              sub — `i = pop(); push(pop() - i)`
 *   0x04              mul
 *   0x05              div — throws on divide-by-zero
 *   0x06              execute opcode (next byte is a main opcode that
 *                     mutates VAR(0); push VAR(0) after dispatch)
 *
 *   0xFF              end
 *
 * For now subop 6 (nested-opcode) throws — we'll add it once the boot
 * script demands it. Halts use the same "loud halt" philosophy as the
 * main dispatcher.
 *
 * The expression stack is local to the evaluation — there's no
 * cross-call retention. We use a small per-call array; depth is
 * tiny in practice (boot scripts rarely exceed 4–6 deep).
 */

import { isVarParam, readU16, readVarRef, readU8, writeRef } from './params';
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
 * Evaluate one `0xAC expression` opcode at the slot's current PC.
 * On entry the opcode byte itself has already been consumed; PC
 * sits at the dest var-ref. On exit PC sits after the 0xFF terminator
 * and the destination variable has been written.
 *
 * `vm` is required so subop 0x06 ("nested opcode") can dispatch
 * arbitrary main opcodes by name lookup. Pass `null` only in tests
 * that don't exercise that subop — calling it will throw.
 */
export function evalExpression(slot: ScriptSlot, vars: Variables, vm: Vm | null = null): void {
  // The dest var-ref is always a raw reference word — no mode bit on
  // an expression destination (it's the equivalent of setVar's dest).
  const dest = readU16(slot);

  const stack: number[] = [];

  // Soft depth cap matches the runUntilAllYield runaway-guard ethos:
  // expressions are tiny in practice, so anything over a few hundred
  // subops is almost certainly a malformed stream.
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
        // Nested opcode: read the next byte, dispatch as a regular
        // main opcode, then push global #0 (VAR_RESULT) onto the
        // stack. SCUMM v5 convention: any opcode that "returns" a
        // value writes it into VAR_RESULT — getRandomNumber, the
        // `getActor*` family, etc. The nested-dispatch path here is
        // how scripts compose those into expressions.
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
