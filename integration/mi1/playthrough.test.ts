/**
 * MI1 playthrough — drives the real game through its own scripts and asserts
 * the mechanics work: boot → first room, walking, verb dispatch, and the
 * two-actor pirate conversation. Everything is driven by numeric ids (see
 * `game.ts`), with no save-file dependence and no localized-string
 * assertions, so the same suite passes on any build (IT/EN).
 *
 * Data-gated: skipped when the game files aren't present. Run with
 * `npm run test:integration` (NOT part of the default `npm test`).
 */
import { describe, expect, it } from 'vitest';
import {
  driveTicks,
  driveToRoom,
  driveUntil,
  hover,
} from '../../src/testkit/scummv5';
import { VAR_CURRENT_LIGHTS, VAR_EGO } from '../../src/engine/vm/vars';
import type { Vm } from '../../src/engine/vm/vm';
import { boot, hasGame, ROOMS, VERBS } from './game';

/** Boot + drive the intro until we land in the first interactive room. */
const driveToFirstRoom = (vm: Vm): boolean => driveToRoom(vm, ROOMS.meleeLookout.id);

describe.skipIf(!hasGame())('MI1 playthrough', () => {
  it('start → first interactive room: boots the intro through to room 33, lit, no halt', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    expect(vm.currentRoom).toBe(ROOMS.meleeLookout.id);
    expect(vm.haltInfo).toBeNull();
    // Ego is assigned and present in the room.
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(ego).toBeGreaterThan(0);
    expect(vm.actors.get(ego).room).toBe(ROOMS.meleeLookout.id);
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
    const moved = driveUntil(
      vm,
      () => { const a = vm.actors.get(ego); return a.x !== start.x || a.y !== start.y; },
      { maxTicks: 2400 },
    );
    expect(moved).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  it('verb-dispatch: Look at the poster runs sentence script #2 → a description', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    // Faithful flow: click the "Esamina" verb (8), hover the poster so
    // the #23 poller loads it into g108, then a scene click → #4 commits
    // doSentence → #2 → printEgo. Assert the mechanic — a non-empty
    // description is produced — not the (localized) text itself.
    vm.handleVerbClick(VERBS.look, 1);
    driveTicks(vm, 24);
    hover(vm, ROOMS.meleeLookout.poster.x, ROOMS.meleeLookout.poster.y);
    vm.handleSceneClick(1);
    driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 3600 });
    expect((vm.activeDialog?.text ?? '').length).toBeGreaterThan(0);
    expect(vm.haltInfo).toBeNull();
  });

  // A two-actor dialog conversation: reach the LOOM-ad pirate close-up, pick
  // an answer, and ego speaks that line.
  it('pirate conversation: pick an answer and ego speaks that line', () => {
    const vm = boot();
    expect(driveToFirstRoom(vm)).toBe(true);
    // Drive Mêlée → SCUMM Bar (room 28): open then walk through the bar door.
    vm.pushSentence({ verb: VERBS.open, objectA: ROOMS.meleeLookout.barDoor, objectB: 0 });
    driveTicks(vm, 600);
    vm.pushSentence({ verb: VERBS.walk, objectA: ROOMS.meleeLookout.barDoor, objectB: 0 });
    driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 600 });
    expect(vm.currentRoom).toBe(ROOMS.scummBar.id);
    driveTicks(vm, 200);

    // Start the LOOM-ad pirate conversation (#93 loads the close-up room 82).
    vm.startScriptById(ROOMS.pirateCloseup.convoScript, { args: [] });
    driveTicks(vm, 400);
    expect(vm.currentRoom).toBe(ROOMS.pirateCloseup.id);
    // The dialog options are live verbs. Capture the answer's own label
    // (this build's language) so we can verify ego speaks THAT line without
    // hardcoding a translation.
    const answer = vm.verbs.get(ROOMS.pirateCloseup.answers.niceHat);
    expect(answer?.state).toBe('on');
    expect(answer?.name?.length ?? 0).toBeGreaterThan(0);

    // Click the answer → #14 sets g194 → #93 makes ego speak the selected
    // line. The mechanic: the spoken line is the answer we picked.
    vm.handleVerbClick(ROOMS.pirateCloseup.answers.niceHat, 1);
    driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 400 });
    expect(vm.activeDialog?.text).toBe(answer!.name);
    expect(vm.haltInfo).toBeNull();
  });
});
