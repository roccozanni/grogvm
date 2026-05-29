import { describe, expect, it } from 'vitest';
import { SEED_OPCODES } from './opcodes/index';
import { Vm } from './vm';

function makeVm(
  resolve?: (id: number) => { bytecode: Uint8Array; room: number },
): Vm {
  return new Vm({
    numVariables: 800,
    numBitVariables: 2048,
    handlers: SEED_OPCODES,
    resolveGlobalScript: resolve,
  });
}
const bytes = (...v: number[]) => new Uint8Array(v);

describe('freezeScripts', () => {
  it('freezes other slots (skipping the caller); frozen slots are not runnable', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    const b = vm.startScript({ scriptId: 2, bytecode: bytes(0x80) });
    vm.freezeScripts(false, b.slotIndex); // b is the caller
    expect(a.freezeCount).toBe(1);
    expect(a.runnable).toBe(false);
    expect(b.freezeCount).toBe(0); // caller spared
    expect(b.runnable).toBe(true);
  });

  it('is cumulative; unfreezeAllScripts thaws everything', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.freezeScripts(false, -1);
    vm.freezeScripts(false, -1);
    expect(a.freezeCount).toBe(2);
    vm.unfreezeAllScripts();
    expect(a.freezeCount).toBe(0);
    expect(a.runnable).toBe(true);
  });

  it('spares freeze-resistant slots unless forced (flag >= 0x80)', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: bytes(0x80), freezeResistant: true });
    vm.freezeScripts(false, -1);
    expect(a.freezeCount).toBe(0); // skipped
    vm.freezeScripts(true, -1); // force
    expect(a.freezeCount).toBe(1);
  });

  it('the scheduler skips frozen slots in step()', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: bytes(0x80, 0x00) });
    const b = vm.startScript({ scriptId: 2, bytecode: bytes(0x80, 0x00) });
    a.freeze();
    // Only b should run; a stays put.
    const ran = vm.step();
    expect(ran).toBe(b);
    expect(a.pc).toBe(0);
  });
});

describe('cutscene / endCutscene', () => {
  it('pushes and pops the cutscene stack', () => {
    const vm = makeVm();
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    expect(vm.cutsceneStack.length).toBe(1);
    vm.endCutscene();
    expect(vm.cutsceneStack.length).toBe(0);
  });

  it('protects the cutscene script from a freezeScripts during the cutscene', () => {
    const vm = makeVm();
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    // A different script freezes everything — the cutscene caller is spared
    // (this is exactly what MI1's #18 does to the credits script).
    vm.freezeScripts(false, 99);
    expect(caller.freezeCount).toBe(0);
    expect(caller.runnable).toBe(true);
  });

  it('runs VAR_CUTSCENE_START_SCRIPT on begin and VAR_CUTSCENE_END_SCRIPT on end', () => {
    const started: number[] = [];
    const vm = makeVm((id) => {
      started.push(id);
      return { bytecode: bytes(0xa0), room: 1 };
    });
    vm.vars.writeGlobal(Vm.VAR_CUTSCENE_START_SCRIPT, 18);
    vm.vars.writeGlobal(Vm.VAR_CUTSCENE_END_SCRIPT, 19);
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    expect(started).toContain(18);
    vm.endCutscene();
    expect(started).toContain(19);
  });

  it('clears VAR_OVERRIDE on begin and end', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_OVERRIDE, 7);
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    expect(vm.vars.readGlobal(Vm.VAR_OVERRIDE)).toBe(0);
  });

  it('reset() clears the cutscene stack', () => {
    const vm = makeVm();
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    vm.reset();
    expect(vm.cutsceneStack.length).toBe(0);
  });
});
