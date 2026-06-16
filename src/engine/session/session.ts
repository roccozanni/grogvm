/** EngineSession — the game loop and runtime control surface. See pages/docs/engine/session.md. */

import { bootGame } from '../vm/boot';
import type { AudioBackend } from '../sound/backend';
import type { Vm } from '../vm/vm';
import { snapshotVm, restoreVm, type SaveState } from '../vm/savestate';
import { composeFrame } from '../render/compositor';
import { composeScreen, SCREEN_HEIGHT } from '../render/screen';
import { VIEWPORT_W, viewportLeft } from '../graphics/viewport';
import type { Renderer } from '../render/renderer';
import {
  VAR_MOUSE_X,
  VAR_MOUSE_Y,
  VAR_VIRT_MOUSE_X,
  VAR_VIRT_MOUSE_Y,
} from '../vm/vars';
import type { Clock } from './clock';
import type {
  EngineSession,
  FrameInfo,
  InputEvent,
  SessionGame,
  SessionStatus,
} from './types';

/** Cap on ticks run in a single clock callback (rates above clock cadence). */
const MAX_TICKS_PER_FRAME = 64;
/** Consecutive identical yield fingerprints that count as "settled into idle". */
const IDLE_STREAK_THRESHOLD = 10;
/** Trace mnemonics per slot folded into the idle fingerprint. */
const MNEMONICS_PER_SLOT_IN_FINGERPRINT = 3;
/** Fixed tick cadence: 60 Hz = full rAF speed. The loop still batches and
 *  catches up after a stall (hidden tab); there's no user-facing rate knob. */
const TICK_RATE_HZ = 60;

/** All-black 256-colour palette for the brief no-room interval. */
const BLACK_PALETTE = new Uint8Array(768);

// Per-frame vertical shake offsets (px). APPROXIMATION: SCUMM's shake table is
// engine-internal (not in the game bytecode); only the on/off state is faithful.
const SHAKE_OFFSETS = [0, 2, 4, 2, 0, -2, -4, -2] as const;

// g107 holds the armed verb (set by verb-input script #4); 11 (Walk-to) is
// the resting default, treated as "nothing armed". An MI1 script convention,
// not engine state — revisit if another v5 game arms verbs elsewhere.
const G_ACTIVE_VERB = 107;
const VERB_WALK_TO = 11;

export function createSession(
  game: SessionGame,
  renderer: Renderer,
  clock: Clock,
  opts?: {
    bootParam?: number;
    autoPauseOnIdle?: boolean;
    /** Output backend, reused across restore/reboot VM swaps (it owns the AudioContext). */
    audio?: AudioBackend;
  },
): EngineSession {
  // Play sets this false (a self-pause would soft-lock the clean player); all-dead
  // and halt pauses always apply. See session.md §3.
  const autoPauseOnIdle = opts?.autoPauseOnIdle ?? true;
  const audio = opts?.audio;
  let vm: Vm = bootGame(
    game.resourceFile,
    game.index,
    game.loff,
    game.gameId,
    opts?.bootParam,
    undefined,
    game.cdTrackDurations,
    audio,
  ).vm;

  let tickCount = 0;
  let playing = false;
  let idleReason: string | null = null;

  // Loop timing (driven by the injected clock's nowMs, never performance.now).
  let lastTickAt = 0;
  let needsTimeSync = false;

  // Idle detection.
  let lastIdleFingerprint: string | null = null;
  let idleStreak = 0;

  // Frame production.
  let lastPalette: Uint8Array | null = null;
  let lastW = -1;
  let lastH = -1;
  let roomScratch = new Uint8Array(320 * 200); // full-room compose buffer
  let viewScratch = new Uint8Array(320 * 200); // camera-sliced room band
  let shakeScratch = new Uint8Array(320 * 200); // vertically-jittered band when shaking
  let screenScratch = new Uint8Array(320 * 200); // the full assembled screen
  let shakePhase = 0; // advances per presented frame while shakeEnabled

  const frameSubs = new Set<(f: FrameInfo) => void>();

  // ── tick + idle detection ─────────────────────────────────────────────

  const runTick = () => {
    const result = vm.tick();
    tickCount++;
    return result;
  };

  /** Stable for N ticks ⇒ wait-for-input loop. Timer-driven waits keep
   *  changing (the annotation value advances), so they don't trip it. */
  const yieldFingerprint = (): string => {
    const parts: string[] = [];
    const tailBySlot = new Map<number, string[]>();
    for (let i = vm.trace.length - 1; i >= 0; i--) {
      const t = vm.trace[i]!;
      let arr = tailBySlot.get(t.slotIndex);
      if (!arr) {
        arr = [];
        tailBySlot.set(t.slotIndex, arr);
      }
      if (arr.length < MNEMONICS_PER_SLOT_IN_FINGERPRINT) {
        arr.push(t.mnemonic ?? `op=0x${t.opcode.toString(16)}`);
      }
    }
    for (const s of vm.slots) {
      if (s.status === 'dead') continue;
      const tail = tailBySlot.get(s.slotIndex) ?? [];
      parts.push(`s${s.slotIndex}:${s.status}:${s.scriptId}@${s.pc}|${tail.join('//')}`);
    }
    for (const a of vm.actors.all()) {
      if (a.isMoving) parts.push(`a${a.id}@${a.x},${a.y}`);
      let cursorSum = 0;
      let anyActive = false;
      for (const limb of a.anim.limbs) {
        if (limb.active && !limb.finished) {
          cursorSum += limb.cursor;
          anyActive = true;
        }
      }
      if (anyActive) parts.push(`anim${a.id}=${cursorSum}`);
    }
    return parts.sort().join('|');
  };

  const checkIdle = (): boolean => {
    // A running cutscene freezes background scripts, so the fingerprint stops
    // changing — without this guard we'd auto-pause mid-cutscene.
    if (vm.cutsceneStack.length > 0) {
      idleStreak = 0;
      lastIdleFingerprint = null;
      return false;
    }
    const fp = yieldFingerprint();
    if (fp === lastIdleFingerprint) {
      idleStreak++;
    } else {
      lastIdleFingerprint = fp;
      idleStreak = 1;
    }
    return idleStreak >= IDLE_STREAK_THRESHOLD;
  };

  const idleMessage = (): string => {
    const liveSlots = vm.slots
      .filter((s) => s.status !== 'dead')
      .map((s) => `#${s.scriptId}`)
      .join(', ');
    return `engine in idle wait loop — only ${liveSlots} live, no observable progress for ${IDLE_STREAK_THRESHOLD} ticks`;
  };

  // ── frame production ──────────────────────────────────────────────────

  const composeAndPresent = (framed: boolean): FrameInfo => {
    const room = vm.loadedRoom;
    const roomW = room?.width ?? 320;
    const height = room?.height ?? 144;
    const viewportW = Math.min(VIEWPORT_W, roomW);

    const roomNeed = roomW * height;
    if (roomScratch.length < roomNeed) roomScratch = new Uint8Array(roomNeed);
    const roomBuf = roomScratch.subarray(0, roomNeed);
    const compose = composeFrame({
      room,
      framebuffer: roomBuf,
      actors: room ? vm.actors.inRoom(vm.currentRoom) : [],
      getCostume: (id) => vm.getCostume(id),
      objectDrawQueue: vm.objectDrawQueue,
      getObjectState: (id) => vm.objectStates.get(id) ?? 1,
      getObjectPosition: (id) => vm.objectDrawPositions.get(id),
      // NeverClip class (20, bit 19) → actor always in front of z-planes.
      isNeverClip: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 19)) !== 0,
      // Screen dims size the null-room (credits) drawBox case.
      drawnBoxes: vm.drawnBoxes,
      screenWidth: roomW,
      screenHeight: height,
    });

    // Camera slice; when the viewport spans the whole room, present the room buffer directly.
    const cameraLeft = room ? viewportLeft(vm.camera.x, roomW, viewportW) : 0;
    let fb: Uint8Array;
    if (viewportW === roomW) {
      fb = roomBuf;
    } else {
      const viewNeed = viewportW * height;
      if (viewScratch.length < viewNeed) viewScratch = new Uint8Array(viewNeed);
      fb = viewScratch.subarray(0, viewNeed);
      for (let y = 0; y < height; y++) {
        const src = y * roomW + cameraLeft;
        fb.set(roomBuf.subarray(src, src + viewportW), y * viewportW);
      }
    }

    // Screen shake (roomOps shakeOn): gated on the flag, so normal frames are
    // byte-for-byte unchanged. Vacated band cleared to palette 0.
    if (vm.shakeEnabled) {
      const off = SHAKE_OFFSETS[shakePhase % SHAKE_OFFSETS.length]!;
      shakePhase++;
      if (off !== 0) {
        const need = viewportW * height;
        if (shakeScratch.length < need) shakeScratch = new Uint8Array(need);
        const sh = shakeScratch.subarray(0, need);
        if (off > 0) {
          // shift content DOWN by `off` rows; top `off` rows black.
          sh.fill(0, 0, off * viewportW);
          sh.set(fb.subarray(0, (height - off) * viewportW), off * viewportW);
        } else {
          // shift content UP by `-off` rows; bottom rows black.
          const a = -off;
          sh.set(fb.subarray(a * viewportW, height * viewportW), 0);
          sh.fill(0, (height - a) * viewportW, need);
        }
        fb = sh;
      }
    } else {
      shakePhase = 0;
    }

    // Assemble the COMPLETE screen: room band + verb panel + dialog. What the
    // renderer presents is the whole visible game — no layer paints after it.
    const screenW = Math.max(viewportW, VIEWPORT_W);
    const screenH = Math.max(height, SCREEN_HEIGHT);
    const screenNeed = screenW * screenH;
    if (screenScratch.length < screenNeed) screenScratch = new Uint8Array(screenNeed);
    const screenFb = screenScratch.subarray(0, screenNeed);
    const armed = vm.vars.readGlobal(G_ACTIVE_VERB);
    composeScreen({
      roomBand: fb,
      viewportWidth: viewportW,
      roomHeight: height,
      framebuffer: screenFb,
      screenWidth: screenW,
      screenHeight: screenH,
      cameraLeft,
      verbs: [...vm.verbs.values()],
      isVerbArchived: (id) => vm.savedVerbStates.has(id),
      currentCharsetId: vm.currentCharset,
      getCharset: (id) => vm.getCharset(id),
      getRoom: (id) => vm.getRoom(id),
      activeDialog: vm.activeDialog,
      systemTexts: vm.systemTexts,
      getActor: (id) => (id >= 1 && id <= vm.actors.capacity ? vm.actors.get(id) : null),
      screenTop: vm.screen.top,
      charsetColorMap: vm.charsetColorMap,
      armedVerbId: armed > 0 && armed !== VERB_WALK_TO ? armed : null,
      // Script-screen coords — the shell's input layer maintains these VARs.
      mouse: { x: vm.vars.readGlobal(VAR_MOUSE_X), y: vm.vars.readGlobal(VAR_MOUSE_Y) },
      getObjectState: (id) => vm.objectStates.get(id),
    });

    if (screenW !== lastW || screenH !== lastH) {
      renderer.resize(screenW, screenH);
      lastW = screenW;
      lastH = screenH;
    }

    if (room) lastPalette = room.palette;
    // No-room frames keep the last room's palette so verb/dialog text stays
    // visible over the black band (BLACK_PALETTE would render it invisible).
    const palette = room?.palette ?? lastPalette ?? BLACK_PALETTE;
    renderer.setPalette(palette);
    // The assembled frame is the complete screen — every pixel is opaque.
    renderer.setTransparentIndex(null);
    renderer.present(screenFb);

    const info: FrameInfo = {
      tickCount,
      framed,
      width: screenW,
      height: screenH,
      viewportWidth: viewportW,
      roomHeight: height,
      roomId: room?.id ?? null,
      palette,
      framebuffer: Uint8Array.from(screenFb),
      compose,
      halted: vm.haltInfo !== null,
    };
    for (const cb of [...frameSubs]) cb(info);
    return info;
  };

  // ── loop ──────────────────────────────────────────────────────────────

  const pauseInternal = (reason: string | null): void => {
    playing = false;
    idleReason = reason;
    clock.stop();
  };

  /** Run up to `batch` ticks, then present once. Bails (after presenting) on
   *  halt, all-slots-dead, or settling into an idle wait loop. */
  const runBatch = (batch: number): void => {
    let anyFramed = false;
    for (let i = 0; i < batch; i++) {
      const r = runTick();
      if (vm.haltInfo) {
        pauseInternal(null);
        composeAndPresent(anyFramed);
        return;
      }
      // All-dead / idle detection only applies on real frames; non-frame
      // jiffies are just time passing.
      if (!r.framed) continue;
      anyFramed = true;
      const anyMoving = [...vm.actors.all()].some((a) => a.isMoving);
      const progressed = r.resumed || r.ran > 0 || anyMoving || r.delaying;
      if (!progressed) {
        pauseInternal('all slots dead');
        composeAndPresent(true);
        return;
      }
      if (autoPauseOnIdle && checkIdle()) {
        pauseInternal(idleMessage());
        composeAndPresent(true);
        return;
      }
    }
    composeAndPresent(anyFramed);
  };

  const onClockTick = (now: number): void => {
    if (!playing || vm.haltInfo) return;
    if (needsTimeSync) {
      // First callback after play(): reset the time base so a stale lastTickAt
      // doesn't fast-forward a huge batch on frame 1.
      needsTimeSync = false;
      lastTickAt = now;
      runBatch(1);
      return;
    }
    const minIntervalMs = 1000 / TICK_RATE_HZ;
    const elapsed = now - lastTickAt;
    if (elapsed < minIntervalMs - 0.5) return; // not time yet; wait for next clock tick
    const batch = Math.min(
      MAX_TICKS_PER_FRAME,
      Math.max(1, Math.floor(elapsed / minIntervalMs)),
    );
    // Carry the sub-interval remainder into the next time base — discarding
    // it (lastTickAt = now) leaked every callback's fractional leftover, so
    // VM time ran 1-3% slow against wall time and real-time audio drifted
    // audibly. Cap the carry at one interval: a long stall (hidden tab) is
    // dropped, not replayed as a fast-forward backlog.
    const remainder = elapsed - batch * minIntervalMs;
    lastTickAt = now - Math.min(remainder, minIntervalMs);
    runBatch(batch);
  };

  // ── lifecycle ───────────────────────────────────────────────────────

  /** Adopt a freshly-booted/restored VM: swap the reference and zero all
   *  per-VM tracking. Forces a renderer resize on the next present. */
  const adopt = (next: Vm): void => {
    vm = next;
    tickCount = 0;
    lastIdleFingerprint = null;
    idleStreak = 0;
    idleReason = null;
    lastPalette = null;
    lastW = -1;
    lastH = -1;
  };

  // ── input ─────────────────────────────────────────────────────────────

  const writeMouse = (roomX: number, roomY: number): void => {
    vm.mouseRoomX = roomX;
    vm.mouseRoomY = roomY;
    vm.vars.writeGlobal(VAR_MOUSE_X, roomX);
    vm.vars.writeGlobal(VAR_MOUSE_Y, roomY);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_X, roomX);
    vm.vars.writeGlobal(VAR_VIRT_MOUSE_Y, roomY);
  };

  // ── public surface ──────────────────────────────────────────────────

  const session: EngineSession = {
    get vm(): Vm {
      return vm;
    },

    play(): void {
      if (playing || vm.haltInfo) return;
      playing = true;
      idleReason = null;
      lastIdleFingerprint = null;
      idleStreak = 0;
      needsTimeSync = true;
      clock.start(onClockTick);
    },

    pause(): void {
      if (!playing) return;
      playing = false;
      clock.stop();
    },

    step(): FrameInfo {
      let framed = false;
      if (!vm.haltInfo) framed = runTick().framed;
      return composeAndPresent(framed);
    },

    present(): FrameInfo {
      return composeAndPresent(false);
    },

    sendInput(ev: InputEvent): void {
      switch (ev.type) {
        case 'move':
          writeMouse(ev.roomX, ev.roomY);
          break;
        case 'down':
          writeMouse(ev.roomX, ev.roomY);
          if (ev.button === 'left') vm.input.leftHold = true;
          else vm.input.rightHold = true;
          break;
        case 'up':
          if (ev.button === 'left') vm.input.leftHold = false;
          else vm.input.rightHold = false;
          break;
        case 'key':
          if (ev.key === 'Escape') vm.abortCutscene();
          else if (ev.key === '.') vm.skipText();
          break;
      }
    },

    snapshot(label?: string, savedAt?: number): SaveState {
      return snapshotVm(vm, {
        game: game.gameId,
        label,
        savedAt: savedAt ?? Date.now(),
      });
    },

    restore(state: SaveState): void {
      const wasPlaying = playing;
      if (playing) {
        playing = false;
        clock.stop();
      }
      const fresh = bootGame(
        game.resourceFile, game.index, game.loff, game.gameId, undefined, undefined, game.cdTrackDurations, audio,
      ).vm;
      restoreVm(fresh, state);
      adopt(fresh);
      composeAndPresent(false);
      if (wasPlaying) {
        this.play();
      } else {
        idleReason = `loaded${state.label ? ` "${state.label}"` : ''} — room ${vm.currentRoom} (paused)`;
      }
    },

    onFrame(cb: (frame: FrameInfo) => void): () => void {
      frameSubs.add(cb);
      return () => {
        frameSubs.delete(cb);
      };
    },

    status(): SessionStatus {
      return {
        playing,
        tickCount,
        idleReason,
        halted: vm.haltInfo !== null,
        tickRateHz: TICK_RATE_HZ,
      };
    },

    dispose(): void {
      playing = false;
      clock.stop();
      vm.audio.dispose();
      renderer.dispose();
      frameSubs.clear();
    },
  };

  return session;
}
