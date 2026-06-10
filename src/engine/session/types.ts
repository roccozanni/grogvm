import type { Vm } from '../vm/vm';
import type { GameId } from '../vm/boot';
import type { SaveState } from '../vm/savestate';
import type { ComposeFrameResult } from '../render/compositor';
import type { ResourceFile } from '../resources/tree';
import type { IndexFile } from '../resources/index-file';
import type { RoomOffsetTable } from '../resources/loff';

/** Everything `bootGame` needs to start (and re-start) a game, bundled. */
export interface SessionGame {
  readonly resourceFile: ResourceFile;
  readonly index: IndexFile;
  readonly loff: RoomOffsetTable;
  readonly gameId: GameId;
  /**
   * CD-track durations (jiffies) by track number, read at load time —
   * pages/docs/engine/audio.md §3. Absent ⇒ CD-gated waits fall through.
   */
  readonly cdTrackDurations?: ReadonlyMap<number, number>;
}

/**
 * Engine-level input only (cursor, button holds, Escape / `.` keys). Verb and
 * sentence click dispatch is deliberately NOT here — that's the Play surface's job.
 */
export type InputEvent =
  | { readonly type: 'move'; readonly roomX: number; readonly roomY: number }
  | {
      readonly type: 'down';
      readonly button: 'left' | 'right';
      readonly roomX: number;
      readonly roomY: number;
    }
  | { readonly type: 'up'; readonly button: 'left' | 'right' }
  | { readonly type: 'key'; readonly key: string };

/** Emitted to {@link EngineSession.onFrame} subscribers after each present. */
export interface FrameInfo {
  /** Cumulative jiffies ticked since the current VM was booted/restored. */
  readonly tickCount: number;
  /** True if a game frame actually ran this present (not just a timing jiffy). */
  readonly framed: boolean;
  /** Full assembled SCREEN dimensions (room band + verb panel), as presented. */
  readonly width: number;
  readonly height: number;
  /** Camera-window (room slice) width — ≤ {@link width}. */
  readonly viewportWidth: number;
  /** Screen row where the verb band starts; a 200-tall room leaves no band. */
  readonly roomHeight: number;
  /** `loadedRoom.id`, or `null` during the brief no-room interval. */
  readonly roomId: number | null;
  /** 768-byte RGB palette: the room's, else the last-seen / default. */
  readonly palette: Uint8Array;
  /** A COPY of the indexed framebuffer that was presented (width*height). */
  readonly framebuffer: Uint8Array;
  /** Compositor diagnostics (actors/objects drawn + per-limb skip reasons). */
  readonly compose: ComposeFrameResult;
  /** True if the VM has halted on an unhandled opcode. */
  readonly halted: boolean;
}

export interface SessionStatus {
  readonly playing: boolean;
  readonly tickCount: number;
  /** Set when the loop auto-paused (idle wait loop / all slots dead / loaded a save). */
  readonly idleReason: string | null;
  readonly halted: boolean;
  readonly tickRateHz: number;
}

/**
 * The single object the shell holds to run a game (pages/docs/engine/session.md).
 * Wires VM + compositor + renderer + loop; the clock is injected.
 */
export interface EngineSession {
  /** Swapped by {@link restore} / {@link reboot} — never cache it; read through the getter. */
  readonly vm: Vm;

  // ── clock control (arms/disarms the injected clock; never calls rAF) ──
  play(): void;
  pause(): void;
  /** Advance exactly one jiffy, compose, present, emit. Ignores throttle. */
  step(): FrameInfo;
  /**
   * Compose + present the current VM state WITHOUT ticking. For paused-state
   * refreshes (e.g. the hover highlight under a moving pointer); while
   * playing, the next frame picks up the same state anyway.
   */
  present(): FrameInfo;
  setRate(hz: number): void;

  sendInput(ev: InputEvent): void;

  // ── persistence ──
  snapshot(label?: string, savedAt?: number): SaveState;
  /** Boot a fresh VM for the same game and restore into it. Preserves play/pause. */
  restore(state: SaveState): void;
  /** Fresh boot of the same game (discards current state). */
  reboot(): void;

  // ── debug drivers ──
  /** Warp into a room via the faithful enterRoom path, then settle its entry script. */
  enterRoom(roomId: number): void;
  /** Run synchronously until control returns to the player. True if reached. */
  skipCutscene(): boolean;

  /** Subscribe to frame emissions. Returns an unsubscribe function. */
  onFrame(cb: (frame: FrameInfo) => void): () => void;
  status(): SessionStatus;
  dispose(): void;
}
