import { describe, expect, it } from 'vitest';
import { SEED_OPCODES } from './opcodes/index';
import { Vm } from './vm';

function makeVm(
  resolveGlobalScript?: (id: number) => { bytecode: Uint8Array; room: number },
): Vm {
  return new Vm({
    numVariables: 800,
    numBitVariables: 2048,
    handlers: SEED_OPCODES,
    resolveGlobalScript,
  });
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

// ─── doSentence opcode (0x19) ───────────────────────────────────────────

describe('doSentence opcode', () => {
  it('enqueues a (verb, objectA, objectB) sentence (direct operands)', () => {
    const vm = makeVm();
    // 0x19, verb=7 (u8), objectA=0x0140=320 (u16 LE), objectB=0x0002=2.
    vm.startScript({ scriptId: 1, bytecode: bytes(0x19, 7, 0x40, 0x01, 0x02, 0x00) });
    vm.step();
    expect(vm.sentenceStack).toEqual([{ verb: 7, objectA: 320, objectB: 2 }]);
  });

  it('clears the queue when verb is 0xFE and reads no object operands', () => {
    const vm = makeVm();
    vm.pushSentence({ verb: 1, objectA: 2, objectB: 3 });
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x19, 0xfe, 0x00) });
    vm.step();
    expect(vm.sentenceStack).toEqual([]);
    // Only the verb byte was consumed (pc = 1 opcode + 1 verb byte).
    expect(slot.pc).toBe(2);
  });

  it('reads operands from variables in var-mode (0x79 = bits 0x40|0x20 set)', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(100, 11); // objectA source
    vm.vars.writeGlobal(101, 22); // objectB source
    // 0x79 sets param2 (0x40) + param3 (0x20) var-mode; param1 (verb)
    // stays direct. verb=4, objectA=var100, objectB=var101.
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x79, 4, 100, 0x00, 101, 0x00),
    });
    vm.step();
    expect(vm.sentenceStack).toEqual([{ verb: 4, objectA: 11, objectB: 22 }]);
  });
});

// ─── sentence driver (processSentence) ──────────────────────────────────

describe('processSentence', () => {
  const SCRIPT_ID = 42;
  const SENTENCE_BYTECODE = bytes(0x80, 0x00); // breakHere, stopObjectCode

  function vmWithSentenceScript(): Vm {
    const vm = makeVm((id) =>
      id === SCRIPT_ID
        ? { bytecode: SENTENCE_BYTECODE, room: 3 }
        : (() => {
            throw new Error(`unexpected script id ${id}`);
          })(),
    );
    vm.vars.writeGlobal(Vm.VAR_SENTENCE_SCRIPT, SCRIPT_ID);
    return vm;
  }

  it('starts the sentence script with [verb, objA, objB] locals + label', () => {
    const vm = vmWithSentenceScript();
    vm.pushSentence({ verb: 5, objectA: 60, objectB: 0 });

    const slot = vm.processSentence();
    expect(slot).not.toBeNull();
    expect(slot!.scriptId).toBe(SCRIPT_ID);
    expect(slot!.label).toBe('SENTENCE-5-60-0');
    expect(slot!.room).toBe(3);
    expect(slot!.locals[0]).toBe(5);
    expect(slot!.locals[1]).toBe(60);
    expect(slot!.locals[2]).toBe(0);
    // The sentence was consumed.
    expect(vm.sentenceStack).toEqual([]);
  });

  it('pops the most-recently pushed sentence first (LIFO)', () => {
    const vm = vmWithSentenceScript();
    vm.pushSentence({ verb: 1, objectA: 10, objectB: 0 });
    vm.pushSentence({ verb: 2, objectA: 20, objectB: 0 });

    const slot = vm.processSentence();
    expect(slot!.label).toBe('SENTENCE-2-20-0');
    expect(vm.sentenceStack).toEqual([{ verb: 1, objectA: 10, objectB: 0 }]);
  });

  it('returns null when the queue is empty', () => {
    const vm = vmWithSentenceScript();
    expect(vm.processSentence()).toBeNull();
  });

  it('does not re-enter while the sentence script is already running', () => {
    const vm = vmWithSentenceScript();
    vm.pushSentence({ verb: 1, objectA: 10, objectB: 0 });
    const first = vm.processSentence();
    expect(first).not.toBeNull();
    // first slot is now running (breakHere yields, but status != dead).
    vm.pushSentence({ verb: 2, objectA: 20, objectB: 0 });
    expect(vm.processSentence()).toBeNull();
    // The second sentence stays queued for a later tick.
    expect(vm.sentenceStack).toEqual([{ verb: 2, objectA: 20, objectB: 0 }]);
  });

  it('returns null when VAR_SENTENCE_SCRIPT is unset (0)', () => {
    const vm = vmWithSentenceScript();
    vm.vars.writeGlobal(Vm.VAR_SENTENCE_SCRIPT, 0);
    vm.pushSentence({ verb: 1, objectA: 10, objectB: 0 });
    expect(vm.processSentence()).toBeNull();
    // Sentence is left intact for when the script id becomes available.
    expect(vm.sentenceStack.length).toBe(1);
  });
});

// ─── reset + clear ──────────────────────────────────────────────────────

describe('sentence state lifecycle', () => {
  it('clearSentence drops all pending sentences', () => {
    const vm = makeVm();
    vm.pushSentence({ verb: 1, objectA: 2, objectB: 3 });
    vm.pushSentence({ verb: 4, objectA: 5, objectB: 6 });
    vm.clearSentence();
    expect(vm.sentenceStack).toEqual([]);
  });

  it('reset() clears the sentence stack', () => {
    const vm = makeVm();
    vm.pushSentence({ verb: 1, objectA: 2, objectB: 3 });
    vm.reset();
    expect(vm.sentenceStack).toEqual([]);
  });
});
