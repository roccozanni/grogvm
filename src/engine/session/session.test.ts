/**
 * EngineSession integration tests — headless (MemoryRenderer + ManualClock),
 * data-gated on real MI1 like mi1-smoke / savestate. Proves the loop,
 * frame production, lifecycle, and input all work without a DOM or rAF.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseResourceFile } from '../resources/file';
import { parseIndexFile } from '../resources/index-file';
import { parseLoff } from '../resources/loff';
import { SCUMM_V5_XOR_KEY } from '../resources/xor';
import { MemoryRenderer } from '../render/memory';
import { VAR_MOUSE_X, VAR_VIRT_MOUSE_Y } from '../vm/vars';
import type { Vm } from '../vm/vm';
import { createSession } from './session';
import { ManualClock } from './clock';
import type { EngineSession, SessionGame } from './types';

const INDEX = 'games/MI1/MONKEY.000';
const RESOURCE = 'games/MI1/MONKEY.001';
const hasData = existsSync(INDEX) && existsSync(RESOURCE);

function makeGame(): SessionGame {
  const index = parseIndexFile(parseResourceFile(new Uint8Array(readFileSync(INDEX)), SCUMM_V5_XOR_KEY));
  const resourceFile = parseResourceFile(new Uint8Array(readFileSync(RESOURCE)), SCUMM_V5_XOR_KEY);
  return { resourceFile, index, loff: parseLoff(resourceFile), gameId: 'MI1' };
}

/** Fast-forward the underlying VM into the first interactive room (room 33)
 *  WITHOUT composing every tick — keeps the test quick. We exercise the
 *  session layer from there. */
function fastForwardToRoom33(vm: Vm): void {
  for (let t = 0; t < 60000 && vm.currentRoom !== 33 && !vm.haltInfo; t++) vm.tick();
  for (let i = 0; i < 24; i++) vm.tick(); // settle actors/verbs/dialog
}

describe.skipIf(!hasData)('EngineSession — real MI1', () => {
  it('step() composes the current room and presents it to the renderer', () => {
    const renderer = new MemoryRenderer();
    const session = createSession(makeGame(), renderer, new ManualClock());
    fastForwardToRoom33(session.vm);
    expect(session.vm.currentRoom).toBe(33);

    const frame = session.step();

    // FrameInfo describes the composed room frame.
    expect(frame.roomId).toBe(33);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.framebuffer.length).toBe(frame.width * frame.height);
    // Camera-driven viewport: the presented frame is at most VIEWPORT_W wide,
    // and equals min(320, roomWidth) — never the full width of a wide room.
    const roomW = session.vm.loadedRoom!.width;
    expect(frame.width).toBe(Math.min(320, roomW));
    expect(frame.width).toBeLessThanOrEqual(320);
    expect(frame.compose.actorsDrawn).toBeGreaterThanOrEqual(1);
    expect(frame.halted).toBe(false);
    // It actually reached the renderer at the right size, with a real palette.
    expect(renderer.presentCount).toBeGreaterThan(0);
    expect(renderer.width).toBe(frame.width);
    expect(renderer.height).toBe(frame.height);
    expect(renderer.framebuffer.length).toBe(frame.width * frame.height);
    expect(renderer.palette.some((b) => b !== 0)).toBe(true);
  });

  it('onFrame subscribers receive each presented frame; unsubscribe stops it', () => {
    const session = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    fastForwardToRoom33(session.vm);
    const seen: number[] = [];
    const off = session.onFrame((f) => seen.push(f.tickCount));
    session.step();
    session.step();
    expect(seen.length).toBe(2);
    off();
    session.step();
    expect(seen.length).toBe(2); // no more after unsubscribe
  });

  it('play() ticks via the clock and pause() stops it', () => {
    const renderer = new MemoryRenderer();
    const clock = new ManualClock();
    const session = createSession(makeGame(), renderer, clock);

    session.play();
    expect(clock.running).toBe(true);
    // ~30 frames at 60 Hz. Early boot is busy (scripts dispatching / cutscene
    // running), so it won't auto-pause this soon.
    for (let i = 0; i < 30; i++) clock.advance(1000 / 60);
    const ticked = session.status().tickCount;
    expect(ticked).toBeGreaterThan(0);
    expect(session.status().playing).toBe(true);
    expect(renderer.presentCount).toBeGreaterThan(0);

    session.pause();
    expect(clock.running).toBe(false);
    for (let i = 0; i < 10; i++) clock.advance(1000 / 60);
    expect(session.status().tickCount).toBe(ticked); // no ticks while paused
  });

  it('setRate throttles the tick cadence', () => {
    const slowClock = new ManualClock();
    const fastClock = new ManualClock();
    const sSlow = createSession(makeGame(), new MemoryRenderer(), slowClock);
    const sFast = createSession(makeGame(), new MemoryRenderer(), fastClock);

    sSlow.setRate(10); // 100 ms / tick
    sFast.setRate(60); // ~16.7 ms / tick
    sSlow.play();
    sFast.play();
    // Same wall-clock budget delivered in 16.7 ms steps to both.
    for (let i = 0; i < 60; i++) {
      slowClock.advance(1000 / 60);
      fastClock.advance(1000 / 60);
    }
    expect(sFast.status().tickCount).toBeGreaterThan(sSlow.status().tickCount);
  });

  it('skipCutscene fast-forwards the intro into interactive room 33', () => {
    const session = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    session.skipCutscene();
    expect(session.vm.loadedRoom?.id).toBe(33);
    expect(session.vm.haltInfo).toBeNull();
    expect([...session.vm.verbs.values()].some((v) => v.state === 'on')).toBe(true);
    // NB: it returns `false` (caps at MAX_SKIP_TICKS) for this path — room 33's
    // ego idle animation keeps the yield fingerprint changing, so the
    // idle+interactive stop never trips. Faithful to the ported logic; the
    // value of this control here is the synchronous drive-through to room 33.
  });

  it('play() runs continuously through the intro without a spurious pause', () => {
    // Exercises the loop's progress / cutscene-guard paths: they must NOT
    // misfire and auto-pause while real scripts are dispatching. (Positive
    // idle-pause triggering is validated in-app via the Debug surface — MI1's
    // animated rooms never go fingerprint-stable headlessly.)
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

  it('snapshot → restore through the session reproduces the room', () => {
    const s1 = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    fastForwardToRoom33(s1.vm);
    const snap = s1.snapshot('t', 1000);
    const json = JSON.stringify(snap);

    const s2 = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    s2.restore(JSON.parse(json));
    expect(s2.vm.currentRoom).toBe(33);
    expect(s2.vm.loadedRoom?.id).toBe(33);
    expect(s2.vm.haltInfo).toBeNull();
    // Re-serialises identically (same meta → byte-equal).
    expect(JSON.stringify(s2.snapshot('t', 1000))).toBe(json);
    // Restored while not playing → stays paused with a banner.
    expect(s2.status().playing).toBe(false);
    expect(s2.status().idleReason).toMatch(/loaded/);
  });

  it('reboot returns to a fresh boot (tick counter reset)', () => {
    const session = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    for (let i = 0; i < 20; i++) session.step();
    expect(session.status().tickCount).toBe(20);
    session.reboot();
    expect(session.status().tickCount).toBe(0);
    expect(session.vm.haltInfo).toBeNull();
  });

  it('sendInput writes mouse vars and toggles button holds', () => {
    const session = createSession(makeGame(), new MemoryRenderer(), new ManualClock());
    session.sendInput({ type: 'move', roomX: 42, roomY: 17 });
    expect(session.vm.mouseRoomX).toBe(42);
    expect(session.vm.mouseRoomY).toBe(17);
    expect(session.vm.vars.readGlobal(VAR_MOUSE_X)).toBe(42);
    expect(session.vm.vars.readGlobal(VAR_VIRT_MOUSE_Y)).toBe(17);

    session.sendInput({ type: 'down', button: 'left', roomX: 42, roomY: 17 });
    expect(session.vm.input.leftHold).toBe(true);
    session.sendInput({ type: 'up', button: 'left' });
    expect(session.vm.input.leftHold).toBe(false);

    // Escape with no active cutscene is a harmless no-op.
    expect(() => session.sendInput({ type: 'key', key: 'Escape' })).not.toThrow();
  });

  it('dispose stops the clock and disposes the renderer', () => {
    const renderer = new MemoryRenderer();
    const clock = new ManualClock();
    const session = createSession(makeGame(), renderer, clock);
    session.play();
    expect(clock.running).toBe(true);
    session.dispose();
    expect(clock.running).toBe(false);
    expect(renderer.disposed).toBe(true);
  });
});

describe('ManualClock', () => {
  it('fires the callback on advance and reports time', () => {
    const clock = new ManualClock();
    const times: number[] = [];
    clock.start((now) => times.push(now));
    clock.advance(16);
    clock.advance(16);
    expect(times).toEqual([16, 32]);
    expect(clock.time).toBe(32);
    expect(clock.running).toBe(true);
  });

  it('stop() unsubscribes', () => {
    const clock = new ManualClock();
    let fired = 0;
    clock.start(() => fired++);
    clock.advance(16);
    clock.stop();
    expect(clock.running).toBe(false);
    clock.advance(16);
    expect(fired).toBe(1);
  });
});
