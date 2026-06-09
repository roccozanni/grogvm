/**
 * EngineSession — the single object the shell holds to run a game
 * (ARCHITECTURE.md §5.9; see pages/docs/engine/session.md).
 *
 * Wires the VM + frame compositor + an injected Renderer + an injected Clock
 * into one control surface: play/pause/step/setRate, sendInput,
 * snapshot/restore, debug warp/skip, and an onFrame stream. The clock is
 * injected so the loop is deterministically testable (no requestAnimationFrame
 * in the engine).
 *
 * The loop semantics (throttle, batch, idle auto-pause, all-dead pause) are
 * ported from the legacy `shell/player/vm-inspector.ts` rAF loop. That
 * inspector is deliberately NOT rewired onto this session — it is slated for
 * deletion in a later Phase-10 task, so the logic lives here as the canonical
 * copy and is duplicated there only until then.
 */

import { bootGame } from '../vm/boot';
import type { Vm } from '../vm/vm';
import { snapshotVm, restoreVm, type SaveState } from '../vm/savestate';
import { composeFrame } from '../render/compositor';
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
/** Hard cap on the synchronous skip-cutscene loop. */
const MAX_SKIP_TICKS = 20000;
/** Hard cap on the synchronous enterRoom (warp) settle loop. */
const WARP_SETTLE_TICKS = 400;
/** Trace mnemonics per slot folded into the idle fingerprint. */
const MNEMONICS_PER_SLOT_IN_FINGERPRINT = 3;

/** All-black 256-colour palette for the brief no-room interval. */
const BLACK_PALETTE = new Uint8Array(768);

// Vertical screen-shake offsets (px) cycled per frame while `roomOps shakeOn`
// is active — a small oscillation around rest. APPROXIMATION: SCUMM's real
// shake table is engine-internal (not in the game bytecode), so the exact
// amplitude/timing is a placeholder to tune in-browser; only the on/off STATE
// is engine-faithful.
const SHAKE_OFFSETS = [0, 2, 4, 2, 0, -2, -4, -2] as const;

export function createSession(
  game: SessionGame,
  renderer: Renderer,
  clock: Clock,
  opts?: { bootParam?: number; tickRateHz?: number; autoPauseOnIdle?: boolean },
): EngineSession {
  // Auto-pause when the engine settles into an idle wait loop. The Debug
  // surface wants this (don't burn frames at a static screen); the Play
  // surface sets it false so the game runs continuously — there's no resume
  // button on the clean player, so a self-pause would soft-lock. All-dead and
  // halt pauses always apply regardless.
  const autoPauseOnIdle = opts?.autoPauseOnIdle ?? true;
  let vm: Vm = bootGame(
    game.resourceFile,
    game.index,
    game.loff,
    game.gameId,
    opts?.bootParam,
  ).vm;

  let tickCount = 0;
  let playing = false;
  let idleReason: string | null = null;
  let tickRateHz = opts?.tickRateHz ?? 60;

  // Loop timing (driven by the injected clock's nowMs, never performance.now).
  let lastTickAt = 0;
  let needsTimeSync = false;

  // Idle detection.
  let lastIdleFingerprint: string | null = null;
  let idleStreak = 0;

  // Frame production.
  let lastPalette: Uint8Array | null = null;
  let lastTransparentIndex: number | null = null;
  let lastW = -1;
  let lastH = -1;
  let roomScratch = new Uint8Array(320 * 200); // full-room compose buffer
  let viewScratch = new Uint8Array(320 * 200); // presented viewport slice
  let shakeScratch = new Uint8Array(320 * 200); // vertically-jittered frame when shaking
  let shakePhase = 0; // advances per presented frame while shakeEnabled

  const frameSubs = new Set<(f: FrameInfo) => void>();

  // ── tick + idle detection (ported from vm-inspector) ──────────────────

  const runTick = () => {
    const result = vm.tick();
    tickCount++;
    return result;
  };

  /** Snapshot of "live slots at yield + moving actors + anim cursors + recent
   *  trace mnemonics" — stable for N ticks ⇒ engine is in a wait-for-input
   *  loop. Timer-driven waits keep changing (the annotation value advances),
   *  so they don't trip it; pure input waits do. */
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
    // A running cutscene is intentional scripted progress, not idle — its
    // background scripts are frozen and the cutscene sits in a timer wait, so
    // the fingerprint stops changing. Without this guard we'd auto-pause a few
    // ticks into MI1's credits.
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
    // Camera-driven viewport: present a fixed-width window into the room,
    // scrolled by the camera. Off-camera columns are never drawn.
    const viewportW = Math.min(VIEWPORT_W, roomW);

    // Compose the full room (background + actors + objects, all in room space).
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
      // drawBox fills — applied over the bg; screen dims drive the null-room
      // (credits) case where there's no room to size from.
      drawnBoxes: vm.drawnBoxes,
      screenWidth: roomW,
      screenHeight: height,
    });

    // Extract the camera slice. When the viewport spans the whole room (the
    // common, non-scrolling case) we present the room buffer directly.
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

    // Screen shake (roomOps shakeOn): jolt the finished frame vertically by a
    // small per-frame offset. Gated on the flag, so normal frames are byte-for-
    // byte unchanged. Content shifts up/down with the vacated band cleared to
    // palette 0 (black). (Waveform is approximate — see SHAKE_OFFSETS.)
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

    if (viewportW !== lastW || height !== lastH) {
      renderer.resize(viewportW, height);
      lastW = viewportW;
      lastH = height;
    }

    if (room) {
      lastPalette = room.palette;
      lastTransparentIndex = room.transparentIndex;
      renderer.setPalette(room.palette);
      renderer.setTransparentIndex(room.transparentIndex);
    } else {
      // No room loaded: present a predictable black backdrop. The room
      // palette is cached separately (lastPalette) so the shell's overlays
      // keep their colours through the brief no-room interval (task 5).
      renderer.setPalette(BLACK_PALETTE);
      renderer.setTransparentIndex(null);
    }
    renderer.present(fb);

    const info: FrameInfo = {
      tickCount,
      framed,
      width: viewportW,
      height,
      roomId: room?.id ?? null,
      palette: room?.palette ?? lastPalette ?? BLACK_PALETTE,
      transparentIndex: room ? room.transparentIndex : lastTransparentIndex,
      framebuffer: Uint8Array.from(fb),
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
      // Non-frame jiffies are just time passing toward the next game frame —
      // always progress. All-dead / idle detection only applies on real
      // frames, where scripts + actors actually ran.
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
      // First callback after play(): set the time base and run a single tick,
      // so we don't fast-forward a huge batch on frame 1 (lastTickAt was stale).
      needsTimeSync = false;
      lastTickAt = now;
      runBatch(1);
      return;
    }
    const minIntervalMs = 1000 / tickRateHz;
    const elapsed = now - lastTickAt;
    if (elapsed < minIntervalMs - 0.5) return; // not time yet; wait for next clock tick
    lastTickAt = now;
    const batch = Math.min(
      MAX_TICKS_PER_FRAME,
      Math.max(1, Math.floor(elapsed / minIntervalMs)),
    );
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
    lastTransparentIndex = null;
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

    setRate(hz: number): void {
      tickRateHz = Math.max(1, Math.min(1000, hz));
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
      const fresh = bootGame(game.resourceFile, game.index, game.loff, game.gameId).vm;
      restoreVm(fresh, state);
      adopt(fresh);
      composeAndPresent(false);
      if (wasPlaying) {
        this.play();
      } else {
        idleReason = `loaded${state.label ? ` "${state.label}"` : ''} — room ${vm.currentRoom} (paused)`;
      }
    },

    reboot(): void {
      const wasPlaying = playing;
      if (playing) {
        playing = false;
        clock.stop();
      }
      adopt(bootGame(game.resourceFile, game.index, game.loff, game.gameId).vm);
      composeAndPresent(false);
      if (wasPlaying) this.play();
    },

    enterRoom(roomId: number): void {
      if (playing) {
        playing = false;
        clock.stop();
      }
      vm.enterRoom(roomId);
      idleStreak = 0;
      lastIdleFingerprint = null;
      for (let i = 0; i < WARP_SETTLE_TICKS; i++) {
        if (vm.haltInfo) break;
        runTick();
        if (checkIdle()) break;
      }
      idleReason = vm.haltInfo
        ? null
        : `warped to room ${roomId} (loaded=${vm.loadedRoom?.id ?? 'none'})`;
      composeAndPresent(true);
    },

    skipCutscene(): boolean {
      if (playing) {
        playing = false;
        clock.stop();
      }
      idleStreak = 0;
      lastIdleFingerprint = null;
      let reached = false;
      for (let i = 0; i < MAX_SKIP_TICKS; i++) {
        if (vm.haltInfo) break;
        runTick();
        const interactive = [...vm.verbs.values()].some((v) => v.state === 'on');
        if (checkIdle() && interactive) {
          reached = true;
          break;
        }
      }
      idleReason = reached
        ? 'skipped past cutscene — control returned to the verb bar'
        : vm.haltInfo
          ? null
          : `skip ran ${MAX_SKIP_TICKS} ticks without control returning`;
      composeAndPresent(true);
      return reached;
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
        tickRateHz,
      };
    },

    dispose(): void {
      playing = false;
      clock.stop();
      renderer.dispose();
      frameSubs.clear();
    },
  };

  return session;
}
