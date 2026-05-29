import { describe, expect, it } from 'vitest';
import { SEED_OPCODES } from './opcodes/index';
import { Vm } from './vm';

function makeVm(): Vm {
  return new Vm({ numVariables: 100, numBitVariables: 64, handlers: SEED_OPCODES });
}
const bytes = (...v: number[]) => new Uint8Array(v);

describe('talk timing (VAR_HAVE_MSG)', () => {
  it('beginTalk sets VAR_HAVE_MSG and a length-based talk delay', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_CHARINC, 3);
    vm.beginTalk('a'.repeat(50)); // 50 × 3 = 150 ticks
    expect(vm.talkDelay).toBe(150);
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(1);
  });

  it('floors the delay so short lines still linger', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_CHARINC, 1);
    vm.beginTalk('Hi'); // 2 × 1 = 2, floored to 30
    expect(vm.talkDelay).toBe(30);
  });

  it('beginTick counts the timer down and clears VAR_HAVE_MSG at zero', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_CHARINC, 1);
    vm.beginTalk('Hi'); // talkDelay = 30
    for (let i = 0; i < 29; i++) vm.beginTick();
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(1); // still talking
    vm.beginTick();
    expect(vm.talkDelay).toBe(0);
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
  });

  it('endTalk clears immediately', () => {
    const vm = makeVm();
    vm.beginTalk('something');
    vm.endTalk();
    expect(vm.talkDelay).toBe(0);
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
  });

  it('a text print starts the talk timer; an empty print clears it', () => {
    const vm = makeVm();
    // printEgo "Hi": 0xD8, subop 0x0F (TEXTSTRING), 'H','i', 0x00, stop.
    // (SCUMM strings are NUL-terminated; 0xFF NN is an inline escape.)
    vm.startScript({ scriptId: 1, bytecode: bytes(0xd8, 0x0f, 0x48, 0x69, 0x00, 0xa0) });
    vm.step();
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(1);
    expect(vm.talkDelay).toBeGreaterThan(0);
    // empty printEgo clears.
    vm.startScript({ scriptId: 2, bytecode: bytes(0xd8, 0x0f, 0x00, 0xa0) });
    while (vm.slots.find((s) => s.scriptId === 2 && s.runnable)) vm.step();
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
    expect(vm.activeDialog).toBeNull();
  });

  it('wait-for-message blocks while talking and releases when the timer drains', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(Vm.VAR_CHARINC, 1);
    vm.beginTalk('Hi'); // talkDelay = 30, HAVE_MSG = 1
    // wait-message (0xAE 0x02), then stop.
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x02, 0xa0) });
    vm.step();
    expect(slot.status).toBe('yielded'); // blocked
    expect(slot.pc).toBe(0); // rewound to re-check
    for (let i = 0; i < 30; i++) vm.beginTick(); // drain the timer
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
    slot.resume();
    vm.step(); // re-runs wait-message; now passes
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(2); // consumed the wait, didn't rewind
  });
});
