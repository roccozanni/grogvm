import { describe, expect, it } from 'vitest';
import { SEED_OPCODES } from './opcodes/index';
import { Vm } from './vm';
import { VAR_EGO, VAR_HAVE_MSG } from './vars';

function makeVm(): Vm {
  return new Vm({ numVariables: 800, numBitVariables: 2048, handlers: SEED_OPCODES });
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

// 0xAE wait — SO_WAIT_FOR_ACTOR(1), MESSAGE(2), CAMERA(3), SENTENCE(4).
// When the condition isn't met the handler rewinds PC to the 0xAE byte
// and yields, so the next tick re-checks.

describe('wait opcode — SO_WAIT_FOR_ACTOR', () => {
  it('yields and rewinds PC while the actor is moving (direct operand)', () => {
    const vm = makeVm();
    vm.actors.get(3).isMoving = true;
    // 0xAE, subop 0x01 (actor, direct byte), actor id 3.
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x01, 0x03) });
    vm.step();
    expect(slot.status).toBe('yielded');
    expect(slot.pc).toBe(0); // rewound to the opcode byte
  });

  it('falls through when the actor is not moving', () => {
    const vm = makeVm();
    vm.actors.get(3).isMoving = false;
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x01, 0x03, 0x00) });
    vm.step();
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(3); // consumed opcode + subop + actor byte
  });

  it('reads the actor id from a var when subop bit 0x80 is set (0x81)', () => {
    const vm = makeVm();
    // This is exactly MI1 sentence script #2's `AE 81 01 00` = wait for
    // the actor in VAR_EGO. Point ego at actor 5 and make it move.
    vm.vars.writeGlobal(VAR_EGO, 5);
    vm.actors.get(5).isMoving = true;
    const slot = vm.startScript({
      scriptId: 1,
      bytecode: bytes(0xae, 0x81, VAR_EGO & 0xff, (VAR_EGO >> 8) & 0xff),
    });
    vm.step();
    expect(slot.status).toBe('yielded');
    expect(slot.pc).toBe(0);
  });

  it('resumes and falls through once the actor stops', () => {
    const vm = makeVm();
    const a = vm.actors.get(3);
    a.isMoving = true;
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x01, 0x03, 0x00) });
    vm.step(); // yields
    expect(slot.status).toBe('yielded');

    a.isMoving = false;
    slot.resume();
    vm.step(); // re-runs 0xAE, now ready → falls through
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(3);
  });
});

describe('wait opcode — other conditions', () => {
  it('SO_WAIT_FOR_MESSAGE yields while VAR_HAVE_MSG is set', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(VAR_HAVE_MSG, 1);
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x02) });
    vm.step();
    expect(slot.status).toBe('yielded');
    expect(slot.pc).toBe(0);
  });

  it('SO_WAIT_FOR_MESSAGE falls through when VAR_HAVE_MSG is 0', () => {
    const vm = makeVm();
    vm.vars.writeGlobal(VAR_HAVE_MSG, 0);
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x02, 0x00) });
    vm.step();
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(2);
  });

  it('SO_WAIT_FOR_SENTENCE yields while the queue is non-empty', () => {
    const vm = makeVm();
    vm.pushSentence({ verb: 1, objectA: 2, objectB: 0 });
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x04) });
    vm.step();
    expect(slot.status).toBe('yielded');
  });

  it('SO_WAIT_FOR_SENTENCE falls through when the queue is empty', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x04, 0x00) });
    vm.step();
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(2);
  });

  it('SO_WAIT_FOR_CAMERA falls through when no pan is armed', () => {
    const vm = makeVm();
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x03, 0x00) });
    vm.step();
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(2);
  });

  it('SO_WAIT_FOR_CAMERA yields while a pan is in flight', () => {
    const vm = makeVm();
    vm.camera.x = 160;
    vm.cameraDest = 480;
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x03, 0x00) });
    vm.step();
    expect(slot.status).toBe('yielded');
    expect(slot.pc).toBe(0); // rewound for the per-frame re-check
  });

  it('SO_WAIT_FOR_CAMERA falls through when the pan target IS the current position', () => {
    // Room 28's camera script re-issues panCameraTo to the camera's current
    // x every frame; a reached destination must read as settled or every
    // waiter behind it (the trio conversation #220) deadlocks.
    const vm = makeVm();
    vm.camera.x = 480;
    vm.cameraDest = 480;
    const slot = vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x03, 0x00) });
    vm.step();
    expect(slot.status).toBe('running');
    expect(slot.pc).toBe(2);
  });

  it('halts on an unknown wait subop', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: bytes(0xae, 0x1f) });
    vm.step();
    expect(vm.isHalted).toBe(true);
  });
});
