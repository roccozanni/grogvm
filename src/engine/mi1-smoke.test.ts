/**
 * End-to-end smoke tests against real MI1 data (DoD #1/#2/#3).
 *
 * These exercise the whole boot → intro → gameplay path through the
 * actual game scripts — the thing unit tests with synthetic bytecode
 * can't cover. They are **data-gated**: when `games/MI1-IT-CD-DOS-VGA` isn't present
 * (CI, fresh checkout) the whole suite is skipped, so the green-without-
 * data convention holds. They never commit any copyrighted bytes.
 *
 * Driver mirrors the inspector's per-tick loop (freeze-aware resume +
 * delayRemaining countdown, processSentence, runUntilAllYield, then
 * stepAllActorWalks + stepAnim) — see scratch/drive-intro.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseResourceFile } from './resources/file';
import { parseIndexFile } from './resources/index-file';
import { parseLoff } from './resources/loff';
import { SCUMM_V5_XOR_KEY } from './resources/xor';
import { applyStandPose } from './actor/walk';
import { currentLimbPicture } from './graphics/costume-anim';
import { bootGame } from './vm/boot';
import { VAR_CURRENT_LIGHTS, VAR_EGO } from './vm/vars';
import type { Vm } from './vm/vm';

const INDEX = 'games/MI1-IT-CD-DOS-VGA/MONKEY.000';
const RESOURCE = 'games/MI1-IT-CD-DOS-VGA/MONKEY.001';
const hasData = existsSync(INDEX) && existsSync(RESOURCE);

/** The first interactive room of the intro (Mêlée lookout path → room 33). */
const FIRST_ROOM = 33;
/** The election-poster object in room 33 + a room-px point inside it. */
const POSTER_X = 268;
const POSTER_Y = 104;
const POSTER_LOOK = 'Rieleggete il Governatore Marley.';

function boot(): Vm {
  const index = parseIndexFile(parseResourceFile(new Uint8Array(readFileSync(INDEX)), SCUMM_V5_XOR_KEY));
  const res = parseResourceFile(new Uint8Array(readFileSync(RESOURCE)), SCUMM_V5_XOR_KEY);
  return bootGame(res, index, parseLoff(res), 'MI1').vm;
}

// One jiffy via the shared engine driver (frame-gated scripts + actors +
// anim, per-jiffy delay/timer countdown) — same model the shell runs.
function tick(vm: Vm): void {
  vm.tick();
}

/**
 * Point the virtual mouse at a room coord and let the #23 hover poller
 * run a few frames so it hit-tests the object into g108 (the faithful
 * way the click flow learns what's under the cursor).
 */
function hover(vm: Vm, x: number, y: number): void {
  vm.mouseRoomX = x;
  vm.mouseRoomY = y;
  vm.vars.writeGlobal(20, x); // VAR_VIRT_MOUSE_X
  vm.vars.writeGlobal(21, y); // VAR_VIRT_MOUSE_Y
  vm.vars.writeGlobal(44, x); // VAR_MOUSE_X
  vm.vars.writeGlobal(45, y); // VAR_MOUSE_Y
  // Several frames' worth of jiffies so the per-frame #23 poller actually
  // runs (a frame fires only every VAR_TIMER_NEXT jiffies).
  for (let i = 0; i < 24; i++) tick(vm);
}

/** Boot + drive the intro until we land in the first interactive room. */
function driveToFirstRoom(vm: Vm, maxTicks = 60000): boolean {
  for (let t = 0; t < maxTicks && !vm.haltInfo; t++) {
    tick(vm);
    if (vm.currentRoom === FIRST_ROOM) return true;
  }
  return false;
}

describe.skipIf(!hasData)('MI1 smoke — boot → gameplay', () => {
  it('start → first interactive room: boots the intro through to room 33, lit, no halt', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    expect(vm.currentRoom).toBe(FIRST_ROOM);
    expect(vm.haltInfo).toBeNull();
    // Ego is assigned and present in the room.
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(ego).toBeGreaterThan(0);
    expect(vm.actors.get(ego).room).toBe(FIRST_ROOM);
    // Room reads as lit (the lighting fix) so look-ats give real text.
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS)).not.toBe(0);
    // Control returned to the player: user input enabled, a verb active.
    expect(vm.cursor.userput).toBeGreaterThan(0);
    // Cursor is live (g52 > 0) so the #23 hover poller runs — the basis
    // of the faithful click flow.
    expect(vm.cursor.state).toBeGreaterThan(0);
    expect([...vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
  });

  it('walk-around: a floor click walks ego toward the target', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    const ego = vm.vars.readGlobal(VAR_EGO);
    const start = { x: vm.actors.get(ego).x, y: vm.actors.get(ego).y };
    // Hover a bare floor point (no object) then click — #4 walks ego to
    // the mouse coords. Faithful flow: scene click carries no object id.
    hover(vm, 160, 140);
    vm.handleSceneClick(1);
    let moved = false;
    for (let t = 0; t < 2400 && !vm.haltInfo; t++) {
      tick(vm);
      const a = vm.actors.get(ego);
      if (a.x !== start.x || a.y !== start.y) { moved = true; break; }
    }
    expect(moved).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  it('verb-dispatch: Look at the poster runs sentence script #2 → real description', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    // Faithful flow: click the "Esamina" verb (8), hover the poster so
    // the #23 poller loads it into g108, then a scene click → #4 commits
    // doSentence → #2 → printEgo.
    vm.handleVerbClick(8, 1);
    for (let i = 0; i < 24; i++) tick(vm);
    hover(vm, POSTER_X, POSTER_Y);
    vm.handleSceneClick(1);
    let dialog: string | null = null;
    for (let t = 0; t < 3600 && !vm.haltInfo; t++) {
      tick(vm);
      if (vm.activeDialog) { dialog = vm.activeDialog.text; break; }
    }
    expect(dialog).toBe(POSTER_LOOK);
    expect(vm.haltInfo).toBeNull();
  });

  // Regression: a room change runs the OLD room's exit script (EXCD). SCUMM's
  // startScene runs it NESTED — to completion before the loadRoom opcode
  // returns — so the calling script's *next* opcodes see the post-EXCD state.
  // The pirate-conversation script #93 relies on this: it does `loadRoom 82`
  // then `g32 = 14` (VAR_VERB_SCRIPT → the dialog input script #14). Room 28's
  // EXCD resets `g32 = 4` (the default verb script). When EXCD ran deferred
  // (queued as a slot, executed after #93 finished its frame), it clobbered the
  // 14 back to 4 — so dialog clicks routed to #4 (which only arms the verb,
  // never commits a dialog selection) and the conversation hung: answers
  // highlighted on hover but clicking did nothing. With EXCD nested, the 14
  // survives and a dialog answer commits via #14 → #93.
  it('pirate conversation: EXCD does not clobber VAR_VERB_SCRIPT; dialog click commits', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    // Drive Mêlée → SCUMM Bar (room 28): open then walk through the bar door
    // (object 428). Same flow scratch/probe-room28-pirates.ts uses.
    vm.pushSentence({ verb: 2, objectA: 428, objectB: 0 });
    for (let t = 0; t < 600 && !vm.haltInfo; t++) tick(vm);
    vm.pushSentence({ verb: 11, objectA: 428, objectB: 0 });
    for (let t = 0; t < 600 && !vm.haltInfo; t++) { tick(vm); if (vm.currentRoom === 28) break; }
    expect(vm.currentRoom).toBe(28);
    for (let t = 0; t < 200; t++) tick(vm);

    // Start the LOOM-ad pirate conversation (#93 loads the close-up room 82
    // itself, then sets g32 = 14).
    vm.startScriptById(93, { args: [] });
    for (let t = 0; t < 400 && !vm.haltInfo; t++) tick(vm);
    expect(vm.currentRoom).toBe(82);
    // The crux: the conversation's verb-input script survives EXCD-28.
    expect(vm.vars.readGlobal(32)).toBe(14);
    // The dialog options are live verbs (120 "Olá, a te.", 121 "Che bel
    // cappello.", …).
    expect(vm.verbs.get(121)?.state).toBe('on');

    // Click answer 121 → #14 sets g194 → #93 makes ego speak the line.
    vm.handleVerbClick(121, 1);
    let dialog: string | null = null;
    for (let t = 0; t < 400 && !vm.haltInfo; t++) {
      tick(vm);
      if (vm.activeDialog) { dialog = vm.activeDialog.text; break; }
    }
    expect(dialog).toBe('Che bel cappello.');
    expect(vm.haltInfo).toBeNull();
  });

  // The hang watchdog would have caught THIS bug at play time. Recreate the
  // pre-fix corruption (VAR_VERB_SCRIPT clobbered to 4 inside the conversation)
  // and confirm a run of dead dialog clicks trips the watchdog — the live
  // signal we now have instead of a multi-hour disassembly dig.
  it('hang watchdog fires on the dialog-stuck symptom (clicks that change nothing)', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    vm.pushSentence({ verb: 2, objectA: 428, objectB: 0 });
    for (let t = 0; t < 600 && !vm.haltInfo; t++) tick(vm);
    vm.pushSentence({ verb: 11, objectA: 428, objectB: 0 });
    for (let t = 0; t < 600 && !vm.haltInfo; t++) { tick(vm); if (vm.currentRoom === 28) break; }
    expect(vm.currentRoom).toBe(28);
    for (let t = 0; t < 200; t++) tick(vm);
    vm.startScriptById(93, { args: [] });
    for (let t = 0; t < 400 && !vm.haltInfo; t++) tick(vm);
    expect(vm.currentRoom).toBe(82);

    // Recreate the bug: point VAR_VERB_SCRIPT at the default script #4 (which
    // only arms a verb, never commits a dialog pick) instead of dialog #14.
    vm.vars.writeGlobal(32, 4);
    let hang: import('./vm/vm').HangInfo | null = null;
    vm.enableHangWatchdog((info) => { hang = info; }, { settleFrames: 3, deadInputThreshold: 3 });

    // Click an answer three times; each arms g107 but commits nothing.
    for (let c = 0; c < 3; c++) {
      vm.handleVerbClick(121, 1);
      for (let t = 0; t < 40 && !vm.haltInfo; t++) tick(vm);
    }
    expect(hang).not.toBeNull();
    expect(hang!.verbScript).toBe(4); // points right at the mis-routed script
    expect(hang!.room).toBe(82);
  });

  // Regression: the head limb must track facing at rest. The stand/walk
  // costume records only stop/un-stop the head — only the init pose
  // carries the head's per-direction frame — so a stop must re-point the
  // head via init (see stepAllActorWalks' stand branch). Before the fix
  // the head kept whatever frame init last set, so a turned actor showed
  // a stale head (e.g. a front "looking-at-camera" head while facing W).
  it('rest head limb tracks facing (init re-point at stand)', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    const ego = vm.vars.readGlobal(VAR_EGO);
    const actor = vm.actors.get(ego);
    const costume = vm.getCostume(actor.costume);
    expect(costume).not.toBeNull();

    // Turn the actor in place to each facing and re-point the stand pose
    // (the real helper the walk loop + faceActor/animateActor use).
    const headFrame = (facing: 'W' | 'E' | 'S' | 'N'): { start: number; pic: number; stopped: boolean } => {
      actor.facing = facing;
      applyStandPose(vm, actor);
      const l1 = actor.anim.limbs[1]!;
      return {
        start: l1.start,
        pic: l1.active ? currentLimbPicture(actor.anim, 1, costume!.payload) : -1,
        stopped: ((actor.anim.stopped >> 1) & 1) === 1,
      };
    };

    const w = headFrame('W');
    const e = headFrame('E');
    const s = headFrame('S');
    const n = headFrame('N');

    // The head is drawn (active, un-stopped) at rest in every direction.
    for (const h of [w, e, s, n]) {
      expect(h.stopped).toBe(false);
      expect(h.pic).toBeGreaterThanOrEqual(0);
    }
    // Front (S), side (W/E), and back (N) are DISTINCT head frames — the
    // crux: before the fix the head was the same frame for every facing.
    expect(s.start).not.toBe(w.start); // front ≠ side
    expect(n.start).not.toBe(w.start); // back ≠ side
    expect(n.start).not.toBe(s.start); // back ≠ front
  });
});
