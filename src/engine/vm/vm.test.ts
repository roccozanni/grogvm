import { describe, expect, it } from 'vitest';
import type { LoadedObject } from '../object/loader';
import type { LoadedRoom } from '../room/loader';
import { NUM_SLOTS, UnknownOpcodeError, Vm, type HangInfo, type OpcodeHandler } from './vm';

function makeVm(handlers: Record<number, OpcodeHandler> = {}): Vm {
  return new Vm({
    numVariables: 32,
    numBitVariables: 64,
    handlers: new Map(Object.entries(handlers).map(([k, h]) => [Number(k), h])),
  });
}

/** A trivial "stopObjectCode" — kills the slot. */
const stop: OpcodeHandler = (vm, slot) => {
  vm.annotate('stop');
  slot.kill();
};

/** A trivial "breakHere" — yields. */
const breakHere: OpcodeHandler = (vm, slot) => {
  vm.annotate('breakHere');
  slot.yield_();
};

/** A minimal LoadedRoom carrying just the objects a test needs. */
function roomWithObjects(
  id: number,
  objects: ReadonlyArray<LoadedObject>,
): LoadedRoom {
  return {
    id,
    width: 320,
    height: 200,
    numObjects: objects.length,
    palette: new Uint8Array(768),
    transparentIndex: null,
    indexed: new Uint8Array(0),
    stripMethods: [],
    zPlanes: [],
    entryScript: null,
    exitScript: null,
    localScripts: new Map(),
    objects: new Map(objects.map((o) => [o.objId, o])),
    walkBoxes: [],
    boxMatrix: [], scaleSlots: [],
  };
}

/** A LoadedObject with just an id + verb map (other fields stubbed). */
function objWithVerbs(
  objId: number,
  verbs: ReadonlyMap<number, Uint8Array>,
): LoadedObject {
  return {
    objId,
    cdhd: {
      objId,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      flags: 0,
      parent: 0,
      walkX: 0,
      walkY: 0,
      actorDir: 0,
    },
    imhd: { objId, numImages: 0, flags: 0, x: 0, y: 0, width: 0, height: 0 },
    images: new Map(),
    name: `obj${objId}`,
    verbs,
  };
}

describe('Vm — setBoxFlags (matrixOp box locking)', () => {
  // setBoxFlags records a runtime box-flag override; the box-graph pathfinder
  // reads it live (excluding 0x80 boxes from routing — see boxgraph.test.ts).

  it('records a box-flag override', () => {
    const vm = makeVm();
    vm.setBoxFlags(1, 0x80);
    expect(vm.boxFlagOverrides.get(1)).toBe(0x80);
  });

  it('clearing the lock (flag 0) overwrites the override', () => {
    const vm = makeVm();
    vm.setBoxFlags(1, 0x80);
    vm.setBoxFlags(1, 0x00);
    expect(vm.boxFlagOverrides.get(1)).toBe(0x00);
  });

  it('accumulates overrides across calls', () => {
    const vm = makeVm();
    vm.setBoxFlags(1, 0x80);
    vm.setBoxFlags(0, 0x80);
    expect(vm.boxFlagOverrides.get(0)).toBe(0x80);
    expect(vm.boxFlagOverrides.get(1)).toBe(0x80);
  });
});

describe('Vm — startVerbScript', () => {
  it('starts a labelled slot from the verb bytecode', () => {
    const vm = makeVm();
    const code = new Uint8Array([0x48, 0x04, 0x00, 0xa0]);
    vm.loadedRoom = roomWithObjects(7, [objWithVerbs(42, new Map([[11, code]]))]);

    const slot = vm.startVerbScript(42, 11);
    expect(slot).not.toBeNull();
    expect(slot!.label).toBe('VERB-42-11');
    expect(slot!.scriptId).toBe(42);
    expect(slot!.room).toBe(7);
    expect(slot!.bytecode).toBe(code);
    expect(slot!.status).toBe('running');
  });

  it('seeds locals directly from the args list (no verb/obj prepend)', () => {
    // The startObject opcode's args map straight onto L0, L1, …. Per the game
    // bytecode (scratch/dis.ts), sentence #2 runs verbs as `startObject obj
    // verb [secondObj, verb]`, so the verb body reads the second object at L0.
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(50, new Map([[3, new Uint8Array([0xa0])]])),
    ]);

    const slot = vm.startVerbScript(50, 3, [99, 100])!;
    expect(slot.locals[0]).toBe(99);
    expect(slot.locals[1]).toBe(100);
    expect(slot.locals[2]).toBe(0); // unset locals stay zero
  });

  it('falls back to the default verb (0xFF)', () => {
    const vm = makeVm();
    const def = new Uint8Array([0xa0]);
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(42, new Map([[0xff, def]])),
    ]);

    const slot = vm.startVerbScript(42, 11);
    expect(slot!.bytecode).toBe(def);
    expect(slot!.label).toBe('VERB-42-11');
  });

  it('returns null when the object is not in the room', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, []);
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });

  it('returns null when no room is loaded', () => {
    const vm = makeVm();
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });

  it('returns null when the verb and default are both absent', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, [
      objWithVerbs(42, new Map([[3, new Uint8Array([0xa0])]])),
    ]);
    expect(vm.startVerbScript(42, 11)).toBeNull();
  });
});

describe('Vm — talk timer + dialog clearing', () => {
  const dialog = (actorId: number, keepText = false) => ({
    actorId,
    text: 'hi',
    x: null,
    y: null,
    color: 1,
    center: false,
    overhead: false,
    clipped: null,
    keepText,
  });

  it('clears actor speech when the message finishes', () => {
    const vm = makeVm();
    vm.activeDialog = dialog(1);
    vm.beginTalk('hi');
    for (let i = 0; i < 200 && vm.activeDialog; i++) vm.beginTick();
    expect(vm.activeDialog).toBeNull();
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
  });

  it('keeps a keepText systemText after the talk timer drains', () => {
    const vm = makeVm();
    vm.systemText = dialog(255, true); // a sign/credit: persists
    vm.beginTalk('hi');
    for (let i = 0; i < 200; i++) vm.beginTick();
    expect(vm.systemText).not.toBeNull(); // keepText — never auto-cleared
  });

  it('keeps a non-keepText systemText past the talk timer; clears it on endCutscene (the cook shout)', () => {
    const vm = makeVm();
    vm.systemText = dialog(255, false); // one-shot system line, no keepText
    vm.beginTalk('hi');
    for (let i = 0; i < 200; i++) vm.beginTick();
    // The talk timer only governs VAR_HAVE_MSG (so `wait forMessage` releases);
    // the printed text persists on screen — SCUMM's restoreCharsetBg, not the
    // timer, removes it. The treasure-map close-up depends on this (it prints
    // then waits for a click). VAR_HAVE_MSG has cleared so the cook's
    // `wait forMessage` releases, but the line stays up...
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0);
    expect(vm.systemText).not.toBeNull();
    // ...until its `endCutScene` restores the screen.
    vm.endCutscene();
    expect(vm.systemText).toBeNull();
  });

  it('actor speech and a keepText sign coexist; draining speech leaves the sign', () => {
    const vm = makeVm();
    // Persistent sign (system, keepText) + transient actor speech share the screen.
    vm.systemText = dialog(254, true);
    vm.activeDialog = dialog(1);
    vm.beginTalk('hi');
    for (let i = 0; i < 200 && vm.activeDialog; i++) vm.beginTick();
    expect(vm.activeDialog).toBeNull(); // speech finished + cleared
    expect(vm.systemText).not.toBeNull(); // the keepText sign is still up
  });

  it('blasts distinct-position system lines side by side in one frame (the "Parte Due / Il Viaggio" card)', () => {
    const vm = makeVm();
    // Same frame, no restore armed: the chapter card (global #122) prints
    // both lines back-to-back before yielding, so they coexist.
    vm.addSystemText({ ...dialog(254), text: 'Parte Uno', x: 155, y: 165 });
    vm.addSystemText({ ...dialog(254), text: 'Le Tre Prove', x: 155, y: 180 });
    expect(vm.systemTexts.map((d) => d.text)).toEqual(['Parte Uno', 'Le Tre Prove']);
    expect(vm.systemText?.text).toBe('Le Tre Prove'); // back-compat: last line
  });

  it('erases the previous frame\'s transient label before drawing the next (bug-map-labels)', () => {
    const vm = makeVm();
    // The map hover poller (global #24) re-prints the location name near the
    // cursor every frame. Each new frame arms the per-cycle restore, so the
    // drifting label replaces the previous one instead of smearing a trail.
    (vm as unknown as { systemTextRestorePending: boolean }).systemTextRestorePending = true;
    vm.addSystemText({ ...dialog(255), text: "l'osservatorio", x: 74, y: 123 });
    (vm as unknown as { systemTextRestorePending: boolean }).systemTextRestorePending = true;
    vm.addSystemText({ ...dialog(255), text: "l'osservatorio", x: 72, y: 124 });
    // Hover-out: a bare `print " " at 0,0` clears the last label too.
    (vm as unknown as { systemTextRestorePending: boolean }).systemTextRestorePending = true;
    vm.addSystemText({ ...dialog(255), text: ' ', x: 0, y: 0 });
    expect(vm.systemTexts.map((d) => d.text)).toEqual([' ']); // single line, no trail
  });

  it('a new-frame transient print leaves keepText signs standing', () => {
    const vm = makeVm();
    vm.addSystemText({ ...dialog(255, true), text: 'SIGN', x: 10, y: 10 }); // keepText
    (vm as unknown as { systemTextRestorePending: boolean }).systemTextRestorePending = true;
    vm.addSystemText({ ...dialog(255), text: 'label', x: 50, y: 50 }); // transient, new frame
    (vm as unknown as { systemTextRestorePending: boolean }).systemTextRestorePending = true;
    vm.addSystemText({ ...dialog(255), text: 'label2', x: 60, y: 60 }); // erases 'label', not SIGN
    expect(vm.systemTexts.map((d) => d.text)).toEqual(['SIGN', 'label2']);
  });

  it('replaces a system line printed again at the same position (credit roll)', () => {
    const vm = makeVm();
    vm.addSystemText({ ...dialog(255), text: 'LINE A', x: 160, y: 90 });
    vm.addSystemText({ ...dialog(255), text: 'LINE B', x: 160, y: 90 });
    expect(vm.systemTexts.map((d) => d.text)).toEqual(['LINE B']); // not stacked
  });

  it('clears blasted system text on a room change (screen redraw)', () => {
    const vm = makeVm();
    vm.addSystemText({ ...dialog(254), text: 'Parte Uno', x: 155, y: 165 });
    vm.addSystemText({ ...dialog(254), text: 'Le Tre Prove', x: 155, y: 180 });
    vm.enterRoom(2);
    expect(vm.systemTexts).toEqual([]);
  });

  it('advances queued sentence pages on the talk timer before clearing', () => {
    const vm = makeVm();
    // Page 0 showing; pages "two"/"three" queued (\xff\x03-separated source).
    vm.activeDialog = { ...dialog(1), text: 'one' };
    vm.beginTalk('one');
    vm.queueTalkPages(['two', 'three'], { ...dialog(1), text: 'one' }, false);
    // Capture each distinct text the dialog cycles through over time.
    const seen: (string | null)[] = ['one'];
    let haveMsgWhileTwo = -1;
    for (let i = 0; i < 200; i++) {
      vm.beginTick();
      const t = vm.activeDialog?.text ?? null;
      if (t !== seen[seen.length - 1]) {
        seen.push(t);
        if (t === 'two') haveMsgWhileTwo = vm.vars.readGlobal(Vm.VAR_HAVE_MSG);
      }
    }
    expect(seen).toEqual(['one', 'two', 'three', null]);
    expect(haveMsgWhileTwo).toBe(1); // message not "done" mid-pages
    expect(vm.vars.readGlobal(Vm.VAR_HAVE_MSG)).toBe(0); // done after last page
  });

  it('endTalk drops any queued pages', () => {
    const vm = makeVm();
    vm.activeDialog = { ...dialog(1), text: 'one' };
    vm.beginTalk('one');
    vm.queueTalkPages(['two'], { ...dialog(1), text: 'one' }, false);
    vm.endTalk();
    vm.activeDialog = null;
    for (let i = 0; i < 200; i++) vm.beginTick();
    expect(vm.activeDialog).toBeNull(); // page "two" never resurfaces
  });
});


describe('Vm — scene/verb click routing (faithful, no engine shortcut)', () => {
  it('handleSceneClick does not enqueue engine-side (the verb script commits)', () => {
    const vm = makeVm();
    // No VAR_VERB_SCRIPT set → the input hook is a no-op; the key point
    // is that the engine itself never pushes a sentence anymore.
    vm.handleSceneClick(1);
    vm.handleSceneClick(2);
    expect(vm.sentenceStack.length).toBe(0);
  });

  it('handleVerbClick does not enqueue engine-side either', () => {
    const vm = makeVm();
    vm.handleVerbClick(8, 1);
    expect(vm.sentenceStack.length).toBe(0);
  });
});

describe('Vm — walkActorTo', () => {
  it('plans a walk: sets the target + isMoving on the actor', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(1, []); // empty walkable mask → straight-line
    const a = vm.actors.get(3);
    a.room = 1;
    a.x = 10;
    a.y = 20;
    vm.walkActorTo(3, 100, 60);
    expect(a.isMoving).toBe(true);
    expect(a.walkTarget).toEqual({ x: 100, y: 60 });
  });

  it('is a no-op for an out-of-range actor id', () => {
    const vm = makeVm();
    expect(() => vm.walkActorTo(0, 10, 10)).not.toThrow();
    expect(() => vm.walkActorTo(9999, 10, 10)).not.toThrow();
  });
});

describe('Vm — actorFromPos', () => {
  // Place an actor in the current room with an explicit drawn bbox.
  const place = (vm: Vm, id: number, bounds: { left: number; top: number; right: number; bottom: number }) => {
    vm.currentRoom = 1;
    const a = vm.actors.get(id);
    a.room = 1;
    a.visible = true;
    a.drawBounds = bounds;
    return a;
  };

  it('returns the actor whose drawn bounds contain the point', () => {
    const vm = makeVm();
    place(vm, 3, { left: 90, top: 40, right: 110, bottom: 60 });
    expect(vm.actorFromPos(100, 50)).toBe(3);
  });

  it('returns 0 when the point is outside every actor (right/bottom exclusive)', () => {
    const vm = makeVm();
    place(vm, 3, { left: 90, top: 40, right: 110, bottom: 60 });
    expect(vm.actorFromPos(80, 50)).toBe(0); // left of box
    expect(vm.actorFromPos(110, 50)).toBe(0); // right edge exclusive
    expect(vm.actorFromPos(100, 60)).toBe(0); // bottom edge exclusive
  });

  it('ignores actors not in the current room', () => {
    const vm = makeVm();
    const a = place(vm, 3, { left: 90, top: 40, right: 110, bottom: 60 });
    a.room = 2; // elsewhere
    expect(vm.actorFromPos(100, 50)).toBe(0);
  });

  it('ignores invisible actors and actors with no drawn bounds', () => {
    const vm = makeVm();
    const a = place(vm, 3, { left: 90, top: 40, right: 110, bottom: 60 });
    a.visible = false;
    expect(vm.actorFromPos(100, 50)).toBe(0);
    a.visible = true;
    a.drawBounds = null; // off-screen last frame
    expect(vm.actorFromPos(100, 50)).toBe(0);
  });

  it('skips actors flagged Untouchable (class 32)', () => {
    const vm = makeVm();
    place(vm, 3, { left: 90, top: 40, right: 110, bottom: 60 });
    vm.objectClasses.set(3, 1 << 31); // class 32 = bit 31
    expect(vm.actorFromPos(100, 50)).toBe(0);
  });

  it('returns the highest-id (topmost) actor among overlapping hits', () => {
    const vm = makeVm();
    place(vm, 2, { left: 80, top: 30, right: 120, bottom: 70 });
    place(vm, 5, { left: 90, top: 40, right: 110, bottom: 60 });
    expect(vm.actorFromPos(100, 50)).toBe(5);
  });
});

describe('Vm — moveCameraFollow', () => {
  const wideRoom = (w: number) => ({ ...roomWithObjects(1, []), width: w });

  it('scrolls to keep the followed actor in the dead-zone band', () => {
    const vm = makeVm();
    vm.loadedRoom = wideRoom(1008);
    vm.currentRoom = 1;
    const a = vm.actors.get(1);
    a.room = 1;
    a.x = 500;
    vm.cameraFollowActor = 1;
    vm.camera.x = 160;
    vm.moveCameraFollow();
    expect(vm.camera.x).toBe(420); // 500 − 80 (dead zone)
  });

  it('does not move while the actor stays within the dead zone', () => {
    const vm = makeVm();
    vm.loadedRoom = wideRoom(1008);
    vm.currentRoom = 1;
    const a = vm.actors.get(1);
    a.room = 1;
    a.x = 200;
    vm.cameraFollowActor = 1;
    vm.camera.x = 160;
    vm.moveCameraFollow();
    expect(vm.camera.x).toBe(160);
  });

  it('clamps the camera centre to the room bounds', () => {
    const vm = makeVm();
    vm.loadedRoom = wideRoom(1008);
    vm.currentRoom = 1;
    const a = vm.actors.get(1);
    a.room = 1;
    a.x = 1000;
    vm.cameraFollowActor = 1;
    vm.camera.x = 800;
    vm.moveCameraFollow();
    expect(vm.camera.x).toBe(848); // 1008 − 160 (max centre)
  });

  it('no-ops when nothing is followed', () => {
    const vm = makeVm();
    vm.loadedRoom = wideRoom(1008);
    vm.currentRoom = 1;
    vm.camera.x = 160;
    vm.moveCameraFollow();
    expect(vm.camera.x).toBe(160);
  });
});

describe('Vm — runInventoryScript', () => {
  const invCode = new Uint8Array([0xa0]); // stopObjectCode
  function vmWithResolver(): Vm {
    return new Vm({
      numVariables: 800,
      numBitVariables: 64,
      handlers: new Map(),
      resolveGlobalScript: () => ({ bytecode: invCode, room: 0 }),
    });
  }

  it('starts the VAR_INVENTORY_SCRIPT script with arg as local0', () => {
    const vm = vmWithResolver();
    vm.vars.writeGlobal(Vm.VAR_INVENTORY_SCRIPT, 9);
    vm.runInventoryScript(1);
    const slot = vm.slots.find((s) => s.scriptId === 9 && s.status !== 'dead');
    expect(slot).toBeDefined();
    expect(slot!.label).toBe('INVENTORY');
    expect(slot!.locals[0]).toBe(1);
  });

  it('is a no-op when VAR_INVENTORY_SCRIPT is unset (0)', () => {
    const vm = vmWithResolver();
    vm.runInventoryScript(1);
    expect(vm.slots.every((s) => s.status === 'dead')).toBe(true);
  });

  it('stops the previous instance before restarting (non-recursive)', () => {
    const vm = vmWithResolver();
    vm.vars.writeGlobal(Vm.VAR_INVENTORY_SCRIPT, 9);
    vm.runInventoryScript(1);
    vm.runInventoryScript(2);
    const live = vm.slots.filter((s) => s.scriptId === 9 && s.status !== 'dead');
    expect(live.length).toBe(1); // exactly one instance, not stacked
    expect(live[0]!.locals[0]).toBe(2);
  });
});

describe('Vm — objectName + captureInventoryName', () => {
  /** A named object with no verbs (overrides objWithVerbs' default name). */
  function named(objId: number, name: string): LoadedObject {
    return { ...objWithVerbs(objId, new Map()), name };
  }

  it('resolves a name from the current room', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(5, [named(42, 'the rock')]);
    expect(vm.objectName(42)).toBe('the rock');
  });

  it('returns undefined for an unknown object', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(5, []);
    expect(vm.objectName(99)).toBeUndefined();
  });

  it('resolves a low id to its actor name (getObjOrActorName)', () => {
    // Ids within the actor table are actors, not objects — e.g. MI1's
    // "Dai la pentola a Fratelli Fettucini" (actor 3, renamed at room entry).
    const vm = makeVm();
    vm.actors.get(3).name = 'Fratelli Fettucini';
    expect(vm.objectName(3)).toBe('Fratelli Fettucini');
  });

  it('returns undefined for an unnamed actor, not the object table', () => {
    const vm = makeVm();
    // An object happens to share the id; the actor branch wins (name '' →
    // undefined), so an unnamed actor never leaks an object name.
    vm.loadedRoom = roomWithObjects(5, [named(3, 'should not win')]);
    expect(vm.objectName(3)).toBeUndefined();
  });

  it('falls back to the carried-item snapshot when not in the room', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(5, [named(42, 'the rock')]);
    vm.captureInventoryName(42, 0); // snapshot from the current room
    // Now leave the room — the object is gone from the live table.
    vm.loadedRoom = roomWithObjects(6, []);
    expect(vm.objectName(42)).toBe('the rock');
  });

  it('prefers the current room over a stale snapshot', () => {
    const vm = makeVm();
    vm.inventoryNames.set(42, 'old name');
    vm.loadedRoom = roomWithObjects(5, [named(42, 'fresh name')]);
    expect(vm.objectName(42)).toBe('fresh name');
  });

  it('captureInventoryName resolves a hinted room via resolveRoom', () => {
    const otherRoom = roomWithObjects(9, [named(70, 'a map')]);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: (id) => {
        if (id === 9) return otherRoom;
        throw new Error(`no room ${id}`);
      },
    });
    vm.loadedRoom = roomWithObjects(5, []); // 70 not present here
    vm.captureInventoryName(70, 9);
    expect(vm.objectName(70)).toBe('a map');
  });

  it('captureInventoryName is a no-op when the name is unresolvable', () => {
    const vm = makeVm();
    vm.loadedRoom = roomWithObjects(5, []);
    vm.captureInventoryName(123, 0);
    expect(vm.inventoryNames.has(123)).toBe(false);
    expect(vm.objectName(123)).toBeUndefined();
  });

  it('reset() clears the carried-item table', () => {
    const vm = makeVm();
    vm.inventoryNames.set(42, 'the rock');
    vm.reset();
    expect(vm.inventoryNames.size).toBe(0);
  });
});

describe('Vm — slot allocation', () => {
  it('startScript picks the first dead slot', () => {
    const vm = makeVm();
    const a = vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0]) });
    const b = vm.startScript({ scriptId: 2, bytecode: new Uint8Array([0]) });
    expect(a.slotIndex).toBe(0);
    expect(b.slotIndex).toBe(1);
  });

  it('throws when every slot is in use', () => {
    const vm = makeVm();
    for (let i = 0; i < NUM_SLOTS; i++) {
      vm.startScript({ scriptId: i + 1, bytecode: new Uint8Array([0]) });
    }
    expect(() =>
      vm.startScript({ scriptId: 99, bytecode: new Uint8Array([0]) }),
    ).toThrow();
  });
});

describe('Vm — step()', () => {
  it('dispatches one opcode per step and advances PC', () => {
    const vm = makeVm({ 0x00: stop });
    const slot = vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x00]) });
    expect(slot.pc).toBe(0);
    vm.step();
    // stop killed the slot; pc was advanced past the opcode then slot reset
    expect(slot.status).toBe('dead');
  });

  it('returns undefined when no slot is runnable', () => {
    expect(makeVm().step()).toBeUndefined();
  });

  it('halts on unknown opcode with a clear HaltInfo', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 7, bytecode: new Uint8Array([0xab]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.opcode).toBe(0xab);
    expect(vm.haltInfo!.scriptId).toBe(7);
    expect(vm.haltInfo!.pc).toBe(0);
    expect(vm.haltInfo!.reason).toContain('0xab');
    expect(vm.haltInfo!.reason).toContain('Unknown opcode');
  });

  it('halt embeds bytecode context centred on the failing opcode', () => {
    const vm = makeVm({ 0x80: breakHere });
    const code = new Uint8Array([0x80, 0x80, 0x80, 0xff, 0x80, 0x80, 0x80]);
    vm.startScript({ scriptId: 1, bytecode: code });
    while (!vm.isHalted && vm.step()) {
      // resume from each yield
      for (const s of vm.slots) s.resume();
    }
    expect(vm.haltInfo!.opcode).toBe(0xff);
    const ctx = vm.haltInfo!.bytecodeContext;
    expect(ctx[vm.haltInfo!.contextOpcodeOffset]).toBe(0xff);
  });

  it('halt is sticky — subsequent step() is a no-op', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0xff, 0x00]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    expect(vm.step()).toBeUndefined();
    expect(vm.haltInfo!.pc).toBe(0); // didn't move past the original halt
  });

  it('UnknownOpcodeError message contains the byte', () => {
    expect(new UnknownOpcodeError(0x4a).message).toContain('0x4a');
  });
});

describe('Vm — trace ring', () => {
  it('records dispatched opcodes in order', () => {
    const vm = makeVm({ 0x80: breakHere, 0x00: stop });
    vm.startScript({ scriptId: 5, bytecode: new Uint8Array([0x80, 0x80, 0x00]) });
    vm.step();
    for (const s of vm.slots) s.resume();
    vm.step();
    for (const s of vm.slots) s.resume();
    vm.step();
    const t = vm.trace;
    expect(t).toHaveLength(3);
    expect(t.map((e) => e.opcode)).toEqual([0x80, 0x80, 0x00]);
    expect(t.map((e) => e.pc)).toEqual([0, 1, 2]);
    expect(t.map((e) => e.mnemonic)).toEqual(['breakHere', 'breakHere', 'stop']);
    expect(t[0]!.scriptId).toBe(5);
  });

  it('overwrites oldest entries past capacity', () => {
    const vm = makeVm({ 0x80: breakHere });
    // 80 breakHere opcodes; capacity is 64, so newest 64 should remain.
    const code = new Uint8Array(80).fill(0x80);
    vm.startScript({ scriptId: 1, bytecode: code });
    while (!vm.isHalted) {
      const ran = vm.step();
      if (!ran) break;
      for (const s of vm.slots) s.resume();
    }
    const t = vm.trace;
    expect(t.length).toBe(64);
    // Oldest in the buffer is the 17th opcode (= pc 16).
    expect(t[0]!.pc).toBe(16);
    expect(t[t.length - 1]!.pc).toBe(79);
  });
});

describe('Vm — runUntilAllYield', () => {
  it('runs until every running slot yields or dies', () => {
    const vm = makeVm({ 0x80: breakHere, 0x00: stop });
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x80, 0x00]) });
    const steps = vm.runUntilAllYield();
    expect(steps).toBe(1);
    expect(vm.slots[0]!.status).toBe('yielded');
  });

  it('halts on runaway loop hitting the step cap', () => {
    // A handler that doesn't yield AND resets PC to 0 → infinite loop.
    const noYieldRewind: OpcodeHandler = (vm, slot) => {
      vm.annotate('nop');
      slot.pc = 0;
    };
    const vm = makeVm({ 0x01: noYieldRewind });
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x01]) });
    vm.runUntilAllYield(50);
    expect(vm.isHalted).toBe(true);
    expect(vm.haltInfo!.reason).toContain('exceeded');
  });
});

describe('Vm — reset', () => {
  it('clears halt, slots, and trace', () => {
    const vm = makeVm();
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0xff]) });
    vm.step();
    expect(vm.isHalted).toBe(true);
    vm.reset();
    expect(vm.isHalted).toBe(false);
    expect(vm.trace).toHaveLength(0);
    expect(vm.slots.every((s) => s.status === 'dead')).toBe(true);
  });

  it('clears mouseRoomX/Y', () => {
    const vm = makeVm();
    vm.mouseRoomX = 120;
    vm.mouseRoomY = 40;
    vm.reset();
    expect(vm.mouseRoomX).toBe(0);
    expect(vm.mouseRoomY).toBe(0);
  });

  it('clears sticky input hold flags', () => {
    const vm = makeVm();
    vm.input.leftHold = true;
    vm.input.rightHold = true;
    vm.reset();
    expect(vm.input.leftHold).toBe(false);
    expect(vm.input.rightHold).toBe(false);
  });
});

describe('Vm — beginTick', () => {
  /** beginTick writes to global 53 — use a var bank big enough so the
   *  write isn't silently absorbed by the OOB-leniency handler. */
  const makeWideVm = () =>
    new Vm({ numVariables: 100, numBitVariables: 64, handlers: new Map() });

  it('mirrors the cursor counters into VAR_USERPUT / VAR_CURSORSTATE', () => {
    const vm = makeWideVm();
    vm.cursor.userput = 1;
    vm.cursor.state = 1;
    vm.beginTick();
    expect(vm.vars.readGlobal(Vm.VAR_USERPUT)).toBe(1);
    expect(vm.vars.readGlobal(Vm.VAR_CURSORSTATE)).toBe(1);
    vm.cursor.userput = 0;
    vm.cursor.state = 0;
    vm.beginTick();
    expect(vm.vars.readGlobal(Vm.VAR_USERPUT)).toBe(0);
    expect(vm.vars.readGlobal(Vm.VAR_CURSORSTATE)).toBe(0);
  });
});

describe('Vm — enterRoom + ENCD/EXCD', () => {
  function fakeRoom(id: number, encd?: number[], excd?: number[]) {
    return {
      id,
      width: 8,
      height: 8,
      numObjects: 0,
      palette: new Uint8Array(768),
      transparentIndex: null,
      indexed: new Uint8Array(64),
      stripMethods: [],
      zPlanes: [],
      entryScript: encd ? new Uint8Array(encd) : null,
      exitScript: excd ? new Uint8Array(excd) : null,
      localScripts: new Map(),
      objects: new Map(),
      walkBoxes: [],
      boxMatrix: [], scaleSlots: [],
    };
  }

  it('updates currentRoom + VAR_ROOM + loadedRoom from the resolver', () => {
    const room = fakeRoom(7);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(7);
    expect(vm.currentRoom).toBe(7);
    expect(vm.vars.readGlobal(4)).toBe(7); // VAR_ROOM
    expect(vm.loadedRoom).toBe(room);
    expect(vm.lastRoomLoadError).toBeNull();
  });

  it('records the error and clears loadedRoom when the resolver throws', () => {
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => {
        throw new Error('no LOFF entry for room 0');
      },
    });
    vm.enterRoom(0);
    expect(vm.loadedRoom).toBeNull();
    expect(vm.lastRoomLoadError).toMatch(/no LOFF entry/);
    expect(vm.currentRoom).toBe(0);
  });

  it('starts the new room\'s ENCD as a labelled slot', () => {
    const room = fakeRoom(10, [0xa0]); // ENCD = stopObjectCode
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(10);
    const encd = vm.slots.find((s) => s.label === 'ENCD-10');
    expect(encd).toBeDefined();
    expect(encd!.status).toBe('running');
    expect(encd!.room).toBe(10);
    expect(Array.from(encd!.bytecode)).toEqual([0xa0]);
  });

  it('starts the previous room\'s EXCD when transitioning to a new room', () => {
    const a = fakeRoom(1, [0x80], [0xa0]); // ENCD breakHere; EXCD stopObjectCode
    const b = fakeRoom(2);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: (id) => (id === 1 ? a : b),
    });
    vm.enterRoom(1);
    // Sanity: ENCD-1 fired.
    expect(vm.slots.some((s) => s.label === 'ENCD-1')).toBe(true);
    vm.enterRoom(2);
    // EXCD-1 should now be queued (for the room we just left).
    expect(vm.slots.some((s) => s.label === 'EXCD-1')).toBe(true);
    expect(vm.loadedRoom).toBe(b);
  });

  it('runs ENCD NESTED — its effect is visible the instant enterRoom returns', () => {
    // ENCD = [0x01] → "g5 = 99". If ENCD were merely queued (deferred), g5
    // would still be 0 here and only update on a later tick; SCUMM runs the
    // entry script nested inside startScene, so the caller sees it done. This
    // is the invariant the pirate-conversation fix depends on (a script's
    // post-loadRoom opcodes must observe the post-ENCD/EXCD state).
    const room = fakeRoom(11, [0x01]);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map<number, OpcodeHandler>([[0x01, (v, slot) => { v.vars.writeGlobal(5, 99); slot.kill(); }]]),
      resolveRoom: () => room,
    });
    vm.enterRoom(11);
    expect(vm.vars.readGlobal(5)).toBe(99); // ran synchronously, no tick needed
  });

  it('runs EXCD NESTED before the new room loads', () => {
    // Leaving room 1 (EXCD = [0x01] → "g6 = 7") for room 2: EXCD must have run
    // by the time enterRoom returns, mirroring runExitScript.
    const a = fakeRoom(1, undefined, [0x01]);
    const b = fakeRoom(2);
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map<number, OpcodeHandler>([[0x01, (v, slot) => { v.vars.writeGlobal(6, 7); slot.kill(); }]]),
      resolveRoom: (id) => (id === 1 ? a : b),
    });
    vm.enterRoom(1);
    vm.enterRoom(2);
    expect(vm.vars.readGlobal(6)).toBe(7);
  });

  it('does nothing extra when ENCD/EXCD are absent', () => {
    const room = fakeRoom(3); // no scripts
    const vm = new Vm({
      numVariables: 32,
      numBitVariables: 64,
      handlers: new Map(),
      resolveRoom: () => room,
    });
    vm.enterRoom(3);
    // Only system state should change; no labelled slots.
    expect(vm.slots.every((s) => s.label === '')).toBe(true);
  });
});

describe('Vm — hang watchdog', () => {
  // A VM whose VAR_VERB_SCRIPT (g32) resolves to `verbScriptBytecode`, with
  // a frame every tick (VAR_TIMER_NEXT = 1) so the settle window advances.
  function makeInputVm(
    verbScriptBytecode: number[],
    handlers: Record<number, OpcodeHandler>,
  ): Vm {
    const vm = new Vm({
      numVariables: 64,
      numBitVariables: 64,
      handlers: new Map(Object.entries(handlers).map(([k, h]) => [Number(k), h])),
      resolveGlobalScript: () => ({ bytecode: new Uint8Array(verbScriptBytecode), room: 0 }),
    });
    vm.vars.writeGlobal(19, 1); // VAR_TIMER_NEXT — frame every tick
    vm.vars.writeGlobal(32, 4); // VAR_VERB_SCRIPT (global id < LSCR_THRESHOLD)
    return vm;
  }

  function click(vm: Vm, settleTicks = 4): void {
    vm.handleVerbClick(50, 1);
    for (let t = 0; t < settleTicks; t++) vm.tick();
  }

  it('fires after N consecutive clicks that change nothing (the dialog-hang symptom)', () => {
    // Verb script just stops — arms/commits nothing, like #4 on a dialog verb
    // when VAR_VERB_SCRIPT is mis-pointed away from the dialog input script.
    const vm = makeInputVm([0x01], { 0x01: (_v, s) => s.kill() });
    let fired: HangInfo | null = null;
    vm.enableHangWatchdog((info) => { fired = info; }, { settleFrames: 2, deadInputThreshold: 3 });
    click(vm);
    expect(fired).toBeNull(); // one dead click isn't enough
    click(vm);
    expect(fired).toBeNull();
    click(vm);
    expect(fired).not.toBeNull();
    expect(fired!.deadInputs).toBe(3);
    expect(fired!.verbScript).toBe(4);
  });

  it('does NOT fire when a click makes progress (commits a sentence)', () => {
    // Verb script pushes a sentence then stops — observable progress.
    const vm = makeInputVm([0x02], {
      0x02: (v, s) => { v.pushSentence({ verb: 1, objectA: 2, objectB: 0 }); s.kill(); },
    });
    let fired: HangInfo | null = null;
    vm.enableHangWatchdog((info) => { fired = info; }, { settleFrames: 2, deadInputThreshold: 3 });
    click(vm);
    click(vm);
    click(vm);
    expect(fired).toBeNull();
  });

  it('a single dead click between progress does not accumulate toward the threshold', () => {
    // Alternate dead / progress clicks: the run never reaches 3 dead in a row.
    let mode = 0;
    const vm = makeInputVm([0x03], {
      0x03: (v, s) => { if (mode === 1) v.pushSentence({ verb: 1, objectA: 2, objectB: 0 }); s.kill(); },
    });
    let fired: HangInfo | null = null;
    vm.enableHangWatchdog((info) => { fired = info; }, { settleFrames: 2, deadInputThreshold: 3 });
    mode = 0; click(vm); // dead
    mode = 1; click(vm); // progress → resets run
    mode = 0; click(vm); // dead
    mode = 0; click(vm); // dead
    expect(fired).toBeNull(); // only 2 dead in a row since the reset
  });

  it('is a no-op (no cost, no fire) when disabled', () => {
    const vm = makeInputVm([0x01], { 0x01: (_v, s) => s.kill() });
    let fired: HangInfo | null = null;
    vm.enableHangWatchdog((info) => { fired = info; }, { settleFrames: 2, deadInputThreshold: 3 });
    vm.disableHangWatchdog();
    click(vm); click(vm); click(vm); click(vm);
    expect(fired).toBeNull();
  });
});

describe('tick() — jiffy/frame split', () => {
  // 0x01: increment g0. 0x02: reset pc to 0 and yield (loop forever,
  // one increment per resume) — i.e. one increment per game frame.
  const incLoop: Record<number, OpcodeHandler> = {
    0x01: (vm) => vm.vars.writeGlobal(0, vm.vars.readGlobal(0) + 1),
    0x02: (_vm, slot) => { slot.pc = 0; slot.yield_(); },
  };

  it('runs the script frame only every VAR_TIMER_NEXT jiffies', () => {
    const vm = makeVm(incLoop);
    vm.vars.writeGlobal(19, 4); // VAR_TIMER_NEXT = 4 jiffies per frame
    vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x01, 0x02]) });
    // First tick is a frame (accumulator 0 -> 1 >= ... ); count frames.
    let frames = 0;
    for (let j = 0; j < 20; j++) if (vm.tick().framed) frames++;
    // 20 jiffies / 4 per frame = 5 frames, and the loop increments g0
    // exactly once per frame.
    expect(frames).toBe(5);
    expect(vm.vars.readGlobal(0)).toBe(5);
  });

  it('counts down a slot delay every jiffy, resuming on the next frame', () => {
    const vm = makeVm(incLoop);
    vm.vars.writeGlobal(19, 5); // 5 jiffies per frame
    const slot = vm.startScript({ scriptId: 1, bytecode: new Uint8Array([0x01, 0x02]) });
    // Run one frame so the loop is established, then park it on a delay.
    vm.tick();
    slot.yield_();
    slot.delayRemaining = 8;
    const g0 = vm.vars.readGlobal(0);
    // 8 jiffies of delay: decrements every jiffy regardless of frames.
    for (let j = 0; j < 8; j++) vm.tick();
    expect(slot.delayRemaining).toBe(0);
    // It must not have resumed (and incremented) while delaying.
    expect(vm.vars.readGlobal(0)).toBe(g0);
    // Next frame boundary resumes it.
    for (let j = 0; j < 5; j++) vm.tick();
    expect(vm.vars.readGlobal(0)).toBeGreaterThan(g0);
  });
});
