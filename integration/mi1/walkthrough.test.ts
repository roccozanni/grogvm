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
 *
 * BEAT NAMING: `<Part> · <Room> — <what the beat proves>`. Part is the game's
 * own part (roman numeral; I = "The Three Trials"); Room is where the beat
 * acts. No ordinal — file order *is* run order, so the sequence is positional.
 * Stop-on-break surfaces the failing beat's name, so it must say *where* (the
 * room) and *what* broke; don't cross-reference other beats by number.
 *
 * Data-gated (skipped without the game files). Run: `npm run test:integration`.
 */
import { describe, expect, it } from 'vitest';
import {
  driveToRoom,
  driveTicks,
  driveUntil,
  pickAnswer,
  use,
  waitIdle,
  walkTo,
} from '../../src/testkit/scummv5';
import { VAR_CURRENT_LIGHTS, VAR_EGO } from '../../src/engine/vm/vars';
import { boot, hasGame, ROOMS, VARS, VERBS } from './game';

// One VM for the whole walkthrough, driven forward across beats.
const vm = boot();

// Stop-on-break: the FIRST failing beat goes red (that's the regression);
// every later beat is skipped, not cascaded into noise or — worse — falsely
// passed. So a red+skipped tail localizes exactly where the game broke.
let broken = false;
const beat = (name: string, fn: () => void): void =>
  it(name, (ctx) => {
    if (broken) return ctx.skip();
    try {
      fn();
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
    // Player has control: input enabled, the hover poller live, a verb armed.
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
    // Faithful: Open the door (verb→hover→scene-click → doSentence), then a
    // walk-to-door scene click; ego paths to it and the door script changes
    // room. (The old playthrough probe pushed these sentences directly — here
    // we go through the click flow to guard the real input path.)
    use(vm, VERBS.open, ROOMS.meleeLookout.barDoor);
    driveTicks(vm, 600);
    walkTo(vm, ROOMS.meleeLookout.barDoor);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 1200 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · SCUMM Bar — talk to the LOOM-ad pirate → close-up (82), pick an answer, ego speaks it', () => {
    // Continue in the room-28 state the previous beat left; let the bar settle.
    driveTicks(vm, 200);
    // Faithful trigger: "Parla" (talk to) the salesman pirate #333. His verb
    // script starts conversation script #93, which loads the close-up room 82.
    use(vm, VERBS.talk, ROOMS.scummBar.loomPirate);
    expect(driveToRoom(vm, ROOMS.pirateCloseup.id, { maxTicks: 2400 })).toBe(true);

    // The dialog options are live verbs. Drive until the answer arms, then
    // capture its own label (this build's language) so we verify ego speaks
    // THAT line without hardcoding a translation.
    const niceHat = ROOMS.pirateCloseup.answers.niceHat;
    driveUntil(vm, (v) => v.verbs.get(niceHat)?.state === 'on', { maxTicks: 1200 });
    const answer = vm.verbs.get(niceHat);
    expect(answer?.state).toBe('on');
    expect(answer?.name?.length ?? 0).toBeGreaterThan(0);

    // Click the answer → ego speaks the selected line. The mechanic: the
    // spoken line is the answer we picked.
    pickAnswer(vm, niceHat);
    driveUntil(vm, (v) => v.activeDialog !== null, { maxTicks: 400 });
    expect(vm.activeDialog?.text).toBe(answer!.name);

    // End the close-up: once ego's line finishes and the menu re-arms, fire
    // the goodbye ("E' stato bello parlare con te.") to return to the bar —
    // leaving the playthrough back in a navigable room for the next beat.
    waitIdle(vm);
    const goodbye = ROOMS.pirateCloseup.answers.goodbye;
    driveUntil(vm, (v) => v.verbs.get(goodbye)?.state === 'on', { maxTicks: 1200 });
    pickAnswer(vm, goodbye);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 4000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · SCUMM Bar — talk to the 3 pirates; the trials flag (g197) flips', () => {
    // Continue in the room-28 state the previous beat left; let the bar settle.
    driveTicks(vm, 200);
    // Unlike the LOOM pirate, the three important-looking pirates (#322) run
    // their conversation #220 *inline* in the bar — no close-up room. The
    // options arm as live verbs right here in room 28.
    expect(vm.vars.readGlobal(VARS.trialsLearned)).toBe(0); // not yet learned
    use(vm, VERBS.talk, ROOMS.scummBar.threePirates);

    // First menu: pick "Voglio diventare un pirata." (the real opener; the
    // other two are jokes). Capture its own label so we don't hardcode a
    // translation.
    const wantPirate = ROOMS.scummBar.trialsAnswers.wantToBePirate;
    driveUntil(vm, (v) => v.verbs.get(wantPirate)?.state === 'on', { maxTicks: 2400 });
    expect(vm.verbs.get(wantPirate)?.name?.length ?? 0).toBeGreaterThan(0);
    pickAnswer(vm, wantPirate);

    // The pirates explain the three trials → the conversation-stage flag
    // flips. That's the mechanic (no localized text matched).
    expect(driveUntil(vm, (v) => v.vars.readGlobal(VARS.trialsLearned) === 1, { maxTicks: 4000 })).toBe(true);

    // Exit via the goodbye option (it arms in the follow-up menu); control
    // returns in a navigable bar — verb bar live, no lingering menu.
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

    // Pre-position ego at the kitchen door (right side) so it can slip in
    // during the brief window — crossing the whole bar mid-window won't make
    // it. (A floor click toward the door; ego paths to the doorway box.)
    walkTo(vm, { x: 500, y: 130 });
    driveTicks(vm, 1500);

    // The cook cycles out into the bar then back. The door's left open, so a
    // Walk-to (verb 11) carries ego through — but only with the cook deep in
    // the bar (his sweep dips to x≈300), clear of the doorway he'd otherwise
    // block. The window is timed, so retry across cycles; each miss waits out
    // the window before the next try.
    let entered = false;
    for (let attempt = 0; attempt < 12 && !entered; attempt++) {
      driveUntil(vm, () => inBar() && cook().x < 340, { maxTicks: 4000 });
      if (inBar() && cook().x < 340) {
        use(vm, VERBS.walk, ROOMS.scummBar.kitchenDoor);
        entered = driveToRoom(vm, ROOMS.kitchen.id, { maxTicks: 1500 });
      }
      if (!entered) driveUntil(vm, () => !inBar(), { maxTicks: 2000 });
    }
    expect(entered).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — take the meat and the pot', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    // Both sit on the kitchen floor; Pick up (verb 9) flips ownership to ego.
    for (const obj of [ROOMS.kitchen.meat, ROOMS.kitchen.pot]) {
      use(vm, VERBS.pickUp, obj);
      expect(driveUntil(vm, (v) => v.getObjectOwner(obj) === ego, { maxTicks: 3000 })).toBe(true);
    }
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — stomp the board 3× to scare the gull, grab the fish', () => {
    const ego = vm.vars.readGlobal(VAR_EGO);
    const k = ROOMS.kitchen;
    const gull = () => vm.actors.get(k.seagullActor);

    // Open the dock door: unblocks the dock walkboxes, makes the fish touchable
    // and starts the gull watcher (local #203, on ego's distance to the board).
    use(vm, VERBS.open, k.dockDoor);
    driveTicks(vm, 400);

    // Two stomps notch the gull's scare counter; step off between so the
    // watcher re-triggers on the next approach.
    for (let stomp = 1; stomp <= 2; stomp++) {
      walkTo(vm, k.boardWalkTo);
      expect(
        driveUntil(vm, (v) => v.vars.readGlobal(VARS.gullScare) === stomp, { maxTicks: 4000 }),
      ).toBe(true);
      walkTo(vm, k.offBoard);
      driveTicks(vm, 300);
    }

    // Third stomp makes the gull bolt (x 252→310); the fish's "bird will peck"
    // guard lifts only WHILE it flies. Trigger on the bolt, then grab inside
    // that window.
    walkTo(vm, k.boardWalkTo);
    expect(driveUntil(vm, () => gull().x > 260, { maxTicks: 4000 })).toBe(true);
    use(vm, VERBS.pickUp, k.fish);
    expect(driveUntil(vm, (v) => v.getObjectOwner(k.fish) === ego, { maxTicks: 3000 })).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  beat('I · Kitchen — back out through the SCUMM Bar to the Mêlée Lookout (33)', () => {
    // Kitchen → bar through the kitchen-side door (#570); Walk-to runs its
    // room change (no cook gating on this side).
    use(vm, VERBS.walk, ROOMS.kitchen.barDoor);
    expect(driveToRoom(vm, ROOMS.scummBar.id, { maxTicks: 2000 })).toBe(true);

    // Bar → lookout through the left exit (#315). The FIRST bar exit fires a
    // one-time cutscene (the Sheriff; through rooms 70→72) before control
    // lands back at the lookout — so give the room change a wide budget.
    driveTicks(vm, 200);
    use(vm, VERBS.walk, ROOMS.scummBar.exitDoor);
    expect(driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 8000 })).toBe(true);

    // Cutscene released: input live and a verb armed (verb 11 isn't the one
    // re-armed here, so check userput + any-verb-on, as the intro beat does).
    expect(
      driveUntil(vm, (v) => v.cursor.userput > 0 && [...v.verbs.values()].some((x) => x.state === 'on'), {
        maxTicks: 2000,
      }),
    ).toBe(true);
    expect(vm.haltInfo).toBeNull();
  });

  // ── FRONTIER ──────────────────────────────────────────────────────────
  // Next: out into Mêlée town for the three trials (sword, thievery,
  // treasure). (Meat, pot, fish in inventory; trials learned; at the lookout.)
});
