/**
 * SCUMM v5 virtual machine — the dispatch loop.
 *
 * # Model
 *
 * - **Cooperative scheduling.** Scripts run until they call
 *   `breakHere` (or finish via `stopObjectCode`). The VM rotates
 *   through runnable slots one opcode at a time inside `step()`; a
 *   full "tick" of work is `runUntilAllYield()`.
 *
 * - **Halt is a first-class state.** Hitting an opcode we haven't
 *   implemented does not throw out to the caller — the dispatcher
 *   catches the `UnknownOpcodeError` (and any other VM-level error)
 *   and freezes the VM into a `HaltInfo` snapshot. The inspector UI
 *   reads `vm.haltInfo` and renders a halt panel; subsequent
 *   `step()` / `runUntilAllYield()` calls are no-ops until
 *   `vm.reset()`.
 *
 * - **Per-opcode trace ring.** Every dispatched opcode is appended to
 *   `vm.trace` (a circular buffer). The inspector renders the last
 *   N entries; halt also embeds the tail of the trace into
 *   `HaltInfo` for crash forensics.
 *
 * # What's deliberately not here
 *
 * - No tick clock, no real-time pacing — `delay` is a stub in the
 *   opcode set; correct timing lands with the main loop in Phase 6.
 * - No actor / object / palette state — the VM mutates variables
 *   and slots only. Effectful opcodes (loadRoom, walkActor, …) come
 *   when their subsystems exist.
 * - No save/restore — Phase 8.
 */

import { ActorTable, DEFAULT_ACTOR_COUNT } from '../actor/actor';
import { findVerbScript } from '../object/verbs';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { LoadedRoom } from '../room/loader';
import type { Sentence } from './sentence';
import { ScriptSlot } from './slot';
import { Variables } from './variables';
import * as VARS from './vars';

export class UnknownOpcodeError extends Error {
  constructor(public readonly opcode: number) {
    super(`Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}`);
    this.name = 'UnknownOpcodeError';
  }
}

/** One dispatched opcode in the trace ring. */
export interface TraceEntry {
  readonly slotIndex: number;
  readonly scriptId: number;
  /** PC of the opcode byte, before dispatch advanced past it. */
  readonly pc: number;
  readonly opcode: number;
  /** Optional human label, set by the handler. */
  readonly mnemonic?: string;
}

/** Frozen snapshot of the VM at halt time. */
export interface HaltInfo {
  readonly reason: string;
  readonly slotIndex: number;
  readonly scriptId: number;
  readonly pc: number;
  readonly opcode: number;
  /** Up to 16 bytes of bytecode context centred on the PC. */
  readonly bytecodeContext: Uint8Array;
  /** Offset of the failing opcode inside `bytecodeContext`. */
  readonly contextOpcodeOffset: number;
  /** Tail of the trace ring (oldest → newest). */
  readonly trace: ReadonlyArray<TraceEntry>;
}

export type OpcodeHandler = (vm: Vm, slot: ScriptSlot, opcode: number) => void;

/**
 * Snapshot of an in-progress print / printEgo opcode. The renderer
 * reads this every frame; the engine writes it when a string subop
 * runs.
 */
export interface ActiveDialog {
  /** Speaking actor id. 0 = system text (no actor anchor). */
  readonly actorId: number;
  /** Display text — control sequences (`0xFF NN ...`) already stripped. */
  readonly text: string;
  /** Absolute room x or `null` to anchor above the actor. */
  readonly x: number | null;
  readonly y: number | null;
  /** CLUT index for the ink. Defaults to white if no SO_COLOR subop. */
  readonly color: number;
  /** Centre text around `x` rather than left-anchor. */
  readonly center: boolean;
  /** Position above the speaking actor's head. */
  readonly overhead: boolean;
  /** Max x bound from SO_CLIPPED (informational; no wrap yet). */
  readonly clipped: number | null;
}

/**
 * One verb slot in the verb bar. Configured by the `verbOps` opcode
 * (0x7A / 0xFA) subops at boot / room-entry time. The rendering layer
 * paints each slot at `(x, y)` in screen coords with `name` through
 * `color`/`hiColor`/`dimColor` depending on `state` and hover.
 */
export interface VerbSlot {
  readonly id: number;
  /** Display name from `setName` (subop 0x02), printable ASCII; control sequences stripped. */
  name: string;
  /** CLUT index for the normal-state ink. */
  color: number;
  /** CLUT index for the hovered ink. */
  hiColor: number;
  /** CLUT index for the dimmed (unavailable) ink. */
  dimColor: number;
  /** CLUT index for the background fill (rarely set). */
  backColor: number;
  /** Position in screen pixels — script provides this directly. */
  x: number;
  y: number;
  /** Keyboard shortcut key code (0 = none). */
  key: number;
  /** Whether the rendered name is centred around `x` rather than left-aligned. */
  centered: boolean;
  /**
   * Lifecycle state — `on` participates in hit-test + paint; `dim`
   * paints with `dimColor` and rejects clicks; `off` is hidden but
   * preserved (re-add with `on`); `deleted` is fully removed by the
   * `delete` subop.
   */
  state: 'on' | 'off' | 'dim' | 'deleted';
}

export const NUM_SLOTS = 25;
const TRACE_CAPACITY = 64;
/** Global #4 = current-room id per the SCUMM v5 wiki. */
const VAR_ROOM_INDEX = 4;

/** Resolve a global script id to its loaded bytecode + owning room. */
export type GlobalScriptResolver = (
  scriptId: number,
) => { readonly bytecode: Uint8Array; readonly room: number };

/**
 * Decode a room id to a fully-loaded room (background bitmap, palette,
 * z-planes, ENCD/EXCD bytecode). Throws on unknown room ids — the
 * VM's `loadRoom` opcode handler catches that and clears the room.
 */
export type RoomResolver = (roomId: number) => LoadedRoom;

/**
 * Decode a costume id to its parsed header + payload. Throws on
 * unknown ids; the VM caches successful results so each costume is
 * only decoded once per session.
 */
export type CostumeResolver = (costumeId: number) => LoadedCostume;

export interface VmInit {
  readonly numVariables: number;
  readonly numBitVariables: number;
  readonly numRoomVariables?: number;
  readonly handlers: ReadonlyMap<number, OpcodeHandler>;
  /**
   * Resolver for the `startScript` family of opcodes. Optional in
   * tests that don't exercise script start; the real boot path wires
   * it via {@link bootGame}.
   */
  readonly resolveGlobalScript?: GlobalScriptResolver;
  /**
   * Resolver for `loadRoom` (0x72 / 0xF2). Optional in tests that
   * don't exercise room loading. When absent, the opcode handler
   * still updates `vm.currentRoom` + `VAR_ROOM` but leaves
   * `loadedRoom` as `null`.
   */
  readonly resolveRoom?: RoomResolver;
  /**
   * Resolver for actor costumes. Called lazily by
   * {@link Vm.getCostume}; loaded costumes are cached on the VM so
   * each id is only decoded once.
   */
  readonly resolveCostume?: CostumeResolver;
}

export class Vm {
  readonly vars: Variables;
  readonly slots: ReadonlyArray<ScriptSlot>;
  /**
   * Engine string resources, keyed by id. Created and mutated by the
   * `stringOps` (0x27) opcode family; consumed by text-output opcodes
   * once they land. Empty until a script writes.
   */
  readonly strings = new Map<number, Uint8Array>();
  /**
   * Per-object state byte (0..255). Scripts read with `getObjectState`
   * / `ifState` and write with `setState`. Object state determines
   * which OBIM image variant gets composited and which entry of an
   * object's verb-script bank runs on use.
   */
  readonly objectStates = new Map<number, number>();
  /**
   * Per-object owner — actor id that "has" the object (typically
   * because the player picked it up). 0 = nobody (still in the room).
   */
  readonly objectOwners = new Map<number, number>();
  /**
   * Object draw queue — set of object ids the compositor should
   * include in the next frame. Populated by the `drawObject` opcode
   * and cleared on room change. Order isn't significant for v5
   * (object stacking comes from per-object z-planes inside the OBIM
   * image, not from draw-queue order).
   */
  readonly objectDrawQueue = new Set<number>();
  /**
   * Currently-loaded room id (per the VM's view). Set by `loadRoom`
   * (0x72/0xF2) and related opcodes; consumed by the room-render path
   * once the compositor lands. Zero = no room yet.
   */
  currentRoom = 0;
  /**
   * Fully-decoded data for the current room — background bitmap,
   * palette, z-planes, ENCD/EXCD bytecode. `null` until the first
   * successful `loadRoom`, and any time the script loads the room-0
   * sentinel ("no room").
   */
  loadedRoom: LoadedRoom | null = null;
  /**
   * Last room-load error message (if any). Surfaced by the inspector
   * when a `loadRoom` opcode fires for a room the loader can't decode
   * (room id 0, missing block, etc.) — we don't halt for these.
   */
  lastRoomLoadError: string | null = null;
  /**
   * Actor table — fixed-size, indexed by id with slot 0 as sentinel.
   * Mutated by putActor / actorOps / animateActor / walk opcodes; read
   * by the frame compositor and the inspector.
   */
  readonly actors = new ActorTable(DEFAULT_ACTOR_COUNT);
  /**
   * Decoded costumes loaded on demand. Keyed by costume id. Populated
   * by {@link Vm.getCostume}; surfaces in the inspector / compositor.
   */
  readonly costumes = new Map<number, LoadedCostume>();
  /**
   * Current mouse position in **native room coordinates** (not CSS
   * pixels, not screen pixels — pre-2× scale and adjusted for any
   * camera x-scroll). Written by the shell's input layer on every
   * `pointermove`. Mirrored into VAR_MOUSE_X / VAR_MOUSE_Y so scripts
   * that poll the cursor see the same value. Starts at `(0, 0)` so
   * pre-boot reads are deterministic.
   */
  mouseRoomX = 0;
  mouseRoomY = 0;
  /**
   * Cursor / userput state, mutated by the `cursorCommand` opcode
   * (0x2C) subops. `visible` gates whether the cursor sprite paints;
   * `userput` gates whether the input layer accepts clicks (cutscenes
   * temporarily turn this off so the user can't click through). The
   * "soft" subops just toggle the same flags for the duration of a
   * cutscene — distinct call paths but same end state, until we have
   * a reason to model the soft / hard distinction separately.
   */
  readonly cursor = { visible: false, userput: false };
  /**
   * Charset id the engine currently uses for text rendering (verb bar,
   * dialog). Updated by cursorCommand initCharset (subop 0x0D). Zero =
   * "no charset selected yet" — the verb-bar renderer falls back to
   * charset 0 when unset.
   */
  currentCharset = 0;
  /**
   * Verb-slot table, keyed by verb id. Populated by the `verbOps`
   * opcode (0x7A / 0xFA) as scripts configure verbs at boot / room
   * entry. The verb-bar renderer iterates this map.
   */
  readonly verbs = new Map<number, VerbSlot>();
  /**
   * The verb the user most recently clicked on the verb bar, awaiting
   * an object. `null` means no verb is currently armed — a click on
   * an object becomes a walk command (or a "Look at" via right-click,
   * the v5 default). Set by the verb-bar input layer; read by the
   * sentence builder.
   */
  currentVerb: number | null = null;
  /**
   * Pending sentences awaiting the sentence-script driver. Treated as
   * a stack (LIFO) — `doSentence` pushes, {@link processSentence} pops
   * the most-recent one. See `sentence.ts`.
   */
  readonly sentenceStack: Sentence[] = [];
  /**
   * Currently-showing dialog / on-screen text. `null` outside a
   * `print` / `printEgo` opcode. The shell's overlay renderer reads
   * this each frame and paints the text via the Phase 4 CHAR
   * renderer through `vm.currentCharset`.
   *
   * Position semantics:
   *   - `x, y` absolute room coords from the `SO_AT` subop. `null`
   *     means "above the speaking actor's head" (the v5 default).
   *   - `center` mirrors the `SO_CENTER` subop — the renderer
   *     left-shifts text by half its measured width.
   *   - `clipped` is the max X bound for line wrapping (we don't yet
   *     wrap, but the field captures the value for diagnostics).
   *
   * Cleared by `endCutscene` (best-effort — the original engine
   * clears dialog at various points; we'll grow this as scripts
   * surface the patterns).
   */
  activeDialog: ActiveDialog | null = null;
  /**
   * Camera position. `x` is the X coordinate of the camera's CENTRE
   * in the room (SCUMM convention) — for a 320-wide viewport, the
   * visible slice of the room is `[x - 160, x + 160)`. Updated by
   * `setCameraAt` (snap), `panCameraTo` (smooth pan), and
   * `actorFollowCamera` once we wire that. Zero before the first
   * camera op runs.
   *
   * The shell uses this to convert SCREEN-space `print at(x, y)`
   * coords into ROOM-space when painting dialog text on the room
   * canvas — without this conversion text lands at the wrong place
   * for any wider-than-viewport room (e.g. MI1 credits at 640×200).
   */
  readonly camera = { x: 0 };
  /**
   * Active playable-screen vertical bounds, set by `roomOps setScreen`
   * (0x33 subop 0x03). The engine treats rows `[top, bottom)` of the
   * room as the camera viewport; rows below `bottom` are typically the
   * verb-bar area. MI1's boot sets `top=0, bottom=144` so the playable
   * viewport is the top 144 rows. Cutscenes may temporarily extend
   * `bottom` to 200 to fill the screen.
   *
   * Defaults of (0, 200) mean "full screen" until a script provides
   * a real value.
   */
  readonly screen = { top: 0, bottom: 200 };
  /**
   * Pending input state the runtime mirrors into engine VARs at the
   * start of each tick. The shell input layer mutates these on
   * pointerdown / pointerup; {@link Vm.beginTick} converts the queued
   * "press" pulses into a one-tick `VAR_LEFTBTN_DOWN` pulse and the
   * sticky hold flags into `VAR_LEFTBTN_HOLD` / `VAR_RIGHTBTN_HOLD`.
   *
   * Why a queue + sticky split: SCUMM scripts typically poll for
   * "button just went down this frame" (the one-shot) AND "button is
   * still held" (sticky). A single boolean conflates the two and
   * causes wait-loops to either miss the press (if cleared too early)
   * or fire forever (if never cleared).
   */
  readonly input = {
    leftPressQueued: false,
    rightPressQueued: false,
    leftHold: false,
    rightHold: false,
  };
  readonly resolveGlobalScript: GlobalScriptResolver | undefined;
  readonly resolveRoom: RoomResolver | undefined;
  readonly resolveCostume: CostumeResolver | undefined;
  private readonly handlers: ReadonlyMap<number, OpcodeHandler>;
  private readonly traceBuffer: (TraceEntry | undefined)[] = new Array(
    TRACE_CAPACITY,
  ).fill(undefined);
  private traceHead = 0;
  private traceCount = 0;

  private _haltInfo: HaltInfo | null = null;

  /** Slot whose opcode we labelled most recently — set by handlers via `annotate()`. */
  private lastAnnotation: string | undefined;

  /**
   * Engine-side var indices the VM acts on. All sourced from the
   * canonical table in `vars.ts` — see there for the full list and the
   * reconciliation notes (several earlier empirical names were wrong).
   * Re-exposed as statics so existing call sites keep working.
   *
   *   - `VAR_MUSIC_TIMER` (14) — auto-incremented per tick by
   *     {@link beginTick}. MI1's credits cutscene waits on it.
   *   - `VAR_CURSORSTATE` (52) — `beginTick` pulses the left-press bit
   *     here; MI1 boot script #23 polls it to enter the main menu.
   *   - `VAR_USERPUT` (53) — whether user input is currently enabled.
   *   - `VAR_SENTENCE_SCRIPT` (33) — *holds the id of* the sentence
   *     script (MI1 writes 2). Read by {@link processSentence}.
   */
  static readonly VAR_MUSIC_TIMER = VARS.VAR_MUSIC_TIMER;
  static readonly VAR_CURSORSTATE = VARS.VAR_CURSORSTATE;
  static readonly VAR_USERPUT = VARS.VAR_USERPUT;
  static readonly VAR_SENTENCE_SCRIPT = VARS.VAR_SENTENCE_SCRIPT;
  /**
   * Global holding the id of the *input script* (the verb/click hook).
   * MI1 writes 201 (a room-local LSCR). Started by {@link runInputScript}.
   */
  static readonly VAR_VERB_SCRIPT = VARS.VAR_VERB_SCRIPT;

  /** SCUMM v5 reserves script ids >= 200 for room-local LSCR scripts. */
  static readonly LSCR_THRESHOLD = 200;

  constructor(init: VmInit) {
    this.vars = new Variables({
      numVariables: init.numVariables,
      numBitVariables: init.numBitVariables,
      numRoomVariables: init.numRoomVariables,
    });
    this.slots = Array.from({ length: NUM_SLOTS }, (_, i) => new ScriptSlot(i));
    this.handlers = init.handlers;
    this.resolveGlobalScript = init.resolveGlobalScript;
    this.resolveRoom = init.resolveRoom;
    this.resolveCostume = init.resolveCostume;
  }

  /**
   * Transition to a new room. The full sequence (per SCUMM v5):
   *
   *   1. Run the previous room's EXCD as a fresh slot if present
   *      (e.g. stop the title music).
   *   2. Decode the new room — `vm.loadedRoom` becomes the new data
   *      or `null` if the resolver throws (room 0 sentinel, etc.).
   *      `vm.currentRoom` + VAR_ROOM are updated unconditionally so
   *      scripts that read VAR_ROOM see the script-level value even
   *      if the decode failed.
   *   3. Run the new room's ENCD as a fresh slot if present (e.g.
   *      set up actors, play room music).
   *
   * Both ENCD and EXCD slots get a human label ("ENCD-10", "EXCD-10")
   * so the inspector can tell them apart from the global scripts.
   *
   * What this does NOT yet do:
   * - Kill non-freeze-resistant slots from the old room. Phase 7
   *   (verb scripts) will need that distinction.
   */
  enterRoom(roomId: number): void {
    // New room = fresh draw queue. Objects whose state >= 1 stay in
    // their state, but the queue itself starts empty — the new room's
    // ENCD repopulates it for objects that should be visible.
    this.objectDrawQueue.clear();
    const prev = this.loadedRoom;
    if (prev?.exitScript && prev.exitScript.length > 0) {
      try {
        this.startScript({
          scriptId: 0,
          bytecode: prev.exitScript,
          room: prev.id,
          label: `EXCD-${prev.id}`,
        });
      } catch {
        // No free slot — silently skip. EXCD running is best-effort.
      }
    }

    this.currentRoom = roomId;
    this.vars.writeGlobal(VAR_ROOM_INDEX, roomId);
    if (this.resolveRoom) {
      try {
        this.loadedRoom = this.resolveRoom(roomId);
        this.lastRoomLoadError = null;
      } catch (err) {
        this.loadedRoom = null;
        this.lastRoomLoadError = err instanceof Error ? err.message : String(err);
      }
    } else {
      this.loadedRoom = null;
    }

    const next = this.loadedRoom;
    if (next?.entryScript && next.entryScript.length > 0) {
      try {
        this.startScript({
          scriptId: 0,
          bytecode: next.entryScript,
          room: next.id,
          label: `ENCD-${next.id}`,
        });
      } catch {
        // No free slot — silently skip.
      }
    }
  }

  /**
   * Resolve a costume id to its parsed data, using the cache. Returns
   * `null` for id 0 (sentinel), if no resolver was provided, or if
   * the resolver throws. Safe to call from the compositor for every
   * actor every frame — the cache makes it O(1) after first load.
   */
  getCostume(id: number): LoadedCostume | null {
    if (id <= 0) return null;
    const cached = this.costumes.get(id);
    if (cached) return cached;
    if (!this.resolveCostume) return null;
    try {
      const loaded = this.resolveCostume(id);
      this.costumes.set(id, loaded);
      return loaded;
    } catch {
      // Costume id present in DCOS but undecodable — return null so
      // the compositor skips this actor rather than halting.
      return null;
    }
  }

  get haltInfo(): HaltInfo | null {
    return this._haltInfo;
  }

  get isHalted(): boolean {
    return this._haltInfo !== null;
  }

  get trace(): ReadonlyArray<TraceEntry> {
    const out: TraceEntry[] = [];
    const start = (this.traceHead - this.traceCount + TRACE_CAPACITY) % TRACE_CAPACITY;
    for (let i = 0; i < this.traceCount; i++) {
      out.push(this.traceBuffer[(start + i) % TRACE_CAPACITY]!);
    }
    return out;
  }

  /** Find the lowest-index dead slot. Throws if all are in use. */
  startScript(opts: {
    scriptId: number;
    bytecode: Uint8Array;
    args?: ReadonlyArray<number>;
    room?: number;
    /** Optional label for synthetic scripts (ENCD/EXCD/verb/sentence). */
    label?: string;
  }): ScriptSlot {
    const slot = this.slots.find((s) => s.status === 'dead');
    if (!slot) {
      throw new Error('no free script slot available');
    }
    slot.start(opts);
    return slot;
  }

  /**
   * Run an object's verb script as a synthetic slot.
   *
   * Looks up `objId` in the current room, resolves the bytecode for
   * `verbId` (with the SCUMM 0xFF default-verb fallback), and starts a
   * slot labelled `VERB-{objId}-{verbId}`. The verb id, object id, and
   * any extra args land in the slot's locals (locals[0]=verb,
   * locals[1]=obj, locals[2..]=args) — the same convention the
   * sentence script uses, so verb scripts can read which verb invoked
   * them.
   *
   * Returns the started slot, or `null` when the object isn't loaded,
   * has no matching verb (and no default), or no slot is free. Never
   * throws — a missing verb is a normal "nothing happens" click.
   */
  startVerbScript(
    objId: number,
    verbId: number,
    args: ReadonlyArray<number> = [],
  ): ScriptSlot | null {
    const obj = this.loadedRoom?.objects.get(objId);
    if (!obj) return null;
    const bytecode = findVerbScript(obj.verbs, verbId);
    if (!bytecode) return null;
    const slot = this.slots.find((s) => s.status === 'dead');
    if (!slot) return null;
    slot.start({
      scriptId: objId,
      bytecode,
      args: [verbId, objId, ...args],
      room: this.loadedRoom?.id,
      label: `VERB-${objId}-${verbId}`,
    });
    return slot;
  }

  /**
   * Resolve a script id to its bytecode and start it in a free slot.
   * Routes ids >= {@link LSCR_THRESHOLD} to the current room's local
   * scripts and everything else to the global DSCR directory (via the
   * configured resolver). Shared by the `startScript` opcode and the
   * sentence/verb drivers. Throws if the script can't be resolved or
   * no slot is free.
   */
  startScriptById(
    scriptId: number,
    opts: { args?: ReadonlyArray<number>; label?: string } = {},
  ): ScriptSlot {
    let bytecode: Uint8Array;
    let room: number;
    if (scriptId >= Vm.LSCR_THRESHOLD) {
      const local = this.loadedRoom?.localScripts.get(scriptId);
      if (!local) {
        throw new Error(
          `startScriptById: local script #${scriptId} not present in current ` +
            `room ${this.currentRoom} (loaded=${this.loadedRoom?.id ?? 'none'})`,
        );
      }
      bytecode = local;
      room = this.loadedRoom!.id;
    } else {
      if (!this.resolveGlobalScript) {
        throw new Error('startScriptById: no global script resolver configured');
      }
      const resolved = this.resolveGlobalScript(scriptId);
      bytecode = resolved.bytecode;
      room = resolved.room;
    }
    return this.startScript({ scriptId, bytecode, room, args: opts.args, label: opts.label });
  }

  /**
   * Run the input script — the engine's per-click hook into game
   * bytecode. Starts `VAR_VERB_SCRIPT` (MI1 = room-local #201) with
   * locals `[clickArea, code, button]`.
   *
   * `local0 = clickArea` is bytecode-confirmed: MI1's #201 begins
   * `if (local0 == 4) g105 = 1` (see scratch/inspect-input-script.ts).
   * The input script is a *notification hook* — in MI1 it only sets a
   * flag. The engine's built-in verb handler is what actually builds
   * the sentence; this hook lets the game react to raw clicks.
   *
   * Returns the started slot, or `null` when the var is unset or no
   * slot is free. Never throws.
   */
  runInputScript(clickArea: number, code: number, button: number): ScriptSlot | null {
    const scriptId = this.vars.readGlobal(Vm.VAR_VERB_SCRIPT);
    if (scriptId <= 0) return null;
    try {
      return this.startScriptById(scriptId, {
        args: [clickArea, code, button],
        label: `INPUT-${clickArea}-${code}-${button}`,
      });
    } catch {
      // Script not resolvable (e.g. a local id with no current room) —
      // a click with no usable input script is a no-op, not a crash.
      return null;
    }
  }

  /** Push a sentence onto the queue for the sentence driver to run. */
  pushSentence(sentence: Sentence): void {
    this.sentenceStack.push(sentence);
  }

  /** Drop all pending sentences (the `doSentence` 0xFE / reset path). */
  clearSentence(): void {
    this.sentenceStack.length = 0;
  }

  /**
   * Sentence-script driver — call once per engine tick.
   *
   * If a sentence is queued and the sentence script (id from
   * `VAR_SENTENCE_SCRIPT`) isn't already running, pop the most-recent
   * sentence and start that script with `[verb, objectA, objectB]` as
   * its first three locals. Returns the started slot, or `null` when
   * there's nothing to run, the script is already active, or the var
   * is unset.
   *
   * Mirrors the original engine's once-per-frame sentence check.
   */
  processSentence(): ScriptSlot | null {
    if (this.sentenceStack.length === 0) return null;
    const scriptId = this.vars.readGlobal(Vm.VAR_SENTENCE_SCRIPT);
    if (scriptId <= 0) return null;
    // Don't re-enter while the previous sentence is still being run.
    if (this.slots.some((s) => s.status !== 'dead' && s.scriptId === scriptId)) {
      return null;
    }
    const s = this.sentenceStack.pop()!;
    return this.startScriptById(scriptId, {
      args: [s.verb, s.objectA, s.objectB],
      label: `SENTENCE-${s.verb}-${s.objectA}-${s.objectB}`,
    });
  }

  /**
   * Dispatch a single opcode in the next runnable slot. Returns the
   * slot that ran (or undefined if no slot was runnable / VM halted).
   */
  step(): ScriptSlot | undefined {
    if (this._haltInfo) return undefined;
    const slot = this.slots.find((s) => s.status === 'running');
    if (!slot) return undefined;

    if (slot.pc >= slot.bytecode.length) {
      this.haltFromOpcode(
        slot,
        0,
        `pc=${slot.pc} past end of bytecode (len=${slot.bytecode.length})`,
      );
      return slot;
    }

    const opcodePc = slot.pc;
    const opcode = slot.bytecode[opcodePc]!;
    slot.pc++;
    const handler = this.handlers.get(opcode);

    this.lastAnnotation = undefined;

    if (!handler) {
      this.haltFromOpcode(slot, opcode, new UnknownOpcodeError(opcode).message);
      this.appendTrace({
        slotIndex: slot.slotIndex,
        scriptId: slot.scriptId,
        pc: opcodePc,
        opcode,
        mnemonic: '(unknown)',
      });
      return slot;
    }

    try {
      handler(this, slot, opcode);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.haltFromOpcode(slot, opcode, reason, opcodePc);
      this.appendTrace({
        slotIndex: slot.slotIndex,
        scriptId: slot.scriptId,
        pc: opcodePc,
        opcode,
        mnemonic: this.lastAnnotation ?? '(error)',
      });
      return slot;
    }

    this.appendTrace({
      slotIndex: slot.slotIndex,
      scriptId: slot.scriptId,
      pc: opcodePc,
      opcode,
      ...(this.lastAnnotation !== undefined && { mnemonic: this.lastAnnotation }),
    });
    return slot;
  }

  /**
   * Mirror pending input + cursor state into the engine VARs scripts
   * poll. Called by the main-loop driver (the inspector) once at the
   * start of each tick — *before* `runUntilAllYield` — so any script
   * that runs this tick sees the freshest input state.
   *
   * Pulse semantics:
   *   - `VAR_CURSORSTATE` (52) carries the left-press bit: set to 1
   *     only on the single tick where a press has been queued since
   *     the last call, then cleared the following tick. Matches the
   *     SCUMM convention where scripts poll "did the user press *this*
   *     frame?" without having to clear after consuming. (Index 52 is
   *     the full cursor-state var; we currently treat it as a press
   *     pulse, which is enough for MI1 boot #23.)
   *   - `VAR_USERPUT` is sticky — reflects {@link cursor.userput} as
   *     the script understands it.
   */
  beginTick(): void {
    this.vars.writeGlobal(
      Vm.VAR_CURSORSTATE,
      this.input.leftPressQueued ? 1 : 0,
    );
    this.input.leftPressQueued = false;
    // Right-button-down index isn't known yet — wire when a script
    // surfaces the polling pattern.
    this.input.rightPressQueued = false;
    this.vars.writeGlobal(Vm.VAR_USERPUT, this.cursor.userput ? 1 : 0);
    // Tick the music timer. Scripts reset it to 0 then poll for a
    // target value to pace cutscenes — MI1's credits wait on it.
    // (Indices 15/16 are VAR_ACTOR_RANGE_MIN/MAX, NOT timers — the
    // old code wrongly auto-incremented them; see vars.ts.)
    this.vars.writeGlobal(
      Vm.VAR_MUSIC_TIMER,
      this.vars.readGlobal(Vm.VAR_MUSIC_TIMER) + 1,
    );
  }

  /**
   * Step until every slot is dead/yielded/frozen — i.e. until the
   * next `step()` would return undefined. Caps at `maxSteps` to
   * prevent runaway tight loops.
   */
  runUntilAllYield(maxSteps: number = 100_000): number {
    let count = 0;
    while (count < maxSteps && !this._haltInfo) {
      const ran = this.step();
      if (!ran) break;
      count++;
    }
    if (count === maxSteps && !this._haltInfo) {
      // Treat exceeding the step budget as a loud halt: usually means
      // a runaway loop with no breakHere. Snapshot the current slot
      // so the inspector can see where we got stuck.
      const slot = this.slots.find((s) => s.status === 'running');
      if (slot) {
        this.haltFromOpcode(
          slot,
          slot.bytecode[slot.pc] ?? 0,
          `runUntilAllYield exceeded ${maxSteps} steps without yielding (likely a tight loop)`,
        );
      }
    }
    return count;
  }

  /** Reset trace + halt + every slot back to dead. */
  reset(): void {
    for (const s of this.slots) s.kill();
    this.traceBuffer.fill(undefined);
    this.traceHead = 0;
    this.traceCount = 0;
    this._haltInfo = null;
    this.strings.clear();
    this.objectStates.clear();
    this.objectOwners.clear();
    this.objectDrawQueue.clear();
    this.currentRoom = 0;
    this.loadedRoom = null;
    this.lastRoomLoadError = null;
    this.actors.reset();
    this.costumes.clear();
    this.mouseRoomX = 0;
    this.mouseRoomY = 0;
    this.cursor.visible = false;
    this.cursor.userput = false;
    this.currentCharset = 0;
    this.verbs.clear();
    this.currentVerb = null;
    this.sentenceStack.length = 0;
    this.input.leftPressQueued = false;
    this.input.rightPressQueued = false;
    this.input.leftHold = false;
    this.input.rightHold = false;
    this.activeDialog = null;
    this.camera.x = 0;
    this.screen.top = 0;
    this.screen.bottom = 200;
  }

  /** Set the human label for the *next* trace entry (called from a handler). */
  annotate(mnemonic: string): void {
    this.lastAnnotation = mnemonic;
  }

  /**
   * Dispatch a single opcode on an existing slot WITHOUT advancing the
   * trace ring or running the normal halt-recovery — used by the
   * expression evaluator's "nested opcode" subop (0xAC subop 0x06),
   * which composes opcode results into stack-based expressions. The
   * called opcode is expected to write its result to global #0
   * (VAR_RESULT); the expression evaluator then pushes that onto its
   * stack.
   */
  dispatchInline(slot: ScriptSlot, opcode: number): void {
    const handler = this.handlers.get(opcode);
    if (!handler) {
      throw new UnknownOpcodeError(opcode);
    }
    handler(this, slot, opcode);
  }

  /** Manually halt the VM with a reason — exposed for handlers. */
  haltManual(slot: ScriptSlot, reason: string): void {
    const opcode = slot.bytecode[slot.pc] ?? 0;
    this.haltFromOpcode(slot, opcode, reason);
  }

  private haltFromOpcode(
    slot: ScriptSlot,
    opcode: number,
    reason: string,
    overridePc?: number,
  ): void {
    if (this._haltInfo) return;
    const pc = overridePc ?? Math.max(0, slot.pc - 1);
    const lo = Math.max(0, pc - 8);
    const hi = Math.min(slot.bytecode.length, pc + 8);
    const ctx = slot.bytecode.subarray(lo, hi);
    this._haltInfo = {
      reason,
      slotIndex: slot.slotIndex,
      scriptId: slot.scriptId,
      pc,
      opcode,
      bytecodeContext: new Uint8Array(ctx),
      contextOpcodeOffset: pc - lo,
      trace: this.trace.slice(-16),
    };
  }

  private appendTrace(entry: TraceEntry): void {
    this.traceBuffer[this.traceHead] = entry;
    this.traceHead = (this.traceHead + 1) % TRACE_CAPACITY;
    this.traceCount = Math.min(this.traceCount + 1, TRACE_CAPACITY);
  }
}
