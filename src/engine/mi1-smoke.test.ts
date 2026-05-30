/**
 * End-to-end smoke tests against real MI1 data (DoD #1/#2/#3).
 *
 * These exercise the whole boot → intro → gameplay path through the
 * actual game scripts — the thing unit tests with synthetic bytecode
 * can't cover. They are **data-gated**: when `games/MI1` isn't present
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
import { bootGame } from './vm/boot';
import { stepAllActorWalks } from './actor/walk';
import { stepAnim } from './graphics/costume-anim';
import { VAR_CURRENT_LIGHTS, VAR_EGO } from './vm/vars';
import type { Vm } from './vm/vm';

const INDEX = 'games/MI1/MONKEY.000';
const RESOURCE = 'games/MI1/MONKEY.001';
const hasData = existsSync(INDEX) && existsSync(RESOURCE);

/** The first interactive room of the intro (Mêlée lookout path → room 33). */
const FIRST_ROOM = 33;
/** The election-poster object in room 33 + its "Look at" description. */
const POSTER_OBJ = 429;
const POSTER_LOOK = 'Rieleggete il Governatore Marley.';

function boot(): Vm {
  const index = parseIndexFile(parseResourceFile(new Uint8Array(readFileSync(INDEX)), SCUMM_V5_XOR_KEY));
  const res = parseResourceFile(new Uint8Array(readFileSync(RESOURCE)), SCUMM_V5_XOR_KEY);
  return bootGame(res, index, parseLoff(res), 'MI1').vm;
}

function tick(vm: Vm): void {
  vm.beginTick();
  vm.processSentence();
  for (const s of vm.slots) {
    if (s.status === 'yielded' && s.freezeCount === 0) {
      if (s.delayRemaining > 0) { s.delayRemaining--; continue; }
      s.resume();
    }
  }
  vm.runUntilAllYield();
  stepAllActorWalks(vm);
  for (const a of vm.actors.all()) a.anim = stepAnim(a.anim);
}

/** Boot + drive the intro until we land in the first interactive room. */
function driveToFirstRoom(vm: Vm, maxTicks = 12000): boolean {
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
    expect(vm.cursor.userput).toBe(true);
    expect([...vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
  });

  it('walk-around: a floor click walks ego toward the target', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    const ego = vm.vars.readGlobal(VAR_EGO);
    const start = { x: vm.actors.get(ego).x, y: vm.actors.get(ego).y };
    // Bare floor click (no object) → MI1's #4 walks ego to the point.
    vm.mouseRoomX = 160;
    vm.mouseRoomY = 140;
    vm.vars.writeGlobal(44, 160); // VAR_MOUSE_X
    vm.vars.writeGlobal(45, 140); // VAR_MOUSE_Y
    vm.handleSceneClick(0, 1);
    let moved = false;
    for (let t = 0; t < 400 && !vm.haltInfo; t++) {
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
    // Arm "Look at" (verb 8) + click the poster → sentence #2 → printEgo.
    vm.currentVerb = 8;
    vm.handleSceneClick(POSTER_OBJ, 1);
    expect(vm.sentenceStack.length).toBe(1);
    let dialog: string | null = null;
    for (let t = 0; t < 600 && !vm.haltInfo; t++) {
      tick(vm);
      if (vm.activeDialog) { dialog = vm.activeDialog.text; break; }
    }
    expect(dialog).toBe(POSTER_LOOK);
    expect(vm.haltInfo).toBeNull();
  });
});
