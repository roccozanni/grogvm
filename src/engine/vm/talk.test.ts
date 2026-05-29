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

describe('talk color + positioning defaults', () => {
  it('actor talk defaults to the actor talk color + overhead/centred', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(1, 1); // VAR_EGO = actor 1
    const a = vm.actors.get(1);
    a.room = 1;
    a.talkColor = 15;
    // printEgo "Hi" with no SO_AT / SO_COLOR.
    vm.startScript({ scriptId: 1, bytecode: bytes(0xd8, 0x0f, 0x48, 0x69, 0x00, 0xa0) });
    vm.step();
    const d = vm.activeDialog!;
    expect(d.actorId).toBe(1); // printEgo resolved to ego
    expect(d.color).toBe(15); // actor talk color, not the 0x0F default
    expect(d.overhead).toBe(true);
    expect(d.center).toBe(true);
  });

  it('explicit SO_AT / SO_COLOR override the talk defaults', () => {
    const vm = makeVm();
    const a = vm.actors.get(2);
    a.room = 1;
    a.talkColor = 7;
    // print actor=2, SO_AT(10,20), SO_COLOR(5), TEXTSTRING "Hi".
    vm.startScript({
      scriptId: 1,
      bytecode: bytes(
        0x14, 0x02,
        0x00, 0x0a, 0x00, 0x14, 0x00, // SO_AT 10,20
        0x01, 0x05, // SO_COLOR 5
        0x0f, 0x48, 0x69, 0x00, // TEXTSTRING "Hi"
        0xa0,
      ),
    });
    vm.step();
    const d = vm.activeDialog!;
    expect(d.color).toBe(5); // explicit, not talkColor
    expect(d.x).toBe(10);
    expect(d.y).toBe(20);
    expect(d.overhead).toBe(false); // SO_AT given → not talk-overhead
  });

  it('a system message (no valid speaker) stays bottom-centre, default ink', () => {
    const vm = makeVm();
    // print actor=255 (out of range → no speaker), TEXTSTRING "Hi".
    vm.startScript({ scriptId: 1, bytecode: bytes(0x14, 0xff, 0x0f, 0x48, 0x69, 0x00, 0xa0) });
    vm.step();
    const d = vm.activeDialog!;
    expect(d.overhead).toBe(false);
    expect(d.color).toBe(0x0f);
  });
});
