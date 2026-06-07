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
import { prepareActorDraw } from '../graphics/composite';
import { findVerbScript } from '../object/verbs';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { CharsetHeader } from '../graphics/charset';
import type { LoadedRoom } from '../room/loader';
import type { LoadedObject } from '../object/loader';
import type { Sentence } from './sentence';
import { ScriptSlot } from './slot';
import { Variables } from './variables';
import * as VARS from './vars';

/**
 * Jiffies per game frame when `VAR_TIMER_NEXT` is unset / out of range.
 * MI1 runs the intro with `VAR_TIMER_NEXT = 6` (≈ 10 fps).
 */
const DEFAULT_FRAME_INTERVAL = 6;
/**
 * Pixels the camera centre scrolls per game frame during a `panCameraTo`
 * smooth pan. 8 keeps the centre strip-aligned (the v5 background is drawn in
 * 8px strips). Tunable against the room-64 dig pan, the first scene to use it.
 */
const CAMERA_PAN_STEP = 8;

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

/**
 * Fired by the opt-in hang watchdog ({@link Vm.enableHangWatchdog}) when
 * a run of consecutive player clicks each produced **no observable
 * progress** — no room change, no speech, no committed sentence, no new
 * script, no walk command. That is the live symptom of a silent
 * divergence: a script parked waiting on a var the input never sets (the
 * pirate-conversation `VAR_VERB_SCRIPT` clobber hung exactly this way —
 * clicking dialog answers changed nothing).
 */
export interface HangInfo {
  /** How many consecutive clicks produced no progress. */
  readonly deadInputs: number;
  readonly room: number;
  /** `VAR_VERB_SCRIPT` (32) — the usual suspect when clicks misroute. */
  readonly verbScript: number;
  /** Live (non-dead) script ids when the watchdog fired. */
  readonly liveScripts: ReadonlyArray<number>;
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
  /**
   * When true, this is an actor talking with no explicit `SO_COLOR`, so the
   * ink is the speaker's `talkColor` and must be re-read LIVE at render time
   * — not treated as the print-time snapshot in {@link color}. SCUMM reads a
   * talking actor's colour every frame the text is up, so a script that sets
   * the colour *after* the `print` (commonly via a just-`startScript`ed
   * helper that runs a frame later) still tints the line. Without live read
   * the line freezes at the actor's residual colour and a raced colour-setter
   * is missed (the SCUMM-Bar pirates: black instead of yellow). `color` holds
   * the print-time value as a fallback (e.g. the actor no longer exists).
   * Absent is treated as `false` (use the {@link color} snapshot).
   */
  readonly colorFromActor?: boolean;
  /** Centre text around `x` rather than left-anchor. */
  readonly center: boolean;
  /** Position above the speaking actor's head. */
  readonly overhead: boolean;
  /** Max x bound from SO_CLIPPED (informational; no wrap yet). */
  readonly clipped: number | null;
  /**
   * The message carried a `keepText` code (`0xFF 0x02`). Such messages
   * persist on screen until an explicit clear (an empty/space `print` at the
   * same spot) or overwrite — they are NOT removed when the talk timer
   * drains. SCUMM's signs, credits, and the layered "Le tre prove!" title
   * use it; the credit script (#152) prints a credit with keepText, holds it
   * with its own `delay`, then clears it with `print " "`. Without keepText a
   * message clears when its timer ends (the cook's "Non puoi venire di qui!"
   * shout). Absent ⇒ false. Only meaningful for system text (no speaker).
   */
  readonly keepText?: boolean;
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
/**
 * SCUMM's `OF_OWNER_ROOM` — the owner value for an object that belongs to the
 * room it sits in (i.e. not in anyone's inventory). MI1's sentence script #2
 * gates the walk-to-object approach on `getObjectOwner(obj) == 15`, so a
 * room object MUST read as 15 or the ego never walks up to it. Picking the
 * object up reassigns the owner to an actor id; 0 means "nobody / removed".
 */
const OF_OWNER_ROOM = 15;

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

/**
 * Resolve a global object id to the id of the room whose OBCD defines
 * it, or `null` when no room owns it. Object numbers are globally
 * unique (each is defined in exactly one room), so this is the stable
 * "home room" of an object. Used by {@link Vm.findObjectCode} to reach
 * a carried inventory item's verb scripts after it has left its pickup
 * room — SCUMM keeps a picked-up object's OBCD resident; we re-resolve
 * it from its home room instead. See `bootGame` for the lazy index.
 */
export type ObjectRoomResolver = (objId: number) => number | null;

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
  /**
   * Resolver mapping an object id to its home room. Optional in tests;
   * the real boot path wires it via {@link bootGame}. Lets
   * {@link Vm.findObjectCode} run verb scripts for inventory items that
   * have left their pickup room (e.g. MI1's inventory-icon verb 91).
   */
  readonly resolveObjectRoom?: ObjectRoomResolver;
  /**
   * Entropy source for the `getRandomNumber` opcode — a function
   * returning a float in `[0, 1)`. Defaults to {@link Math.random}, so
   * the app plays with live randomness (ambient bar life, etc.). Tests
   * inject a *seeded* generator (see `testkit`) so a scripted playthrough
   * reproduces bit-for-bit across runs — a regression net can't be flaky.
   * The generator's state is intentionally NOT part of the save snapshot
   * ({@link snapshotVm}); seed at construction instead. This is faithful:
   * the original DOS interpreter seeds its RNG once at process start and
   * saves only variables/object/actor state, never the RNG seed — so
   * loading an original save also continues the stream from wherever the
   * process happens to be, and future draws diverge from the live run.
   * Our reloaded saves diverging the same way is correct, not a bug. The
   * seam exists only to make the *test* playthrough reproducible (seeded);
   * it is deterministic-for-reproducibility, not bit-identical to the
   * original's RNG (which the bytecode doesn't define).
   */
  readonly random?: () => number;
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
  /** Object-id → name set by `setObjectName` ($54); wins over OBNA. */
  readonly objectNameOverrides = new Map<number, string>();
  /**
   * Per-object class bitmask, mutated by `actorSetClass` (0x5D) and
   * tested by `ifClassOfIs` (0x1D). Class N occupies bit `N-1` (classes
   * are 1-based in v5). Default 0 (no classes). v5 named classes
   * include 20 NeverClip, 21 AlwaysClip, 22 IgnoreBoxes, 30 XFlip,
   * 31 Player, 32 Untouchable.
   */
  readonly objectClasses = new Map<number, number>();
  /**
   * Per-box walk-flag overrides for the CURRENT room, keyed by box id —
   * set by `matrixOp setBoxFlags` (0x30 sub 0x01). SCUMM stores walk-box
   * flags in the in-memory room and scripts toggle bit 0x80 to lock/unlock
   * a box (a closed door seals its corridor by locking the boxes behind it).
   * Our {@link LoadedRoom} is parsed fresh from disk on every entry (so its
   * `walkBoxes` carry the disk flags), and the flags are runtime state, so we
   * layer the changes here instead of mutating the room. Reset on a real room
   * change ({@link enterRoom}) — SCUMM resets box flags on reload and the
   * entry script re-applies them — and consulted live by the box-graph
   * pathfinder ({@link startWalk}'s `effectiveBoxes`). Saved so a restore
   * (which does NOT re-run the entry script) reproduces the locked passages.
   */
  readonly boxFlagOverrides = new Map<number, number>();
  /**
   * Object draw queue — set of object ids the compositor should
   * include in the next frame. Populated by the `drawObject` opcode
   * and cleared on room change. Order isn't significant for v5
   * (object stacking comes from per-object z-planes inside the OBIM
   * image, not from draw-queue order).
   */
  readonly objectDrawQueue = new Set<number>();
  /**
   * Runtime object positions set by `drawObject … at x,y` (SO_AT). SCUMM's
   * `o5_drawObject` moves the object to `(x * 8, y)` (x is in strips, y in
   * pixels) and draws there until the next reposition; a bare/SO_IMAGE draw
   * keeps the last position. The compositor reads this in preference to the
   * IMHD default. MI1's forest maze (room 58) is the case that needs it: each
   * "screen" is composed by repositioning a shared set of tile objects
   * (656–688) — without the move they all stack at their IMHD x and the
   * screen renders mostly black. Cleared on room change with the draw queue.
   */
  readonly objectDrawPositions = new Map<number, { x: number; y: number }>();
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
   * Snapshot of {@link loadedRoom}'s palette as decoded at room load (CLUT +
   * UI overrides), taken before any script mutates it. `roomOps roomIntensity`
   * (`darkenPalette`) scales the *live* palette from this base, not from itself
   * — so a script that blacks the screen with `setPalColor (0,0,0)` and then
   * fades back in with `roomIntensity 255,i,i` (room 63, the treasure-map
   * close-up) restores the original colours instead of staying black. `null`
   * when no room is loaded; re-captured every {@link applyRoomResources}.
   */
  basePalette: Uint8Array | null = null;
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
   * SCUMM "blasts" system text onto a single charset region. The lifetime
   * model is SCUMM's `restoreCharsetBg`: a *transient* (non-keepText) print
   * draws over a region that is restored (erased) exactly once per display
   * cycle, lazily, just before the first transient draw of that cycle (see
   * {@link systemTextRestorePending}, armed each game frame in {@link tick}).
   * Two consequences, both observed in MI1 bytecode:
   *   - Multiple transient prints **within one frame** coexist — the
   *     "Parte Due / Il Viaggio" chapter card (global #122) prints both
   *     lines back-to-back at @y165/@y180 before yielding, and once drawn
   *     they persist across the following wait frames (no new transient
   *     print arrives to trigger the restore).
   *   - A transient print in a **new** frame erases the previous frame's
   *     transient text first. The map hover poller (global #24) re-prints
   *     the location name at the cursor each frame and a bare `print " "
   *     at 0,0` on hover-out; without the per-frame restore these smear
   *     into a trail of stale labels (bug-map-labels).
   * keepText prints (signs, credits, the "Le tre prove!" title) never
   * trigger or suffer the restore — they accumulate and persist until an
   * explicit empty print, a room change ({@link enterRoom}), or {@link reset}.
   * Same-position prints replace (the credit roll re-prints at one spot).
   * Mutate via {@link addSystemText} / {@link clearSystemText}, not directly.
   */
  systemTexts: ActiveDialog[] = [];

  /**
   * Armed at the top of each game frame ({@link tick}); consumed by the
   * first transient (non-keepText) {@link addSystemText} of that frame,
   * which restores (erases) the prior frame's transient system text before
   * drawing — SCUMM's `restoreCharsetBg`. Transient, not part of save state:
   * it re-arms every frame, so a restore loaded as `false` self-corrects on
   * the next tick.
   */
  private systemTextRestorePending = false;

  /** Back-compat single-slot view: the most-recently-blasted line. */
  get systemText(): ActiveDialog | null {
    return this.systemTexts[this.systemTexts.length - 1] ?? null;
  }
  /** Setting replaces every blasted line (null clears all). */
  set systemText(d: ActiveDialog | null) {
    this.systemTexts = d ? [d] : [];
  }

  /**
   * Blast one system line. A transient (non-keepText) line that is the
   * first of a new display cycle restores the screen first — erasing the
   * previous cycle's transient text (keepText lines survive) — so a
   * cursor-tracking label doesn't smear (see {@link systemTexts}). Further
   * transient lines in the same frame, and all keepText lines, accumulate.
   * A line at an already-occupied anchor replaces it (the credit roll
   * re-prints at one spot).
   */
  addSystemText(dlg: ActiveDialog): void {
    if (!dlg.keepText && this.systemTextRestorePending) {
      this.systemTexts = this.systemTexts.filter((d) => d.keepText);
      this.systemTextRestorePending = false;
    }
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
   * SCUMM's `restoreCharsetBg` partial erase: a screen redraw (cutscene end,
   * camera scroll) wipes *transient* blasted text but leaves keepText lines
   * (signs, credits, the chapter titles), which clear only on overwrite, room
   * change, or {@link clearSystemText}. No-op when nothing transient is up.
   */
  eraseTransientSystemText(): void {
    if (this.systemTexts.some((s) => !s.keepText)) {
      this.systemTexts = this.systemTexts.filter((s) => s.keepText);
    }
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
   * Persistent palette overrides (CLUT index → RGB) from `setPalColor`
   * calls made while **no room is loaded** — MI1's boot runs UI/credit
   * palette scripts (e.g. global #178) before the first room, setting the
   * low "UI" indices (the verb ink #6, the credit/sentence colours #1–3)
   * to the game's magenta interface theme. Those writes have no live room
   * CLUT to land in, so we stash them here and **re-apply them on top of
   * every room's CLUT on load** ({@link enterRoom}) — the room ships a
   * placeholder VGA-16 low palette (orange #6 / teal #3) that would
   * otherwise clobber the UI colours each room change. Cleared by
   * {@link reset}. See pages/docs/scumm/lighting.md / the credits-colour note.
   */
  readonly uiPaletteOverrides = new Map<number, readonly [number, number, number]>();
  /**
   * Charset colour map set by `cursorCommand charsetColor` (subop 0x0E):
   * the list of CLUT indices the text renderer maps glyph pixel values
   * through. MI1's boot sets `[0, 6, 2]` — value 1 (the glyph fill) → CLUT
   * 6 (magenta), value 2 (the shadow/outline) → CLUT 2 (dark magenta). The
   * verb panel renders with this map, which is why the verb glyphs carry a
   * dark-magenta shadow, not a black one. Empty until a charsetColor runs.
   * Cleared by {@link reset}.
   */
  charsetColorMap: number[] = [];
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
   * Each game frame {@link moveCameraFollow} scrolls the camera to keep this
   * actor inside a central dead-zone band — without it the camera snaps
   * once and the actor walks off the edge.
   */
  cameraFollowActor = 0;
  /**
   * Target X of an in-progress `panCameraTo` smooth scroll, or null when the
   * camera is at rest. {@link stepCameraPan} walks {@link camera}.x toward it
   * by {@link CAMERA_PAN_STEP} each game frame and clears it on arrival;
   * `wait forCamera` blocks while it's non-null. Transient (re-derived from
   * camera.x on load), so not part of save state.
   */
  cameraDest: number | null = null;
  /**
   * Room-transition screen effect, set by `roomOps screenEffect`
   * (0x33 subop 0x0A — v5 `SO_ROOM_FADE`). v5 packs two effect numbers
   * into the single operand: the **low byte** is `switchRoomEffect`
   * (the fade-IN effect played when the next room is revealed) and the
   * **high byte** is `switchRoomEffect2` (the fade-OUT effect played
   * when leaving the current room). An operand of **0** is the special
   * "reveal the current room NOW" trigger — it requests an immediate
   * fade-in with the pending effect and leaves the effect numbers
   * unchanged (`requestFadeIn` flips true; the shell may consume it).
   *
   * We record the effect numbers and surface them in the inspector. The
   * transition **animations** (instant / dissolve / scroll) are *not*
   * implemented: MI1's intro-reachable path uses only effect 129
   * (instant) plus a bare `loadRoomWithEgo`, so there is no non-instant
   * transition to animate against yet, and the effect-number → animation
   * mapping can't be validated without a reachable scene that uses one.
   * Cleared by {@link reset}. See pages/docs/scumm/screen-effect.md.
   */
  readonly screenEffect = { switchRoomEffect: 0, switchRoomEffect2: 0, requestFadeIn: false };
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
  readonly resolveObjectRoom: ObjectRoomResolver | undefined;
  /**
   * Resident OBCD cache for carried inventory items — object id → its
   * decoded {@link LoadedObject}, resolved from the object's home room
   * the first time its code is needed off-room. OBCD is immutable
   * resource data, so entries never go stale. See {@link findObjectCode}.
   */
  private readonly residentObjectCode = new Map<number, LoadedObject>();
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
    this.resolveObjectRoom = init.resolveObjectRoom;
    this.randomSource = init.random ?? Math.random;
  }

  /** Entropy source for {@link randomInt}; see {@link VmInit.random}. */
  private readonly randomSource: () => number;

  /**
   * A random integer in `[0, max]` **inclusive** — the contract of the
   * `getRandomNumber` opcode (0x16 / 0x96). The single place the engine
   * consumes randomness, routed through the injectable {@link VmInit.random}
   * source so tests can seed it for reproducible playthroughs.
   */
  randomInt(max: number): number {
    return Math.floor(this.randomSource() * (max + 1));
  }

  /**
   * Resolve an object's code (verb scripts, name, CDHD) whether it sits
   * in the current room OR is carried in the player's inventory.
   *
   * SCUMM keeps a picked-up object's OBCD resident, so its verb scripts
   * run anywhere. Our rooms are decoded on demand, so a carried item's
   * code isn't in {@link loadedRoom} once it leaves its pickup room. We
   * re-resolve it from the object's home room ({@link resolveObjectRoom})
   * and cache it ({@link residentObjectCode}) — OBCD is immutable.
   *
   * Without this, MI1's inventory script #9 (which runs each item's
   * verb-91 "icon" script via `startObject` to learn the slot image,
   * gated by `getVerbEntryPoint`) couldn't reach any carried item's
   * verb 91 — every slot fell back to the generic frame object 1031,
   * so the whole inventory drew one identical wrong icon.
   */
  findObjectCode(objId: number): LoadedObject | null {
    const inRoom = this.loadedRoom?.objects.get(objId);
    if (inRoom) return inRoom;
    const cached = this.residentObjectCode.get(objId);
    if (cached) return cached;
    if (!this.resolveObjectRoom || !this.resolveRoom) return null;
    const homeRoom = this.resolveObjectRoom(objId);
    if (homeRoom === null) return null;
    try {
      const obj = this.resolveRoom(homeRoom).objects.get(objId) ?? null;
      if (obj) this.residentObjectCode.set(objId, obj);
      return obj;
    } catch {
      return null;
    }
  }

  /**
   * Transition to a new room. The full sequence (per SCUMM v5 `startScene`):
   *
   *   1. Run the previous room's EXCD if present (e.g. stop the title
   *      music). Runs NESTED — to its first yield, before this method
   *      returns — matching `runExitScript`.
   *   2. Decode the new room — `vm.loadedRoom` becomes the new data
   *      or `null` if the resolver throws (room 0 sentinel, etc.).
   *      `vm.currentRoom` + VAR_ROOM are updated unconditionally so
   *      scripts that read VAR_ROOM see the script-level value even
   *      if the decode failed.
   *   3. Run the new room's ENCD if present (e.g. set up actors, play
   *      room music). Also NESTED, matching `runEntryScript`.
   *
   * EXCD/ENCD run NESTED (not as deferred slots) because `startScene`
   * is itself invoked synchronously from the `loadRoom` opcode: the
   * exit/entry scripts must finish (to their first breakHere) before
   * the opcode returns, so the calling script's next opcodes observe
   * the post-transition state. Deferring them let the caller's
   * continuation run first and the room script then clobber it — see
   * the EXCD/ENCD `runScriptNested` calls below and the pirate-
   * conversation `VAR_VERB_SCRIPT` regression in the MI1 smoke suite.
   * Both slots get a human label ("ENCD-10", "EXCD-10") so the
   * inspector can tell them apart from the global scripts.
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
    this.objectDrawPositions.clear();
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
    // Any in-progress smooth pan belongs to the old room — cancel it.
    this.cameraDest = null;
    const prev = this.loadedRoom;
    if (prev?.exitScript && prev.exitScript.length > 0) {
      try {
        const excd = this.startScript({
          scriptId: 0,
          bytecode: prev.exitScript,
          room: prev.id,
          label: `EXCD-${prev.id}`,
        });
        // SCUMM `startScene` runs the exit script NESTED (runExitScript →
        // runScript → runScriptNested): it must finish before the loadRoom
        // opcode returns to its caller. Queuing it as a deferred slot instead
        // lets the caller's next opcodes run first — and the EXCD then clobbers
        // them. Concretely: the pirate-conversation script #93 does
        // `loadRoom 82` then `g32 = 14` (set VAR_VERB_SCRIPT to the dialog
        // input script). EXCD-28 resets `g32 = 4` (the default verb script); if
        // it runs *after* #93's `g32 = 14`, the conversation is left routing
        // dialog clicks to the wrong script (#4 arms but never commits), so
        // clicking a dialog answer does nothing. Running EXCD now — before
        // loadRoom returns — restores the original ordering.
        this.runScriptNested(excd);
      } catch {
        // No free slot — silently skip. EXCD running is best-effort.
      }
    }

    // SCUMM's startScene stops every room-local and object/verb script on a
    // room change (WIO_ROOM / WIO_FLOBJECT die; only globals — WIO_GLOBAL —
    // survive). Without this, the old room's ambient/animation loops keep
    // running into the new room and try to start locals that no longer exist
    // there: room 28's #210 (which starts #208/#209) survived a pirate-talk
    // close-up and halted with "local script #209 not present in current room
    // 81 (loaded=58)". Run after EXCD has finished (it's scriptId 0, spared)
    // and before the new ENCD. The transition caller is a global (e.g. the
    // dialog script #17), so it keeps running across the load.
    this.stopRoomLocalScripts();

    // Box walk-flags are per-room and reset to the room's disk values on a
    // room change; the new room's entry script (ENCD) re-applies any door
    // locks below. Clear before applyRoomResources so the fresh mask starts
    // from the disk flags.
    this.boxFlagOverrides.clear();
    this.currentRoom = roomId;
    this.vars.writeGlobal(VAR_ROOM_INDEX, roomId);
    this.applyRoomResources(roomId);

    const next = this.loadedRoom;
    if (next?.entryScript && next.entryScript.length > 0) {
      try {
        const encd = this.startScript({
          scriptId: 0,
          bytecode: next.entryScript,
          room: next.id,
          label: `ENCD-${next.id}`,
        });
        // Nested, same as EXCD above: SCUMM `startScene` runs the entry script
        // (runEntryScript → runScript) to its first yield before the loadRoom
        // opcode returns, so the caller's next opcodes observe the room as the
        // ENCD set it up. `runScriptNested` runs until the first breakHere/stop,
        // so an ENCD that spans frames still yields back to the per-frame
        // scheduler after its prologue — exactly the original's behaviour.
        this.runScriptNested(encd);
      } catch {
        // No free slot — silently skip.
      }
    }
  }

  /**
   * Decode `roomId` into {@link loadedRoom} and re-apply the
   * persistent UI-palette overrides (set by boot palette scripts before
   * any room existed) on top of its freshly decoded CLUT — otherwise the
   * room's placeholder VGA-16 low palette clobbers the verb/credit/
   * sentence colours every room change. Shared by {@link enterRoom} and
   * {@link reloadCurrentRoomResources}; does NOT run entry/exit scripts.
   *
   * Pseudo-rooms (0xCC) are a **fallback**: a high-numbered alias id that
   * doesn't physically exist (MI1's forest maze aliases 201–220 → 58, and
   * 130–132 → 1) loads another room's resources. A room that DOES exist must
   * load its own data, so we resolve the requested id first and only consult
   * the alias when the direct load fails. Pseudo ids are always ≥ 128, so they
   * never shadow a real room (1–127) — the direct-first order is belt-and-
   * braces, not a collision guard.
   */
  private applyRoomResources(roomId: number): void {
    if (this.resolveRoom) {
      let room = this.tryResolveRoom(roomId);
      if (!room) {
        const alias = this.pseudoRooms.get(roomId);
        if (alias !== undefined && alias !== roomId) room = this.tryResolveRoom(alias);
      }
      this.loadedRoom = room;
      if (room) this.lastRoomLoadError = null;
    } else {
      this.loadedRoom = null;
    }

    if (this.loadedRoom && this.uiPaletteOverrides.size > 0) {
      const pal = this.loadedRoom.palette;
      for (const [idx, [r, g, b]] of this.uiPaletteOverrides) {
        if (idx >= 0 && idx < 256) {
          pal[idx * 3] = r;
          pal[idx * 3 + 1] = g;
          pal[idx * 3 + 2] = b;
        }
      }
    }
    // Capture the loaded palette as the base for `roomOps roomIntensity`
    // (darkenPalette), after UI overrides — the dance-step text in room 63
    // is drawn in the UI ink colour, so the base must include it.
    this.basePalette = this.loadedRoom ? this.loadedRoom.palette.slice() : null;

    // Draw every object already in a non-zero, image-backed state. SCUMM draws
    // room objects in their current state at room init, so a door left open
    // stays rendered open when you re-enter (its state persists in
    // objectStates) and a restored save shows the right object states. First
    // entry to a room has all states 0 (no DOBJ parse yet) → nothing queued,
    // so this is purely additive; state-0 / image-less objects are the bg.
    if (this.loadedRoom) {
      for (const [id, obj] of this.loadedRoom.objects) {
        const st = this.objectStates.get(id) ?? 0;
        if (st > 0 && obj.images.has(st)) this.objectDrawQueue.add(id);
      }
    }

  }

  /**
   * Set walk-box `boxId`'s flags (matrixOp setBoxFlags). Bit 0x80 locks the
   * box — the box-graph pathfinder excludes locked boxes, so a closed door's
   * corridor becomes impassable. The override is read live by each walk (see
   * {@link startWalk}'s `effectiveBoxes`), so nothing needs rebuilding here.
   */
  setBoxFlags(boxId: number, flags: number): void {
    this.boxFlagOverrides.set(boxId, flags);
  }

  /**
   * Reload the current room's resources (background, palette, z-planes,
   * scripts) into {@link loadedRoom} **without** running entry/exit
   * scripts or clearing per-room runtime state. For save-state restore:
   * the room's scripts are already represented by the restored slots, so
   * re-running ENCD would double them. `currentRoom`, `pseudoRooms`, and
   * `uiPaletteOverrides` must already be set when this is called.
   */
  reloadCurrentRoomResources(): void {
    if (this.currentRoom === 0) {
      this.loadedRoom = null;
      return;
    }
    this.applyRoomResources(this.currentRoom);
  }

  /**
   * Resolve a room id to its decoded resources, or `null` if it can't be
   * loaded (recording the error). Used by {@link applyRoomResources} to try
   * the requested room before falling back to a pseudo-room alias.
   */
  private tryResolveRoom(id: number): LoadedRoom | null {
    if (!this.resolveRoom) return null;
    try {
      const room = this.resolveRoom(id);
      this.lastRoomLoadError = null;
      return room;
    } catch (err) {
      this.lastRoomLoadError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Save-state access to the multi-page talk queue (the `talkPages` /
   * `talkPageDlg` / `talkPageSystem` private fields). Returns a copy;
   * {@link restoreTalkQueue} writes it back. Kept narrow so the queue's
   * internals stay private outside save/restore.
   */
  snapshotTalkQueue(): { pages: string[]; dlg: ActiveDialog | null; system: boolean } {
    return { pages: [...this.talkPages], dlg: this.talkPageDlg, system: this.talkPageSystem };
  }

  restoreTalkQueue(q: { pages: readonly string[]; dlg: ActiveDialog | null; system: boolean }): void {
    this.talkPages = [...q.pages];
    this.talkPageDlg = q.dlg;
    this.talkPageSystem = q.system;
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
    const obj = this.findObjectCode(objId);
    if (!obj) return null;
    const bytecode = findVerbScript(obj.verbs, verbId);
    if (!bytecode) return null;
    const slot = this.slots.find((s) => s.status === 'dead');
    if (!slot) return null;
    // Tag the slot with the room that actually owns the object's code:
    // the current room when it's a room object, else the carried item's
    // home room (so a verb script that reads its room context is right).
    const room = this.loadedRoom?.objects.has(objId)
      ? this.loadedRoom.id
      : this.resolveObjectRoom?.(objId) ?? this.loadedRoom?.id;
    // The startObject opcode's arg list maps DIRECTLY onto L0, L1, … — there
    // is NO implicit verb/object prepend. Evidence is in the game's own
    // bytecode (disassemble with scratch/dis.ts): sentence script #2 runs a
    // verb as `startObject obj=L1 script=4 [L2]` (give) and the general
    // `startObject obj=L1 script=L0 [L2,L0]`, and the verb bodies read those
    // positions — object 566 verb-7 tests `L0 == 574` (the second object in
    // "Usa carne con pentola"), and object 488 verb-250 (the money routine)
    // does `g195 += L0` (g195 = pieces of eight) then setOwnerOf(488, ego).
    // Prepending [verb, obj] put the verb id in L0, so verb-250 added 250
    // instead of 478 and never re-owned 488 — the Fettucini-cannon reward
    // ("478 pezzi da otto") never reached the inventory.
    slot.start({
      scriptId: objId,
      bytecode,
      args,
      room,
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
  ): ScriptSlot | null {
    // Starting script 0 is a silent no-op, not an error. The game issues it
    // in ordinary play: with a "Dai"/"Use" verb armed, the hover poller #23,
    // over an actor, runs a per-actor handler via the indexed table
    // `g396[actorId]` (= VAR(396 + actorId)) — 0 for an actor with no such
    // handler, so #23 does `startScript 0` (seen in the #23 disassembly,
    // scratch/dis.ts). Index slot 0 is an unused DSCR entry (owning room 0),
    // so resolving id 0 as a global would halt — yet the game hits this on a
    // normal hover, so it must be a no-op. (Repro: give the pot to a pirate in
    // room 51 — see scratch/repro-give-pot.ts.)
    if (scriptId <= 0) return null;

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
   * Stop every room-scoped script — room-local scripts (id ≥
   * {@link LSCR_THRESHOLD}) and object/verb scripts (synthetic `VERB-*`
   * slots) — leaving global scripts and the freshly-started ENCD/EXCD
   * (scriptId 0) alone. SCUMM's `startScene` does this on every room
   * change so an old room's ambient/animation loops don't bleed into the
   * next room. Called by {@link enterRoom}.
   */
  private stopRoomLocalScripts(): void {
    for (const s of this.slots) {
      if (s.status === 'dead') continue;
      if (s.scriptId >= Vm.LSCR_THRESHOLD || s.label.startsWith('VERB-')) {
        s.kill();
      }
    }
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
        // Run #18 nested (to completion) so its freezeScripts takes effect
        // before the caller's next opcode — and before endCutscene starts
        // #19. See runScriptNested.
        const s = this.startScriptById(startScript, { args });
        if (s) this.runScriptNested(s);
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
    // Ending a cutscene restores the screen (SCUMM's restoreCharsetBg), so a
    // transient print left up during it is erased now — the cook's kitchen
    // warning, the map close-up's dance steps. keepText (signs/credits/titles)
    // survives; it clears only on overwrite or room change.
    this.eraseTransientSystemText();
    const endScript = this.vars.readGlobal(Vm.VAR_CUTSCENE_END_SCRIPT);
    if (endScript > 0) {
      try {
        // Run #19 nested so it un-freezes scripts / restores input in order,
        // not queued behind the start script's freeze. See runScriptNested.
        const s = this.startScriptById(endScript, { args: frame?.args ?? [] });
        if (s) this.runScriptNested(s);
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
      const slot = this.startScriptById(scriptId, {
        args: [clickArea, code, button],
        label: `INPUT-${clickArea}-${code}-${button}`,
      });
      this.wdNoteInput();
      return slot;
    } catch {
      // Script not resolvable (e.g. a local id with no current room) —
      // a click with no usable input script is a no-op, not a crash.
      return null;
    }
  }

  // ─── Hang watchdog (opt-in dev aid) ─────────────────────────────────
  //
  // The "input does nothing" detector. Enable it during play/testing and
  // it watches each click (every runInputScript) for a settle window; if
  // `deadInputThreshold` clicks in a row each leave the game with NO
  // observable progress, it fires the sink. "Progress" is deliberately the
  // set of things a click is *meant* to cause — a room change, speech, a
  // committed sentence, a new running script, or a walk command — NOT raw
  // var/animation churn (the music timer ticks every jiffy; idle costumes
  // cycle frames). Fingerprinting only progress signals is what keeps it
  // from drowning in ambient noise. Off by default → the per-frame check
  // is a single null test, so zero cost when disabled.
  private hangWatchdog: {
    sink: (info: HangInfo) => void;
    settle: number;
    threshold: number;
  } | null = null;
  private wdDeadInputs = 0;
  private wdSettleLeft = 0;
  private wdChanged = false;
  private wdPre = '';
  /** Monotonic progress counters the watchdog watches (never decrease, so a
   *  transient talk/sentence still registers; immune to anim/timer churn). */
  private talkSeq = 0;
  private sentenceSeq = 0;

  /**
   * Turn on the hang watchdog. `sink` receives a {@link HangInfo} when a
   * run of dead clicks is detected. `settleFrames` is how many game frames
   * to wait for a click's effect before judging it (default 12 ≈ ~1s at
   * MI1's ~10 fps); `deadInputThreshold` is how many dead clicks in a row
   * trip it (default 3). Idempotent; pass a fresh sink to replace.
   */
  enableHangWatchdog(
    sink: (info: HangInfo) => void,
    opts: { settleFrames?: number; deadInputThreshold?: number } = {},
  ): void {
    this.hangWatchdog = {
      sink,
      settle: Math.max(1, opts.settleFrames ?? 12),
      threshold: Math.max(1, opts.deadInputThreshold ?? 3),
    };
    this.wdDeadInputs = 0;
    this.wdSettleLeft = 0;
    this.wdChanged = false;
  }

  /** Disable the hang watchdog. */
  disableHangWatchdog(): void {
    this.hangWatchdog = null;
  }

  /**
   * Snapshot of *progress-only* state — see {@link hangWatchdog}. Includes
   * only things a click is meant to cause and that don't churn on their own:
   * the room, the monotonic talk/sentence counters, and any commanded walk.
   * Deliberately NOT the live-script set (a click always transiently spawns
   * the verb-redraw script #12 — that's not progress) nor raw vars (the music
   * timer ticks every jiffy; costumes cycle frames).
   */
  private wdFingerprint(): string {
    let walks = '';
    for (const a of this.actors.all()) {
      walks += a.walkTarget ? `${a.walkTarget.x}:${a.walkTarget.y};` : '-;';
    }
    return `r${this.currentRoom}|t${this.talkSeq}|s${this.sentenceSeq}|W${walks}`;
  }

  /** A click fired: open (or restart) a settle window. */
  private wdNoteInput(): void {
    if (!this.hangWatchdog) return;
    // A new click while the previous window is still open: resolve the old
    // one first so each click gets its own verdict (a burst of dead clicks
    // still counts as several).
    if (this.wdSettleLeft > 0) this.wdResolve();
    this.wdPre = this.wdFingerprint();
    this.wdSettleLeft = this.hangWatchdog.settle;
    this.wdChanged = false;
  }

  /** Per-frame: watch the open window for any progress, then judge it. */
  private wdFrameCheck(): void {
    if (!this.hangWatchdog || this.wdSettleLeft <= 0) return;
    if (!this.wdChanged && this.wdFingerprint() !== this.wdPre) this.wdChanged = true;
    this.wdSettleLeft--;
    if (this.wdSettleLeft === 0) this.wdResolve();
  }

  /** Settle window closed: bump or reset the dead-input run; fire at threshold. */
  private wdResolve(): void {
    const wd = this.hangWatchdog;
    if (!wd) return;
    this.wdSettleLeft = 0;
    if (this.wdChanged) {
      this.wdDeadInputs = 0;
      return;
    }
    this.wdDeadInputs++;
    if (this.wdDeadInputs >= wd.threshold) {
      wd.sink({
        deadInputs: this.wdDeadInputs,
        room: this.currentRoom,
        verbScript: this.vars.readGlobal(Vm.VAR_VERB_SCRIPT),
        liveScripts: this.slots.filter((s) => s.status !== 'dead').map((s) => s.scriptId),
      });
      this.wdDeadInputs = 0; // re-arm: warn again after another run
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
    this.sentenceSeq++; // progress signal for the hang watchdog
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
    this.dispatchSlot(slot);
    return slot;
  }

  /**
   * Run one specific slot to completion *right now* — SCUMM's nested
   * `runScript`. Steps only `slot` until it dies, yields (`breakHere`), or
   * freezes, leaving every other slot untouched. Used for scripts that must
   * finish before the caller's next opcode rather than being queued behind
   * it: the cutscene start/end scripts (#18/#19). Queuing them instead
   * scrambles ordering — the start script's `freezeScripts` would run *after*
   * the end script was created and freeze it, deadlocking input (the
   * room-33 "open the SCUMM Bar door" freeze). A `breakHere` mid-script just
   * yields it back to the normal per-frame scheduler — no different from any
   * other yielded slot. Capped against runaway loops.
   */
  runScriptNested(slot: ScriptSlot, maxSteps = 100_000): void {
    let count = 0;
    while (slot.runnable && !this._haltInfo && count < maxSteps) {
      this.dispatchSlot(slot);
      count++;
    }
  }

  /** Dispatch a single opcode in `slot`. Shared by {@link step} (next
   *  runnable slot) and {@link runScriptNested} (one specific slot). */
  private dispatchSlot(slot: ScriptSlot): void {
    if (slot.pc >= slot.bytecode.length) {
      this.haltFromOpcode(
        slot,
        0,
        `pc=${slot.pc} past end of bytecode (len=${slot.bytecode.length})`,
      );
      return;
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
      return;
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
      return;
    }

    this.appendTrace({
      slotIndex: slot.slotIndex,
      scriptId: slot.scriptId,
      pc: opcodePc,
      opcode,
      ...(this.lastAnnotation !== undefined && { mnemonic: this.lastAnnotation }),
    });
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
      if (this.talkDelay === 0) this.advanceOrEndTalk();
    }
  }

  /**
   * The current talk page is finished — its timer drained, or the player
   * skipped it (see {@link skipText}). Either flip to the next queued
   * sentence page or end the message. Shared by the talk timer
   * ({@link beginTick}) and the manual skip so both behave identically.
   */
  private advanceOrEndTalk(): void {
    if (this.talkPages.length > 0) {
      // More sentence pages queued — flip to the next one and re-arm the
      // timer instead of ending the message. VAR_HAVE_MSG stays set
      // (beginTalk re-asserts it), so a wait-for-message keeps blocking
      // until the final page finishes.
      const next = this.talkPages.shift()!;
      const dlg: ActiveDialog = { ...this.talkPageDlg!, text: next };
      if (this.talkPageSystem) this.addSystemText(dlg);
      else this.activeDialog = dlg;
      this.beginTalk(next);
    } else {
      this.vars.writeGlobal(Vm.VAR_HAVE_MSG, 0);
      const d = this.activeDialog;
      if (d && d.actorId >= 1 && d.actorId <= this.actors.capacity && !d.keepText) {
        this.activeDialog = null;
      }
      // System text is NOT dropped here. The talk timer only governs actor
      // speech and VAR_HAVE_MSG (so `wait forMessage` releases); a `print`'s
      // on-screen text persists until it's overwritten by the next transient
      // print, the room changes, or a cutscene ends ({@link endCutscene}) —
      // SCUMM's restoreCharsetBg, not the talk timer. The treasure-map close-up
      // (room 63) prints its dance steps then waits for a *click*, not a
      // message, so timer-dropping it erased the map text after ~1s; the cook's
      // "Non puoi venire di qui!" instead clears at its `endCutScene`.
    }
  }

  /**
   * Skip the current line of speech — the player's `.` (dot) key, the
   * per-line analogue of {@link abortCutscene}'s whole-scene skip. ScummVM
   * maps the dot to "advance past the current spoken line": one press drains
   * the current talk page, flipping to the next queued page if any, else
   * ending the message (clears `VAR_HAVE_MSG` so a wait-for-message releases).
   * No-op when nothing is being said (`talkDelay <= 0`); returns whether it
   * skipped anything. Distinct from `abortCutscene` — this ends one line, not
   * the scene.
   */
  skipText(): boolean {
    if (this.talkDelay <= 0) return false;
    this.talkDelay = 0;
    this.advanceOrEndTalk();
    return true;
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
    // Per-jiffy: input/cursor mirror, music + talk timers. (Camera-follow is
    // NOT here — it runs once per game frame after the walk; see below.)
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
    // Arm SCUMM's per-cycle `restoreCharsetBg`: the first transient system
    // print this frame erases last frame's transient text (see systemTexts).
    this.systemTextRestorePending = true;
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
    // Camera-follow runs here — once per game frame, *after* the walk — not in
    // beginTick (per-jiffy, before the walk). The followed actor only moves in
    // stepAllActorWalks, so following it beforehand left the camera a frame
    // behind: the presented frame showed the actor at its new position against
    // a camera based on its old one, then the camera caught up on the next
    // jiffy while the actor sat still — the actor's screen position oscillated
    // (stutter / "two Guybrush"). Following after the walk keeps (actor, camera)
    // consistent within the single tick the session then presents.
    // A scripted smooth pan (panCameraTo) advances first; it detaches the
    // follow, so the two never fight over camera.x in one frame.
    this.stepCameraPan();
    this.moveCameraFollow();
    this.wdFrameCheck();
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
   * Clamp a camera-centre X to the loaded room's valid range. A script-set
   * roomScroll (roomOps 0x01 → VAR_CAMERA_MIN/MAX) overrides the default
   * full-width bounds. Raw value when no room is loaded.
   */
  clampCameraX(x: number): number {
    const room = this.loadedRoom;
    if (!room) return x;
    const half = 160;
    const min = this.roomScroll ? this.roomScroll.min : Math.min(half, room.width);
    const max = this.roomScroll ? this.roomScroll.max : Math.max(min, room.width - half);
    return Math.max(min, Math.min(max, x));
  }

  /**
   * Move the camera centre to `x` (already clamped). A change scrolls the
   * screen, which in the original redraws the background strips and so erases
   * transient blasted system text (restoreCharsetBg) — see
   * {@link eraseTransientSystemText}. No-op (and no erase) when unchanged.
   */
  moveCameraTo(x: number): void {
    if (x === this.camera.x) return;
    this.camera.x = x;
    this.eraseTransientSystemText();
  }

  /**
   * Advance an in-progress `panCameraTo` by one game frame: step the camera
   * centre {@link CAMERA_PAN_STEP}px toward {@link cameraDest}, clearing the
   * target on arrival. No-op when the camera is at rest.
   */
  stepCameraPan(): void {
    if (this.cameraDest === null) return;
    const dest = this.cameraDest;
    const cur = this.camera.x;
    const next =
      cur < dest
        ? Math.min(dest, cur + CAMERA_PAN_STEP)
        : Math.max(dest, cur - CAMERA_PAN_STEP);
    this.moveCameraTo(next);
    if (next === dest) this.cameraDest = null;
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
    this.moveCameraTo(this.clampCameraX(x));
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
    this.talkSeq++; // progress signal for the hang watchdog
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
   * The owner of an object. An explicit entry (set by `pickupObject` /
   * `setOwnerOf`, or restored from a save) always wins. With no entry, an
   * object present in the **currently loaded room** is owned by the room
   * ({@link OF_OWNER_ROOM} = 15) — its faithful initial state, since we don't
   * yet parse the index's `DOBJ` owner/state directory; anything else is
   * nobody (0). Backs the `getObjectOwner` opcode. Keeping the room default
   * here (not in {@link objectOwners}) leaves {@link inventoryCount} /
   * {@link findInventory} — which scan the map for a matching actor id —
   * untouched (15 is never a real actor).
   */
  getObjectOwner(obj: number): number {
    const explicit = this.objectOwners.get(obj);
    if (explicit !== undefined) return explicit;
    return this.loadedRoom?.objects.has(obj) ? OF_OWNER_ROOM : 0;
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
   * Resolve an object-or-actor display name. Mirrors SCUMM's
   * `getObjOrActorName`: a low id (within the actor table) is an actor,
   * resolved to its `setActorName` name; everything else is an object.
   * For objects: checks a `setObjectName` override, then the current
   * room's object table (room objects + just-picked-up items), then the
   * carried-item snapshot in {@link inventoryNames} (for items carried
   * out of their pickup room). Returns `undefined` when the name is
   * unknown so callers can fall back to an `obj #N` placeholder.
   */
  objectName(objId: number): string | undefined {
    // Actor-or-object split: ids 1..actor-table-size are actors (the same
    // rule objActPos / faceActor use). An unnamed actor falls through to
    // `undefined`, not the object table — its id never names an object.
    if (objId >= 1 && objId <= this.actors.capacity) {
      const name = this.actors.get(objId).name;
      return name !== '' ? name : undefined;
    }
    // A `setObjectName` ($54) rename takes priority over both the room's
    // OBNA and the pickup-time snapshot — it's an explicit in-place
    // overwrite (SCUMM rewrites the OBNA buffer; e.g. obj 488's
    // "@@@@@ pezzi da otto@@@@" → "500 pezzi da otto").
    const renamed = this.objectNameOverrides.get(objId);
    if (renamed !== undefined) return renamed;
    const inRoom = this.loadedRoom?.objects.get(objId)?.name;
    if (inRoom) return inRoom;
    const carried = this.inventoryNames.get(objId);
    if (carried) return carried;
    return undefined;
  }

  /**
   * Override an object's display name in place — backs `setObjectName`
   * ($54/$D4). Wins over the room OBNA and the {@link inventoryNames}
   * snapshot (see {@link objectName}) and persists across rooms and saves,
   * mirroring SCUMM's in-place OBNA rewrite.
   */
  setObjectName(objId: number, name: string): void {
    this.objectNameOverrides.set(objId, name);
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
      const b = this.actorHitBounds(actor.id);
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
   * An actor's on-screen sprite box in room pixels — the rectangle
   * `actorFromPos` hit-tests against. The compositor stamps `drawBounds`
   * each painted frame; headless (no render) it's null, so we derive the
   * same box from the current costume+anim+pos via the shared
   * {@link prepareActorDraw} — so an actor click resolves identically with
   * or without a framebuffer. Returns null when the actor has no costume or
   * nothing would draw.
   */
  actorHitBounds(actorId: number): { left: number; top: number; right: number; bottom: number } | null {
    const actor = this.actors.get(actorId);
    if (!actor) return null;
    if (actor.drawBounds) return actor.drawBounds;
    const costume = actor.costume > 0 ? this.getCostume(actor.costume) : null;
    return costume ? prepareActorDraw(actor, costume).bounds : null;
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
    this.objectNameOverrides.clear();
    this.objectClasses.clear();
    this.boxFlagOverrides.clear();
    this.objectDrawQueue.clear();
    this.objectDrawPositions.clear();
    this.currentRoom = 0;
    this.frameAccumulator = 0;
    this.loadedRoom = null;
    this.basePalette = null;
    this.lastRoomLoadError = null;
    this.uiPaletteOverrides.clear();
    this.charsetColorMap = [];
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
    this.cameraDest = null;
    this.screen.top = 0;
    this.screen.bottom = 200;
    this.screenEffect.switchRoomEffect = 0;
    this.screenEffect.switchRoomEffect2 = 0;
    this.screenEffect.requestFadeIn = false;
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
