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

  it('runs the start/end scripts NESTED so freeze/unfreeze ordering is right', () => {
    // Regression: the room-33 "open the SCUMM Bar door" freeze. The start
    // script (#18) freezes every other slot; the end script (#19) unfreezes.
    // If they are merely queued (not run nested), a caller that does
    // cutScene…endCutScene in one run starts #18 AFTER #19 exists, so #18's
    // freeze catches #19 and it never unfreezes → input dead. Nested
    // execution runs each to completion in order.
    const scripts: Record<number, Uint8Array> = {
      18: bytes(0x60, 0x7f, 0xa0), // freezeScripts 127; stop
      19: bytes(0x60, 0x00, 0xa0), // freezeScripts 0 (thaw all); stop
    };
    const vm = makeVm((id) => ({ bytecode: scripts[id]!, room: 1 }));
    vm.vars.writeGlobal(Vm.VAR_CUTSCENE_START_SCRIPT, 18);
    vm.vars.writeGlobal(Vm.VAR_CUTSCENE_END_SCRIPT, 19);
    const bystander = vm.startScript({ scriptId: 5, bytecode: bytes(0x80, 0xa0) });
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });

    vm.beginCutscene([], caller.slotIndex);
    expect(bystander.freezeCount).toBe(1); // #18 ran nested → bystander frozen
    vm.endCutscene();
    expect(bystander.freezeCount).toBe(0); // #19 ran nested → thawed again
    expect(bystander.runnable).toBe(true);
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

describe('abortCutscene (Escape / override skip)', () => {
  it('is a no-op (false) when no cutscene is active', () => {
    const vm = makeVm();
    expect(vm.abortCutscene()).toBe(false);
  });

  it('is a no-op when the active cutscene armed no override (not skippable)', () => {
    const vm = makeVm();
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80) });
    vm.beginCutscene([], caller.slotIndex);
    expect(vm.abortCutscene()).toBe(false);
  });

  it('jumps the cutscene script to its override target, thaws it, sets VAR_OVERRIDE=1', () => {
    const vm = makeVm();
    const caller = vm.startScript({ scriptId: 1, bytecode: bytes(0x80, 0x80, 0x80, 0x00) });
    vm.beginCutscene([], caller.slotIndex);
    caller.overridePc = 3; // armed skip target (the trailing stop)
    caller.freeze();
    caller.yield_();
    expect(vm.abortCutscene()).toBe(true);
    expect(caller.pc).toBe(3);
    expect(caller.overridePc).toBe(null);
    expect(caller.freezeCount).toBe(0);
    expect(caller.status).toBe('running');
    expect(vm.vars.readGlobal(Vm.VAR_OVERRIDE)).toBe(1);
  });

  it('skips a base-level override armed with NO active cutscene (MI1 "le tre prove")', () => {
    // g#57 arms beginOverride after its setup cutscenes have already ended, so
    // the skippable gate runs with an empty cutscene stack. ESC must still skip.
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0x80, 0x80, 0x80, 0x00) });
    slot.overridePc = 3; // armed by beginOverride; no beginCutscene around it
    slot.yield_();
    expect(vm.cutsceneStack.length).toBe(0);
    expect(vm.abortCutscene()).toBe(true);
    expect(slot.pc).toBe(3);
    expect(slot.overridePc).toBe(null);
    expect(slot.status).toBe('running');
    expect(vm.vars.readGlobal(Vm.VAR_OVERRIDE)).toBe(1);
  });

  it('beginOverride opcode (0x58) records the skip target and clears VAR_OVERRIDE', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_OVERRIDE, 9);
    // 0x58 0x01 0x18 [delta=+2] — target is 2 bytes past the delta word.
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0x58, 0x01, 0x18, 0x02, 0x00, 0x80, 0x80, 0x00),
    });
    vm.step();
    expect(vm.vars.readGlobal(Vm.VAR_OVERRIDE)).toBe(0);
    expect(slot.overridePc).toBe(7); // pc after the operands (5) + delta (2)
  });
});
