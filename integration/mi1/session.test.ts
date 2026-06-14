/**
 * EngineSession driving the REAL game — the end-to-end coverage the synthetic
 * `src/engine/session/session.test.ts` can't provide: that `createSession`
 * wires the actual MI1 resources into a VM that boots through the intro, loads
 * a real room, composes a frame with drawn actors and the room's palette, runs
 * continuously through scripted dispatch without a spurious idle-pause, and
 * round-trips its live state. (The bare VM is exercised by `walkthrough.test.ts`;
 * this covers the session layer ON TOP of the real game.)
 *
 * The loop/lifecycle/input plumbing (clock throttle, idle/all-dead pause,
 * onFrame, sendInput, reboot, dispose) is pinned synthetically — not duplicated
 * here. Data-gated, so it self-skips on a fresh checkout.
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../../src/engine/session/session';
import { ManualClock } from '../../src/engine/session/clock';
import { MemoryRenderer } from '../../src/engine/render/memory';
import type { SessionGame } from '../../src/engine/session/types';
import type { Vm } from '../../src/engine/vm/vm';
import { loadScummV5, readCdTrackDurations } from '../../src/testkit/scummv5';
import { viewportLeft } from '../../src/engine/graphics/viewport';
import { boot, DATA_DIR, hasGame, ROOMS } from './game';

const LOOKOUT = ROOMS.meleeLookout.id; // 33 — the first interactive room

function makeGame(): SessionGame {
  const { res, index, loff } = loadScummV5(DATA_DIR);
  return {
    resourceFile: res,
    index,
    loff,
    gameId: 'MI1',
    cdTrackDurations: readCdTrackDurations(DATA_DIR),
  };
}

/** Fast-forward the VM into the first interactive room (33) WITHOUT composing
 *  every tick — keeps the test quick; we exercise the session from there. */
function fastForwardToLookout(vm: Vm): void {
  for (let t = 0; t < 60000 && vm.currentRoom !== LOOKOUT && !vm.haltInfo; t++) vm.tick();
  for (let i = 0; i < 24; i++) vm.tick(); // settle actors/verbs/dialog
}

describe.skipIf(!hasGame())('EngineSession — real MI1', () => {
  it('step() composes the live room and presents it with actors + palette', () => {
    const renderer = new MemoryRenderer();
    const session = createSession(makeGame(), renderer, new ManualClock());
    fastForwardToLookout(session.vm);
    expect(session.vm.currentRoom).toBe(LOOKOUT);

    const frame = session.step();

    expect(frame.roomId).toBe(LOOKOUT);
    expect(frame.framebuffer.length).toBe(frame.width * frame.height);
    // The presented frame is the full assembled screen; the camera-driven
    // room slice is min(320, roomWidth) wide and rides alongside.
    const roomW = session.vm.loadedRoom!.width;
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(200);
    expect(frame.viewportWidth).toBe(Math.min(320, roomW));
    expect(frame.compose.actorsDrawn).toBeGreaterThanOrEqual(1);
    expect(frame.halted).toBe(false);
    expect(renderer.presentCount).toBeGreaterThan(0);
    expect(renderer.width).toBe(frame.width);
    expect(renderer.height).toBe(frame.height);
    expect(renderer.palette.some((b) => b !== 0)).toBe(true);
  });

  it('the presented frame includes verb-bar text pixels — the complete screen crosses the Renderer seam', () => {
    const renderer = new MemoryRenderer();
    const session = createSession(makeGame(), renderer, new ManualClock());
    session.skipCutscene(); // drives to the lookout with the verb bar live
    const frame = session.present();
    expect([...session.vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
    // The verb band (rows ≥ roomHeight) carries real ink: at least one pixel
    // differs from the band fill — text/images, not just the black panel.
    const band = frame.framebuffer.subarray(frame.roomHeight * frame.width);
    expect(band.some((p) => p !== 0)).toBe(true);
  });

  it('play() runs continuously through the intro without a spurious pause', () => {
    // Exercises the loop's progress / cutscene-guard paths against REAL scripts:
    // they must NOT misfire and auto-pause while scripts are dispatching. (MI1's
    // animated rooms never go fingerprint-stable headlessly — the positive
    // idle-pause trigger is pinned synthetically instead.)
    const renderer = new MemoryRenderer();
    const clock = new ManualClock();
    const session = createSession(makeGame(), renderer, clock);
    let sawRoom = false;
    session.onFrame((f) => {
      if (f.roomId !== null) sawRoom = true;
    });
    session.play();
    for (let i = 0; i < 300; i++) clock.advance(1000 / 60);
    expect(session.status().playing).toBe(true);
    expect(session.status().tickCount).toBeGreaterThan(100);
    expect(renderer.presentCount).toBeGreaterThan(0);
    expect(sawRoom).toBe(true); // a room loaded + composed during play
  });

  it('skipCutscene fast-forwards the intro into the interactive lookout', () => {
    const session = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    session.skipCutscene();
    expect(session.vm.loadedRoom?.id).toBe(LOOKOUT);
    expect(session.vm.haltInfo).toBeNull();
    expect([...session.vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
    // NB: it returns `false` (caps at MAX_SKIP_TICKS) for this path — room 33's
    // ego idle animation keeps the yield fingerprint changing, so the
    // idle+interactive stop never trips. Faithful to the ported logic; the
    // value here is the synchronous drive-through to the lookout.
  });

  // NB: session-level snapshot/restore (reproduces room, paused-with-banner,
  // byte-equal re-serialize) is game-agnostic and pinned synthetically in
  // `src/engine/session/session.test.ts`; the real-state round-trip lives in
  // `integration/mi1/savestate.test.ts`. Not duplicated here.

  // A room load reclamps the camera to the NEW room's bounds, the way SCUMM's
  // per-frame cameraMoved() does. The LeChuck-explosion ending (global #137)
  // crosses a wide room → the 320-wide blimp room → the 640-wide credits room
  // with NO setCameraAt; the narrow room must pull a carried-over centre to
  // 160 so the credits room inherits it and frames the cliff at the left.
  // Without the reclamp the centre stays pinned mid-room and the credits room
  // is split down the middle (cliff | LucasArts logo).
  it('a room load pulls the camera centre into the new room (explosion-ending path)', () => {
    const vm = boot();
    const CREDITS = 10;

    vm.enterRoom(ROOMS.stan.id); // 640 wide (where the explosion is triggered)
    vm.camera.x = 297; // camera parked near ego, as in the bug-report save
    expect(vm.loadedRoom!.width).toBe(640);

    vm.enterRoom(ROOMS.meleeMap.id); // 320-wide blimp room — clamps centre to 160
    expect(vm.loadedRoom!.width).toBe(320);
    expect(vm.camera.x).toBe(160);

    vm.enterRoom(CREDITS); // 640-wide credits room — inherits 160, NOT 297
    expect(vm.loadedRoom!.width).toBe(640);
    expect(vm.camera.x).toBe(160);
    // The visible slice starts at the room's left edge (the cliff), not mid-room.
    expect(viewportLeft(vm.camera.x, vm.loadedRoom!.width)).toBe(0);
  });
});
