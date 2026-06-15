/**
 * Tests for the execution tracer. The pure helpers (groupFrame/formatFrames)
 * run on hand-built trace entries; traceTicks drives a synthetic VM with a
 * couple of toy opcodes, so — like the other testkit drivers — none of this
 * needs the game data and it all runs under the default `npm test`.
 */
import { describe, expect, it } from 'vitest';
import { Vm, type OpcodeHandler, type TraceEntry } from '../engine/vm/vm';
import { formatFrames, groupFrame, traceTicks } from './trace';

const entry = (scriptId: number, pc: number, opcode: number, mnemonic?: string): TraceEntry => ({
  slotIndex: 0,
  scriptId,
  pc,
  opcode,
  mnemonic,
});

describe('groupFrame', () => {
  it('returns no runs for an empty frame', () => {
    expect(groupFrame([])).toEqual([]);
  });

  it('groups a single script run, preserving opcode order', () => {
    const runs = groupFrame([entry(5, 0, 0x80), entry(5, 1, 0x81)]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scriptId).toBe(5);
    expect(runs[0]!.ops.map((o) => o.pc)).toEqual([0, 1]);
  });

  it('starts a new run when the running script changes — including re-entry', () => {
    const runs = groupFrame([
      entry(5, 0, 0x01),
      entry(9, 0, 0x02),
      entry(5, 1, 0x03), // 5 re-entered after 9 ran: a distinct third run
    ]);
    expect(runs.map((r) => r.scriptId)).toEqual([5, 9, 5]);
    expect(runs.map((r) => r.ops.length)).toEqual([1, 1, 1]);
  });

  it('splits runs that share a scriptId but differ by slot', () => {
    const a = { ...entry(7, 0, 0x01), slotIndex: 0 };
    const b = { ...entry(7, 0, 0x01), slotIndex: 1 };
    expect(groupFrame([a, b])).toHaveLength(2);
  });
});

describe('formatFrames', () => {
  const frames = [
    { tick: 0, ran: 2, truncated: false, runs: groupFrame([entry(5, 0, 0x80, 'breakHere'), entry(5, 1, 0x00)]) },
    { tick: 6, ran: 70, truncated: true, runs: groupFrame([entry(9, 4, 0x01)]) },
  ];

  it('renders mnemonics when present and hex otherwise', () => {
    const lines = formatFrames(frames);
    expect(lines[0]).toBe('t0 ran=2');
    expect(lines[1]).toBe('  #5 breakHere@0 0x00@1');
  });

  it('flags ring truncation on the frame header', () => {
    expect(formatFrames(frames)[2]).toBe('t6 ran=70 (ring truncated)');
  });

  it('compact mode lists scripts with opcode counts, no opcode detail', () => {
    expect(formatFrames(frames, { ops: false })[1]).toBe('  #5 (2)');
  });
});

describe('traceTicks (synthetic)', () => {
  // 0x01: a no-op that just labels itself; 0x00: stop (kills the slot).
  const inc: OpcodeHandler = (vm) => vm.annotate('inc');
  const stop: OpcodeHandler = (vm, slot) => {
    vm.annotate('stop');
    slot.kill();
  };
  const makeVm = (): Vm => {
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map<number, OpcodeHandler>([
        [0x01, inc],
        [0x00, stop],
      ]),
    });
    vm.vars.writeGlobal(19, 1); // VAR_TIMER_NEXT: one frame per jiffy
    return vm;
  };

  it('captures the opcodes a script ran, grouped by the running slot, dropping idle jiffies', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 7, bytecode: new Uint8Array([0x01, 0x01, 0x00]) });
    const frames = traceTicks(vm, 10);
    // The whole script runs (and dies) in the first frame; later jiffies are idle.
    expect(frames).toHaveLength(1);
    expect(frames[0]!.tick).toBe(0);
    expect(frames[0]!.ran).toBe(3);
    // The two `inc`s run under script 7; `stop` (a kill) is recorded *after*
    // the slot's id was cleared, so it lands in a trailing scriptId-0 run —
    // the same VM quirk vm.test.ts's trace-ring test sidesteps. Pin it.
    expect(frames[0]!.runs.map((r) => r.scriptId)).toEqual([7, 0]);
    expect(frames[0]!.runs[0]!.ops.map((o) => o.mnemonic)).toEqual(['inc', 'inc']);
    expect(frames[0]!.runs[1]!.ops.map((o) => o.mnemonic)).toEqual(['stop']);
  });

  it('keepIdle emits the idle jiffies too', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 7, bytecode: new Uint8Array([0x00]) });
    const frames = traceTicks(vm, 4, { keepIdle: true });
    expect(frames).toHaveLength(4);
    expect(frames.slice(1).every((f) => f.ran === 0 && f.runs.length === 0)).toBe(true);
  });

  it('the scripts filter keeps only matching runs', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 7, bytecode: new Uint8Array([0x01, 0x00]) });
    expect(traceTicks(vm, 4, { scripts: new Set([999]) })).toHaveLength(0);
    const vm2 = makeVm();
    vm2.startScript({ scriptId: 7, bytecode: new Uint8Array([0x01, 0x00]) });
    expect(traceTicks(vm2, 4, { scripts: new Set([7]) })).toHaveLength(1);
  });
});
