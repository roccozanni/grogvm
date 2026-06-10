/**
 * EngineSession tests — fully synthetic (MemoryRenderer + ManualClock, a
 * hand-built one-room game), so they run in the default data-free suite and
 * pin the *session layer* — the loop, frame production, lifecycle, input —
 * not any particular game. The real-game drive-through lives in
 * `integration/mi1/session.test.ts`.
 *
 * The synthetic game is the minimum `bootGame` needs: a LECF with one ROOM and
 * global script #1 (the boot script). The boot bytecode is the only knob — a
 * yield-loop keeps a slot alive forever (the steady-state most tests want); a
 * lone `stopObjectCode` dies immediately (the all-slots-dead path). Headless and
 * deterministic, so unlike a real animated game it CAN settle to a stable
 * fingerprint — which is what lets us exercise the idle auto-pause synthetically.
 */
import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../resources/block';
import { parseLoff } from '../resources/loff';
import type { ResourceFile } from '../resources/tree';
import type { IndexFile } from '../resources/index-file';
import { MemoryRenderer } from '../render/memory';
import { VAR_MOUSE_X, VAR_VIRT_MOUSE_Y } from '../vm/vars';
import { createSession } from './session';
import { ManualClock } from './clock';
import type { SessionGame } from './types';

// ── synthetic-game builder ────────────────────────────────────────────────
// SCUMM blocks: 4-char tag + big-endian u32 size (header included) + payload.

function block(tag: string, payload: Uint8Array | number[] = []): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(8 + body.length);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  const size = out.length;
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(body, 8);
  return out;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(bufs.reduce((s, b) => s + b.length, 0));
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/** Minimal decodable SMAP: one uncompressed (method 0x01) strip per 8px column. */
function smapBody(width: number, height: number, fill: number): Uint8Array {
  const stripCount = width / 8;
  const offsets = stripCount * 4;
  const strip = new Uint8Array(1 + height * 8);
  strip[0] = 0x01;
  strip.fill(fill, 1);
  const out = new Uint8Array(offsets + stripCount * strip.length);
  for (let i = 0; i < stripCount; i++) {
    const start = offsets + i * strip.length + 8; // +8: offsets are block-relative
    out[i * 4] = start & 0xff;
    out[i * 4 + 1] = (start >>> 8) & 0xff;
    out[i * 4 + 2] = (start >>> 16) & 0xff;
    out[i * 4 + 3] = (start >>> 24) & 0xff;
    out.set(strip, offsets + i * strip.length);
  }
  return out;
}

/** A recognisable (non-black) 256-colour CLUT so palette assertions have teeth. */
function clutBody(): Uint8Array {
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    out[i * 3] = i;
    out[i * 3 + 1] = 255 - i;
    out[i * 3 + 2] = (i * 7) & 0xff;
  }
  return out;
}

const ROOM_ID = 5;
const ROOM_W = 320;
const ROOM_H = 144;
/** breakHere; jump -4 → yields every frame forever, keeping the slot alive. */
const BOOT_YIELD_LOOP = [0x80, 0x18, 0xfc, 0xff];
/** stopObjectCode → the boot slot dies on its first frame. */
const BOOT_DIE = [0x00];

/** Assemble a one-room game whose boot script (#1) runs `bootBytecode`. */
function makeSyntheticGame(bootBytecode: number[] = BOOT_YIELD_LOOP): SessionGame {
  const room = block(
    'ROOM',
    concat(
      block('RMHD', [ROOM_W & 0xff, ROOM_W >>> 8, ROOM_H & 0xff, ROOM_H >>> 8, 0, 0]),
      block('CLUT', clutBody()),
      block('TRNS', [0, 0]),
      block('RMIM', concat(block('RMIH', [0, 0]), block('IM00', block('SMAP', smapBody(ROOM_W, ROOM_H, 42))))),
      block('ENCD', [0xa0]), // stopObjectCode — entry script just returns
    ),
  );
  const scrp = block('SCRP', bootBytecode);

  // LOFF (1 entry) sits between the LECF and LFLF headers, so the ROOM block
  // lands at a fixed offset; SCRP follows the ROOM inside the same LFLF.
  const roomOffset = 8 /* LECF */ + (8 + 1 + 5) /* LOFF */ + 8 /* LFLF */;
  const loffBytes = block('LOFF', [1, ROOM_ID, roomOffset & 0xff, (roomOffset >>> 8) & 0xff, 0, 0]);
  const lecf = block('LECF', concat(loffBytes, block('LFLF', concat(room, scrp))));

  const resourceFile: ResourceFile = { bytes: lecf, tree: parseBlocks(lecf) };
  const loff = parseLoff(resourceFile);

  const index: IndexFile = {
    maxs: { raw: [], numVariables: 800, numBitVariables: 2048, numLocalObjects: 200, numCharsets: 0, numVerbs: 0 },
    rooms: [],
    // Script #1 lives `room.length` bytes past the ROOM block it follows.
    scripts: [
      { room: 0, offset: 0 },
      { room: ROOM_ID, offset: room.length },
    ],
    sounds: [],
    costumes: [],
    charsets: [],
    objects: [],
  };

  return { resourceFile, index, loff, gameId: 'MI1' };
}

describe('EngineSession — synthetic game', () => {
  it('step() composes the loaded room and presents it to the renderer', () => {
    const renderer = new MemoryRenderer();
    const session = createSession(makeSyntheticGame(), renderer, new ManualClock());
    session.enterRoom(ROOM_ID);

    const frame = session.step();

    expect(frame.roomId).toBe(ROOM_ID);
    // The presented frame is the full assembled screen (room band + verb
    // band); the room slice geometry rides alongside.
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(200);
    expect(frame.viewportWidth).toBe(Math.min(320, ROOM_W));
    expect(frame.roomHeight).toBe(ROOM_H);
    expect(frame.framebuffer.length).toBe(frame.width * frame.height);
    expect(frame.halted).toBe(false);
    // It reached the renderer at the right size, with the room's real palette.
    expect(renderer.presentCount).toBeGreaterThan(0);
    expect(renderer.width).toBe(frame.width);
    expect(renderer.height).toBe(frame.height);
    expect(renderer.framebuffer.length).toBe(frame.width * frame.height);
    expect(renderer.palette.some((b) => b !== 0)).toBe(true);
    // Rows below the room band are the verb panel (band fill, CLUT 0 here).
    for (let y = ROOM_H; y < 200; y += 13) {
      expect(frame.framebuffer[y * 320 + 7]).toBe(0);
    }
  });

  it('enterRoom warps into a room, loads it, and reports the warp', () => {
    const session = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
    session.enterRoom(ROOM_ID);
    expect(session.vm.currentRoom).toBe(ROOM_ID);
    expect(session.vm.loadedRoom?.id).toBe(ROOM_ID);
    expect(session.vm.haltInfo).toBeNull();
    expect(session.status().idleReason).toMatch(/warped to room 5/);
  });

  it('onFrame subscribers receive each presented frame; unsubscribe stops it', () => {
    const session = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
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
    // autoPauseOnIdle off: the yield-loop would otherwise settle and self-pause.
    const session = createSession(makeSyntheticGame(), renderer, clock, { autoPauseOnIdle: false });

    session.play();
    expect(clock.running).toBe(true);
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
    const sSlow = createSession(makeSyntheticGame(), new MemoryRenderer(), slowClock, { autoPauseOnIdle: false });
    const sFast = createSession(makeSyntheticGame(), new MemoryRenderer(), fastClock, { autoPauseOnIdle: false });

    sSlow.setRate(10); // 100 ms / tick
    sFast.setRate(60); // ~16.7 ms / tick
    sSlow.play();
    sFast.play();
    for (let i = 0; i < 60; i++) {
      slowClock.advance(1000 / 60);
      fastClock.advance(1000 / 60);
    }
    expect(sFast.status().tickCount).toBeGreaterThan(sSlow.status().tickCount);
  });

  it('auto-pauses once the engine settles into a stable idle fingerprint', () => {
    // The yield-loop is the canonical "waiting for input" steady state: same
    // slots yielded, no actors moving — the fingerprint stops changing and the
    // idle streak trips. (A real animated game never settles headlessly, so
    // this is the path the MI1 suite can't cover.)
    const clock = new ManualClock();
    const session = createSession(makeSyntheticGame(), new MemoryRenderer(), clock);
    session.play();
    for (let i = 0; i < 200 && session.status().playing; i++) clock.advance(1000 / 60);
    expect(session.status().playing).toBe(false);
    expect(session.status().idleReason).toMatch(/idle/);
    expect(clock.running).toBe(false);
  });

  it('pauses with "all slots dead" once every script has stopped', () => {
    const clock = new ManualClock();
    const session = createSession(makeSyntheticGame(BOOT_DIE), new MemoryRenderer(), clock);
    session.play();
    for (let i = 0; i < 60 && session.status().playing; i++) clock.advance(1000 / 60);
    expect(session.status().playing).toBe(false);
    expect(session.status().idleReason).toBe('all slots dead');
  });

  it('snapshot → restore through the session reproduces the room', () => {
    const s1 = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
    s1.enterRoom(ROOM_ID);
    const snap = s1.snapshot('t', 1000);
    const json = JSON.stringify(snap);

    const s2 = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
    s2.restore(JSON.parse(json));
    expect(s2.vm.currentRoom).toBe(ROOM_ID);
    expect(s2.vm.loadedRoom?.id).toBe(ROOM_ID);
    expect(s2.vm.haltInfo).toBeNull();
    // Re-serialises identically (same meta → byte-equal).
    expect(JSON.stringify(s2.snapshot('t', 1000))).toBe(json);
    // Restored while not playing → stays paused with a banner.
    expect(s2.status().playing).toBe(false);
    expect(s2.status().idleReason).toMatch(/loaded/);
  });

  it('reboot returns to a fresh boot (tick counter reset)', () => {
    const session = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
    for (let i = 0; i < 20; i++) session.step();
    expect(session.status().tickCount).toBe(20);
    session.reboot();
    expect(session.status().tickCount).toBe(0);
    expect(session.vm.haltInfo).toBeNull();
  });

  it('sendInput writes mouse vars and toggles button holds', () => {
    const session = createSession(makeSyntheticGame(), new MemoryRenderer(), new ManualClock());
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
    const session = createSession(makeSyntheticGame(), renderer, clock, { autoPauseOnIdle: false });
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
