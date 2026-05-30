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
import { startWalk, stepAllActorWalks } from '../actor/walk';
import { stepAnim } from '../graphics/costume-anim';
import { findVerbScript } from '../object/verbs';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { CharsetHeader } from '../graphics/charset';
import type { LoadedRoom } from '../room/loader';
import type { Sentence } from './sentence';
import { ScriptSlot } from './slot';
import { Variables } from './variables';
import * as VARS from './vars';

/**
 * Jiffies per game frame when `VAR_TIMER_NEXT` is unset / out of range.
 * MI1 runs the intro with `VAR_TIMER_NEXT = 6` (≈ 10 fps).
 */
const DEFAULT_FRAME_INTERVAL = 6;

/** What {@link Vm.tick} did this jiffy. */
export interface TickResult {
  /** True if a game frame ran this jiffy (scripts + actors + anim advanced). */
  readonly framed: boolean;
  /** True if any slot was resumed this frame. */
  readonly resumed: boolean;
  /** Opcodes dispatched this frame. */
  readonly ran: number;
  /** True if a slot's `delay` countdown ticked this jiffy. */
  readonly delaying: boolean;
}

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
  /**
   * Charset id the verb's text renders with — captured from the active
   * charset (`cursorCommand initCharset`) when the verb is created /
   * (re)named, mirroring SCUMM's per-verb `charset_nr`. MI1 sets charset
   * 6 (a tall serif font) before defining the verb panel, then switches
   * to charset 2 for dialogue; without capturing this the verbs would
   * wrongly redraw in whatever charset the dialogue last selected.
   */
  charset: number;
  /** Whether the rendered name is centred around `x` rather than left-aligned. */
  centered: boolean;
  /**
   * Image-backed verb: the object (and the room it lives in) whose
   * sprite is drawn in this slot *instead of* a text name. Set by
   * `verbOps` `setImage` (0x01, current room) / `setImageInRoom` (0x16,
   * explicit room). MI1's inventory slots are image verbs — script #9
   * assigns the slot-frame objects (1031 filled / 1032 empty) + the
   * arrow (1033) from the UI room (99). `null` for ordinary text verbs;
   * `setName` clears it back to text.
   */
  image: { obj: number; room: number } | null;
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

/**
 * Floor for the talk timer (ticks) so even a 1-char line lingers long
 * enough to read. ~0.5s at 60 Hz. See {@link Vm.beginTalk}.
 */
const MIN_TALK_TICKS = 30;
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

/**
 * Resolve a SCUMM charset id (the value scripts pass to `initCharset`)
 * to its parsed header + payload, or `null` when unresolvable / built-in.
 * The shell's text renderer uses this so dialog renders with the charset
 * the game actually selected. See `resolveCharsetById`.
 */
export type CharsetResolver = (
  charsetId: number,
) => { header: CharsetHeader; payload: Uint8Array } | null;

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
  /**
   * Resolver for charsets by SCUMM id. The VM doesn't render, but holds
   * this so the shell's text renderer can map `vm.currentCharset` to the
   * right font via the index (not file-walk order). See {@link CharsetResolver}.
   */
  readonly resolveCharset?: CharsetResolver;
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
   * Object names captured at pickup time, keyed by object id. SCUMM
   * resolves an object's name from its OBNA, which only lives in the
   * room that object belongs to — so once an item is carried out of
   * its pickup room, the current room's object table no longer knows
   * its name. We snapshot the name when ownership is taken so the
   * sentence line / inventory can label a carried item that originated
   * elsewhere. Consulted by {@link objectName} as a fallback behind the
   * current room.
   */
  readonly inventoryNames = new Map<number, string>();
  /**
   * Per-object class bitmask, mutated by `actorSetClass` (0x5D) and
   * tested by `ifClassOfIs` (0x1D). Class N occupies bit `N-1` (classes
   * are 1-based in v5). Default 0 (no classes). v5 named classes
   * include 20 NeverClip, 21 AlwaysClip, 22 IgnoreBoxes, 30 XFlip,
   * 31 Player, 32 Untouchable.
   */
  readonly objectClasses = new Map<number, number>();
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
   * Jiffies elapsed toward the next game frame. SCUMM splits the 60 Hz
   * jiffy clock (which paces `delay` / timers) from the game frame
   * (scripts + actors + anim), which advances once every
   * `VAR_TIMER_NEXT` jiffies. {@link tick} accumulates here and runs a
   * frame when it reaches the interval. See {@link tick}.
   */
  private frameAccumulator = 0;
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
   * Pseudo-room alias table, built by `pseudoRoom` (0xCC): maps an
   * aliased room number → the real room id whose resources back it.
   * SCUMM's `_resourceMapper` — used so several logical "rooms" (in
   * MI1, music-track selectors) share one physical room's resources.
   * {@link enterRoom} translates the requested id through this map
   * before resolving room data; an unmapped id resolves to itself.
   */
  readonly pseudoRooms = new Map<number, number>();
  /**
   * Pending host-level request from `systemOps` (0x98): a script asked
   * to restart, pause, or quit. We record it instead of acting so a
   * script-triggered shutdown can't kill the inspector mid-debug; the
   * shell decides what (if anything) to do. `null` until a script asks.
   */
  systemRequest: 'restart' | 'pause' | 'quit' | null = null;
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
   * (0x2C) subops and mirrored into `VAR_CURSORSTATE` (g52) /
   * `VAR_USERPUT` (g53). Both are **counters**, matching the original
   * (`SO_CURSOR_SOFT_ON/OFF` do `state++/--`, hard on/off set 1/0): a
   * cutscene's soft-off can nest, and a soft-on only re-shows the cursor
   * if it was on before. `state > 0` = cursor live (gates the sprite and
   * MI1's #23 hover poller); `userput > 0` = input accepted (cutscenes
   * drop it so clicks don't pass through).
   */
  readonly cursor = { state: 0, userput: 0 };
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
   * Verb states stashed by `saveRestoreVerbs` save (mode 1), keyed by
   * verb id → the `state` it had before being hidden. The cutscene
   * start script (#18) saves the verb ranges so the bar disappears for
   * the cutscene; the end script (#19) restores them. Cleared on
   * {@link reset}.
   */
  readonly savedVerbStates = new Map<number, VerbSlot['state']>();
  /**
   * Pending sentences awaiting the sentence-script driver. Treated as
   * a stack (LIFO) — `doSentence` pushes, {@link processSentence} pops
   * the most-recent one. See `sentence.ts`.
   */
  readonly sentenceStack: Sentence[] = [];
  /**
   * Active cutscene frames (`cutscene` pushes, `endCutscene` pops).
   * Each records the room at begin-time and the slot that opened it, so
   * the override (Escape-skip) path and any restore can find them.
   * Nesting is allowed (depth = stack length).
   */
  readonly cutsceneStack: Array<{
    readonly room: number;
    readonly callerSlot: number;
    readonly args: ReadonlyArray<number>;
  }> = [];
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
   * On-screen *system* text — strings from `print`s with no real speaker
   * (reserved actor ids like 252–255: signs, narrator, the credit roll).
   * Held SEPARATELY from {@link activeDialog} (actor speech) because the
   * two channels coexist and must not mask each other (a sign stays up
   * while Guybrush talks).
   *
   * SCUMM "blasts" system text onto the screen, where it *accumulates*:
   * successive prints at DIFFERENT positions stack (the "Le tre prove"
   * part-title is two prints — "Parte Uno" @y165 + "Le Tre Prove" @y180
   * — both visible at once), while a print at an already-occupied
   * position replaces it (the credit roll re-prints at the same spot).
   * Blast text is erased when the screen is redrawn — i.e. on a room
   * change ({@link enterRoom}) — and never by the talk timer; it also
   * clears on an empty system print or {@link reset}. Mutate via
   * {@link addSystemText} / {@link clearSystemText}, not directly.
   */
  systemTexts: ActiveDialog[] = [];

  /** Back-compat single-slot view: the most-recently-blasted line. */
  get systemText(): ActiveDialog | null {
    return this.systemTexts[this.systemTexts.length - 1] ?? null;
  }
  /** Setting replaces every blasted line (null clears all). */
  set systemText(d: ActiveDialog | null) {
    this.systemTexts = d ? [d] : [];
  }

  /**
   * Blast one system line. Replaces any existing line at the same screen
   * anchor (so the credit roll, which re-prints at one spot, doesn't
   * stack), otherwise appends (so distinct positions coexist).
   */
  addSystemText(dlg: ActiveDialog): void {
    const key = `${dlg.x},${dlg.y}`;
    const at = this.systemTexts.findIndex((d) => `${d.x},${d.y}` === key);
    if (at >= 0) this.systemTexts[at] = dlg;
    else this.systemTexts.push(dlg);
  }

  /** Erase all blasted system text (room change / empty print / reset). */
  clearSystemText(): void {
    this.systemTexts = [];
  }
  /**
   * Remaining sentence pages of the current message (the text after each
   * `\xff\x03` "wait" code), advanced by the talk timer in
   * {@link beginTick}: when a page's `talkDelay` drains, the next page
   * replaces it on the same channel and re-arms the timer, so a
   * multi-sentence line ("Yikes!\xff\x03Non dovresti…") shows one
   * sentence at a time instead of all at once. Empty for single-page
   * lines — the common case — so paging is a no-op there.
   */
  private talkPages: string[] = [];
  /** The dialog template (style/channel) the queued pages reuse. */
  private talkPageDlg: ActiveDialog | null = null;
  /** Whether the queued pages render on the system channel vs actor speech. */
  private talkPageSystem = false;
  /**
   * Persistent SCUMM `_string[0]` state for *system* `print`s (actor
   * 255 / no speaker — credits, signs, narrator). In the original, a
   * print's position/colour/centre fields are STICKY: a bare `print`
   * with no subops reuses whatever the last positioned print set. The
   * MI1 credits rely on this — only the first line of each screen
   * carries `SO_AT`/`SO_CENTER`; the rest inherit it. Actor talk does
   * NOT read this (it computes position above the actor each time), so
   * we only persist/consult it on the system-message path.
   */
  printState: {
    x: number | null;
    y: number | null;
    color: number;
    colorSet: boolean;
    center: boolean;
    overhead: boolean;
    clipped: number | null;
  } = { x: null, y: null, color: 0x0f, colorSet: false, center: false, overhead: false, clipped: null };
  /**
   * Ticks remaining that the current message is "being said". Set by a
   * text `print` (length × VAR_CHARINC, floored), counted down each
   * {@link beginTick}; when it hits 0, `VAR_HAVE_MSG` is cleared. This
   * is what paces dialog: `wait`-for-message (0xAE/0x02) blocks while
   * `VAR_HAVE_MSG != 0`, so without a talk timer the engine races
   * through a conversation in a few frames.
   */
  talkDelay = 0;
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
   * Camera-centre scroll bounds set by `roomOps roomScroll` (subop
   * 0x01): the min/max X the camera centre may reach in this room.
   * `null` means "use the default bounds" — `[160, width-160]`, the
   * widest the viewport can pan without showing past a room edge.
   * Each value is floored at 160 (half the 320-wide screen) when set,
   * matching the original. Cleared on room change ({@link enterRoom}).
   */
  roomScroll: { min: number; max: number } | null = null;
  /**
   * Actor the camera tracks (0 = none), set by `actorFollowCamera`.
   * Each tick {@link moveCameraFollow} scrolls the camera to keep this
   * actor inside a central dead-zone band — without it the camera snaps
   * once and the actor walks off the edge.
   */
  cameraFollowActor = 0;
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
   * Sticky pointer-button hold state, mutated by the shell input layer
   * on pointerdown / pointerup. Surfaced in the inspector's Input panel
   * for diagnostics. Discrete clicks are handled event-driven via
   * {@link handleSceneClick} / {@link handleVerbClick}, not by polling
   * these flags.
   */
  readonly input = {
    leftHold: false,
    rightHold: false,
  };
  readonly resolveGlobalScript: GlobalScriptResolver | undefined;
  readonly resolveRoom: RoomResolver | undefined;
  readonly resolveCostume: CostumeResolver | undefined;
  readonly resolveCharset: CharsetResolver | undefined;
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
   *   - `VAR_USERPUT` (53) — whether user input is currently enabled.
   *   - `VAR_SENTENCE_SCRIPT` (33) — *holds the id of* the sentence
   *     script (MI1 writes 2). Read by {@link processSentence}.
   */
  static readonly VAR_MUSIC_TIMER = VARS.VAR_MUSIC_TIMER;
  static readonly VAR_USERPUT = VARS.VAR_USERPUT;
  /** Engine-maintained cursor state. `> 0` enables MI1's #23 hover poller. */
  static readonly VAR_CURSORSTATE = VARS.VAR_CURSORSTATE;
  static readonly VAR_SENTENCE_SCRIPT = VARS.VAR_SENTENCE_SCRIPT;
  /** Non-zero while a message is being "said"; gates `wait`-for-message. */
  static readonly VAR_HAVE_MSG = VARS.VAR_HAVE_MSG;
  /** Per-character talk-delay increment (MI1 = 3). */
  static readonly VAR_CHARINC = VARS.VAR_CHARINC;
  /**
   * Global holding the id of the *input script* (the verb/click hook).
   * MI1 writes 201 (a room-local LSCR). Started by {@link runInputScript}.
   */
  static readonly VAR_VERB_SCRIPT = VARS.VAR_VERB_SCRIPT;
  /** Set to 0 by `cutscene`/`endCutscene`; bumped by `beginOverride`. */
  static readonly VAR_OVERRIDE = VARS.VAR_OVERRIDE;
  /** Scripts run by `cutscene` (start) / `endCutscene` (end). MI1: 18 / 19. */
  static readonly VAR_CUTSCENE_START_SCRIPT = VARS.VAR_CUTSCENE_START_SCRIPT;
  static readonly VAR_CUTSCENE_END_SCRIPT = VARS.VAR_CUTSCENE_END_SCRIPT;
  /**
   * Global holding the id of the *inventory script* — the engine runs
   * it (via {@link runInventoryScript}) whenever the inventory changes;
   * it reads each owned object via `findInventory` and lays the items
   * out into the inventory verb slots (verbs 200–207, arrows 208/209).
   * MI1 = #9.
   */
  static readonly VAR_INVENTORY_SCRIPT = VARS.VAR_INVENTORY_SCRIPT;

  /** SCUMM v5 reserves script ids >= 200 for room-local LSCR scripts. */
  static readonly LSCR_THRESHOLD = 200;

  /**
   * Click-area codes passed to the input script (`runInputScript`'s
   * `local0`). **Guessed** from the common v5 convention — only the
   * input-script *hook* depends on these, not the core sentence flow
   * (the engine builds the sentence directly), so a wrong guess just
   * misfires #201's flag. MI1's #201 acts on area 4 (likely key). To
   * be pinned down precisely later if the hook matters.
   */
  static readonly CLICK_AREA_VERB = 1;
  static readonly CLICK_AREA_SCENE = 2;
  static readonly CLICK_AREA_INVENTORY = 3;


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
    this.resolveCharset = init.resolveCharset;
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
    // Redrawing the screen for a new room erases any blasted system text
    // (signs / part-titles / credits) from the old one — they live on the
    // framebuffer, not in a persistent layer. Cleared here, before the
    // new room's ENCD runs, so a part-title the ENCD prints (room 96's
    // "Le tre prove") survives while the previous room's text doesn't
    // linger over the new background.
    this.clearSystemText();
    // A new room starts with default scroll bounds; its ENCD may set
    // tighter ones via roomOps roomScroll.
    this.roomScroll = null;
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
    // Pseudo-rooms (0xCC) alias one logical id onto another's physical
    // resources — resolve through the mapper, identity for normal ids.
    const physicalRoom = this.pseudoRooms.get(roomId) ?? roomId;
    if (this.resolveRoom) {
      try {
        this.loadedRoom = this.resolveRoom(physicalRoom);
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
    /** Skipped by a normal `freezeScripts` (startScript opcode bit 0x20). */
    freezeResistant?: boolean;
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
    opts: {
      args?: ReadonlyArray<number>;
      label?: string;
      freezeResistant?: boolean;
    } = {},
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
    return this.startScript({
      scriptId,
      bytecode,
      room,
      args: opts.args,
      label: opts.label,
      freezeResistant: opts.freezeResistant,
    });
  }

  /**
   * Freeze every slot except `exceptSlot` (the script issuing the
   * freeze). Freeze-resistant slots are spared unless `force` is set
   * (the `freezeScripts` flag ≥ 0x80). Cumulative — see
   * {@link ScriptSlot.freezeCount}.
   */
  freezeScripts(force: boolean, exceptSlot: number): void {
    for (const s of this.slots) {
      if (s.slotIndex === exceptSlot || s.status === 'dead') continue;
      // The script that opened an active cutscene is protected — it
      // keeps running to play the cutscene out (e.g. MI1's credits
      // script, which #18 would otherwise freeze). Matches SCUMM's
      // "skip the cutscene script" rule.
      if (this.cutsceneStack.some((f) => f.callerSlot === s.slotIndex)) continue;
      if (s.freezeResistant && !force) continue;
      s.freeze();
    }
  }

  /** Thaw every slot completely (the `freezeScripts 0` reset). */
  unfreezeAllScripts(): void {
    for (const s of this.slots) s.freezeCount = 0;
  }

  /**
   * Begin a cutscene (opcode 0x40). Pushes a frame, clears
   * `VAR_OVERRIDE`, and runs `VAR_CUTSCENE_START_SCRIPT` (MI1 #18 —
   * hides the cursor / disables user input). The caller keeps running
   * (a cutscene does NOT freeze scripts — that's the separate
   * `freezeScripts` opcode). Args pass through to the start script.
   */
  beginCutscene(args: ReadonlyArray<number>, callerSlot: number): void {
    this.cutsceneStack.push({ room: this.currentRoom, callerSlot, args: [...args] });
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 0);
    const startScript = this.vars.readGlobal(Vm.VAR_CUTSCENE_START_SCRIPT);
    if (startScript > 0) {
      try {
        this.startScriptById(startScript, { args });
      } catch {
        // Start script unresolvable — cutscene still proceeds.
      }
    }
  }

  /**
   * End the current cutscene (opcode 0xC0). Pops the frame, clears
   * `VAR_OVERRIDE`, and runs `VAR_CUTSCENE_END_SCRIPT` (MI1 #19 —
   * restores the cursor / input) with the begin-time args. No-op if no
   * cutscene is active.
   */
  endCutscene(): void {
    const frame = this.cutsceneStack.pop();
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 0);
    const endScript = this.vars.readGlobal(Vm.VAR_CUTSCENE_END_SCRIPT);
    if (endScript > 0) {
      try {
        this.startScriptById(endScript, { args: frame?.args ?? [] });
      } catch {
        // End script unresolvable.
      }
    }
  }

  /**
   * Abort the active cutscene (the player pressed the cutscene-exit key,
   * Escape). SCUMM's `abortCutscene`: if the current cutscene armed a
   * skip target via `beginOverride` (opcode 0x58, recorded on the
   * cutscene script's slot as `overridePc`), jump that slot to the
   * target, thaw + run it, and set `VAR_OVERRIDE = 1` so the override
   * code can tell it was aborted. The override block then fast-forwards
   * to the cutscene's end state and calls `endCutscene` itself.
   *
   * No-op (returns false) when no cutscene is active or the current one
   * isn't skippable (no override armed) — matching the original, where
   * Escape does nothing until a `beginOverride` runs.
   */
  abortCutscene(): boolean {
    const frame = this.cutsceneStack[this.cutsceneStack.length - 1];
    if (!frame) return false;
    const slot = this.slots[frame.callerSlot];
    if (!slot || slot.status === 'dead' || slot.overridePc === null) return false;
    slot.pc = slot.overridePc;
    slot.overridePc = null;
    slot.delayRemaining = 0;
    slot.freezeCount = 0;
    slot.resume();
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 1);
    return true;
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

  /**
   * Handle a verb-bar click — the engine's `checkExecVerbs` behaviour
   * for a verb hit: run the verb-input script (`VAR_VERB_SCRIPT`, MI1
   * #4) with `[CLICK_AREA_VERB, verbId, button]`. The script arms the
   * active verb (g107) and updates the sentence line; the actual sentence
   * is committed by that script via `doSentence` once the object(s) are
   * gathered. (Inventory items are verbs too — pass their verb id here.)
   */
  handleVerbClick(verbId: number, button = 1): void {
    this.runInputScript(Vm.CLICK_AREA_VERB, verbId, button);
  }

  /**
   * Handle a click in the room scene — `checkExecVerbs` runs the verb-
   * input script with `[CLICK_AREA_SCENE, 0, button]`. The clicked object
   * is **not** passed: the per-frame hover poller (#23, gated on
   * `VAR_CURSORSTATE > 0`) has already hit-tested whatever is under the
   * cursor into the game's active-object globals (g108/g109), and the
   * verb-input script (#4) reads those, gathers a second object for
   * Use/Give, and commits via `doSentence` — which {@link processSentence}
   * then runs. Right-click (`button === 2`) is handled inside #4 (it uses
   * the hovered object's default verb, g182). This is the faithful path;
   * the old engine-side single-object enqueue has been retired.
   */
  handleSceneClick(button = 1): void {
    this.runInputScript(Vm.CLICK_AREA_SCENE, 0, button);
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
    const slot = this.slots.find((s) => s.runnable);
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
   * Mirror engine state into the VARs scripts poll. Called by the
   * main-loop driver (the inspector) once at the start of each tick —
   * *before* `runUntilAllYield` — so any script that runs this tick
   * sees the freshest state.
   *
   *   - `VAR_USERPUT` reflects {@link cursor.userput} (whether user
   *     input is currently enabled).
   *   - `VAR_MUSIC_TIMER` auto-increments — scripts reset it to 0 then
   *     poll for a target to pace cutscenes (MI1's credits wait on it).
   *
   *   - `VAR_CURSORSTATE` (52) / `VAR_USERPUT` (53) mirror the cursor
   *     counters. The original writes these at the end of `cursorCommand`
   *     (`VAR(VAR_CURSORSTATE) = _cursor.state`); we also refresh them
   *     here so a script polling them mid-frame sees the live value.
   *     `g52 > 0` is what enables MI1's #23 hover poller (which fills
   *     g108/g109 — the objects the verb script #4 acts on).
   */
  beginTick(): void {
    this.vars.writeGlobal(Vm.VAR_USERPUT, this.cursor.userput);
    this.vars.writeGlobal(Vm.VAR_CURSORSTATE, this.cursor.state);
    this.vars.writeGlobal(
      Vm.VAR_MUSIC_TIMER,
      this.vars.readGlobal(Vm.VAR_MUSIC_TIMER) + 1,
    );
    // Tick the talk timer. When it drains, the message is "done":
    // VAR_HAVE_MSG clears (so a wait-for-message releases) and actor
    // speech disappears. System / credit text (no real speaker, id 255)
    // persists until the script overwrites it — only actor speech
    // auto-clears, matching the original's stopTalk.
    if (this.talkDelay > 0) {
      this.talkDelay--;
      if (this.talkDelay === 0) {
        if (this.talkPages.length > 0) {
          // More sentence pages queued — flip to the next one and re-arm
          // the timer instead of ending the message. VAR_HAVE_MSG stays
          // set (beginTalk re-asserts it), so a wait-for-message keeps
          // blocking until the final page finishes.
          const next = this.talkPages.shift()!;
          const dlg: ActiveDialog = { ...this.talkPageDlg!, text: next };
          if (this.talkPageSystem) this.addSystemText(dlg);
          else this.activeDialog = dlg;
          this.beginTalk(next);
        } else {
          this.vars.writeGlobal(Vm.VAR_HAVE_MSG, 0);
          const d = this.activeDialog;
          if (d && d.actorId >= 1 && d.actorId <= this.actors.capacity) {
            this.activeDialog = null;
          }
        }
      }
    }
    this.moveCameraFollow();
  }

  /**
   * Advance the engine by one **jiffy** (1/60 s), the unit `delay` and
   * the timers count in. Returns what happened (see {@link TickResult}).
   *
   * SCUMM separates two clocks. The **jiffy clock** (60 Hz) paces
   * `delay`, `VAR_MUSIC_TIMER`, and the talk timer — all wall-time
   * accurate. The **game frame** — running scripts, walking actors, and
   * advancing costume animation — fires only once every
   * `VAR_TIMER_NEXT` jiffies (MI1: 6 → ~10 fps). Running the frame work
   * every jiffy instead (the old behaviour) makes everything that moves
   * — walks, cloud/sparkle/fire anims — run ~6× too fast even though
   * delay-gated cutscene timing stays correct.
   *
   * So every jiffy we tick the input/music/talk timers ({@link beginTick})
   * and the per-slot `delay` countdown; only on a frame boundary do we
   * resume scripts, drain them, step walks, and advance anims.
   *
   * This is the canonical per-jiffy driver — the shell's main loop and
   * headless harnesses both call it so the timing model lives in one
   * place. Frozen slots (cutscene / `freezeScripts`) are never resumed
   * and their `delay` countdown is paused, matching the original.
   */
  tick(): TickResult {
    if (this._haltInfo) return { framed: false, resumed: false, ran: 0, delaying: false };
    // Per-jiffy: input/cursor mirror, music + talk timers, camera follow.
    this.beginTick();
    // Per-jiffy: drain `delay` countdowns. A frozen slot's delay is paused.
    let delaying = false;
    for (const s of this.slots) {
      if (s.status === 'yielded' && s.freezeCount === 0 && s.delayRemaining > 0) {
        s.delayRemaining--;
        delaying = true;
      }
    }
    // Frame gate: only run the heavy frame work every VAR_TIMER_NEXT jiffies.
    this.frameAccumulator++;
    if (this.frameAccumulator < this.frameInterval()) {
      return { framed: false, resumed: false, ran: 0, delaying };
    }
    this.frameAccumulator = 0;
    // ── one game frame ──
    this.processSentence();
    let resumed = false;
    for (const s of this.slots) {
      if (s.status === 'yielded' && s.freezeCount === 0 && s.delayRemaining === 0) {
        s.resume();
        resumed = true;
      }
    }
    const ran = this.runUntilAllYield();
    stepAllActorWalks(this);
    for (const actor of this.actors.all()) actor.anim = stepAnim(actor.anim);
    return { framed: true, resumed, ran, delaying };
  }

  /**
   * Jiffies per game frame, from `VAR_TIMER_NEXT` (clamped to a sane
   * range). MI1 runs ~6 (≈ 10 fps); falls back to
   * {@link DEFAULT_FRAME_INTERVAL} when the var is unset / nonsensical.
   */
  private frameInterval(): number {
    const v = this.vars.readGlobal(VARS.VAR_TIMER_NEXT);
    if (!Number.isFinite(v) || v < 1) return DEFAULT_FRAME_INTERVAL;
    return Math.min(v, 60);
  }

  /**
   * Scroll the camera to keep the followed actor (`cameraFollowActor`)
   * within a central dead-zone band. The actor can drift up to
   * `CAMERA_DEAD_ZONE` px off-centre before the camera moves — small
   * movements don't scroll (no jitter), but the actor never leaves the
   * 320-wide viewport. The camera centre is clamped to the room's valid
   * range. No-op when no actor is followed or it isn't in this room.
   */
  moveCameraFollow(): void {
    const id = this.cameraFollowActor;
    if (id < 1 || id > this.actors.capacity) return;
    const actor = this.actors.get(id);
    const room = this.loadedRoom;
    if (!room || actor.room !== this.currentRoom) return;
    const DEAD = 80;
    let x = this.camera.x;
    if (actor.x > x + DEAD) x = actor.x - DEAD;
    else if (actor.x < x - DEAD) x = actor.x + DEAD;
    else return;
    const half = 160;
    const min = Math.min(half, room.width);
    const max = Math.max(min, room.width - half);
    this.camera.x = Math.max(min, Math.min(max, x));
  }

  /**
   * Mark a message as being said for `text` — sets `VAR_HAVE_MSG` and a
   * talk timer proportional to the text length (× `VAR_CHARINC`, the
   * SCUMM text-speed var), floored so even short lines linger. Called
   * by the `print` / `printEgo` opcodes. Paces dialog so a
   * wait-for-message actually waits.
   */
  beginTalk(text: string): void {
    const charinc = Math.max(1, this.vars.readGlobal(Vm.VAR_CHARINC));
    this.talkDelay = Math.max(MIN_TALK_TICKS, text.length * charinc);
    this.vars.writeGlobal(Vm.VAR_HAVE_MSG, 1);
  }

  /**
   * Queue the remaining sentence pages of a multi-part message (the text
   * after each `\xff\x03`). `dlg` is the just-shown first page's dialog —
   * reused as the style/channel template for each following page;
   * `isSystem` selects the system vs actor-speech channel. Called by the
   * `print` opcode right after `beginTalk` of the first page. A no-op for
   * single-page lines, so it costs nothing in the common case.
   */
  queueTalkPages(pages: string[], dlg: ActiveDialog, isSystem: boolean): void {
    this.talkPages = pages.slice();
    this.talkPageDlg = dlg;
    this.talkPageSystem = isSystem;
  }

  /** Clear the current message immediately (empty `print`, room change). */
  endTalk(): void {
    this.talkDelay = 0;
    this.talkPages = [];
    this.talkPageDlg = null;
    this.vars.writeGlobal(Vm.VAR_HAVE_MSG, 0);
  }

  /**
   * How many objects the actor `owner` carries. SCUMM v5 ties inventory
   * membership to ownership, so an object is "in someone's inventory"
   * exactly when its {@link objectOwners} entry names that actor.
   * owner 0 (nobody / still in the room) owns nothing. Backs the
   * `getInventoryCount` opcode ($31).
   */
  inventoryCount(owner: number): number {
    if (owner === 0) return 0;
    let n = 0;
    for (const o of this.objectOwners.values()) if (o === owner) n++;
    return n;
  }

  /**
   * The `index`-th (1-based) object owned by `owner`, in pickup order
   * (Map insertion order mirrors SCUMM's inventory-array append order).
   * Returns 0 when `owner` is nobody or `index` is out of range. Backs
   * the `findInventory` opcode ($3D).
   */
  findInventory(owner: number, index: number): number {
    if (owner === 0 || index < 1) return 0;
    let n = 0;
    for (const [obj, o] of this.objectOwners) {
      if (o === owner && ++n === index) return obj;
    }
    return 0;
  }

  /**
   * Resolve an object's display name. Checks the current room's object
   * table first (correct for room objects and just-picked-up items),
   * then the carried-item snapshot in {@link inventoryNames} (for items
   * carried out of their pickup room). Returns `undefined` when the name
   * is unknown so callers can fall back to an `obj #N` placeholder.
   */
  objectName(objId: number): string | undefined {
    const inRoom = this.loadedRoom?.objects.get(objId)?.name;
    if (inRoom) return inRoom;
    const carried = this.inventoryNames.get(objId);
    if (carried) return carried;
    return undefined;
  }

  /**
   * Snapshot an object's name into {@link inventoryNames} as it enters
   * an inventory. Looks in the current room first, then the hinted room
   * (the `room` operand of `pickupObject`) via {@link resolveRoom}. A
   * no-op when the name can't be resolved — better a stale `obj #N` than
   * a crash. Called from the ownership-taking opcodes.
   */
  captureInventoryName(objId: number, roomHint: number): void {
    let name = this.loadedRoom?.objects.get(objId)?.name;
    if (!name && roomHint && roomHint !== this.currentRoom && this.resolveRoom) {
      try {
        name = this.resolveRoom(roomHint).objects.get(objId)?.name;
      } catch {
        // Unresolvable room — leave the name unknown.
      }
    }
    if (name) this.inventoryNames.set(objId, name);
  }

  /**
   * Run MI1's inventory script (the id in `VAR_INVENTORY_SCRIPT`, #9 for
   * MI1) with `arg` as `local0`. SCUMM calls this whenever the inventory
   * changes (e.g. after `pickupObject`) — the script walks the owner's
   * items via `findInventory` and writes their names/images into the
   * inventory verb slots, so the inventory renders through the verb bar.
   *
   * Faithful to the original's non-recursive `runScript`: any existing
   * instance is stopped first so the slots don't stack. No-op when the
   * var is unset (0) or no resolver/slot is available (never throws — a
   * failed inventory refresh shouldn't take down the engine).
   */
  runInventoryScript(arg: number): void {
    const scriptId = this.vars.readGlobal(Vm.VAR_INVENTORY_SCRIPT);
    if (!scriptId) return;
    for (const s of this.slots) {
      if (s.status !== 'dead' && s.scriptId === scriptId) s.kill();
    }
    try {
      this.startScriptById(scriptId, { args: [arg], label: 'INVENTORY' });
    } catch {
      // No free slot / unresolved script — leave the inventory stale
      // rather than halt. Surfaced via the absence of a refresh, not a crash.
    }
  }

  /**
   * Walk an actor to a room coordinate, pathfinding through the current
   * room's walkable mask (same planner the `walkActorTo` opcode uses).
   * No-op for an out-of-range / unplaced actor. Used by click-to-walk;
   * `stepAllActorWalks` advances the walk per tick.
   */
  walkActorTo(actorId: number, x: number, y: number): void {
    if (actorId < 1 || actorId > this.actors.capacity) return;
    startWalk(this, this.actors.get(actorId), { x, y });
  }

  /**
   * Return the id of the actor under room-space point `(x, y)`, or `0`
   * if none — backing the `actorFromPos` opcode (and Talk-to clicks).
   *
   * Mirrors SCUMM's `getActorFromPos`: test each actor in the current
   * room against the box it actually drew last frame ({@link Actor.drawBounds},
   * the engine's stand-in for the original's gfx-usage bits), skipping
   * actors with the Untouchable class (32). Actors paint in ascending
   * id order — later ids on top — so among overlapping hits we return
   * the highest id (the topmost), matching the rendered z-order.
   */
  actorFromPos(x: number, y: number): number {
    let hit = 0;
    for (const actor of this.actors.all()) {
      if (actor.room !== this.currentRoom || !actor.visible) continue;
      const b = actor.drawBounds;
      if (!b) continue;
      // Untouchable = class 32 → bit 31 of the class mask.
      if ((this.objectClasses.get(actor.id) ?? 0) & (1 << 31)) continue;
      if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
        hit = actor.id; // keep the highest-id (topmost) match
      }
    }
    return hit;
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
      const slot = this.slots.find((s) => s.runnable);
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
    this.inventoryNames.clear();
    this.objectClasses.clear();
    this.objectDrawQueue.clear();
    this.currentRoom = 0;
    this.frameAccumulator = 0;
    this.loadedRoom = null;
    this.lastRoomLoadError = null;
    this.pseudoRooms.clear();
    this.systemRequest = null;
    this.actors.reset();
    this.costumes.clear();
    this.mouseRoomX = 0;
    this.mouseRoomY = 0;
    this.cursor.state = 0;
    this.cursor.userput = 0;
    this.currentCharset = 0;
    this.verbs.clear();
    this.savedVerbStates.clear();
    this.sentenceStack.length = 0;
    this.cutsceneStack.length = 0;
    this.input.leftHold = false;
    this.input.rightHold = false;
    this.activeDialog = null;
    this.systemText = null;
    this.printState = {
      x: null,
      y: null,
      color: 0x0f,
      colorSet: false,
      center: false,
      overhead: false,
      clipped: null,
    };
    this.talkDelay = 0;
    this.talkPages = [];
    this.talkPageDlg = null;
    this.talkPageSystem = false;
    this.camera.x = 0;
    this.roomScroll = null;
    this.cameraFollowActor = 0;
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
