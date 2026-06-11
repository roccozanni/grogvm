import { describe, expect, it } from 'vitest';
import { SEED_OPCODES } from './opcodes/index';
import { restoreVm, SAVE_VERSION, type SaveState, SaveStateError, snapshotVm } from './savestate';
import type { ActiveDialog, VerbSlot } from './vm';
import { Vm } from './vm';

function freshVm(): Vm {
  return new Vm({ numVariables: 800, numBitVariables: 2048, handlers: SEED_OPCODES });
}

/** Mutate a representative slice of every persisted field. */
function loadUpState(vm: Vm): void {
  // Variables across all three banks.
  vm.vars.writeGlobal(5, 1234);
  vm.vars.writeGlobal(799, -42);
  vm.vars.writeRoom(3, 77);
  vm.vars.writeBit(0, 1);
  vm.vars.writeBit(2047, 1);
  vm.vars.writeBit(100, 1);

  // Two live slots with distinct bytecode + advanced pc/locals.
  const s0 = vm.startScript({ scriptId: 0, bytecode: new Uint8Array([0x80, 0x00, 0x00]), label: 'ENCD-9' });
  s0.pc = 1;
  s0.locals[0] = 9;
  s0.locals[24] = -3;
  s0.delayRemaining = 12;
  s0.freezeCount = 2;
  s0.freezeResistant = true;
  const s1 = vm.startScript({ scriptId: 42, bytecode: new Uint8Array([0x1a, 0x05, 0x00, 0x07, 0x00, 0x00]) });
  s1.pc = 4;
  s1.overridePc = 2;
  s1.yield_();

  // Object / inventory / class state.
  vm.strings.set(7, new Uint8Array([72, 105])); // "Hi"
  vm.objectStates.set(300, 1);
  vm.objectOwners.set(301, 5);
  vm.inventoryNames.set(302, 'spada di gomma');
  vm.objectClasses.set(303, 0b1010);
  vm.objectDrawQueue.add(300);
  vm.objectDrawQueue.add(303);
  vm.drawnBoxes.push({ left: 0, top: 0, right: 319, bottom: 199, color: 7 });
  vm.shakeEnabled = true;

  // Room / camera.
  vm.currentRoom = 33;
  vm.boxFlagOverrides.set(4, 0x80);
  vm.boxFlagOverrides.set(5, 0x00);
  vm.pseudoRooms.set(0x81, 33);
  vm.uiPaletteOverrides.set(6, [127, 47, 127]);
  vm.uiPaletteOverrides.set(3, [223, 83, 223]);
  vm.camera.x = 200;
  vm.roomScroll = { min: 160, max: 480 };
  vm.cameraFollowActor = 3;
  vm.screen.top = 0;
  vm.screen.bottom = 144;
  vm.screenEffect.switchRoomEffect = 129;
  vm.screenEffect.switchRoomEffect2 = 129;
  vm.screenEffect.requestFadeIn = true;

  // Cursor / charset / system.
  vm.cursor.state = 1;
  vm.cursor.userput = 1;
  vm.currentCharset = 6;
  vm.systemRequest = 'pause';

  // Verbs.
  const verb: VerbSlot = {
    id: 11, name: 'Vai', color: 6, hiColor: 3, dimColor: 8, backColor: 0,
    x: 8, y: 8, key: 0, charset: 6, centered: false, image: null, state: 'on',
  };
  vm.verbs.set(11, verb);
  vm.verbs.set(200, { ...verb, id: 200, name: '', image: { obj: 1031, room: 99 } });
  vm.savedVerbStates.set(11, 'off');

  // Sentence / cutscene.
  vm.sentenceStack.push({ verb: 11, objectA: 300, objectB: 0 });
  vm.cutsceneStack.push({ room: 33, callerSlot: 0, args: [1, 2, 3] });

  // Dialog / text.
  const dlg: ActiveDialog = {
    actorId: 3, text: 'Sono Guybrush Threepwood', x: 160, y: 40,
    color: 15, center: true, overhead: true, clipped: null, charset: 2,
  };
  vm.activeDialog = dlg;
  vm.systemTexts = [{ ...dlg, actorId: 0, text: 'Parte Uno', y: 165 }];
  vm.printState = { x: 155, y: 165, color: 15, colorSet: true, center: true, overhead: false, clipped: 300 };
  vm.talkDelay = 45;
  vm.restoreTalkQueue({ pages: ['pagina 2', 'pagina 3'], dlg, system: false });

  // Actors — including anim (limbs + stopped bitmask).
  const ego = vm.actors.get(3);
  ego.room = 33;
  ego.x = 160;
  ego.y = 120;
  ego.costume = 12;
  ego.facing = 'W';
  ego.name = 'Guybrush Threepwood';
  ego.scale = 200;
  ego.width = 48;
  ego.forceClip = 0;
  ego.walkTarget = { x: 50, y: 100 };
  ego.walkPath = [{ x: 60, y: 110 }, { x: 50, y: 100 }];
  ego.walkPathIdx = 1;
  ego.walkLeg = {
    fromX: 60, fromY: 110, toX: 50, toY: 100,
    deltaXFactor: -131072, deltaYFactor: -131072, xfrac: 0x8000, yfrac: 0x1234,
  };
  ego.isMoving = true;
  ego.anim = {
    animId: 2,
    stopped: 0b10,
    limbs: Array.from({ length: 16 }, (_, i) => ({
      active: i < 3,
      start: i * 4,
      length: 8,
      noLoop: i === 1,
      cursor: i,
      finished: false,
    })),
  };
}

describe('save-state — synthetic round-trip', () => {
  it('round-trips every persisted field through JSON and back', () => {
    const vm = freshVm();
    loadUpState(vm);

    const snap1 = snapshotVm(vm, { game: 'MI1' });
    const json = JSON.stringify(snap1);
    const parsed = JSON.parse(json) as SaveState;

    const vm2 = freshVm();
    restoreVm(vm2, parsed);
    const snap2 = snapshotVm(vm2, { game: 'MI1' });

    // The whole snapshot is identical after a save→load→save cycle.
    expect(JSON.stringify(snap2)).toBe(json);
  });

  it('restores spot-checked fields with correct values and types', () => {
    const vm = freshVm();
    loadUpState(vm);
    const vm2 = freshVm();
    restoreVm(vm2, JSON.parse(JSON.stringify(snapshotVm(vm))) as SaveState);

    expect(vm2.vars.readGlobal(5)).toBe(1234);
    expect(vm2.vars.readGlobal(799)).toBe(-42);
    expect(vm2.vars.readRoom(3)).toBe(77);
    expect(vm2.vars.readBit(0)).toBe(1);
    expect(vm2.vars.readBit(2047)).toBe(1);
    expect(vm2.vars.readBit(101)).toBe(0);

    expect(vm2.currentRoom).toBe(33);
    expect(vm2.pseudoRooms.get(0x81)).toBe(33);
    expect(vm2.cameraFollowActor).toBe(3);
    expect(vm2.systemRequest).toBe('pause');

    // Slot 0: frozen, mid-script, with locals + freeze flags.
    const s0 = vm2.slots[0]!;
    expect(s0.status).toBe('running');
    expect(s0.label).toBe('ENCD-9');
    expect(s0.pc).toBe(1);
    expect(s0.locals[0]).toBe(9);
    expect(s0.locals[24]).toBe(-3);
    expect(s0.freezeCount).toBe(2);
    expect(s0.freezeResistant).toBe(true);
    expect([...s0.bytecode]).toEqual([0x80, 0x00, 0x00]);
    // Slot 1: yielded with an override PC.
    expect(vm2.slots[1]!.status).toBe('yielded');
    expect(vm2.slots[1]!.overridePc).toBe(2);

    expect([...vm2.strings.get(7)!]).toEqual([72, 105]);
    expect(vm2.inventoryNames.get(302)).toBe('spada di gomma');
    expect(vm2.verbs.get(200)!.image).toEqual({ obj: 1031, room: 99 });
    expect(vm2.savedVerbStates.get(11)).toBe('off');
    expect(vm2.sentenceStack).toEqual([{ verb: 11, objectA: 300, objectB: 0 }]);
    expect(vm2.activeDialog!.text).toBe('Sono Guybrush Threepwood');
    expect(vm2.snapshotTalkQueue().pages).toEqual(['pagina 2', 'pagina 3']);

    expect(vm2.drawnBoxes).toEqual([{ left: 0, top: 0, right: 319, bottom: 199, color: 7 }]);
    expect(vm2.shakeEnabled).toBe(true);

    const ego = vm2.actors.get(3);
    expect(ego.x).toBe(160);
    expect(ego.facing).toBe('W');
    expect(ego.width).toBe(48);
    expect(ego.name).toBe('Guybrush Threepwood');
    expect(ego.walkPath).toEqual([{ x: 60, y: 110 }, { x: 50, y: 100 }]);
    // The mid-leg fixed-point state survives, so a restored walk resumes on
    // the same line with the same sub-pixel remainders.
    expect(ego.walkLeg).toEqual({
      fromX: 60, fromY: 110, toX: 50, toY: 100,
      deltaXFactor: -131072, deltaYFactor: -131072, xfrac: 0x8000, yfrac: 0x1234,
    });
    expect(ego.anim.stopped).toBe(0b10);
    expect(ego.anim.limbs).toHaveLength(16);
    expect(ego.anim.limbs[1]!.noLoop).toBe(true);
    expect(ego.anim.limbs[0]!.active).toBe(true);
    expect(ego.anim.limbs[15]!.active).toBe(false);
  });

  it('clears prior state on restore (no leakage from the target VM)', () => {
    const vm = freshVm();
    loadUpState(vm);
    const snap = JSON.parse(JSON.stringify(snapshotVm(vm))) as SaveState;

    // A target VM dirtied with DIFFERENT state must end up matching the save.
    const vm2 = freshVm();
    vm2.vars.writeGlobal(5, 9999);
    vm2.vars.writeGlobal(10, 555); // not set in the save — must be wiped to 0
    vm2.objectStates.set(900, 7); // stale entry — must be gone
    vm2.startScript({ scriptId: 1, bytecode: new Uint8Array([0x80]) });

    restoreVm(vm2, snap);

    expect(vm2.vars.readGlobal(5)).toBe(1234);
    expect(vm2.vars.readGlobal(10)).toBe(0);
    expect(vm2.objectStates.has(900)).toBe(false);
    expect(vm2.objectStates.get(300)).toBe(1);
  });

  it('rejects an unknown save version', () => {
    const vm = freshVm();
    const bad = { ...snapshotVm(vm), version: SAVE_VERSION + 1 } as SaveState;
    expect(() => restoreVm(freshVm(), bad)).toThrow(SaveStateError);
  });
});
