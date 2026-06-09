/**
 * MI1 FULL WALKTHROUGH — the regression net.
 *
 * ONE continuous run: a single VM, booted once, driven through the game's own
 * solution from the title screen onward, state carrying forward the whole way.
 * We grow it room by room; the last green beat is the **frontier** — how far
 * the engine currently gets. Run it at the end of a session / after a refactor:
 * if the game stopped being playable anywhere, the failing beat's name says
 * where.
 *
 * WHAT THIS COVERS — and what it doesn't:
 *   • It is HEADLESS. It drives the VM and asserts on observable VM *state*
 *     (current room, object ownership, globals/bit-vars, halt, actor
 *     position, dialog text-as-data). It renders ZERO pixels.
 *   • So it catches LOGIC / PLAYABILITY regressions ("the door won't open",
 *     "the trial flag stops setting", "a script halts", "ego can't path").
 *     It does NOT catch visual ones — garbled compositing, z-order, a missing
 *     cursor — those stay the domain of in-browser real-pixel confirmation.
 *     A green run proves the game *plays*, never that it *renders*.
 *
 * RULES (same as the rest of the suite):
 *   • Drive from boot every run — no save fast-forward — so intro/early-room
 *     regressions can't hide. It gets slower as it spans the game; that's the
 *     price of honest coverage.
 *   • Deterministic: boot seeds the engine RNG ({@link SEED}) so the run is
 *     reproducible — a flaky regression net is worthless.
 *   • Assert MECHANICS via numeric ids, never localized strings. Where text
 *     must be checked, derive it from this build (e.g. a dialog answer's own
 *     `name`).
 *   • Player actions go through the faithful click flow ({@link actions});
 *     any unavoidable shortcut is flagged as debt at the call site.
 *   • Movement is a BARE click, never an armed verb. In MI1 "Walk to" is the
 *     *default* sentence, not a verb button you press — the player just clicks
 *     a spot or a thing and the engine runs its default action: floor → walk
 *     there; a door/arch → enter if open, stop in front if closed; a map node
 *     → travel. So `walkTo(vm, target)` (hover + click, no verb armed) is how
 *     ego moves and goes through doors/arches/nodes. `use(vm, VERB, obj)` is
 *     ONLY for the real verb buttons — Open, Look at, Pick up, Talk to, Push,
 *     Give — e.g. a closed door is `use(open, door)` then `walkTo(door)`.
 *
 * BEAT NAMING: `<Part> · <Room> — <what the beat proves>`. Part is the game's
 * own part (roman numeral; I = "The Three Trials"); Room is where the beat
 * acts. No ordinal — file order *is* run order, so the sequence is positional.
 * Stop-on-break surfaces the failing beat's name, so it must say *where* (the
 * room) and *what* broke; don't cross-reference other beats by number.
 *
 * Data-gated (skipped without the game files). Run: `npm run test:integration`.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it, type TestContext } from 'vitest';
import { snapshotVm } from '../../src/engine/vm/savestate';
import {
  driveToRoom,
  driveUntil,
  give,
  pickAnswer,
  pickDialogAnswer,
  use,
  useWith,
  waitGlobal,
  waitIdle,
  waitPickedUp,
  waitPlayable,
  waitReady,
  walkTo,
} from '../../src/testkit/scummv5';
import { VAR_CURRENT_LIGHTS, VAR_EGO } from '../../src/engine/vm/vars';
import {
  boot,
  enoughForSwordMaster,
  fightSwordMaster,
  grindOneDuel,
  hasGame,
  ROOMS,
  VARS,
  VERBS,
} from './game';

// One VM for the whole walkthrough, driven forward across beats.
const vm = boot();

// Stop-on-break: the FIRST failing beat goes red (that's the regression);
// every later beat is skipped, not cascaded into noise or — worse — falsely
// passed. So a red+skipped tail localizes exactly where the game broke.
let broken = false;
const beat = (name: string, fn: (ctx: TestContext) => void | Promise<void>): void =>
  it(name, async (ctx) => {
    if (broken) return ctx.skip();
    try {
      await fn(ctx);
    } catch (e) {
      broken = true;
      throw e;
    }
  });

describe.skipIf(!hasGame())('MI1 — full walkthrough', () => {
  beat('I · Mêlée Lookout — intro boots through to the lookout (33), lit, control returned', () => {
    expect(driveToRoom(vm, ROOMS.meleeLookout.id)).toBe(true);
    expect(vm.haltInfo).toBeNull();
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(ego).toBeGreaterThan(0);
    expect(vm.actors.get(ego).room).toBe(ROOMS.meleeLookout.id);
    // Lit (the lighting seed) so look-ats yield real descriptions, not "too dark".
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS)).not.toBe(0);
    expect(vm.cursor.userput).toBeGreaterThan(0);
    expect(vm.cursor.state).toBeGreaterThan(0);
    expect([...vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
  });

  beat('I · Mêlée Lookout — a floor click walks ego across the lookout', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const start = { x: vm.actors.get(ego).x, y: vm.actors.get(ego).y };
    walkTo(vm, { x: 160, y: 140 });
    const moved = driveUntil(
      vm,
      () => { const a = vm.actors.get(ego); return a.x !== start.x || a.y !== start.y; },
      { maxTicks: 2400 },
    );
    expect(moved).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée Lookout — "Look at" the election poster yields a description', () => {
    use(vm, VERBS.look, ROOMS.meleeLookout.poster);
    driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 3600 });
    expect((vm.activeDialog?.text ?? '').length).toBeGreaterThan(0);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée Lookout — open the bar door, walk through into the SCUMM Bar (28)', () => {
    use(vm, VERBS.open, ROOMS.meleeLookout.barDoor);
    walkTo(vm, ROOMS.meleeLookout.barDoor);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 1200 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · SCUMM Bar — talk to the LOOM-ad pirate → close-up (82), pick an answer, ego speaks it', () => {
    // Talking to the salesman pirate #333 starts conversation script #93, which
    // loads the close-up room 82.
    use(vm, VERBS.talk, ROOMS.scummBar.loomPirate);
    expect(driveToRoom(vm, ROOMS.pirateCloseup.id, { maxTicks: 2400 })).toBe(true);

    // This beat hand-rolls the dialog (rather than pickDialogAnswer) to prove
    // the mechanic end-to-end: the line ego speaks IS the answer we clicked.
    const niceHat = ROOMS.pirateCloseup.answers.niceHat;
    driveUntil(vm, (v) => v.verbs.get(niceHat)?.state === 'on', { maxTicks: 1200 });
    const answer = vm.verbs.get(niceHat);
    expect(answer?.state).toBe('on');
    expect(answer?.name?.length ?? 0).toBeGreaterThan(0);
    pickAnswer(vm, niceHat);
    driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 400 });
    expect(vm.activeDialog?.text).toBe(answer!.name);

    // Fire the goodbye option once it re-arms to return to the bar.
    waitIdle(vm);
    const goodbye = ROOMS.pirateCloseup.answers.goodbye;
    driveUntil(vm, (v) => v.verbs.get(goodbye)?.state === 'on', { maxTicks: 1200 });
    pickAnswer(vm, goodbye);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 4000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · SCUMM Bar — talk to the 3 pirates; the trials flag (g197) flips', () => {
    // Unlike the LOOM pirate, the three important-looking pirates (#322) run
    // their conversation #220 *inline* in the bar — no close-up room.
    expect(vm.vars.readGlobal(VARS.trialsLearned)).toBe(0); // not yet learned
    use(vm, VERBS.talk, ROOMS.scummBar.threePirates);

    // Pick "Voglio diventare un pirata." — the real opener (the other two are
    // jokes that dead-end). The pirates then explain the trials → g197 flips.
    const wantPirate = ROOMS.scummBar.trialsAnswers.wantToBePirate;
    driveUntil(vm, (v) => v.verbs.get(wantPirate)?.state === 'on', { maxTicks: 2400 });
    expect(vm.verbs.get(wantPirate)?.name?.length ?? 0).toBeGreaterThan(0);
    pickAnswer(vm, wantPirate);
    expect(waitGlobal(vm, VARS.trialsLearned, 1)).toBe(true);

    const goodbye = ROOMS.scummBar.trialsAnswers.goodbye;
    driveUntil(vm, (v) => v.verbs.get(goodbye)?.state === 'on', { maxTicks: 2400 });
    pickAnswer(vm, goodbye);
    expect(
      driveUntil(vm, (v) => v.verbs.get(VERBS.talk)?.state === 'on', { maxTicks: 4000 }),
    ).toBe(true);
    expect(vm.loadedRoom?.id).toBe(ROOMS.scummBar.id);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · SCUMM Bar — wait out the cook, sneak into the kitchen (41)', () => {
    const cook = () => vm.actors.get(ROOMS.scummBar.cookActor);
    const inBar = () => cook().room === ROOMS.scummBar.id;

    // Pre-position ego at the kitchen door so it can slip in during the brief
    // window — crossing the whole bar mid-window won't make it.
    walkTo(vm, { x: 500, y: 130 });

    // The cook cycles out into the bar then back. The door's left open, so a
    // click on it carries ego through — but only with the cook deep in the bar
    // (his sweep dips to x≈300), clear of the doorway he'd otherwise block. The
    // window is timed, so retry across cycles; each miss waits out the window
    // before the next try.
    let entered = false;
    for (let attempt = 0; attempt < 12 && !entered; attempt++) {
      driveUntil(vm, () => inBar() && cook().x < 340, { maxTicks: 4000 });
      if (inBar() && cook().x < 340) {
        walkTo(vm, ROOMS.scummBar.kitchenDoor);
        entered = driveToRoom(vm, ROOMS.kitchen.id, { maxTicks: 1500 });
      }
      if (!entered) driveUntil(vm, () => !inBar(), { maxTicks: 2000 });
    }
    expect(entered).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — take the meat and the pot', () => {
    for (const obj of [ROOMS.kitchen.meat, ROOMS.kitchen.pot]) {
      use(vm, VERBS.pickUp, obj);
      expect(waitPickedUp(vm, obj)).toBe(true);
    }
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — stomp the board 3× to scare the gull, grab the fish', () => {
    const k = ROOMS.kitchen;
    const gull = () => vm.actors.get(k.seagullActor);

    // Open the dock door and wait for it to actually swing open (its state
    // flips to 1): only then are the dock walkboxes unblocked — until then ego
    // can't even path onto the dock — and the gull watcher (local #203, on
    // ego's distance to the board) is armed.
    use(vm, VERBS.open, k.dockDoor);
    expect(driveUntil(vm, (v) => v.objectStates.get(k.dockDoor) === 1, { maxTicks: 4000 })).toBe(true);

    // Two stomps notch the gull's scare counter; step off between so the
    // watcher re-triggers on the next approach (the next `walkTo` waits for ego
    // to finish stepping off before heading back).
    for (let stomp = 1; stomp <= 2; stomp++) {
      walkTo(vm, k.boardWalkTo);
      expect(
        driveUntil(vm, (v) => v.vars.readGlobal(VARS.gullScare) === stomp, { maxTicks: 4000 }),
      ).toBe(true);
      walkTo(vm, k.offBoard);
    }

    // Third stomp makes the gull bolt (x 252→310); the fish's "bird will peck"
    // guard lifts only WHILE it flies. Trigger on the bolt, then grab inside
    // that window.
    walkTo(vm, k.boardWalkTo);
    expect(driveUntil(vm, () => gull().x > 260, { maxTicks: 4000 })).toBe(true);
    use(vm, VERBS.pickUp, k.fish);
    expect(waitPickedUp(vm, k.fish)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — back out through the SCUMM Bar to the Mêlée Lookout (33)', () => {
    // The kitchen-side door isn't cook-gated, so a plain walk back out.
    walkTo(vm, ROOMS.kitchen.barDoor);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 2000 })).toBe(true);

    // The FIRST bar exit fires a one-time cutscene (the Sheriff; through rooms
    // 70→72) before control lands back at the lookout — hence the wide budget.
    walkTo(vm, ROOMS.scummBar.exitDoor);
    expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 8000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée Lookout — off the cliff, up the path, across the map to the clearing (52)', () => {
    walkTo(vm, ROOMS.meleeLookout.cliff);
    expect(driveToRoom(vm, ROOMS.cliffPath.id, { maxTicks: 4000 })).toBe(true);

    // "il sentiero" lists verbs [90, 255] but no walk verb, so the click's
    // default sentence falls back to the 0xFF/255 default entry, which runs the
    // exit up to the map.
    walkTo(vm, ROOMS.cliffPath.path);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 4000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    walkTo(vm, ROOMS.meleeMap.clearing);
    expect(driveToRoom(vm, ROOMS.clearing.id, { maxTicks: 6000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Clearing — enter the circus tent (51); the brothers start arguing', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    // Room 52 is a high zone (right, where you enter) and a low zone (left,
    // the tent). You can't walk straight across: local script 202 force-stops
    // the ego whenever it's in box 7 (the diagonal bridge) at x>200, so a
    // single click on the tent stalls at the high/low boundary. The faithful
    // play is to descend into the low zone first, then walk to the tent —
    // staged here in short hops exactly as a player clicks their way down.
    for (const wp of [{ x: 209, y: 118 }, { x: 120, y: 115 }, { x: 90, y: 92 }]) {
      walkTo(vm, wp);
      driveUntil(
        vm,
        (v) => {
          const a = v.actors.get(ego);
          return Math.abs(a.x - wp.x) <= 6 && Math.abs(a.y - wp.y) <= 8;
        },
        { maxTicks: 4000 },
      );
    }
    walkTo(vm, ROOMS.clearing.circusTent);
    expect(driveToRoom(vm, ROOMS.circus.id, { maxTicks: 6000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Circus — break in (ahem) and negotiate the cannonball job', () => {
    const A = ROOMS.circus.fettuciniAnswers;
    // Break into the argument with "ahem", then negotiate: ask the pay, accept,
    // claim the helmet. The menus are sequential and separated by speech, so the
    // recurring answer id (120) can't cross-match. The last pick takes the
    // cannon-launch branch and hands control back (the brothers want the helmet).
    pickDialogAnswer(vm, A.ahem);
    pickDialogAnswer(vm, A.howMuchPay);
    pickDialogAnswer(vm, A.acceptDeal);
    pickDialogAnswer(vm, A.haveHelmet);
    expect(waitPlayable(vm, 8000)).toBe(true);
    expect(vm.loadedRoom?.id).toBe(ROOMS.circus.id);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Circus — give the pot as a helmet; the cannon gag pays 478 pieces of eight', () => {
    expect(vm.vars.readGlobal(VARS.money)).toBe(0);

    // The pot is the "helmet": give it to a brother (the first give-to-actor) →
    // the cannon-launch cutscene plays through to the post-launch amnesia gag.
    give(vm, VERBS.give, ROOMS.kitchen.pot, ROOMS.circus.brotherActor);
    pickDialogAnswer(vm, ROOMS.circus.fettuciniAnswers.amnesia, { armTicks: 30000 });

    // The payout: object #488 (pieces of eight) runs its verb-250 script,
    // adding 478 to the money global.
    expect(waitGlobal(vm, VARS.money, 478, 20000)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Circus — back to the map and on to the Mêlée town street (35)', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const A = () => vm.actors.get(ego);
    // The cannon gag fires ego clean out of the circus and dumps him back in
    // the clearing (52) — there's no manual exit to take; just let it play out.
    // He lands in the low (tent) zone, so climb the diagonal bridge back to the
    // high zone before taking the path up (reverse of the staged descent in).
    expect(driveToRoom(vm, ROOMS.clearing.id, { maxTicks: 6000 })).toBe(true);
    for (const wp of [{ x: 120, y: 115 }, { x: 209, y: 118 }, { x: 430, y: 130 }]) {
      walkTo(vm, wp);
      driveUntil(vm, () => Math.abs(A().x - wp.x) <= 8 && Math.abs(A().y - wp.y) <= 10, { maxTicks: 4000 });
    }
    walkTo(vm, ROOMS.clearing.pathToMap);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);

    // Map → the town: the "village" node lands ego in the wide lookout/town
    // room 33 (g196 still 0 this early); walk east through its arch into the
    // town street (35). One grouped travel beat, lookout-arch and all.
    walkTo(vm, ROOMS.meleeMap.village);
    expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 8000 })).toBe(true);
    walkTo(vm, ROOMS.meleeLookout.townArch);
    expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 12000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée town — buy the treasure map off the citizen (the cousin-Dominique line)', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(vm.getObjectOwner(ROOMS.meleeStreet.map)).not.toBe(ego);
    const startMoney = vm.vars.readGlobal(VARS.money);

    // The cousin-Dominique line is the opener that gets the citizen to offer the
    // map; "take it" then buys it for 100 pieces of eight. (The other openers
    // dead-end.)
    use(vm, VERBS.talk, ROOMS.meleeStreet.citizen);
    expect(pickDialogAnswer(vm, ROOMS.meleeStreet.citizenAnswers.dominique).length).toBeGreaterThan(0);
    expect(pickDialogAnswer(vm, ROOMS.meleeStreet.citizenAnswers.takeMap).length).toBeGreaterThan(0);
    expect(waitPickedUp(vm, ROOMS.meleeStreet.map)).toBe(true);
    expect(waitGlobal(vm, VARS.money, startMoney - 100)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Voodoo Lady — duck in (29), pocket the chicken, and back out to the street', () => {
    use(vm, VERBS.open, ROOMS.meleeStreet.voodooDoor);
    walkTo(vm, ROOMS.meleeStreet.voodooDoor);
    expect(driveToRoom(vm, ROOMS.voodooShop.id, { maxTicks: 8000 })).toBe(true);

    use(vm, VERBS.pickUp, ROOMS.voodooShop.chicken);
    expect(waitPickedUp(vm, ROOMS.voodooShop.chicken)).toBe(true);

    walkTo(vm, ROOMS.voodooShop.door);
    expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée town — through the arch and into the general store (30)', () => {
    walkTo(vm, ROOMS.meleeStreet.storeArch);
    expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 10000 })).toBe(true);
    // The store door's Open handler only fires with ego standing at it, so the
    // "approach, open, enter": click it (ego walks up, stops — it's closed),
    // Open it, then click again to walk through.
    walkTo(vm, ROOMS.storeStreet.storeDoor);
    use(vm, VERBS.open, ROOMS.storeStreet.storeDoor);
    walkTo(vm, ROOMS.storeStreet.storeDoor);
    expect(driveToRoom(vm, ROOMS.store.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · General store — grab the sword & shovel, ring for the shopkeeper, pay up', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const startMoney = vm.vars.readGlobal(VARS.money);
    const A = ROOMS.store.buyAnswers;

    // Lift both items off the shelf first — ownership flips to ego on the spot
    // (he's pocketing unpaid merchandise).
    for (const obj of [ROOMS.store.sword, ROOMS.store.shovel]) {
      use(vm, VERBS.pickUp, obj);
      expect(waitPickedUp(vm, obj)).toBe(true);
    }

    // Ring the bell (Push) to summon the shopkeeper, then buy through his
    // conversation. The buy menu reuses verb ids (120/121 recur across stages),
    // so pick in order: bring up the sword → buy it, the shovel → buy it, leave.
    use(vm, VERBS.push, ROOMS.store.bell);
    use(vm, VERBS.talk, ROOMS.store.shopkeeper);
    pickDialogAnswer(vm, A.aboutSword);
    pickDialogAnswer(vm, A.wantIt);
    pickDialogAnswer(vm, A.aboutShovel);
    pickDialogAnswer(vm, A.wantIt);
    pickDialogAnswer(vm, A.lookAround); // ends the chat, hands control back

    // Paid for both (sword 100 + shovel 75 = 175) and still holding them.
    expect(waitGlobal(vm, VARS.money, startMoney - 175)).toBe(true);
    expect(vm.getObjectOwner(ROOMS.store.sword)).toBe(ego);
    expect(vm.getObjectOwner(ROOMS.store.shovel)).toBe(ego);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · General store — step back out to the street (34)', () => {
    use(vm, VERBS.open, ROOMS.store.door);
    walkTo(vm, ROOMS.store.door);
    expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · General store — back across the island to the forest fork (218)', () => {
    // The whole trip out, reversed, in one go: the store street's far-east arch
    // → the town street, its west arch → the lookout, off the cliff, up the
    // path to the map, then the map's crossroads node (#911, "il bivio") — the
    // one node we've not taken before — loads room 218, the forest-maze entry
    // (a pseudo-room backed by room 58). Each hop is a bare click whose default
    // verb-11 runs the transition.
    walkTo(vm, ROOMS.storeStreet.townArch);
    expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 12000 })).toBe(true);
    walkTo(vm, ROOMS.meleeStreet.lookoutArch);
    expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 12000 })).toBe(true);
    walkTo(vm, ROOMS.meleeLookout.cliff);
    expect(driveToRoom(vm, ROOMS.cliffPath.id, { maxTicks: 6000 })).toBe(true);
    walkTo(vm, ROOMS.cliffPath.path);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 6000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    walkTo(vm, ROOMS.meleeMap.crossroads);
    expect(driveToRoom(vm, ROOMS.forest.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest — thread the maze (back/left/right…) out to the dig clearing (64)', () => {
    // From the entry (218) the path back, left, right, left, right, back,
    // right, left, back walks out to the treasure clearing. Each turn is a
    // click on a direction's "il sentiero" tile; its verb-11 switches on the
    // current pseudo-room (`g4`) and loads the next. Asserting the pseudo-room
    // each step lands in proves we're threading the exact route (a re-wired
    // maze edge fails on the step that broke), and the last `back` exits to 64.
    const F = ROOMS.forest;
    const route: ReadonlyArray<[number, number]> = [
      [F.back, 215], [F.left, 220], [F.right, 213], [F.left, 212], [F.right, 204],
      [F.back, 211], [F.right, 216], [F.left, 201], [F.back, ROOMS.forestDig.id],
    ];
    for (const [path, next] of route) {
      walkTo(vm, path);
      expect(driveUntil(vm, (v) => v.currentRoom === next, { maxTicks: 12000 })).toBe(true);
    }
    expect(vm.currentRoom).toBe(ROOMS.forestDig.id);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest dig — Use the shovel on the X; the cutscene unearths the T-shirt', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(vm.getObjectOwner(ROOMS.forestDig.tshirt)).not.toBe(ego);

    // "Usa pala con X": the dig cutscene (local #200) plays "Passano ore",
    // ego digs, and `pickupObject`s the treasure T-shirt into the inventory.
    // It's a long cutscene (two camera pans + the dig-and-refill), hence the
    // wide budget.
    useWith(vm, VERBS.use, ROOMS.store.shovel, ROOMS.forestDig.x);
    expect(waitPickedUp(vm, ROOMS.forestDig.tshirt, 60000)).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest dig — back up the path to the map, into the maze at the crossroads (218)', () => {
    // The dig clearing's only exit is "il sentiero nella foresta" (#750): a
    // bare click runs its verb-11 → back to the Mêlée map, landing on the
    // crossroads node. Re-enter the maze through that same node (#911, "il
    // bivio") → the forest entry pseudo-room (218).
    walkTo(vm, ROOMS.forestDig.pathToMap);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    walkTo(vm, ROOMS.meleeMap.crossroads);
    expect(driveToRoom(vm, ROOMS.forest.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest — thread the back-route out to the sword-master fork (209)', () => {
    // A different thread of the maze than the treasure route: from the entry
    // (218) the path back, back, right, right, left, back lands at the
    // sword-master fork (pseudo-room 209). Same three direction objects as the
    // treasure run (back #685 / left #688 / right #687); asserting the
    // pseudo-room each step lands in proves we're walking this exact route. The
    // second `back` (215→203) is the map-gated edge — we hold the map (#442),
    // so it lets us through instead of bouncing us out.
    const F = ROOMS.forest;
    const route: ReadonlyArray<[number, number]> = [
      [F.back, 215], [F.back, 203], [F.right, 202], [F.right, 205], [F.left, 217], [F.back, 209],
    ];
    for (const [path, next] of route) {
      walkTo(vm, path);
      expect(driveUntil(vm, (v) => v.currentRoom === next, { maxTicks: 12000 })).toBe(true);
    }
    expect(vm.currentRoom).toBe(209);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest — push the signpost (the trunk drops as a bridge), cross to the Sword Master (61)', () => {
    // Push the signpost (#681): its local #203 drops the dead tree-trunk into a
    // bridge — unblocking the box and playing the fall — and sets bit#546. Wait
    // for that bit before crossing: only then is the right path (#687) walkable
    // over to the Sword Master's clearing (61). Reaching room 61 is the
    // discovery — the location is now known for the swordfighting trial later.
    expect(vm.vars.readBit(ROOMS.forest.bridgeBit)).toBe(0);
    use(vm, VERBS.push, ROOMS.forest.signpost);
    expect(
      driveUntil(vm, (v) => v.vars.readBit(ROOMS.forest.bridgeBit) === 1, { maxTicks: 12000 }),
    ).toBe(true);

    walkTo(vm, ROOMS.forest.right);
    expect(driveToRoom(vm, ROOMS.swordMaster.id, { maxTicks: 12000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Sword Master — back to the map and on to the troll bridge (57)', () => {
    // Out of the Sword Master's clearing: #743 has no walk verb, so a bare
    // click runs its default (verb 255) → back to the Mêlée map. From there the
    // "il ponte" node (#914) drops ego on the troll's side of the bridge (57).
    walkTo(vm, ROOMS.swordMaster.path);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    walkTo(vm, ROOMS.meleeMap.bridge);
    expect(driveToRoom(vm, ROOMS.trollBridge.id, { maxTicks: 10000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Troll bridge — give the troll the red herring; cross back to the map', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    // The troll wants "una cosa rossa": give him the red herring (the kitchen
    // fish, #568) — the two-object "Dai" sentence to the troll actor. Local
    // #204 says "Un'aringa rossa! ... Passa!", unblocks the bridge, and walks
    // ego across, landing back on the map. The fish ends owned by the troll.
    expect(vm.getObjectOwner(ROOMS.kitchen.fish)).toBe(ego);
    give(vm, VERBS.give, ROOMS.kitchen.fish, ROOMS.trollBridge.trollActor);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 12000 })).toBe(true);
    expect(vm.getObjectOwner(ROOMS.kitchen.fish)).not.toBe(ego);
    // Crossing leaves the map's verb bar empty (local #204 sets VAR_VERB_SCRIPT
    // on the way over), so just settle — node travel runs the default-verb
    // sentence and needs no armed verb. Don't waitPlayable here (no verb arms).
    waitReady(vm);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée map — travel on to the house (la casa, 43)', () => {
    // Bridge crossed, the far side of the map is reachable: the "la casa" node
    // (#916) loads the house (room 43).
    walkTo(vm, ROOMS.meleeMap.house);
    expect(driveToRoom(vm, ROOMS.house.id, { maxTicks: 12000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat("I · House — knock and take Captain Smirk's basic swordfighting lesson (60 → 43)", () => {
    const startMoney = vm.vars.readGlobal(VARS.money);
    expect(vm.vars.readBit(ROOMS.house.lessonTakenBit)).toBe(0);

    // Knock (Open the door, #591) → Smirk's doorway conversation (global #57).
    // The whole exchange is cutscene-driven and each menu's intended line is
    // the first slot (verb 120), so pick 120 down the negotiation: (1) ask to
    // be trained, (2) "Sì che lo sono!" — yes I'm a pirate, (3,4) "Lo sono!"
    // insist twice more, (5) "Ho 30 pezzi da otto" (we hold ≥30), (6) hand over
    // the sword ("Va bene, ecco."). That sends ego into Smirk's gym (60).
    use(vm, VERBS.open, ROOMS.house.door);
    for (let menu = 0; menu < 6; menu++) {
      expect(pickDialogAnswer(vm, 120, { armTicks: 20000 }).length).toBeGreaterThan(0);
    }
    expect(driveToRoom(vm, ROOMS.smirkGym.id, { maxTicks: 30000 })).toBe(true);

    // The teaching cutscene runs long, then the insult lesson begins. With no
    // real comebacks yet, answer "whatever" (verb 120) to both insults — that
    // ends the lesson and boots Guybrush back outside the house (43).
    pickDialogAnswer(vm, 120, { armTicks: 60000 });
    pickDialogAnswer(vm, 120, { armTicks: 60000 });
    expect(driveToRoom(vm, ROOMS.house.id, { maxTicks: 60000 })).toBe(true);

    // Paid 30 for the lesson; the lesson-taken flag is now set.
    expect(vm.vars.readGlobal(VARS.money)).toBe(startMoney - 30);
    expect(vm.vars.readBit(ROOMS.house.lessonTakenBit)).toBe(1);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · House — back out the lower path to the Mêlée map (85)', () => {
    // The house's lower path (#592) is a bare-click exit back to the map.
    walkTo(vm, ROOMS.house.pathToMap);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée map — take up a west-of-fork spot to draw pirates out', () => {
    // Pirates spawn at random map spots and walk toward random nodes; a duel
    // fires when one closes on ego. The east/house edge stays cold for tens of
    // thousands of ticks, but the west-of-fork side has the traffic (confirmed
    // in scratch/stumble.ts). Park here; the grind beat below does the wandering.
    walkTo(vm, ROOMS.pirateDuel.westSpots[0]!);
    expect(vm.currentRoom).toBe(ROOMS.meleeMap.id);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Mêlée map — grind pirate duels lose-to-learn until ready for the Sword Master', () => {
    // ONE beat for the whole grind (per-duel beats were too noisy). Each
    // `grindOneDuel` plays one provoked duel to completion lose-to-learn: a duel
    // is full-mode (g285=3) and the turn flips on who won the last exchange, so
    // throwing a known insult and letting the pirate counter it both teaches that
    // comeback (#82) AND flips us to defense, where the pirate insults us and we
    // learn a new insult (#83). (Winning every exchange — the old picker — stays
    // on attack and learns almost nothing.) We loop until `enoughForSwordMaster`:
    // the comebacks Carla's seeded duel needs PLUS the gate g282>3. The seed is
    // fixed so this is deterministic — exactly 30 duels every run. CAP is only a
    // runaway-loop backstop (a broken gate fails the assertion below instead of
    // hanging), set a little above 30 — not the exact count — so a benign upstream
    // RNG nudge that shifts it slightly still passes.
    const CAP = 36;
    let fought = 0;
    for (; fought < CAP && !enoughForSwordMaster(vm); fought++) {
      expect(grindOneDuel(vm)).toBe(true);
      // `grindOneDuel` only returns true once back on the map (global #114).
      expect(vm.currentRoom).toBe(ROOMS.meleeMap.id);
      expect(vm.haltInfo).toBeNull();
    }
    expect(enoughForSwordMaster(vm)).toBe(true);
    expect(vm.vars.readGlobal(VARS.fightsWon)).toBeGreaterThan(3);
  });

  beat('I · Mêlée map — travel to the Sword Master’s clearing (61)', () => {
    // The map node #918 walks ego over and `loadRoomWithEgo room=61`.
    walkTo(vm, ROOMS.meleeMap.swordMaster);
    expect(driveToRoom(vm, ROOMS.swordMaster.id, { maxTicks: 14000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Sword Master — win the insult duel; the swordfighting trial is passed', () => {
    // Talk to Carla → sit out the intro → her duel runs in room 44 (g285=2, she
    // insults 16..33). `fightSwordMaster` defends with scroll-to-want (the comeback
    // menu pages 6 at a time) and wins. Beating her sets bit#20 — trial complete.
    expect(vm.vars.readBit(ROOMS.swordMaster.foughtBit)).toBe(0);
    expect(fightSwordMaster(vm)).toBe(true);
    expect(vm.vars.readBit(ROOMS.swordMaster.foughtBit)).toBe(1);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Sword Master — back to the map and into the forest at the crossroads (218)', () => {
    // The thievery trial opens with a forest detour for the guard-dogs' sedative.
    // Out of the Sword Master's clearing via her path (#743, a bare-click default)
    // → the Mêlée map, then the crossroads node (#911, "il bivio") → the forest
    // entry pseudo-room (218), exactly as the treasure/sword-master runs began.
    walkTo(vm, ROOMS.swordMaster.path);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    walkTo(vm, ROOMS.meleeMap.crossroads);
    expect(driveToRoom(vm, ROOMS.forest.id, { maxTicks: 8000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Forest — one back step to the yellow-flower screen (215), pick the petal', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    expect(vm.getObjectOwner(ROOMS.forest.yellowPetal)).not.toBe(ego);

    // From the entry (218) a single `back` (#685) lands on the one screen whose
    // flowers are yellow (pseudo-room 215). Pick up the plant (#678): in g4==215
    // its verb-9 `pickupObject`s the yellow petal (#689) into inventory — the
    // sedative for the mansion's guard dogs. (Pseudo-rooms all alias room 58, so
    // gate on `currentRoom`/g4, not `loadedRoom`.)
    walkTo(vm, ROOMS.forest.back);
    expect(
      driveUntil(vm, (v) => v.currentRoom === ROOMS.forest.flowerScreen, { maxTicks: 12000 }),
    ).toBe(true);
    use(vm, VERBS.pickUp, ROOMS.forest.flowerPlant);
    expect(waitPickedUp(vm, ROOMS.forest.yellowPetal)).toBe(true);
    expect(vm.getObjectOwner(ROOMS.forest.yellowPetal)).toBe(ego);
    expect(vm.haltInfo).toBeNull();
  });

  beat("I · Forest — out of the maze and across the island to the Governor's mansion (36)", () => {
    // Petal in hand, leave the forest and cross to the mansion through the
    // lookout/town/shops. Out of the flower screen (215): right (#687) back to
    // the entry (218), then right again dumps to the Mêlée map (a wrong turn at
    // the entry exits the maze). From the map the village node (#917) still
    // lands at the lookout (33) — g196 has climbed to 2, but that node routes
    // there regardless — then east through its arch (#427) to the town street
    // (35), the store arch (#451) to the store street (34), and finally
    // "il palazzo del Governatore" (#431, a verb-11 `loadRoomWithEgo room=36`)
    // walks ego up to the mansion gate, where the piranha poodles guard the door.
    walkTo(vm, ROOMS.forest.right);
    expect(driveUntil(vm, (v) => v.currentRoom === ROOMS.forest.id, { maxTicks: 12000 })).toBe(true);
    walkTo(vm, ROOMS.forest.right);
    expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 12000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    walkTo(vm, ROOMS.meleeMap.village);
    expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 12000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    walkTo(vm, ROOMS.meleeLookout.townArch);
    expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 14000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    walkTo(vm, ROOMS.meleeStreet.storeArch);
    expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    walkTo(vm, ROOMS.storeStreet.mansion);
    expect(driveToRoom(vm, ROOMS.governorMansion.id, { maxTicks: 14000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat("I · Governor's mansion — drug the meat with the petal, give it to the dogs (they sleep)", () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const petal = ROOMS.forest.yellowPetal; // #689
    const meat = ROOMS.kitchen.meat; // #566
    const dogs = ROOMS.governorMansion.dogs; // #467
    expect(vm.getObjectOwner(petal)).toBe(ego);
    expect(vm.vars.readBit(ROOMS.governorMansion.dogsAsleepBit)).toBe(0);

    // DEBT — both steps commit the sentence directly (`pushSentence`) rather than
    // through the faithful click flow, because the headless testkit can't reach
    // either UI gesture: the drug is a TWO-INVENTORY combine (the second item is
    // picked from the inventory panel, which needs a real cursor hover the
    // headless harness doesn't model), and the dogs (#467) aren't hit-testable
    // headlessly for the give-target hover. The committed triples are the exact
    // `doSentence` the verb-input script would build, so the engine path under
    // test is identical — only the click-gathering is bypassed. Wire real
    // gestures here once the testkit models inventory-slot / object hover.

    // Drug the meat: "Use the yellow petal with the meat". The meat's verb-7
    // (partner #689) sets the drugged class on #566 and runs global #182, which
    // renames it "la carne condita" and consumes the petal (#689 → owner 0).
    vm.pushSentence({ verb: VERBS.use, objectA: petal, objectB: meat });
    expect(driveUntil(vm, (v) => v.getObjectOwner(petal) === 0, { maxTicks: 12000 })).toBe(true);

    // Give the drugged meat to the dogs (#467): runs their verb-80 → room-local
    // #201, which feeds them, checks the drugged class, and sets bit#15 (asleep),
    // renaming them "i cani piranha che dormono". "Give" (not "Use") is the verb
    // that reaches the feed branch — its proximity gate is the one the getDist
    // box-clamp fix unblocked, so the ego can reach the dogs across the locked
    // sleep-gate boxes. The meat ends consumed (owner → the room, 15).
    vm.pushSentence({ verb: VERBS.give, objectA: meat, objectB: dogs });
    expect(
      driveUntil(vm, (v) => v.vars.readBit(ROOMS.governorMansion.dogsAsleepBit) === 1, { maxTicks: 40000 }),
    ).toBe(true);
    expect(vm.getObjectOwner(meat)).not.toBe(ego);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat("I · Governor's mansion — slip inside and trip the booby-trap gauntlet for the joke loot", () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const mansion = ROOMS.governorMansion;
    const inside = ROOMS.governorInterior;

    // Dogs down: the gate door (#465) now opens — the dog-feed #201 lifted the
    // pen-box lock and set the door's class. Open it, then walk through →
    // `loadRoomWithEgo room=53` lands ego at the interior door (#633).
    use(vm, VERBS.open, mansion.door);
    walkTo(vm, mansion.door);
    expect(driveToRoom(vm, inside.id, { maxTicks: 14000 })).toBe(true);
    expect(waitPlayable(vm)).toBe(true);

    // The idol sits behind a booby-trap gauntlet. The right-hand door (#632),
    // once opened, runs the gauntlet cutscene (local #210) on Walk-to: it arms
    // the four joke items and drops them into ego's hands, then hands control
    // back. The rat repellent (#640) is the one we'll trade Otis for the cake.
    const loot = [inside.ratRepellent, inside.styleManual, inside.waxLips, inside.stapleRemover];
    for (const item of loot) expect(vm.getObjectOwner(item)).not.toBe(ego);
    use(vm, VERBS.open, inside.rightDoor);
    walkTo(vm, inside.rightDoor);
    expect(
      driveUntil(vm, (v) => v.getObjectOwner(inside.ratRepellent) === ego, { maxTicks: 40000 }),
    ).toBe(true);
    for (const item of loot) expect(vm.getObjectOwner(item)).toBe(ego);
    expect(vm.currentRoom).toBe(inside.id);
    expect(waitPlayable(vm)).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  // ALWAYS THE LAST BEAT: snapshot the furthest clean playable state to a save so
  // the NEXT frontier's beats can be developed by fast-forwarding here
  // (restoreSave) instead of re-driving from boot — the regression net itself
  // always runs from boot. As the walkthrough grows, this beat moves to stay last,
  // so the save tracks the leading edge. Regenerated every green run, so it can't
  // drift stale.
  beat('frontier — snapshot the furthest clean state to saves/MI1-walkthrough-frontier', () => {
    writeFileSync(
      'saves/MI1-walkthrough-frontier.websave.json',
      JSON.stringify(snapshotVm(vm, { game: 'MI1', label: 'walkthrough-frontier' })),
    );
    // Furthest clean point so far: inside the Governor's mansion (room 53),
    // dogs drugged asleep behind us and the booby-trap gauntlet's four joke
    // items in hand — swordfighting + treasure trials passed, thievery trial
    // under way, next stop the prison to trade Otis the rat repellent.
    expect(vm.currentRoom).toBe(ROOMS.governorInterior.id);
    expect(vm.vars.readBit(ROOMS.governorMansion.dogsAsleepBit)).toBe(1);
    expect(vm.getObjectOwner(ROOMS.governorInterior.ratRepellent)).toBe(vm.vars.readGlobal(VAR_EGO));
  });
});
