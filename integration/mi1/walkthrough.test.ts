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
 * BEAT KINDS: every beat is either TRAVEL (🚶‍➡️) — move ego from room A to room
 * B, the whole leg in one beat however many rooms it crosses (doors, map
 * nodes, ziplines included) — or ACTION (⚙️) — what ego does inside the room
 * it traveled to. Don't mix the two; a leg that takes an action to survive
 * (the melting-mug race) is still one travel beat.
 *
 * BEAT NAMING: `<kind emoji> <Room> — <what the beat proves>`, grouped by
 * `describe` into the game's own parts (Part I = "The Three Trials"); Room is
 * where the beat acts (a travel beat's starting room). No ordinal — file
 * order *is* run order, so the sequence is positional. Stop-on-break surfaces
 * the failing beat's name, so it must say *where* (the room) and *what*
 * broke; don't cross-reference other beats by number.
 *
 * Data-gated (skipped without the game files). Run: `npm run test:integration`.
 * With BEAT_SAVES set (`npm run test:integration:save`) every green beat
 * also dumps an importable checkpoint save to saves/beats/.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it, type TestContext } from 'vitest';
import { snapshotVm } from '../../src/engine/vm/savestate';
import {
  actorPoint,
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
import { VAR_CURRENT_LIGHTS, VAR_EGO, VAR_VERB_SCRIPT } from '../../src/engine/vm/vars';
import {
  boot,
  buySeaMonkey,
  crackSafe,
  enoughForSwordMaster,
  fightSwordMaster,
  grindOneDuel,
  hasGame,
  mugDying,
  mugHasGrog,
  mugUsable,
  ROOMS,
  townToMap,
  VARS,
  VERBS,
} from './game';

// One VM for the whole walkthrough, driven forward across beats.
const vm = boot();

// Stop-on-break: the FIRST failing beat goes red (that's the regression);
// every later beat is skipped, not cascaded into noise or — worse — falsely
// passed. So a red+skipped tail localizes exactly where the game broke.
let broken = false;

// The grog carrier in play, shared by the run-to-the-jail and lock-melt
// beats (which mug is live depends on how many pours the run needed).
let activeMug = 0;
let remainingMugs: number[] = [];

// Per-beat checkpoints, opt-in via BEAT_SAVES (`npm run
// test:integration:save`): every green beat also snapshots the VM to
// saves/beats/<run-order>-<slug>.websave.json — an in-browser import target
// at each point of the run, for visual spot-checks (the net itself renders no
// pixels) and for bisecting where a rendering regression starts. The
// directory is wiped up front so checkpoints from an older engine can't pass
// as fresh; a beat that ends before full settle (e.g. the troll-bridge
// crossing) restores exactly there, mid-choreography rather than at idle.
const beatSavesDir = process.env.BEAT_SAVES ? 'saves/beats' : undefined;
if (beatSavesDir) {
  rmSync(beatSavesDir, { recursive: true, force: true });
  mkdirSync(beatSavesDir, { recursive: true });
}
let beatOrdinal = 0;
const slugify = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const beat = (name: string, fn: (ctx: TestContext) => void | Promise<void>): void => {
  const ordinal = ++beatOrdinal;
  it(name, async (ctx) => {
    if (broken) return ctx.skip();
    try {
      await fn(ctx);
    } catch (e) {
      broken = true;
      throw e;
    }
    if (beatSavesDir) {
      writeFileSync(
        `${beatSavesDir}/${String(ordinal).padStart(3, '0')}-${slugify(name)}.websave.json`,
        JSON.stringify(snapshotVm(vm, { game: 'MI1', label: name })),
      );
    }
  });
};

describe.skipIf(!hasGame())('MI1 — full walkthrough', () => {
  describe('Part I — The Three Trials', () => {
    beat('🚶‍➡️ Mêlée Lookout — intro boots through to the lookout (33), lit, control returned', () => {
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

    beat('⚙️ Mêlée Lookout — a floor click walks ego across the lookout', () => {
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

    beat('⚙️ Mêlée Lookout — "Look at" the election poster yields a description', () => {
      use(vm, VERBS.look, ROOMS.meleeLookout.poster);
      driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 3600 });
      expect((vm.activeDialog?.text ?? '').length).toBeGreaterThan(0);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Mêlée Lookout — open the bar door, walk through into the SCUMM Bar (28)', () => {
      use(vm, VERBS.open, ROOMS.meleeLookout.barDoor);
      walkTo(vm, ROOMS.meleeLookout.barDoor);
      expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 1200 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ SCUMM Bar — talk to the LOOM-ad pirate → close-up (82), pick an answer, ego speaks it', () => {
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

    beat('⚙️ SCUMM Bar — talk to the 3 pirates; the trials flag (g197) flips', () => {
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

    beat('🚶‍➡️ SCUMM Bar — wait out the cook, sneak into the kitchen (41)', () => {
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

    beat('⚙️ Kitchen — take the meat and the pot', () => {
      for (const obj of [ROOMS.kitchen.meat, ROOMS.kitchen.pot]) {
        use(vm, VERBS.pickUp, obj);
        expect(waitPickedUp(vm, obj)).toBe(true);
      }
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Kitchen — stomp the board 3× to scare the gull, grab the fish', () => {
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

    beat('🚶‍➡️ Kitchen — back out through the SCUMM Bar to the Mêlée Lookout (33)', () => {
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

    beat('🚶‍➡️ Mêlée Lookout — off the cliff, up the path, across the map to the clearing (52)', () => {
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

    beat('🚶‍➡️ Clearing — enter the circus tent (51); the brothers start arguing', () => {
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

    beat('⚙️ Circus — break in (ahem) and negotiate the cannonball job', () => {
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

    beat('⚙️ Circus — give the pot as a helmet; the cannon gag pays 478 pieces of eight', () => {
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

    beat('🚶‍➡️ Circus — back to the map and on to the Mêlée town street (35)', () => {
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

    beat('⚙️ Mêlée town — buy the treasure map off the citizen (the cousin-Dominique line)', () => {
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

    beat('⚙️ Voodoo Lady — duck in (29), pocket the chicken, and back out to the street', () => {
      use(vm, VERBS.open, ROOMS.meleeStreet.voodooDoor);
      walkTo(vm, ROOMS.meleeStreet.voodooDoor);
      expect(driveToRoom(vm, ROOMS.voodooShop.id, { maxTicks: 8000 })).toBe(true);

      use(vm, VERBS.pickUp, ROOMS.voodooShop.chicken);
      expect(waitPickedUp(vm, ROOMS.voodooShop.chicken)).toBe(true);

      // The shop's entrance choreography (local #200, gated on arriving from
      // the street — g101, the exit hook's record) closes the door behind you,
      // so leaving is open-then-walk again.
      use(vm, VERBS.open, ROOMS.voodooShop.door);
      expect(driveUntil(vm, (v) => v.objectStates.get(ROOMS.voodooShop.door) === 1, { maxTicks: 8000 })).toBe(true);
      walkTo(vm, ROOMS.voodooShop.door);
      expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 8000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Mêlée town — through the arch and into the general store (30)', () => {
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

    beat('⚙️ General store — grab the sword & shovel, ring for the shopkeeper, pay up', () => {
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

    beat('🚶‍➡️ General store — step back out to the street (34)', () => {
      use(vm, VERBS.open, ROOMS.store.door);
      walkTo(vm, ROOMS.store.door);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 8000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ General store — back across the island to the forest fork (218)', () => {
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

    beat('🚶‍➡️ Forest — thread the maze (back/left/right…) out to the dig clearing (64)', () => {
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

    beat('⚙️ Forest dig — Use the shovel on the X; the cutscene unearths the T-shirt', () => {
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

    beat('🚶‍➡️ Forest dig — back up the path to the map, into the maze at the crossroads (218)', () => {
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

    beat('🚶‍➡️ Forest — thread the back-route out to the sword-master fork (209)', () => {
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

    beat('⚙️ Forest — push the signpost (the trunk drops as a bridge), cross to the Sword Master (61)', () => {
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

    beat('🚶‍➡️ Sword Master — back to the map and on to the troll bridge (57)', () => {
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

    beat('⚙️ Troll bridge — give the troll the red herring; cross back to the map', () => {
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

    beat('🚶‍➡️ Mêlée map — travel on to the house (la casa, 43)', () => {
      // Bridge crossed, the far side of the map is reachable: the "la casa" node
      // (#916) loads the house (room 43).
      walkTo(vm, ROOMS.meleeMap.house);
      expect(driveToRoom(vm, ROOMS.house.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ House — knock and take Captain Smirk's basic swordfighting lesson (60 → 43)", () => {
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

    beat('🚶‍➡️ House — back out the lower path to the Mêlée map (85)', () => {
      // The house's lower path (#592) is a bare-click exit back to the map.
      walkTo(vm, ROOMS.house.pathToMap);
      expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Mêlée map — take up a west-of-fork spot to draw pirates out', () => {
      // Pirates spawn at random map spots and walk toward random nodes; a duel
      // fires when one closes on ego. The east/house edge stays cold for tens of
      // thousands of ticks, but the west-of-fork side has the traffic (confirmed
      // in scratch/stumble.ts). Park here; the grind beat below does the wandering.
      walkTo(vm, ROOMS.pirateDuel.westSpots[0]!);
      expect(vm.currentRoom).toBe(ROOMS.meleeMap.id);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Mêlée map — grind pirate duels lose-to-learn until ready for the Sword Master', () => {
      // ONE beat for the whole grind (per-duel beats were too noisy). Each
      // `grindOneDuel` plays one provoked duel to completion lose-to-learn: a duel
      // is full-mode (g285=3) and the turn flips on who won the last exchange, so
      // throwing a known insult and letting the pirate counter it both teaches that
      // comeback (#82) AND flips us to defense, where the pirate insults us and we
      // learn a new insult (#83). (Winning every exchange — the old picker — stays
      // on attack and learns almost nothing.) We loop until `enoughForSwordMaster`:
      // the comebacks Carla's seeded duel needs PLUS the gate g282>3. The seed is
      // fixed so this is deterministic — ~42 duels every run. The exact count (and
      // which comebacks the pirate pool teaches late or never) shifts whenever an
      // engine change moves tick dynamics — the audio timing seam, the
      // line-following walker, and its scale throttle all did — because the
      // ambient RNG stream advances differently; when that happens, re-derive
      // SWORD_MASTER_NEEDED (game.ts) from the grind's learning order. CAP is
      // only a runaway-loop backstop (a broken gate fails the assertion below
      // instead of hanging), set comfortably above the real count — not the
      // exact count — so a benign RNG nudge still passes.
      const CAP = 60;
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

    beat('🚶‍➡️ Mêlée map — travel to the Sword Master’s clearing (61)', () => {
      // The map node #918 walks ego over and `loadRoomWithEgo room=61`.
      walkTo(vm, ROOMS.meleeMap.swordMaster);
      expect(driveToRoom(vm, ROOMS.swordMaster.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Sword Master — win the insult duel; the swordfighting trial is passed', () => {
      // Talk to Carla → sit out the intro → her duel runs in room 44 (g285=2, she
      // insults 16..33). `fightSwordMaster` defends with scroll-to-want (the comeback
      // menu pages 6 at a time) and wins. Beating her sets bit#20 — trial complete.
      expect(vm.vars.readBit(ROOMS.swordMaster.foughtBit)).toBe(0);
      expect(fightSwordMaster(vm)).toBe(true);
      expect(vm.vars.readBit(ROOMS.swordMaster.foughtBit)).toBe(1);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Sword Master — back to the map and into the forest at the crossroads (218)', () => {
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

    beat('⚙️ Forest — one back step to the yellow-flower screen (215), pick the petal', () => {
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

    beat("🚶‍➡️ Forest — out of the maze and across the island to the Governor's mansion (36)", () => {
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

    beat("⚙️ Governor's mansion — drug the meat with the petal, give it to the dogs (they sleep)", () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const petal = ROOMS.forest.yellowPetal; // #689
      const meat = ROOMS.kitchen.meat; // #566
      const dogs = ROOMS.governorMansion.dogs; // #467
      expect(vm.getObjectOwner(petal)).toBe(ego);
      expect(vm.vars.readBit(ROOMS.governorMansion.dogsAsleepBit)).toBe(0);

      // Drug the meat: "Use the yellow petal with the meat" — a TWO-INVENTORY
      // combine: both clicks land on inventory slots, and the second slot click
      // itself commits the sentence. The meat's verb-7 (partner #689) sets the
      // drugged class on #566 and runs global #182, which renames it "la carne
      // condita" and consumes the petal (#689 → owner 0).
      useWith(vm, VERBS.use, petal, meat);
      expect(driveUntil(vm, (v) => v.getObjectOwner(petal) === 0, { maxTicks: 12000 })).toBe(true);

      // Give the drugged meat to the dogs (#467): runs their verb-80 → room-local
      // #201, which feeds them, checks the drugged class, and sets bit#15 (asleep),
      // renaming them "i cani piranha che dormono". The dogs are a scene OBJECT
      // (class 5, a legitimate give target for the hover poller), so the gesture
      // is Give + the meat's slot + a scene click on them. "Give" (not "Use") is
      // the verb that reaches the feed branch — its proximity gate is the one the
      // getDist box-clamp fix unblocked, so the ego can reach the dogs across the
      // locked sleep-gate boxes. The meat ends consumed (owner → the room, 15).
      useWith(vm, VERBS.give, meat, dogs);
      expect(
        driveUntil(vm, (v) => v.vars.readBit(ROOMS.governorMansion.dogsAsleepBit) === 1, { maxTicks: 40000 }),
      ).toBe(true);
      expect(vm.getObjectOwner(meat)).not.toBe(ego);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Governor's mansion — slip inside and trip the booby-trap gauntlet for the joke loot", () => {
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

    beat('⚙️ Mêlée jail — speak with Otis; he wants a breath mint (arms the store mint line)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const inside = ROOMS.governorInterior;
      const jail = ROOMS.prison;

      // The idol needs a file, baked into Otis's cake. Out of the mansion to the
      // jail: interior door #633 → gate (36); the gate path #466 → store street
      // (34); the prison entrance #434 → the jail (31).
      walkTo(vm, inside.entryDoor);
      expect(driveToRoom(vm, ROOMS.governorMansion.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.governorMansion.path);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.storeStreet.prison);
      expect(driveToRoom(vm, jail.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Otis is locked in the far-left cell. Walk to his bars and Talk: his
      // monologue (a victim of society; can't keep his breath fresh in here) runs
      // and hands control straight back — no menu. It sets bit#420, the gate that
      // unlocks the breath-mint line in the shopkeeper's tree.
      expect(vm.vars.readBit(jail.talkedBit)).toBe(0);
      const otis = vm.actors.get(jail.prisonerActor);
      walkTo(vm, { x: otis.x + 30, y: otis.y });
      waitIdle(vm);
      use(vm, VERBS.talk, jail.prisoner);
      expect(driveUntil(vm, (v) => v.vars.readBit(jail.talkedBit) === 1, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ General store — buy the breath mint Otis asked for', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const jail = ROOMS.prison;
      const store = ROOMS.store;

      // Out of the jail (#400) → store street (34), in through the store door.
      walkTo(vm, jail.entrance);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      use(vm, VERBS.open, ROOMS.storeStreet.storeDoor);
      walkTo(vm, ROOMS.storeStreet.storeDoor);
      expect(driveToRoom(vm, store.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Ring for the shopkeeper, talk to him, pick the mint line — armed only
      // because Otis has been spoken to (bit#420). It costs 1 piece of eight; the
      // mint (#395) lands in inventory. Then leave the chat (look-around) the same
      // way the sword/shovel buy does, and step back out to the street.
      const startMoney = vm.vars.readGlobal(VARS.money);
      expect(vm.getObjectOwner(store.mint)).not.toBe(ego);
      use(vm, VERBS.push, store.bell);
      use(vm, VERBS.talk, store.shopkeeper);
      pickDialogAnswer(vm, store.buyAnswers.breathMint);
      expect(driveUntil(vm, (v) => v.getObjectOwner(store.mint) === ego, { maxTicks: 8000 })).toBe(true);
      expect(waitGlobal(vm, VARS.money, startMoney - 1)).toBe(true);
      pickDialogAnswer(vm, store.buyAnswers.lookAround);
      expect(waitPlayable(vm)).toBe(true);

      use(vm, VERBS.open, store.door);
      walkTo(vm, store.door);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Mêlée jail — bribe Otis (mint + repellent) for the cake; open it for the file', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const jail = ROOMS.prison;
      const inside = ROOMS.governorInterior;

      // Back to the jail, mint in hand.
      walkTo(vm, ROOMS.storeStreet.prison);
      expect(driveToRoom(vm, jail.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      const otis = vm.actors.get(jail.prisonerActor);
      const approach = () => {
        walkTo(vm, { x: otis.x + 30, y: otis.y });
        waitIdle(vm);
      };
      // Otis's receive-handler is verb-80 on the OBJECT #405 (→ room-local
      // #203), not on actor 4 — so the gesture targets the prisoner OBJECT:
      // Give + the item's slot + a scene click on #405 (class 5, so the hover
      // poller routes it into object B over the overlaid actor). That's
      // `useWith` with the Give verb, unlike the troll/brother gives, whose
      // recipients really are actors (`give()` drives those).
      //
      // Mint first — settles Otis's death-breath so he'll deal; then the rat
      // repellent — he trades Aunt Tillie's carrot cake (#420 → ego).
      expect(vm.getObjectOwner(jail.cake)).not.toBe(ego);
      approach();
      // Otis defaults to class 6 (death-breath); his "Mentina al grog!" reaction
      // CLEARS class 6 — and the repellent trade below only accepts once his breath
      // is settled (class 6 clear). Wait for the reaction to actually START (the
      // committed sentence isn't picked up the same tick, so waitPlayable alone can
      // return before the cutscene begins) and then for it to end.
      useWith(vm, VERBS.give, ROOMS.store.mint, jail.prisoner);
      expect(driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm, 40000)).toBe(true);
      approach();
      // The repellent trade is a long hand-over cutscene (Otis eats, thanks you,
      // produces the cake) — the cake transfers only at its tail, so wait it out.
      useWith(vm, VERBS.give, inside.ratRepellent, jail.prisoner);
      expect(driveUntil(vm, (v) => v.getObjectOwner(jail.cake) === ego, { maxTicks: 40000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Open the cake — "Apri" + its inventory slot (a one-object sentence the
      // slot click commits) → it renames to "la lima" and the verb-2
      // `actorSetClass` sets class 3 (and clears class 6): that class flip is
      // the file marker. Assert the class, not the localized name.
      const isFile = (v: typeof vm) =>
        ((v.objectClasses.get(jail.cake) ?? 0) & (1 << jail.cakeIsFileClassBit)) !== 0;
      expect(isFile(vm)).toBe(false);
      use(vm, VERBS.open, jail.cake);
      expect(driveUntil(vm, isFile, { maxTicks: 6000 })).toBe(true);
      expect(vm.getObjectOwner(jail.cake)).toBe(ego);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Governor's mansion — through the hole with the file: grab the idol", () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const jail = ROOMS.prison;
      const inside = ROOMS.governorInterior;

      // Back to the mansion, file in hand: jail exit #400 → store street; the
      // mansion node #431 → the gate (36); the dogs are still asleep, so open the
      // gate door and walk into the interior (53).
      walkTo(vm, jail.entrance);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.storeStreet.mansion);
      expect(driveToRoom(vm, ROOMS.governorMansion.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      use(vm, VERBS.open, ROOMS.governorMansion.door);
      walkTo(vm, ROOMS.governorMansion.door);
      expect(driveToRoom(vm, inside.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // With the file (the opened cake) in hand, Walk to the spioncino (#637, the
      // hole in the wall — a bare click runs its only verb, 11): it checks ego
      // holds the file then fires the grab cutscene (#211), which reaches through
      // the booby-trap gauntlet and `pickupObject`s the idol (#635) into inventory.
      expect(vm.getObjectOwner(jail.cake)).toBe(ego); // the file
      expect(vm.getObjectOwner(inside.idol)).not.toBe(ego);
      walkTo(vm, inside.hole);
      expect(
        driveUntil(vm, (v) => v.getObjectOwner(inside.idol) === ego, { maxTicks: 40000 }),
      ).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Governor\'s mansion → the sea — caught with the idol, dumped overboard, recover it', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const inside = ROOMS.governorInterior;
      const sea = ROOMS.seaBottom;

      // The grab runs straight into the Sheriff/Governor catch (#212): an excuse
      // menu, then the smitten-stammer cascade in the Governor's close-up (room
      // 23) — all don't-care comedy options. Pick the first armed answer each time
      // until control returns in the mansion.
      const answers = () =>
        [...vm.verbs.entries()].filter(([k, v]) => k >= 120 && k <= 129 && v.state === 'on');
      for (let step = 0; step < 14; step++) {
        if (!driveUntil(vm, () => answers().length > 0, { maxTicks: 8000 })) break;
        const k = answers()[0]![0];
        pickAnswer(vm, k);
        driveUntil(vm, () => !answers().some(([j]) => j === k), { maxTicks: 6000 });
      }
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.currentRoom).toBe(inside.id);

      // Walk out with the idol: opening the gate door (#633) while holding it runs
      // the Sheriff block (#217) — Fester won't budge. Telling him he's blocking
      // the exit (#122) provokes him to hurl ego (and the idol) into the harbor.
      use(vm, VERBS.open, inside.entryDoor);
      expect(
        driveUntil(vm, (v) => v.verbs.get(inside.festerBlockingExit)?.state === 'on', { maxTicks: 14000 }),
      ).toBe(true);
      pickAnswer(vm, inside.festerBlockingExit);

      // Splash — the sea bottom (room 42), tied to the idol. Pick it up: the
      // stolen idol recovered, the thievery trial's prize in hand.
      expect(driveToRoom(vm, sea.id, { maxTicks: 20000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.getObjectOwner(sea.idol)).not.toBe(ego);
      use(vm, VERBS.pickUp, sea.idol);
      expect(waitPickedUp(vm, sea.idol)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Sea → Mêlée docks — surface with the idol; vow to get a crew and a ship', () => {
      const docks = ROOMS.docks;

      // Grabbing the idol auto-climbs the ladder: the escape script surfaces ego
      // on the Mêlée docks (room 83), where the kidnapping conversation runs.
      expect(driveToRoom(vm, docks.id, { maxTicks: 20000 })).toBe(true);

      // Declare the rescue — "Andrò a procurarmi un equipaggio ed una nave…" (#123)
      // ends the conversation and sets the quest flag (bit#304), Part I's setup
      // done and the hunt for a ship begun.
      expect(vm.vars.readBit(docks.questDeclaredBit)).toBe(0);
      expect(
        driveUntil(vm, (v) => v.verbs.get(docks.getCrewAndShip)?.state === 'on', { maxTicks: 14000 }),
      ).toBe(true);
      pickAnswer(vm, docks.getCrewAndShip);
      expect(
        driveUntil(vm, (v) => v.vars.readBit(docks.questDeclaredBit) === 1, { maxTicks: 8000 }),
      ).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Mêlée docks — back ashore: up the molo and into the SCUMM Bar (28)', () => {
      // Post-vow the molo (#905) carries ego straight up to the lookout (33,
      // bit#453 reroute); the bar door is right there.
      walkTo(vm, 905);
      expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      use(vm, VERBS.open, ROOMS.meleeLookout.barDoor);
      walkTo(vm, ROOMS.meleeLookout.barDoor);
      expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ SCUMM Bar — pocket all five pewter mugs', () => {
      // The bar has emptied out — the cook just stands idle — and the five
      // mugs (#362–366) are free to take, the grog carriers for Otis's lock.
      const ego = vm.vars.readGlobal(VAR_EGO);
      for (const mug of ROOMS.scummBar.mugs) {
        use(vm, VERBS.pickUp, mug);
        expect(waitPickedUp(vm, mug)).toBe(true);
        expect(mugUsable(vm, mug)).toBe(true); // class 12: the barrel will fill it
      }
      expect(vm.getObjectOwner(ROOMS.scummBar.mugs[0]!)).toBe(ego);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ SCUMM Bar — into the kitchen (41)', () => {
      // The kitchen door is shut post-vow (no cook gate anymore): Open it,
      // walk through.
      use(vm, VERBS.open, ROOMS.scummBar.kitchenDoor);
      walkTo(vm, ROOMS.scummBar.kitchenDoor);
      expect(driveToRoom(vm, ROOMS.kitchen.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ SCUMM Bar kitchen — fill a mug at the grog barrel (the melt timer starts)', () => {
      // With a dozen-plus items carried the mug's slot sits past the panel's
      // visible window, so the gesture scrolls the panel first — the testkit's
      // slot click models the arrows.
      const [mug] = ROOMS.scummBar.mugs;
      expect(mugHasGrog(vm, mug!)).toBe(false);
      useWith(vm, VERBS.use, mug!, ROOMS.kitchen.barrel);
      expect(driveUntil(vm, (v) => mugHasGrog(v as typeof vm, mug!), { maxTicks: 8000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ SCUMM Bar kitchen — race the melting mug across town to the jail (31), pouring as it dies', () => {
      // The melt ladder drains fastest in the transit rooms (35: −3/tick,
      // 34: −5), so the run is: kitchen door → bar → lookout → town street →
      // store street → jail, decanting into a fresh mug (global #69) whenever
      // the active one hits its dying stage (class 6). Four spares is plenty.
      const mugs = [...ROOMS.scummBar.mugs];
      let active = mugs.shift()!;
      const pourIfDying = (): void => {
        if (!mugDying(vm, active)) return;
        const next = mugs.shift()!;
        useWith(vm, VERBS.use, active, next); // a two-inventory combine
        expect(driveUntil(vm, (v) => mugHasGrog(v as typeof vm, next), { maxTicks: 6000 })).toBe(true);
        active = next;
      };
      const hop = (target: number, room: number): void => {
        walkTo(vm, target);
        expect(driveToRoom(vm, room, { maxTicks: 14000 })).toBe(true);
        expect(waitPlayable(vm)).toBe(true);
        pourIfDying();
      };
      hop(ROOMS.kitchen.barDoor, ROOMS.scummBar.id);
      hop(ROOMS.scummBar.exitDoor, ROOMS.meleeLookout.id);
      hop(ROOMS.meleeLookout.townArch, ROOMS.meleeStreet.id);
      hop(ROOMS.meleeStreet.storeArch, ROOMS.storeStreet.id);
      hop(ROOMS.storeStreet.prison, ROOMS.prison.id);
      // Arrived with live grog: still a mug (class 12) and still full (class 18).
      expect(mugUsable(vm, active)).toBe(true);
      expect(mugHasGrog(vm, active)).toBe(true);
      activeMug = active;
      remainingMugs = mugs;
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Mêlée jail — Otis agrees to join, then the grog melts his lock', () => {
      const jail = ROOMS.prison;
      // Post-vow his conversation arms the recruit pair: #123 is the news
      // ("Hanno rapito il Governatore!"), then #123 again is the ask ("Se ti
      // faccio uscire, ti unirai al mio equipaggio?") — the second sets
      // bit#477, REQUIRED before the melt or #70 takes the mocking branch.
      expect(vm.vars.readBit(jail.otisAgreedBit)).toBe(0);
      const otis = vm.actors.get(jail.prisonerActor);
      walkTo(vm, { x: otis.x + 30, y: otis.y });
      waitIdle(vm);
      use(vm, VERBS.talk, jail.prisoner);
      expect(pickDialogAnswer(vm, jail.recruitAnswer, { armTicks: 16000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, jail.recruitAnswer, { armTicks: 16000 }).length).toBeGreaterThan(0);
      expect(
        driveUntil(vm, (v) => v.vars.readBit(jail.otisAgreedBit) === 1, { maxTicks: 8000 }),
      ).toBe(true);
      // Step out of the conversation (the remaining options are small talk; the
      // goodbye is the last armed slot each menu).
      for (let step = 0; step < 4; step++) {
        const open = [...vm.verbs.entries()].filter(([k, s]) => k >= 120 && k <= 129 && s.state === 'on');
        if (open.length === 0) break;
        pickAnswer(vm, open[open.length - 1]![0]);
        driveUntil(vm, () => ![...vm.verbs.entries()].some(([k, s]) => k >= 120 && k <= 129 && s.state === 'on'), { maxTicks: 10000 });
      }
      expect(waitPlayable(vm, 14000)).toBe(true);

      // Pour onto the lock (#403 → #69 → #70): the rescue cutscene melts it,
      // frees Otis (bit#76 — his crew flag) and, with bit#477 set, plays the
      // friendly join before he heads off "to get his things".
      if (mugDying(vm, activeMug)) {
        const next = remainingMugs.shift()!;
        useWith(vm, VERBS.use, activeMug, next); // a two-inventory combine
        expect(driveUntil(vm, (v) => mugHasGrog(v as typeof vm, next), { maxTicks: 6000 })).toBe(true);
        activeMug = next;
      }
      expect(vm.vars.readBit(jail.otisFreedBit)).toBe(0);
      useWith(vm, VERBS.use, activeMug, jail.lock);
      expect(
        driveUntil(vm, (v) => v.vars.readBit(jail.otisFreedBit) === 1, { maxTicks: 20000 }),
      ).toBe(true);
      expect(
        driveUntil(vm, (v) => v.actors.get(jail.prisonerActor).room !== jail.id, { maxTicks: 60000 }),
      ).toBe(true);
      expect(waitPlayable(vm, 20000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ Mêlée jail — back across town and up to the Sword Master's clearing (61)", () => {
      // Jail → store street → town street, west arch (the post-vow reroute can
      // land either at the lookout or back on the docks — both reach the cliff
      // path), up to the map, and out to her clearing.
      walkTo(vm, ROOMS.prison.entrance);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.storeStreet.townArch);
      expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      townToMap(vm);
      expect(vm.currentRoom).toBe(ROOMS.meleeMap.id);
      walkTo(vm, ROOMS.meleeMap.swordMaster);
      expect(driveToRoom(vm, ROOMS.swordMaster.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Sword Master's clearing — Carla joins on hearing the news (bit#89)", () => {
      expect(vm.vars.readBit(ROOMS.swordMaster.recruitedBit)).toBe(0);
      use(vm, VERBS.talk, ROOMS.swordMaster.master);
      expect(
        pickDialogAnswer(vm, ROOMS.swordMaster.recruitAnswer, { armTicks: 16000 }).length,
      ).toBeGreaterThan(0);
      // Her reaction plays through the close-up (44) and back; the flag is the
      // mechanic, the room the proof control returned.
      expect(
        driveUntil(vm, (v) => v.vars.readBit(ROOMS.swordMaster.recruitedBit) === 1, { maxTicks: 30000 }),
      ).toBe(true);
      expect(driveUntil(vm, (v) => v.currentRoom === ROOMS.swordMaster.id, { maxTicks: 30000 })).toBe(true);
      expect(waitPlayable(vm, 20000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ Sword Master's clearing — to Hook Isle; zipline across on the rubber chicken into Meathook's house", () => {
      const isle = ROOMS.hookIsle;
      const ego = () => vm.actors.get(vm.vars.readGlobal(VAR_EGO));
      walkTo(vm, ROOMS.swordMaster.path);
      expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.meleeMap.beach);
      expect(driveToRoom(vm, isle.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Climb the ladder tower to its platform (box 7), hook the chicken over
      // the cable (#203 glides ego across to the house pole top, box 10), then
      // the front door — touchable only on this side — into the house.
      walkTo(vm, isle.tower);
      expect(driveUntil(vm, () => ego().walkBox === isle.towerTopBox, { maxTicks: 8000 })).toBe(true);
      useWith(vm, VERBS.use, ROOMS.voodooShop.chicken, isle.cableFromTower);
      expect(driveUntil(vm, () => ego().walkBox === isle.houseTopBox, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 10000)).toBe(true);
      // The chicken survives the trip (it's a pulley, not a fare).
      expect(vm.getObjectOwner(ROOMS.voodooShop.chicken)).toBe(vm.vars.readGlobal(VAR_EGO));
      use(vm, VERBS.open, isle.door);
      expect(driveUntil(vm, (v) => v.objectStates.get(isle.door) === 1, { maxTicks: 8000 })).toBe(true);
      walkTo(vm, isle.door);
      expect(driveToRoom(vm, ROOMS.meathookHouse.id, { maxTicks: 8000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Meathook's house — the news, the dare, the beast: Meathook joins (bit#88)", () => {
      const house = ROOMS.meathookHouse;
      // Walking in fires his accost by itself. The news (120), then the crew
      // idea (122) → he questions our bravery and the dare tour (#201) walks us
      // through the trophy doors to the little door.
      expect(pickDialogAnswer(vm, house.answers.kidnapped, { armTicks: 20000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, house.answers.crewIdea, { armTicks: 20000 }).length).toBeGreaterThan(0);
      const tourRunning = (v: typeof vm) =>
        v.slots.some((s) => s.status !== 'dead' && s.scriptId === house.tourScript);
      expect(driveUntil(vm, tourRunning, { maxTicks: 30000 })).toBe(true);
      const doorTouchable = (v: typeof vm) =>
        (((v.objectClasses.get(house.littleDoor) ?? 0) >>> 31) & 1) === 0;
      expect(
        driveUntil(vm, (v) => v.cutsceneStack.length === 0 && doorTouchable(v), { maxTicks: 120000 }),
      ).toBe(true);

      // Open the little door → the beast bursts out shrieking (#49 sets
      // bit#323, clears the door's class 6 and renames it the winged devil)…
      expect(vm.vars.readBit(house.beastOutBit)).toBe(0);
      use(vm, VERBS.open, house.littleDoor);
      expect(driveUntil(vm, (v) => v.vars.readBit(house.beastOutBit) === 1, { maxTicks: 30000 })).toBe(true);
      const class6 = (v: typeof vm) => (((v.objectClasses.get(house.littleDoor) ?? 0) >> 5) & 1) === 1;
      expect(driveUntil(vm, (v) => !class6(v), { maxTicks: 60000 })).toBe(true);
      expect(waitPlayable(vm, 30000)).toBe(true);

      // …then touch it: "Usa" has no entry on #478, so the engine falls back to
      // its 255 default — the payoff cutscene (#205). Meathook signs on
      // (bit#88) and the scene walks ego back outside.
      use(vm, VERBS.use, house.littleDoor);
      expect(driveUntil(vm, (v) => v.vars.readBit(house.recruitedBit) === 1, { maxTicks: 120000 })).toBe(true);
      expect(driveToRoom(vm, ROOMS.hookIsle.id, { maxTicks: 30000 })).toBe(true);
      expect(waitPlayable(vm, 20000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Hook Isle — zipline back and return to the Mêlée map', () => {
      const isle = ROOMS.hookIsle;
      const ego = () => vm.actors.get(vm.vars.readGlobal(VAR_EGO));
      // The mirror trip: house pole up (box 10), chicken on the cable back to
      // the tower (box 7), climb down, and the path — touchable again on this
      // side — up to the map.
      walkTo(vm, isle.housePole);
      expect(driveUntil(vm, () => ego().walkBox === isle.houseTopBox, { maxTicks: 8000 })).toBe(true);
      useWith(vm, VERBS.use, ROOMS.voodooShop.chicken, isle.cableFromHouse);
      expect(driveUntil(vm, () => ego().walkBox === isle.towerTopBox, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 10000)).toBe(true);
      walkTo(vm, isle.tower);
      driveUntil(vm, () => ego().walkBox !== isle.towerTopBox, { maxTicks: 8000 });
      expect(waitPlayable(vm, 10000)).toBe(true);
      walkTo(vm, isle.path);
      expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ Mêlée map — the harbor-lights node down to Stan's lot (59)", () => {
      walkTo(vm, ROOMS.meleeMap.lights);
      expect(driveToRoom(vm, ROOMS.stan.id, { maxTicks: 14000 })).toBe(true);
      // No settle: Stan accosts on arrival — the next beat picks up his menu.
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Stan's — the cheapest ship, the credit question, and the famous exit", () => {
      const stan = ROOMS.stan;
      const ego = vm.vars.readGlobal(VAR_EGO);
      // Ask for the cheap one (the Sea Monkey pitch), try credit — he points
      // at the storekeeper in town — then back out and leave. His farewell
      // hands over the business card + compass and walks ego off the lot
      // itself (loadRoomWithEgo → the map).
      expect(pickDialogAnswer(vm, stan.answers.cheapest, { armTicks: 30000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, stan.answers.onCredit, { armTicks: 24000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, stan.answers.backOut, { armTicks: 24000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, stan.answers.thinkItOver, { armTicks: 24000 }).length).toBeGreaterThan(0);
      expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 40000 })).toBe(true);
      expect(waitPlayable(vm, 14000)).toBe(true);
      expect(vm.getObjectOwner(stan.businessCard)).toBe(ego);
      expect(vm.getObjectOwner(stan.compass)).toBe(ego);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Mêlée map — back across the island to the general store (30)', () => {
      // Map → the village node (the docks now) → lookout → the two arches →
      // the store.
      walkTo(vm, ROOMS.meleeMap.village);
      expect(
        driveUntil(
          vm,
          (v) => v.currentRoom === ROOMS.meleeLookout.id || v.currentRoom === ROOMS.docks.id,
          { maxTicks: 14000 },
        ),
      ).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      if (vm.currentRoom === ROOMS.docks.id) {
        walkTo(vm, 905); // il molo climbs to the lookout post-vow
        expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 14000 })).toBe(true);
        expect(waitPlayable(vm)).toBe(true);
      }
      walkTo(vm, ROOMS.meleeLookout.townArch);
      expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.meleeStreet.storeArch);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      use(vm, VERBS.open, ROOMS.storeStreet.storeDoor);
      walkTo(vm, ROOMS.storeStreet.storeDoor);
      expect(driveToRoom(vm, ROOMS.store.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ General store — the credit interview: watch the keeper dial the safe', () => {
      const store = ROOMS.store;
      // Ask for the note (armed only after Stan's referral), claim a job, name
      // it — he dials the safe to fetch the note while we "watch" (the
      // combination digits live in g221..g224; random per game, so the
      // cracking beat reads them from the vars).
      use(vm, VERBS.push, store.bell);
      use(vm, VERBS.talk, store.shopkeeper);
      expect(pickDialogAnswer(vm, store.creditAnswers.askNote, { armTicks: 20000 }).length).toBeGreaterThan(0);
      expect(pickDialogAnswer(vm, store.creditAnswers.haveJob, { armTicks: 20000 }).length).toBeGreaterThan(0);
      // The dial: the safe's state flips open while he checks the note.
      expect(
        driveUntil(vm, (v) => v.objectStates.get(store.safe) === 1, { maxTicks: 40000 }),
      ).toBe(true);
      expect(pickDialogAnswer(vm, store.creditAnswers.jobAtStans, { armTicks: 30000 }).length).toBeGreaterThan(0);
      // The combination exists and is in range (1..4 per digit).
      for (let i = 0; i < 4; i++) {
        const digit = vm.vars.readGlobal(store.comboVar + i);
        expect(digit).toBeGreaterThanOrEqual(1);
        expect(digit).toBeLessThanOrEqual(4);
      }
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ General store — send him after the Sword Master; crack the safe for the note', () => {
      const store = ROOMS.store;
      const ego = vm.vars.readGlobal(VAR_EGO);
      // The errand empties the store (the cracking window — he does come back).
      expect(
        pickDialogAnswer(vm, store.creditAnswers.fetchSwordMaster, { armTicks: 30000 }).length,
      ).toBeGreaterThan(0);
      expect(
        driveUntil(vm, (v) => v.actors.get(store.keeperActor).room !== store.id, { maxTicks: 40000 }),
      ).toBe(true);
      expect(waitPlayable(vm, 20000)).toBe(true);
      // The handle (#390) is a parent-gated hotspot — clickable exactly while
      // its safe (#389) sits shut, which it is again now that the keeper's gone.
      expect(vm.getObjectOwner(store.creditNote)).not.toBe(ego);
      expect(crackSafe(vm)).toBe(true);
      expect(vm.getObjectOwner(store.creditNote)).toBe(ego);
      expect(waitPlayable(vm, 20000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ General store — back across town to Stan's lot (59), note in hand", () => {
      use(vm, VERBS.open, ROOMS.store.door);
      walkTo(vm, ROOMS.store.door);
      expect(driveToRoom(vm, ROOMS.storeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, ROOMS.storeStreet.townArch);
      expect(driveToRoom(vm, ROOMS.meleeStreet.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      townToMap(vm);
      expect(vm.currentRoom).toBe(ROOMS.meleeMap.id);
      walkTo(vm, ROOMS.meleeMap.lights);
      expect(driveToRoom(vm, ROOMS.stan.id, { maxTicks: 14000 })).toBe(true);
      // No settle: Stan accosts again — the deal beat picks up his menu.
      expect(vm.haltInfo).toBeNull();
    });

    beat("⚙️ Stan's — the note closes it: walk-away ×3, ladder to 5000, the Sea Monkey is ours", () => {
      const stan = ROOMS.stan;
      // Re-open the cheap-ship pitch, then drive the deal machine: the credit
      // note opens the deal menu, three walk-away threats grind the price 8000
      // → 6400, the rising-offer ladder takes it to 4900, and the insisted 5000
      // clears it — bit#51, the Sea Monkey is ours. Control returns with ego on
      // the deck.
      expect(vm.vars.readBit(stan.shipBoughtBit)).toBe(0);
      expect(pickDialogAnswer(vm, stan.answers.cheapest, { armTicks: 30000 }).length).toBeGreaterThan(0);
      expect(buySeaMonkey(vm)).toBe(true);
      expect(vm.vars.readBit(stan.shipBoughtBit)).toBe(1);
      expect(waitPlayable(vm, 30000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ Stan's — off the lot and down to the Mêlée docks (83)", () => {
      // Ship + three crew flags set: the lot path leads back to the map, and
      // the village node lands at the docks, where the crew is waiting (ENCD →
      // the dock scene starts on arrival, so no settle here).
      walkTo(vm, ROOMS.stan.path);
      expect(driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 20000 })).toBe(true);
      expect(waitPlayable(vm, 14000)).toBe(true);
      walkTo(vm, ROOMS.meleeMap.village);
      expect(driveToRoom(vm, ROOMS.docks.id, { maxTicks: 14000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Mêlée docks — the crew boards the Sea Monkey; Part II opens aboard', () => {
      // Each crew member greets ego with a small don't-care menu; answering
      // through them rolls straight into the departure — rooms 97 → 87 → the
      // below-decks chat (19) — and control comes back in the Sea Monkey's
      // cabin (room 7). Part II.
      const answers = () =>
        [...vm.verbs.entries()].filter(([k, v]) => k >= 120 && k <= 129 && v.state === 'on');
      for (let step = 0; step < 10 && vm.currentRoom === ROOMS.docks.id; step++) {
        if (!driveUntil(vm, () => answers().length > 0 || vm.currentRoom !== ROOMS.docks.id, { maxTicks: 20000 })) break;
        if (vm.currentRoom !== ROOMS.docks.id) break;
        const k = answers()[0]![0];
        pickAnswer(vm, k);
        driveUntil(vm, () => !answers().some(([j]) => j === k) || vm.currentRoom !== ROOMS.docks.id, { maxTicks: 20000 });
      }
      expect(driveToRoom(vm, ROOMS.docks.seaMonkeyCabin, { maxTicks: 60000 })).toBe(true);
      expect(waitPlayable(vm, 30000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });
  });

  describe('Part II — The Journey', () => {
    beat('⚙️ Sea Monkey cabin — pen then ink, the drawer gives up the book, the cabinet stays locked', () => {
      const cabin = ROOMS.shipCabin;
      expect(vm.currentRoom).toBe(cabin.id);

      // The pen first: its Pick up is what clears the ink's untouchable class.
      use(vm, VERBS.pickUp, cabin.pen);
      expect(waitPickedUp(vm, cabin.pen)).toBe(true);
      use(vm, VERBS.pickUp, cabin.ink);
      expect(waitPickedUp(vm, cabin.ink)).toBe(true);

      // The drawer is open-then-look-inside: Open flips its state, the LOOK
      // runs the inside cutscene that auto-pockets the dusty book.
      use(vm, VERBS.open, cabin.drawer);
      expect(driveUntil(vm, (v) => v.objectStates.get(cabin.drawer) === 1, { maxTicks: 6000 })).toBe(true);
      use(vm, VERBS.look, cabin.drawer);
      expect(waitPickedUp(vm, cabin.book, 12000)).toBe(true);

      // The cabinet refuses a bare Open — its key is still hidden in a cereal
      // box two decks down.
      use(vm, VERBS.open, cabin.cabinet);
      waitIdle(vm);
      expect(vm.objectStates.get(cabin.cabinet)).not.toBe(1);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Sea Monkey cabin — out on deck, up the rope ladder to the crow\'s nest (17)', () => {
      walkTo(vm, ROOMS.shipCabin.door);
      expect(driveToRoom(vm, ROOMS.shipDeck.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 12000)).toBe(true);
      walkTo(vm, ROOMS.shipDeck.ropeLadder);
      expect(driveToRoom(vm, ROOMS.crowsNest.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Crow\'s nest — strike the Jolly Roger (a broth ingredient, of course)', () => {
      use(vm, VERBS.pickUp, ROOMS.crowsNest.jollyRoger);
      expect(waitPickedUp(vm, ROOMS.crowsNest.jollyRoger, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Crow\'s nest — slide down and descend the hatches to the hold (8)', () => {
      walkTo(vm, ROOMS.crowsNest.deckBelow);
      expect(driveToRoom(vm, ROOMS.shipDeck.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipDeck.hatch);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.holdHatch);
      expect(driveToRoom(vm, ROOMS.shipHold.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Sea Monkey hold — gunpowder off the kegs, the giant rope, wine out of the chest', () => {
      const hold = ROOMS.shipHold;
      // The kegs hand over the gunpowder object on Pick up.
      use(vm, VERBS.pickUp, hold.kegs);
      expect(waitPickedUp(vm, hold.gunpowder, 8000)).toBe(true);
      use(vm, VERBS.pickUp, hold.rope);
      expect(waitPickedUp(vm, hold.rope, 8000)).toBe(true);
      // The wine chest is open-then-look-inside, like the cabin drawer.
      use(vm, VERBS.open, hold.wineChest);
      expect(driveUntil(vm, (v) => v.objectStates.get(hold.wineChest) === 1, { maxTicks: 6000 })).toBe(true);
      use(vm, VERBS.look, hold.wineChest);
      expect(waitPickedUp(vm, hold.wine, 12000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Sea Monkey hold — up a deck and through to the galley (14)', () => {
      walkTo(vm, ROOMS.shipHold.ladder);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.galleyDoor);
      expect(driveToRoom(vm, ROOMS.shipGalley.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Galley — the cupboard\'s cereal box crunches down to a prize: a small key', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const galley = ROOMS.shipGalley;
      use(vm, VERBS.open, galley.cupboard);
      expect(driveUntil(vm, (v) => v.objectStates.get(galley.cupboard) === 1, { maxTicks: 6000 })).toBe(true);

      // The visible box (#168) forwards every verb to the real cereal (#164);
      // taking it stages the prize at owner 14, hidden inside the box.
      use(vm, VERBS.pickUp, galley.cerealShelf);
      expect(waitPickedUp(vm, galley.cereal, 8000)).toBe(true);

      // Open the carried box: the eat cutscene ends in "there's a surprise
      // inside" and #185 hands the prize over.
      use(vm, VERBS.open, galley.cereal);
      expect(driveUntil(vm, (v) => v.getObjectOwner(galley.smallKey) === ego, { maxTicks: 20000 })).toBe(true);
      expect(waitPlayable(vm, 12000)).toBe(true);

      // Look at the surprise — it's a small key with a monkey engraved on it.
      use(vm, VERBS.look, galley.smallKey);
      expect(driveUntil(vm, (v) => v.vars.readBit(galley.prizeRevealedBit) === 1, { maxTicks: 8000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Galley — back up top and into the captain\'s cabin (7), key in pocket', () => {
      walkTo(vm, ROOMS.shipGalley.ladder);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.ladderUp);
      expect(driveToRoom(vm, ROOMS.shipDeck.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      use(vm, VERBS.open, ROOMS.shipDeck.cabinDoor);
      walkTo(vm, ROOMS.shipDeck.cabinDoor);
      expect(driveToRoom(vm, ROOMS.shipCabin.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Sea Monkey cabin — the key opens the cabinet; drag the chest out for the recipe + cinnamon', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const cabin = ROOMS.shipCabin;

      useWith(vm, VERBS.use, ROOMS.shipGalley.smallKey, cabin.cabinet);
      expect(driveUntil(vm, (v) => v.objectStates.get(cabin.cabinet) === 1, { maxTicks: 12000 })).toBe(true);

      // The heavy chest inside is hoverable now (parent-gated on the open
      // cabinet). Picking it up runs #184: ego drags it onto the floor —
      // where it seals walkbox 11 and `createBoxMatrix` reroutes the room.
      use(vm, VERBS.pickUp, cabin.heavyChest);
      expect(driveUntil(vm, (v) => v.objectStates.get(cabin.placedChest) === 1, { maxTicks: 20000 })).toBe(true);
      expect(waitPlayable(vm, 12000)).toBe(true);

      // Open the placed chest, look inside: the reveal cutscene pockets the
      // recipe and the cinnamon and sets the recipe flag the pot gates on.
      use(vm, VERBS.open, cabin.placedChest);
      expect(driveUntil(vm, (v) => v.objectStates.get(cabin.placedChestOpen) === 1, { maxTicks: 8000 })).toBe(true);
      use(vm, VERBS.look, cabin.placedChest);
      expect(driveUntil(vm, (v) => v.getObjectOwner(cabin.recipe) === ego, { maxTicks: 20000 })).toBe(true);
      expect(driveUntil(vm, (v) => v.getObjectOwner(cabin.cinnamon) === ego, { maxTicks: 20000 })).toBe(true);
      expect(vm.vars.readBit(cabin.recipeBit)).toBe(1);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Sea Monkey cabin — around the dragged chest (the rebuilt box matrix) and down to the galley', () => {
      // This leg is the createBoxMatrix proof: the direct strip to the door
      // is sealed under the chest, so the walk must take the rebuilt detour.
      walkTo(vm, ROOMS.shipCabin.door);
      expect(driveToRoom(vm, ROOMS.shipDeck.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipDeck.hatch);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.galleyDoor);
      expect(driveToRoom(vm, ROOMS.shipGalley.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Galley — all eight ingredients into the pot; the broth sails the ship itself', () => {
      const galley = ROOMS.shipGalley;
      expect(vm.vars.readGlobal(VARS.voyageStage)).toBe(0);

      // Seven ingredients, each confirmed by its own pot bit; order is free.
      for (const [obj, bit] of galley.ingredients.slice(0, -1)) {
        useWith(vm, VERBS.use, obj, galley.bigPot);
        expect(driveUntil(vm, (v) => v.vars.readBit(bit) === 1, { maxTicks: 16000 })).toBe(true);
      }
      // The eighth fills g260 to 8 and fires the cooking cutscene (#108):
      // ego faints, "Passano giorni", and the voyage stage flips to 1.
      const [lastObj, lastBit] = galley.ingredients[galley.ingredients.length - 1]!;
      useWith(vm, VERBS.use, lastObj, galley.bigPot);
      expect(driveUntil(vm, (v) => v.vars.readBit(lastBit) === 1, { maxTicks: 16000 })).toBe(true);
      expect(waitGlobal(vm, VARS.voyageStage, 1, 60000)).toBe(true);
      expect(vm.vars.readGlobal(galley.potCountVar)).toBe(8);

      // Ego is out cold on the galley floor; the cutscene routes the next
      // click to the wake-up script (g32 → local #201), which hands back
      // control ("Mi sento malissimo").
      expect(driveUntil(vm, (v) => v.vars.readGlobal(VAR_VERB_SCRIPT) === 201, { maxTicks: 20000 })).toBe(true);
      walkTo(vm, { x: 160, y: 130 });
      expect(driveUntil(vm, (v) => v.vars.readGlobal(VAR_VERB_SCRIPT) === 4, { maxTicks: 20000 })).toBe(true);
      expect(waitPlayable(vm, 12000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Galley — pocket the small pot; the business card burns to a flaming mass', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const galley = ROOMS.shipGalley;
      use(vm, VERBS.pickUp, galley.smallPot);
      expect(waitPickedUp(vm, galley.smallPot, 8000)).toBe(true);
      // Stan's business card on the fire — consumed, the flaming mass lands
      // in inventory (the only fire that can ride to the cannon).
      useWith(vm, VERBS.use, ROOMS.stan.businessCard, galley.fire);
      expect(driveUntil(vm, (v) => v.getObjectOwner(galley.flamingMass) === ego, { maxTicks: 16000 })).toBe(true);
      expect(vm.getObjectOwner(ROOMS.stan.businessCard)).not.toBe(ego);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Galley — down for a fresh batch of gunpowder, then up on deck (19)', () => {
      // The pot returned the first batch to the room (owner 15), so the kegs
      // refill on a second visit.
      const ego = vm.vars.readGlobal(VAR_EGO);
      expect(vm.getObjectOwner(ROOMS.shipHold.gunpowder)).not.toBe(ego);
      walkTo(vm, ROOMS.shipGalley.ladder);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.holdHatch);
      expect(driveToRoom(vm, ROOMS.shipHold.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      use(vm, VERBS.pickUp, ROOMS.shipHold.kegs);
      expect(waitPickedUp(vm, ROOMS.shipHold.gunpowder, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipHold.ladder);
      expect(driveToRoom(vm, ROOMS.shipLanding.id, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm, 8000)).toBe(true);
      walkTo(vm, ROOMS.shipLanding.ladderUp);
      expect(driveToRoom(vm, ROOMS.shipDeck.id, { maxTicks: 8000 })).toBe(true);
      // First deck entry post-voyage: the ENCD tail plays the "siamo arrivati
      // a Monkey Island" look and bumps the voyage stage to 2.
      expect(waitPlayable(vm, 8000)).toBe(true);
      expect(vm.vars.readGlobal(VARS.voyageStage)).toBe(2);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Sea Monkey deck — rig the cannon (rope fuse, powder, flame) and ride the pot-helmet to Monkey Island (20)', () => {
      const deck = ROOMS.shipDeck;
      const fuseTouchable = (v: typeof vm) =>
        (((v.objectClasses.get(deck.fuse) ?? 0) >>> 31) & 1) === 0;

      // The rope ties on as the fuse (local #250)…
      useWith(vm, VERBS.use, ROOMS.shipHold.rope, deck.cannon);
      expect(driveUntil(vm, fuseTouchable, { maxTicks: 12000 })).toBe(true);
      // …the gunpowder goes down the nozzle…
      useWith(vm, VERBS.use, ROOMS.shipHold.gunpowder, deck.nozzle);
      expect(driveUntil(vm, (v) => v.vars.readBit(deck.powderLoadedBit) === 1, { maxTicks: 16000 })).toBe(true);

      // …light the fuse and WEAR THE POT — the burn-down (#251) is a short
      // window, and the small pot's one-object Use is the climb-in (#107).
      useWith(vm, VERBS.use, ROOMS.shipGalley.flamingMass, deck.fuse);
      expect(
        driveUntil(vm, (v) => v.slots.some((s) => s.status !== 'dead' && s.scriptId === deck.fuseScript), { maxTicks: 12000 }),
      ).toBe(true);
      use(vm, VERBS.use, ROOMS.shipGalley.smallPot);

      // BOOM: the launch cutscene flies ego over the water to the beach.
      expect(driveToRoom(vm, ROOMS.monkeyBeach.id, { maxTicks: 90000 })).toBe(true);
      expect(waitPlayable(vm, 30000)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });
  });

  describe('Part III — Under Monkey Island', () => {
    beat('⚙️ Monkey beach — get up off the sand, pocket a banana, read the assembly notice', () => {
      const beach = ROOMS.monkeyBeach;
      // The cannon launch dropped ego face-down on the sand with the next click
      // routed to the get-up wakeup (g32 = 201 → local #201). A bare floor click
      // stands him up and restores the normal verb script (g32 → 4).
      expect(vm.vars.readGlobal(VAR_VERB_SCRIPT)).toBe(beach.wakeupVerbScript);
      walkTo(vm, { x: 200, y: 120 });
      expect(driveUntil(vm, (v) => v.vars.readGlobal(VAR_VERB_SCRIPT) === 4, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // A banana off the beach (#265, Pick up).
      use(vm, VERBS.pickUp, beach.banana);
      expect(waitPickedUp(vm, beach.banana)).toBe(true);

      // Read the public-assembly notice by the tree (#271, Look at → local #203):
      // the LeChuck "occupazione della Testa Sacra" announcement. The text-as-data
      // proves the read ran; control then returns.
      use(vm, VERBS.look, beach.assemblyNote);
      expect(driveUntil(vm, (v) => (v.activeDialog?.text ?? '').length > 0, { maxTicks: 8000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Monkey beach — into the jungle and across the overhead map to the Fort (80)', () => {
      const map = ROOMS.monkeyMap;
      // "la giungla" (#261, Walk-to): putActorInRoom 2 + actorFollowCamera carries
      // ego onto the walkable overhead map (room 2) as a small figure.
      walkTo(vm, ROOMS.monkeyBeach.jungle);
      expect(driveToRoom(vm, map.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // The map is several walkable screens; the screen-2 top-left edge (#28)
      // crosses to the Fort screen (room 3) via global #34.
      walkTo(vm, map.toFortScreen);
      expect(driveToRoom(vm, map.fortScreen, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Walk the figure onto the fortezza marker: room-3 local #200 watches ego's
      // distance and at ≤2 runs loadRoomWithEgo room=80 — into the Fort.
      walkTo(vm, map.fortApproach);
      expect(driveToRoom(vm, ROOMS.fort.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Fort — take the rope & spyglass; open the spyglass into a lens', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const fort = ROOMS.fort;
      for (const obj of [fort.rope, fort.spyglass]) {
        use(vm, VERBS.pickUp, obj);
        expect(waitPickedUp(vm, obj)).toBe(true);
      }

      // Open (verb 2) the spyglass: its verb-2 renames it "la lente" and flips
      // the lens class bit (value 2) on — the same id #882 becomes the lens.
      // Assert the class flip, not the localized name.
      const isLens = (v: typeof vm) =>
        ((v.objectClasses.get(fort.spyglass) ?? 0) & (1 << fort.lensClassBit)) !== 0;
      expect(isLens(vm)).toBe(false);
      use(vm, VERBS.open, fort.spyglass);
      expect(driveUntil(vm, isLens, { maxTicks: 8000 })).toBe(true);
      expect(vm.getObjectOwner(fort.spyglass)).toBe(ego);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Fort — push the cannon (it spills); send Herman off, then pocket the gunpowder & cannonball', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const fort = ROOMS.fort;
      const herman = () => vm.actors.get(fort.hermanActor);
      expect(vm.getObjectOwner(fort.gunpowder)).not.toBe(ego);
      expect(vm.getObjectOwner(fort.cannonball)).not.toBe(ego);

      // Push the rusty cannon (#883 → local #200): it tips and spills the
      // gunpowder pile + cannonball onto the floor (state 1, touchable). Herman
      // Toothrot (actor 7) then wanders in to confront you over his spyglass.
      use(vm, VERBS.push, fort.cannon);
      expect(driveUntil(vm, () => herman().room === fort.id, { maxTicks: 12000 })).toBe(true);

      // Send Herman off (#122 "Lasciami in pace, dai?"). The spill is only
      // reachable once he's gone, so wait for him to clear room 80.
      const armed = () => vm.verbs.get(fort.dismissHerman)?.state === 'on';
      expect(driveUntil(vm, () => armed(), { maxTicks: 16000 })).toBe(true);
      pickAnswer(vm, fort.dismissHerman);
      expect(driveUntil(vm, () => herman().room !== fort.id, { maxTicks: 30000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // The gunpowder pile (#887 → #884) and cannonball (#885) on the floor go
      // into the pack — the dam's charge and one of its two igniters.
      use(vm, VERBS.pickUp, fort.gunpowderPile);
      expect(waitPickedUp(vm, fort.gunpowder)).toBe(true);
      use(vm, VERBS.pickUp, fort.cannonball);
      expect(waitPickedUp(vm, fort.cannonball)).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Fort — back across the overhead map to the River Fork (15)', () => {
      const map = ROOMS.monkeyMap;
      // The Fort path (#886) drops ego back on screen 3 (near the fortezza, but
      // clear of its re-entry watcher).
      walkTo(vm, ROOMS.fort.path);
      expect(driveToRoom(vm, map.fortScreen, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      // Screen 3 → screen 4 (the edge connector #39), then the river-fork marker
      // (#51) loads the River Fork (room 15).
      walkTo(vm, map.fortScreenToRiver);
      expect(driveToRoom(vm, map.riverScreen, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, map.riverForkMarker);
      expect(driveToRoom(vm, ROOMS.riverFork.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ River Fork — take the flint (and read the note beneath it)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const river = ROOMS.riverFork;
      // The rock IS a flint (#169); taking it (Pick up → global #167) pockets it
      // and reads the assembly-meeting note (#231) underneath in one gesture.
      expect(vm.getObjectOwner(river.flint)).not.toBe(ego);
      use(vm, VERBS.pickUp, river.flint);
      expect(waitPickedUp(vm, river.flint)).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ River Fork — up the footholds to the catapult platform (16)', () => {
      // "i punti d'appoggio" (#170, Walk-to → local #203) climbs ego up to the
      // catapult platform (room 16).
      walkTo(vm, ROOMS.riverFork.footholds);
      expect(driveToRoom(vm, ROOMS.catapult.platform, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Catapult — aim at the beach banana tree, climb to the ledge and fire; two bananas drop', () => {
      const cat = ROOMS.catapult;
      const answers = () => [...vm.verbs.entries()].filter(([k, v]) => k >= 120 && k <= 132 && v.state === 'on');
      const playable = () =>
        vm.cursor.userput > 0 && vm.activeDialog === null && [...vm.verbs.values()].some((v) => v.state === 'on');

      // Aim: pull the catapult arm (#235) — each pull raises g242 by 1 (it rests
      // at 2); a hit lands only at g242==4, so two effective pulls. Bounded loop
      // (some pulls land mid-animation and don't register).
      for (let i = 0; i < 8 && vm.vars.readGlobal(cat.aimVar) !== cat.aimTarget; i++) {
        use(vm, VERBS.pull, cat.crank);
        driveUntil(vm, () => playable(), { maxTicks: 8000 });
        waitPlayable(vm, 4000);
      }
      expect(vm.vars.readGlobal(cat.aimVar)).toBe(cat.aimTarget);

      // Up to the firing ledge (room 11), where a rock (#116) is already seated.
      walkTo(vm, cat.upToLedge);
      expect(driveToRoom(vm, cat.ledge, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Push the seated rock to fire. Herman wanders in to complain (he comes on
      // his own as ego nears the catapult); shoo him (#122) if he opens a menu.
      // The hit knocks bananas onto the beach and latches bit#530.
      expect(vm.vars.readBit(cat.hitBit)).toBe(0);
      use(vm, VERBS.push, cat.seatedRock);
      for (let i = 0; i < 60 && vm.vars.readBit(cat.hitBit) === 0; i++) {
        driveUntil(vm, () => answers().length > 0 || vm.vars.readBit(cat.hitBit) === 1, { maxTicks: 4000 });
        const a = answers();
        if (a.length > 0) pickAnswer(vm, a[a.length - 1]![0]);
      }
      expect(vm.vars.readBit(cat.hitBit)).toBe(1);
      // The hit cutscene continues a few ticks past the bit#530 latch (shake →
      // the bananas drop → "Wow!"); let it finish before checking the drop.
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.objectStates.get(ROOMS.monkeyBeach.fallenBananas)).toBe(1); // the dropped cluster
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Catapult — back down to the River Fork (15)', () => {
      const cat = ROOMS.catapult;
      // Down the two "il sentiero in basso" exits: ledge → platform (16) → River
      // Fork (15). The firing ledge can't always path straight to the down-path
      // object (depends on where the launch left ego), so nudge ego toward it
      // (box 1) between attempts.
      for (let i = 0; i < 5 && vm.currentRoom === cat.ledge; i++) {
        walkTo(vm, cat.ledgeDown);
        if (driveToRoom(vm, cat.platform, { maxTicks: 10000 })) break;
        walkTo(vm, cat.ledgeDownStage);
        waitPlayable(vm, 6000);
      }
      expect(vm.currentRoom).toBe(cat.platform);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, cat.platformDown);
      expect(driveToRoom(vm, ROOMS.riverFork.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ River Fork — pack the dam with gunpowder, spark it with flint & cannonball; the pond floods', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const river = ROOMS.riverFork;
      const fort = ROOMS.fort;

      // Use the Fort gunpowder on the dam (#176): it's packed on (object #178
      // drawn) and the gunpowder consumed (owner → the room).
      expect(vm.getObjectOwner(fort.gunpowder)).toBe(ego);
      useWith(vm, VERBS.use, fort.gunpowder, river.dam);
      expect(driveUntil(vm, (v) => v.getObjectOwner(fort.gunpowder) !== ego, { maxTicks: 10000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Stand at the dam, then strike the flint against the cannonball (steel) for
      // a spark → global #44: the dam blows, the river floods, and the wash carries
      // ego back onto the overhead map (room 4).
      walkTo(vm, river.dam);
      waitPlayable(vm, 6000);
      useWith(vm, VERBS.use, river.flint, fort.cannonball);
      expect(driveToRoom(vm, ROOMS.monkeyMap.riverScreen, { maxTicks: 30000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Monkey map — down to the Pond (40)', () => {
      // The flood left ego on screen 4, where "il laghetto" (#59) loads the Pond.
      walkTo(vm, ROOMS.monkeyMap.pondMarker);
      expect(driveToRoom(vm, ROOMS.pond.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Pond — take the second rope by the unhealthy man', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      // The flood filled the pond, so the rope (#561) by the unhealthy man is
      // reachable now — a plain Pick up takes it. With the Fort rope, that's the
      // two the Crack descent needs.
      expect(vm.getObjectOwner(ROOMS.pond.secondRope)).not.toBe(ego);
      use(vm, VERBS.pickUp, ROOMS.pond.secondRope);
      expect(waitPickedUp(vm, ROOMS.pond.secondRope)).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Pond — back across the map to the Crack (18)', () => {
      const map = ROOMS.monkeyMap;
      // Out of the Pond (#554) onto screen 4, cross to screen 2 (#46), then "il
      // crepaccio" (#35) drops into the Crack.
      walkTo(vm, ROOMS.pond.exit);
      expect(driveToRoom(vm, map.riverScreen, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, map.riverScreenToCrackScreen);
      expect(driveToRoom(vm, map.crackScreen, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      walkTo(vm, map.crackMarker);
      expect(driveToRoom(vm, ROOMS.crack.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ The Crack — tie both ropes and climb down to the oars', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const crack = ROOMS.crack;
      // Tie the Fort rope to the branch (Use → local #202): ego climbs down a
      // level. Then the Pond rope to the trunk: ego climbs to the bottom. Each
      // tie consumes its rope (owner → the room). The Use-walk puts ego in the
      // walkbox each tie gates on.
      expect(vm.getObjectOwner(crack.oars)).not.toBe(ego);
      useWith(vm, VERBS.use, ROOMS.fort.rope, crack.branch);
      expect(driveUntil(vm, (v) => v.getObjectOwner(ROOMS.fort.rope) !== ego, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      useWith(vm, VERBS.use, ROOMS.pond.secondRope, crack.trunk);
      expect(driveUntil(vm, (v) => v.getObjectOwner(ROOMS.pond.secondRope) !== ego, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      // The oars at the bottom.
      use(vm, VERBS.pickUp, crack.oars);
      expect(waitPickedUp(vm, crack.oars)).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ The Crack — back out onto the overhead map (2)', () => {
      walkTo(vm, ROOMS.crack.exit);
      expect(driveToRoom(vm, ROOMS.monkeyMap.crackScreen, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ Monkey map — down to the south beach (20) for the rowboat', () => {
      walkTo(vm, ROOMS.monkeyMap.beachMarker);
      expect(driveToRoom(vm, ROOMS.monkeyBeach.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ South beach — pick up the catapult-dropped banana cluster (two beach bananas)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const beach = ROOMS.monkeyBeach;
      // The catapult knocked these onto the sand (#270, state 1). A plain Pick up
      // takes both beach bananas (#266 + #267) and clears the cluster — no picker
      // needed. They must be collected HERE: after the row there's no convenient
      // way back to room 20, and the monkey wants five (these two + #265 from the
      // opening + the village pair #282/#283).
      expect(vm.objectStates.get(beach.fallenBananas)).toBe(1);
      expect(vm.getObjectOwner(beach.beachBananaA)).not.toBe(ego);
      use(vm, VERBS.pickUp, beach.fallenBananas);
      expect(waitPickedUp(vm, beach.beachBananaA)).toBe(true);
      expect(waitPickedUp(vm, beach.beachBananaB)).toBe(true);
      expect(vm.objectStates.get(beach.fallenBananas)).toBe(0);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ South beach — oars on the rowboat, row around the island to the north beach (132)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const map = ROOMS.monkeyMap;
      const inBoat = () => vm.actors.get(vm.vars.readGlobal(VAR_EGO)).costume === 4;

      // Use the oars on the rowboat (#263 → local #200): ego rows out onto the
      // overhead-map water (room 2) as the boat figure (costume 4).
      expect(vm.getObjectOwner(ROOMS.crack.oars)).toBe(ego);
      useWith(vm, VERBS.use, ROOMS.crack.oars, ROOMS.monkeyBeach.rowboat);
      expect(driveToRoom(vm, map.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(inBoat()).toBe(true);

      // Circumnavigate clockwise in the boat: screen 2's water exit → screen 5 →
      // screen 6, staying in the boat across each edge (the edge-distance box snap
      // keeps the relative crossing on water, not stranded on a land box). "La
      // spiaggia" then lands ego on the north beach (132), disembarking him (back
      // to the walking figure).
      walkTo(vm, map.boatScreen2to5);
      expect(driveToRoom(vm, 5, { maxTicks: 14000 })).toBe(true); // map screen 5 (east)
      expect(inBoat()).toBe(true);
      walkTo(vm, map.boatScreen5to6);
      expect(driveToRoom(vm, 6, { maxTicks: 14000 })).toBe(true); // map screen 6 (north)
      expect(inBoat()).toBe(true);
      walkTo(vm, map.northBeachLanding);
      expect(driveToRoom(vm, ROOMS.northBeach.id, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('🚶‍➡️ North beach — into the jungle, across the map to the cannibal village (25)', () => {
      // The north beach (132) backs room 1; its jungle exit (#16) carries ego
      // onto overhead-map screen 6 (room 6).
      walkTo(vm, ROOMS.northBeach.jungle);
      expect(driveToRoom(vm, ROOMS.monkeyMap.villageScreen, { maxTicks: 14000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      // Walk the figure onto "il villaggio" (#72): verb-11 loadRoomWithEgo room=25
      // → into the cannibal village.
      walkTo(vm, ROOMS.monkeyMap.villageMarker);
      expect(driveToRoom(vm, ROOMS.cannibalVillage.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Cannibal village — steal the bowl bananas; the cannibals haul ego to the hut (27)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const village = ROOMS.cannibalVillage;
      expect(vm.getObjectOwner(village.bowlBananaA)).not.toBe(ego);

      // Take the bowl bananas (#291 Pick up): pockets the two village bananas
      // (#282/#283) — the last two of the monkey's five — and arms the capture
      // cutscene (#202).
      use(vm, VERBS.pickUp, village.bowlBananas);
      expect(waitPickedUp(vm, village.bowlBananaA)).toBe(true);
      expect(waitPickedUp(vm, village.bowlBananaB)).toBe(true);

      // The capture parks until ego turns back toward the cannibals (the camera
      // pans right past g2>270); walking to the confront spot springs it. Then
      // the threat menu arms — pick "E va bene, mangiami." (#122): the natives
      // escort ego to the guest hut (global #105 → room 27).
      walkTo(vm, village.confrontSpot);
      expect(
        driveUntil(vm, (v) => v.verbs.get(village.fineEatMe)?.state === 'on', { maxTicks: 16000 }),
      ).toBe(true);
      pickAnswer(vm, village.fineEatMe);
      expect(driveToRoom(vm, ROOMS.cannibalHut.id, { maxTicks: 16000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Cannibal hut — take the skull, open the loose board, crawl out to the map (6)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const hut = ROOMS.cannibalHut;

      // The skull (#310) hides the loose board (#309 is its child): Pick up the
      // skull and the board becomes openable (without it, Open #309 does nothing).
      use(vm, VERBS.pickUp, hut.skull);
      expect(waitPickedUp(vm, hut.skull)).toBe(true);

      // Open the loose board → "il buco" (the hole), state 1.
      use(vm, VERBS.open, hut.looseBoard);
      expect(
        driveUntil(vm, (v) => v.objectStates.get(hut.looseBoard) === 1, { maxTicks: 8000 }),
      ).toBe(true);

      // Crawl through the hole (verb 11, a bare click) → out onto overhead-map
      // screen 6. The banana-picker (#314) is deliberately left behind — it won't
      // fit through the hole (local #200 makes ego drop it); it's retrieved later
      // through the door once the idol wins the cannibals over.
      walkTo(vm, hut.looseBoard);
      expect(driveToRoom(vm, ROOMS.monkeyMap.villageScreen, { maxTicks: 14000 })).toBe(true);
      expect(vm.getObjectOwner(hut.picker)).not.toBe(ego);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat("🚶‍➡️ Map screen 6 — row the boat back to the south beach, in through the jungle to the monkey (2)", () => {
      const map = ROOMS.monkeyMap;
      const inBoat = () => vm.actors.get(vm.vars.readGlobal(VAR_EGO)).costume === 4;
      // The walking figure can't path screen 6 → 2 (the inland map's two halves
      // only join by boat). Drop to the north beach (#71 "la spiaggia") and
      // re-launch the rowboat (#17): ego rows out as the boat figure (costume 4).
      walkTo(vm, map.northBeachLanding);
      expect(driveToRoom(vm, ROOMS.northBeach.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      use(vm, VERBS.use, ROOMS.northBeach.rowboat);
      expect(driveUntil(vm, () => inBoat(), { maxTicks: 10000 })).toBe(true);

      // Row 6 → 5 → 2 (water connectors), then beach at the south shore (#30 →
      // room 20). Each crossing stays in the boat (the edge-distance box snap).
      walkTo(vm, map.boatScreen6to5);
      expect(driveToRoom(vm, 5, { maxTicks: 12000 })).toBe(true);
      expect(inBoat()).toBe(true);
      walkTo(vm, map.boatScreen5to2);
      expect(driveToRoom(vm, ROOMS.monkeyMap.id, { maxTicks: 12000 })).toBe(true);
      expect(inBoat()).toBe(true);
      walkTo(vm, map.beachMarker);
      expect(driveToRoom(vm, ROOMS.monkeyBeach.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // South beach → jungle (#261) → overhead-map screen 2, on foot, where the
      // monkey paces.
      walkTo(vm, ROOMS.monkeyBeach.jungle);
      expect(driveToRoom(vm, ROOMS.monkeyMap.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });

    beat('⚙️ Map screen 2 — catch the wandering monkey, feed it the five bananas (it follows)', () => {
      const ego = vm.vars.readGlobal(VAR_EGO);
      const m = ROOMS.monkey;
      const monkeyActor = () => vm.actors.get(m.actor);
      const scriptLive = (id: number) => vm.slots.some((s) => s.status !== 'dead' && s.scriptId === id);
      const held = (b: number) => vm.getObjectOwner(b) === ego;

      // Catch it: the monkey paces, so click where it is and retry until the
      // close-up (room 21) loads. (RNG-touchy — its path differs from boot, so
      // this is a bounded retry, not an exact click.)
      let caught = false;
      for (let i = 0; i < 20 && !caught; i++) {
        try {
          walkTo(vm, actorPoint(vm, m.actor));
        } catch {
          // monkey momentarily mid-transition / off the loaded screen
        }
        caught = driveToRoom(vm, m.closeup, { maxTicks: 4000 });
      }
      expect(caught).toBe(true);
      expect(waitPlayable(vm)).toBe(true);

      // Feed all five: the monkey must be "down" (costume 6) to take a banana, so
      // wait for that and for the feed scripts (#202/#203) to settle between
      // gives; one that lands mid-animation is refused ("Non prima che scenda
      // lui"), so retry each banana until it's consumed (owner → 14).
      for (const banana of m.bananas) {
        for (let tries = 0; held(banana) && tries < 5 && vm.currentRoom === m.closeup; tries++) {
          driveUntil(
            vm,
            (v) =>
              monkeyActor().costume === m.receptiveCostume &&
              !scriptLive(202) &&
              !scriptLive(203) &&
              v.cursor.userput > 0,
            { maxTicks: 8000 },
          );
          give(vm, VERBS.give, banana, m.actor);
          driveUntil(
            vm,
            (v) => !held(banana) || (!scriptLive(202) && !scriptLive(203) && v.cursor.userput > 0),
            { maxTicks: 10000 },
          );
          waitPlayable(vm, 4000);
        }
        expect(held(banana)).toBe(false);
      }
      // All five fed; the follow controller (#43) is running.
      expect(vm.vars.readGlobal(m.fedVar)).toBe(5);

      // Leave the close-up (jungle #274) → back onto the map; the monkey trails
      // ego out (global #34 carries it across the screen change).
      walkTo(vm, m.closeupExit);
      expect(driveToRoom(vm, ROOMS.monkeyMap.id, { maxTicks: 12000 })).toBe(true);
      expect(waitPlayable(vm)).toBe(true);
      expect(driveUntil(vm, () => monkeyActor().room === vm.currentRoom, { maxTicks: 6000 })).toBe(true);
      expect(vm.haltInfo).toBeNull();
    });
  });

  // ALWAYS THE LAST GROUP: snapshot the furthest clean playable state to a save
  // so the NEXT frontier's beats can be developed by fast-forwarding here
  // (restoreSave) instead of re-driving from boot — the regression net itself
  // always runs from boot. As the walkthrough grows, this group moves to stay
  // last, so the save tracks the leading edge. Regenerated every green run, so
  // it can't drift stale.
  describe('frontier', () => {
    beat('snapshot the furthest clean state to saves/MI1-walkthrough-frontier', () => {
      writeFileSync(
        'saves/MI1-walkthrough-frontier.websave.json',
        JSON.stringify(snapshotVm(vm, { game: 'MI1', label: 'walkthrough-frontier' })),
      );
      // Furthest clean point so far: into "Under Monkey Island" — Part III's
      // surface (beach, Fort, catapult, dam, Pond, Crack, the row to the north
      // beach), the cannibal village (bowl bananas stolen, the capture, the hut
      // escape via skull + loose board), then the row BACK to the south side and
      // the wandering monkey caught and fed all five bananas — it now follows ego
      // around the overhead map (screen 2). The totem / Giant Monkey Head is next.
      expect(vm.currentRoom).toBe(ROOMS.monkeyMap.id);
      expect(vm.vars.readGlobal(VARS.voyageStage)).toBe(2);
      expect(vm.vars.readBit(ROOMS.catapult.hitBit)).toBe(1);
      // All five bananas fed to the monkey, which follows in ego's room.
      expect(vm.vars.readGlobal(ROOMS.monkey.fedVar)).toBe(5);
      expect(vm.actors.get(ROOMS.monkey.actor).room).toBe(vm.currentRoom);
    });
  });
});
