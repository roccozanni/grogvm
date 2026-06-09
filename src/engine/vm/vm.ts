/**
 * SCUMM v5 interpreter mainline — script scheduling, world state, and the
 * canonical per-jiffy tick. See pages/docs/engine/architecture.md and
 * pages/docs/scumm/timing.md.
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
import { type AudioBackend, SilentTimingBackend } from '../sound/backend';
import { parseSound, type SoundResource } from '../sound/resource';

/** Jiffies per game frame when `VAR_TIMER_NEXT` is unset / out of range (MI1: 6 ≈ 10 fps). */
const DEFAULT_FRAME_INTERVAL = 6;
/**
 * `panCameraTo` pan speed, px per game frame. 8 keeps the centre
 * strip-aligned; tuned against the room-64 dig pan.
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
 * Fired by the opt-in hang watchdog ({@link Vm.enableHangWatchdog}) when a
 * run of consecutive clicks each produced no observable progress — the live
 * symptom of a script parked waiting on a var the input never sets.
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

/** An in-progress print / printEgo message, read by the renderer each frame. */
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
   * Actor talk with no explicit `SO_COLOR`: render with the speaker's
   * `talkColor` re-read LIVE each frame, not the {@link color} snapshot —
   * a colour set *after* the `print` must still tint the line.
   */
  readonly colorFromActor?: boolean;
  /** Centre text around `x` rather than left-anchor. */
  readonly center: boolean;
  /** Position above the speaking actor's head. */
  readonly overhead: boolean;
  /** Max x bound from SO_CLIPPED (informational; no wrap yet). */
  readonly clipped: number | null;
  /**
   * Message carried the `keepText` code (`0xFF 0x02`): persists until an
   * explicit clear or overwrite, NOT when the talk timer drains. See
   * pages/docs/scumm/char.md. Only meaningful for system text.
   */
  readonly keepText?: boolean;
}

/** A rectangle painted by `drawBox` (0x3F). Coords are inclusive screen
 *  pixels; `color` is a CLUT index. See {@link Vm.drawnBoxes}. */
export interface DrawnBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly color: number;
}

/** One verb-bar slot, configured by the `verbOps` opcode (0x7A / 0xFA). */
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
   * Charset id captured at verb create/rename (SCUMM's per-verb `charset_nr`)
   * — verbs must NOT redraw in whatever charset dialogue last selected.
   */
  charset: number;
  /** Whether the rendered name is centred around `x` rather than left-aligned. */
  centered: boolean;
  /**
   * Image-backed verb: the object (and owning room) drawn in this slot
   * instead of a text name (`verbOps` setImage / setImageInRoom). `null` for
   * text verbs; `setName` clears back to text. See pages/docs/scumm/input.md.
   */
  image: { obj: number; room: number } | null;
  /**
   * `on` hit-tests + paints; `dim` paints dimmed and rejects clicks; `off`
   * is hidden but preserved; `deleted` is fully removed.
   */
  state: 'on' | 'off' | 'dim' | 'deleted';
}

export const NUM_SLOTS = 25;
const TRACE_CAPACITY = 64;

/** Talk-timer floor so even a 1-char line lingers (~0.5 s at 60 Hz). */
const MIN_TALK_TICKS = 30;
/** Global #4 = current-room id per the SCUMM v5 wiki. */
const VAR_ROOM_INDEX = 4;
/**
 * SCUMM's `OF_OWNER_ROOM`: owner value for an object still in its room. MI1's
 * sentence script gates walk-to-object on owner == 15, so a room object MUST
 * read as 15. See pages/docs/scumm/objects.md.
 */
const OF_OWNER_ROOM = 15;

/** Resolve a global script id to its loaded bytecode + owning room. */
export type GlobalScriptResolver = (
  scriptId: number,
) => { readonly bytecode: Uint8Array; readonly room: number };

/** Decode a room id to a fully-loaded room. Throws on unknown ids. */
export type RoomResolver = (roomId: number) => LoadedRoom;

/** Decode a costume id to its parsed data. Throws on unknown ids; results are cached. */
export type CostumeResolver = (costumeId: number) => LoadedCostume;

/**
 * Resolve a SCUMM charset id to its parsed header + payload, or `null` when
 * unresolvable / built-in.
 */
export type CharsetResolver = (
  charsetId: number,
) => { header: CharsetHeader; payload: Uint8Array } | null;

/**
 * Resolve a global object id to the room whose OBCD defines it (`null` when
 * none). Object ids are globally unique, so this is an object's stable home
 * room — used to reach a carried item's verb scripts off-room.
 */
export type ObjectRoomResolver = (objId: number) => number | null;

/** Resolve a sound id to its `SOUN` block payload, or `null` when unused / unresolvable. */
export type SoundResolver = (soundId: number) => Uint8Array | null;

export interface VmInit {
  readonly numVariables: number;
  readonly numBitVariables: number;
  readonly numRoomVariables?: number;
  readonly handlers: ReadonlyMap<number, OpcodeHandler>;
  readonly resolveGlobalScript?: GlobalScriptResolver;
  readonly resolveRoom?: RoomResolver;
  readonly resolveCostume?: CostumeResolver;
  /** Held for the shell's text renderer — the VM itself doesn't render. */
  readonly resolveCharset?: CharsetResolver;
  readonly resolveObjectRoom?: ObjectRoomResolver;
  readonly resolveSound?: SoundResolver;
  /**
   * CD-audio track durations in jiffies, keyed by track number (read from
   * the `TrackN.fla` headers up front). A missing track leaves that
   * CD-gated wait non-blocking.
   */
  readonly cdTrackDurations?: ReadonlyMap<number, number>;
  /** Timing authority `isSoundRunning` polls; defaults to {@link SilentTimingBackend}. */
  readonly audio?: AudioBackend;
  /**
   * Entropy for `getRandomNumber`, in `[0, 1)`; defaults to `Math.random`.
   * Tests inject a seeded source for reproducible playthroughs. Deliberately
   * NOT part of the save snapshot — the original engine never saves its RNG
   * state either, so post-restore draws diverging from the live run is correct.
   */
  readonly random?: () => number;
}

export class Vm {
  readonly vars: Variables;
  readonly slots: ReadonlyArray<ScriptSlot>;
  /** Engine string resources, created/mutated by the `stringOps` (0x27) family. */
  readonly strings = new Map<number, Uint8Array>();
  /**
   * Per-object state byte — selects the OBIM image variant and verb-bank
   * entry. See pages/docs/scumm/objects.md.
   */
  readonly objectStates = new Map<number, number>();
  /** Per-object owner actor id; 0 = nobody (still in the room). */
  readonly objectOwners = new Map<number, number>();
  /**
   * Object names snapshotted at pickup — OBNA lives only in the object's
   * home room, so a carried item's name must survive leaving it. Fallback
   * behind the current room in {@link objectName}.
   */
  readonly inventoryNames = new Map<number, string>();
  /** Object-id → name set by `setObjectName` ($54); wins over OBNA. */
  readonly objectNameOverrides = new Map<number, string>();
  /**
   * Per-object class bitmask (`actorSetClass` / `ifClassOfIs`). Class N
   * occupies bit `N-1` — classes are 1-based in v5.
   */
  readonly objectClasses = new Map<number, number>();
  /**
   * Per-box walk-flag overrides for the CURRENT room (matrixOp setBoxFlags),
   * layered over the disk flags and read live by the pathfinder. Reset on
   * room change; saved because a restore does NOT re-run the entry script.
   * See pages/docs/engine/pathfinding.md.
   */
  readonly boxFlagOverrides = new Map<number, number>();
  /**
   * Object ids the compositor includes next frame; cleared on room change.
   * Order is insignificant in v5 — stacking comes from per-object z-planes.
   */
  readonly objectDrawQueue = new Set<number>();
  /**
   * Runtime positions from `drawObject … at x,y` (x in strips → ×8, y in
   * pixels); wins over the IMHD default until the next reposition. Cleared
   * on room change. See pages/docs/scumm/objects.md.
   */
  readonly objectDrawPositions = new Map<number, { x: number; y: number }>();
  /**
   * `drawBox` rectangles, re-applied over the background each frame — SCUMM
   * paints them into the virtual screen, but we rebuild the framebuffer from
   * `room.indexed` every frame. Cleared on room change (the redraw that
   * erases them in SCUMM).
   */
  readonly drawnBoxes: DrawnBox[] = [];
  /**
   * `roomOps shakeOn/shakeOff`; cleared on room change. The shake waveform is
   * engine-internal (not in the bytecode), so the renderer's jitter is an
   * approximation pending in-browser tuning.
   */
  shakeEnabled = false;
  /** Currently-loaded room id per the VM; 0 = no room yet. */
  currentRoom = 0;
  /** Jiffies elapsed toward the next game frame — see {@link tick}. */
  private frameAccumulator = 0;
  /** Decoded data for the current room; `null` until the first successful `loadRoom`. */
  loadedRoom: LoadedRoom | null = null;
  /**
   * The room palette as decoded at load (CLUT + UI overrides), before any
   * script mutation. `roomOps roomIntensity` scales the live palette from
   * THIS base, not from itself — a blacked-out screen must fade back to the
   * original colours. Re-captured every {@link applyRoomResources}.
   */
  basePalette: Uint8Array | null = null;
  /** Last room-load error, surfaced by the inspector — `loadRoom` failures don't halt. */
  lastRoomLoadError: string | null = null;
  /**
   * Pseudo-room alias table from `pseudoRoom` (0xCC): alias id → the real
   * room whose resources back it. See pages/docs/scumm/room.md.
   */
  readonly pseudoRooms = new Map<number, number>();
  /**
   * Pending restart/pause/quit from `systemOps` (0x98). Recorded, not acted
   * on — a script-triggered shutdown must not kill the inspector mid-debug.
   */
  systemRequest: 'restart' | 'pause' | 'quit' | null = null;
  readonly actors = new ActorTable(DEFAULT_ACTOR_COUNT);
  /** Costumes decoded on demand by {@link Vm.getCostume}, keyed by id. */
  readonly costumes = new Map<number, LoadedCostume>();
  /**
   * Mouse position in native ROOM coordinates (pre-2× scale, adjusted for
   * camera scroll), written by the shell; mirrored into VAR_MOUSE_X/Y.
   */
  mouseRoomX = 0;
  mouseRoomY = 0;
  /**
   * Cursor / userput COUNTERS (soft on/off nest with ++/--; hard on/off set
   * 1/0), mirrored into VAR_CURSORSTATE / VAR_USERPUT. See
   * pages/docs/scumm/input.md.
   */
  readonly cursor = { state: 0, userput: 0 };
  /** Charset id for text rendering, from `cursorCommand initCharset`; 0 = none yet. */
  currentCharset = 0;
  /** Verb-slot table keyed by verb id, populated by `verbOps`. */
  readonly verbs = new Map<number, VerbSlot>();
  /**
   * Verb states stashed by `saveRestoreVerbs` save, keyed by verb id — the
   * cutscene start script hides the bar; the end script restores it.
   */
  readonly savedVerbStates = new Map<number, VerbSlot['state']>();
  /** Pending sentences — LIFO: `doSentence` pushes, {@link processSentence} pops the newest. */
  readonly sentenceStack: Sentence[] = [];
  /**
   * Active cutscene frames (`cutscene` pushes, `endCutscene` pops); nesting
   * allowed. See pages/docs/scumm/cutscenes.md.
   */
  readonly cutsceneStack: Array<{
    readonly room: number;
    readonly callerSlot: number;
    readonly args: ReadonlyArray<number>;
  }> = [];
  /**
   * Actor speech currently showing; `null` outside a print. `x/y` are
   * absolute room coords from `SO_AT`; `null` = above the speaker's head.
   * See pages/docs/scumm/char.md for the two-channel text model.
   */
  activeDialog: ActiveDialog | null = null;
  /**
   * Blasted system text (prints with no real speaker) — a channel separate
   * from {@link activeDialog}; the two coexist and must not mask each other.
   * Lifetime follows SCUMM's `restoreCharsetBg` blast model — see
   * pages/docs/scumm/char.md. Mutate via {@link addSystemText} /
   * {@link clearSystemText}, not directly.
   */
  systemTexts: ActiveDialog[] = [];

  /**
   * Armed each game frame; consumed by the frame's first transient
   * {@link addSystemText}, which erases the prior frame's transient text
   * (SCUMM's `restoreCharsetBg`). Not saved — it re-arms next tick.
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
   * Blast one system line. The first transient line of a new display cycle
   * erases the previous cycle's transient text first (keepText survives);
   * a line at an already-occupied anchor replaces it.
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
   * camera scroll) wipes *transient* blasted text but leaves keepText lines.
   */
  eraseTransientSystemText(): void {
    if (this.systemTexts.some((s) => !s.keepText)) {
      this.systemTexts = this.systemTexts.filter((s) => s.keepText);
    }
  }
  /**
   * Remaining sentence pages of the current message (text after each
   * `\xff\x03` wait code); the talk timer flips to the next page as each
   * page's delay drains. Empty for single-page lines — the common case.
   */
  private talkPages: string[] = [];
  /** The dialog template (style/channel) the queued pages reuse. */
  private talkPageDlg: ActiveDialog | null = null;
  /** Whether the queued pages render on the system channel vs actor speech. */
  private talkPageSystem = false;
  /**
   * SCUMM `_string[0]` for *system* prints: position/colour/centre are
   * STICKY — a bare `print` reuses the last positioned print's fields (the
   * MI1 credits rely on this). Actor talk never reads it.
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
   * Ticks the current message remains "said"; when it drains, `VAR_HAVE_MSG`
   * clears. This paces dialog — `wait`-for-message blocks while it's set.
   */
  talkDelay = 0;
  /**
   * Camera position. `x` is the CENTRE of the viewport in room coords (SCUMM
   * convention): the visible slice is `[x - 160, x + 160)`.
   */
  readonly camera = { x: 0 };
  /**
   * Palette overrides from `setPalColor` while NO room is loaded (boot UI
   * scripts), re-applied on top of every room's CLUT on load — the room's
   * placeholder low palette would otherwise clobber the UI colours each
   * room change. See pages/docs/scumm/lighting.md.
   */
  readonly uiPaletteOverrides = new Map<number, readonly [number, number, number]>();
  /**
   * Charset colour map from `cursorCommand charsetColor`: glyph pixel value
   * → CLUT index. See pages/docs/scumm/char.md.
   */
  charsetColorMap: number[] = [];
  /**
   * Camera-centre bounds from `roomOps roomScroll`; `null` = default
   * `[160, width-160]`. Values are floored at 160, matching the original.
   * Cleared on room change.
   */
  roomScroll: { min: number; max: number } | null = null;
  /** Actor the camera tracks (0 = none); see {@link moveCameraFollow}. */
  cameraFollowActor = 0;
  /**
   * Target of an in-progress `panCameraTo`, or `null` at rest; `wait
   * forCamera` blocks while non-null. Transient — not part of save state.
   */
  cameraDest: number | null = null;
  /**
   * `roomOps screenEffect` state. v5 packs fade-in (low byte) and fade-out
   * (high byte) into one operand; operand 0 requests an immediate fade-in.
   * Effect numbers are recorded but the transition animations are not yet
   * implemented. See pages/docs/scumm/screen-effect.md.
   */
  readonly screenEffect = { switchRoomEffect: 0, switchRoomEffect2: 0, requestFadeIn: false };
  /**
   * Playable-screen vertical bounds from `roomOps setScreen`: rows
   * `[top, bottom)` are the camera viewport (MI1: 0–144; below is the verb
   * bar). Defaults to full screen until a script sets it.
   */
  readonly screen = { top: 0, bottom: 200 };
  /**
   * Sticky pointer-button hold state from the shell, for diagnostics —
   * discrete clicks are event-driven, not polled from these flags.
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
  readonly resolveSound: SoundResolver | undefined;
  /** CD-audio track durations (jiffies) by track number; see {@link VmInit.cdTrackDurations}. */
  readonly cdTrackDurations: ReadonlyMap<number, number> | undefined;
  /** Audio timing authority — see {@link AudioBackend}. */
  readonly audio: AudioBackend;
  /** Parsed sound resources, cached by id (SOUN data is immutable). */
  private readonly soundResourceCache = new Map<number, SoundResource>();
  /**
   * OBCD cache for carried items, resolved from each object's home room on
   * first off-room use. OBCD is immutable, so entries never go stale.
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
   * Engine-acted var indices — the canonical table + reconciliation notes
   * live in `vars.ts`; re-exposed as statics for existing call sites.
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
  /** Id of the input script (the verb/click hook); MI1 writes 201. */
  static readonly VAR_VERB_SCRIPT = VARS.VAR_VERB_SCRIPT;
  /** Set to 0 by `cutscene`/`endCutscene`; bumped by `beginOverride`. */
  static readonly VAR_OVERRIDE = VARS.VAR_OVERRIDE;
  /** Scripts run by `cutscene` (start) / `endCutscene` (end). MI1: 18 / 19. */
  static readonly VAR_CUTSCENE_START_SCRIPT = VARS.VAR_CUTSCENE_START_SCRIPT;
  static readonly VAR_CUTSCENE_END_SCRIPT = VARS.VAR_CUTSCENE_END_SCRIPT;
  /**
   * Id of the inventory script, run on every inventory change to lay items
   * into the inventory verb slots. MI1 = #9. See pages/docs/scumm/input.md.
   */
  static readonly VAR_INVENTORY_SCRIPT = VARS.VAR_INVENTORY_SCRIPT;

  /** SCUMM v5 reserves script ids >= 200 for room-local LSCR scripts. */
  static readonly LSCR_THRESHOLD = 200;

  /**
   * Click-area codes passed to the input script's `local0`. GUESSED from the
   * common v5 convention — only the notification hook reads them, not the
   * core sentence flow. MI1's #201 acts on area 4 (likely key).
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
    this.resolveSound = init.resolveSound;
    this.cdTrackDurations = init.cdTrackDurations;
    this.audio = init.audio ?? new SilentTimingBackend();
    this.randomSource = init.random ?? Math.random;
  }

  /**
   * Parsed timing for a sound id, cached (SOUN data is immutable).
   * Unresolvable ids yield a non-gating 0-jiffy resource so a sound-gated
   * busy-wait can never hang.
   */
  getSoundResource(id: number): SoundResource {
    let res = this.soundResourceCache.get(id);
    if (res === undefined) {
      const bytes = this.resolveSound ? this.resolveSound(id) : null;
      res = parseSound(bytes, (track) => this.cdTrackDurations?.get(track) ?? 0);
      this.soundResourceCache.set(id, res);
    }
    return res;
  }

  /** Entropy source for {@link randomInt}; see {@link VmInit.random}. */
  private readonly randomSource: () => number;

  /** Random integer in `[0, max]` INCLUSIVE — the `getRandomNumber` contract. */
  randomInt(max: number): number {
    return Math.floor(this.randomSource() * (max + 1));
  }

  /**
   * An object's code (verb scripts, name, CDHD) whether it sits in the
   * current room or is carried: SCUMM keeps a picked-up object's OBCD
   * resident, so carried items re-resolve from their home room (cached).
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
   * Room transition per SCUMM v5 `startScene`: old room's EXCD (nested) →
   * stop room-scoped scripts → load resources → new room's ENCD (nested).
   * See pages/docs/engine/room-transitions.md.
   */
  enterRoom(roomId: number): void {
    // New room = fresh draw queue; the ENCD repopulates it.
    this.objectDrawQueue.clear();
    this.objectDrawPositions.clear();
    this.drawnBoxes.length = 0;
    this.shakeEnabled = false;
    // Clear blasted text BEFORE the new ENCD runs, so a title the ENCD
    // prints survives while the old room's text doesn't linger.
    this.clearSystemText();
    this.roomScroll = null;
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
        // Nested per SCUMM's runExitScript: EXCD must finish before the
        // loadRoom opcode returns, or it clobbers the caller's next writes.
        // See pages/docs/engine/room-transitions.md.
        this.runScriptNested(excd);
      } catch {
        // No free slot — silently skip. EXCD running is best-effort.
      }
    }

    // SCUMM's startScene stops every room-local and object/verb script on a
    // room change (only globals survive) — after EXCD (scriptId 0, spared),
    // before the new ENCD.
    this.stopRoomLocalScripts();

    // Box walk-flags reset to the room's disk values on a room change; the
    // new ENCD re-applies any door locks.
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
        // Nested, same as the EXCD above — runs to its first yield before
        // the loadRoom opcode returns.
        this.runScriptNested(encd);
      } catch {
        // No free slot — silently skip.
      }
    }
  }

  /**
   * Decode `roomId` into {@link loadedRoom}, re-applying the UI palette
   * overrides on top of the fresh CLUT. Pseudo-room aliases are a FALLBACK,
   * consulted only when the direct load fails (see pages/docs/scumm/room.md).
   * Does NOT run entry/exit scripts.
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
    // Base for `roomOps roomIntensity` — captured AFTER the UI overrides, so
    // text drawn in the UI ink fades back to the right colour.
    this.basePalette = this.loadedRoom ? this.loadedRoom.palette.slice() : null;

    // Re-queue objects already in a non-zero, image-backed state — a door
    // left open stays rendered open on re-entry / restore.
    if (this.loadedRoom) {
      for (const [id, obj] of this.loadedRoom.objects) {
        const st = this.objectStates.get(id) ?? 0;
        if (st > 0 && obj.images.has(st)) this.objectDrawQueue.add(id);
      }
    }

  }

  /**
   * Set walk-box flags (matrixOp setBoxFlags). Bit 0x80 locks the box; the
   * override is read live by each walk. See pages/docs/engine/pathfinding.md.
   */
  setBoxFlags(boxId: number, flags: number): void {
    this.boxFlagOverrides.set(boxId, flags);
  }

  /**
   * Reload the current room's resources WITHOUT running entry/exit scripts
   * or clearing per-room runtime state — for save-state restore, where the
   * restored slots already represent the room's scripts (re-running ENCD
   * would double them).
   */
  reloadCurrentRoomResources(): void {
    if (this.currentRoom === 0) {
      this.loadedRoom = null;
      return;
    }
    this.applyRoomResources(this.currentRoom);
  }

  /** Resolve a room id to its decoded resources, or `null` (recording the error). */
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

  /** Save-state access to the private talk-page queue; {@link restoreTalkQueue} writes it back. */
  snapshotTalkQueue(): { pages: string[]; dlg: ActiveDialog | null; system: boolean } {
    return { pages: [...this.talkPages], dlg: this.talkPageDlg, system: this.talkPageSystem };
  }

  restoreTalkQueue(q: { pages: readonly string[]; dlg: ActiveDialog | null; system: boolean }): void {
    this.talkPages = [...q.pages];
    this.talkPageDlg = q.dlg;
    this.talkPageSystem = q.system;
  }

  /** Resolve a costume id via the cache; `null` for id 0, no resolver, or decode failure. */
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
      // Undecodable costume — skip the actor rather than halt.
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
   * Run an object's verb script as a synthetic slot (`VERB-{obj}-{verb}`,
   * with the SCUMM 0xFF default-verb fallback). Returns `null` — never
   * throws — when the object isn't loaded, has no matching verb, or no slot
   * is free: a missing verb is a normal "nothing happens" click.
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
    // Tag the slot with the room that owns the object's code — the carried
    // item's home room when it isn't a current-room object.
    const room = this.loadedRoom?.objects.has(objId)
      ? this.loadedRoom.id
      : this.resolveObjectRoom?.(objId) ?? this.loadedRoom?.id;
    // The startObject arg list maps DIRECTLY onto L0, L1, … — there is NO
    // implicit [verb, obj] prepend (verified against MI1's sentence script
    // #2 and the verb bodies it calls). See pages/docs/scumm/opcodes.md.
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
   * Resolve a script id (room-local LSCR for ids ≥ {@link LSCR_THRESHOLD},
   * else global DSCR) and start it in a free slot. Throws if unresolvable
   * or no slot is free.
   */
  startScriptById(
    scriptId: number,
    opts: {
      args?: ReadonlyArray<number>;
      label?: string;
      freezeResistant?: boolean;
    } = {},
  ): ScriptSlot | null {
    // Starting script 0 is a silent no-op, not an error — MI1's hover poller
    // #23 issues `startScript 0` for actors with no per-actor handler. See
    // pages/docs/scumm/opcodes.md.
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
      // The script that opened an active cutscene is spared — SCUMM's
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
   * Stop room-local (id ≥ {@link LSCR_THRESHOLD}) and object/verb scripts,
   * sparing globals and the freshly-started ENCD/EXCD (scriptId 0) —
   * SCUMM's `startScene` behaviour on every room change.
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
   * Begin a cutscene (0x40): push a frame, clear `VAR_OVERRIDE`, run
   * `VAR_CUTSCENE_START_SCRIPT` nested. The caller keeps running. See
   * pages/docs/scumm/cutscenes.md.
   */
  beginCutscene(args: ReadonlyArray<number>, callerSlot: number): void {
    this.cutsceneStack.push({ room: this.currentRoom, callerSlot, args: [...args] });
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 0);
    const startScript = this.vars.readGlobal(Vm.VAR_CUTSCENE_START_SCRIPT);
    if (startScript > 0) {
      try {
        // Nested so #18's freezeScripts takes effect before the caller's
        // next opcode.
        const s = this.startScriptById(startScript, { args });
        if (s) this.runScriptNested(s);
      } catch {
        // Start script unresolvable — cutscene still proceeds.
      }
    }
  }

  /**
   * End the current cutscene (0xC0): pop the frame, clear `VAR_OVERRIDE`,
   * run `VAR_CUTSCENE_END_SCRIPT` nested with the begin-time args.
   */
  endCutscene(): void {
    const frame = this.cutsceneStack.pop();
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 0);
    // Ending a cutscene restores the screen — transient prints erase now;
    // keepText survives.
    this.eraseTransientSystemText();
    const endScript = this.vars.readGlobal(Vm.VAR_CUTSCENE_END_SCRIPT);
    if (endScript > 0) {
      try {
        // Nested so #19 un-freezes scripts / restores input before the
        // caller continues.
        const s = this.startScriptById(endScript, { args: frame?.args ?? [] });
        if (s) this.runScriptNested(s);
      } catch {
        // End script unresolvable.
      }
    }
  }

  /**
   * Abort the active cutscene (Escape): jump the arming slot to its
   * `overridePc`, thaw it, set `VAR_OVERRIDE = 1`. No cutscene frame is
   * required — SCUMM's base level (no open cutscene) is a valid override
   * level, and MI1 arms overrides outside any frame. Returns false (no-op)
   * when nothing is armed. See pages/docs/scumm/cutscenes.md.
   */
  abortCutscene(): boolean {
    const frame = this.cutsceneStack[this.cutsceneStack.length - 1];
    const framed = frame ? this.slots[frame.callerSlot] : undefined;
    const slot =
      framed && framed.status !== 'dead' && framed.overridePc !== null
        ? framed
        : this.slots.find((s) => s.status !== 'dead' && s.overridePc !== null);
    if (!slot || slot.overridePc === null) return false;
    slot.pc = slot.overridePc;
    slot.overridePc = null;
    slot.delayRemaining = 0;
    slot.freezeCount = 0;
    slot.resume();
    this.vars.writeGlobal(Vm.VAR_OVERRIDE, 1);
    return true;
  }

  /**
   * Run the input script (`VAR_VERB_SCRIPT`) with locals
   * `[clickArea, code, button]` — a notification hook, not the sentence
   * builder (see pages/docs/scumm/input.md). Returns `null` — never throws —
   * when the var is unset or no slot is free.
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
      // A click with no usable input script is a no-op, not a crash.
      return null;
    }
  }

  // ─── Hang watchdog (opt-in dev aid) ─────────────────────────────────
  //
  // Fires when N consecutive clicks each produce no observable progress.
  // "Progress" is only what a click is meant to cause (room change, speech,
  // sentence, new script, walk) — never raw var/anim churn, which would
  // drown the signal. Off by default: the per-frame check is one null test.
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
   * Turn on the hang watchdog. `settleFrames`: frames to wait for a click's
   * effect before judging it (default 12 ≈ ~1 s at MI1's ~10 fps);
   * `deadInputThreshold`: dead clicks in a row that trip it (default 3).
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
   * Progress-only snapshot: room, monotonic talk/sentence counters,
   * commanded walks. Deliberately NOT the live-script set (a click always
   * transiently spawns the verb-redraw script) nor raw vars.
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
    // Resolve a still-open window first so each click gets its own verdict.
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
   * Verb-bar click: run the verb-input script with `[CLICK_AREA_VERB,
   * verbId, button]`. Inventory items are verbs too. See
   * pages/docs/scumm/input.md.
   */
  handleVerbClick(verbId: number, button = 1): void {
    this.runInputScript(Vm.CLICK_AREA_VERB, verbId, button);
  }

  /**
   * Scene click: run the verb-input script with `[CLICK_AREA_SCENE, 0,
   * button]`. The clicked object is NOT passed — the hover poller has
   * already hit-tested it into the game's globals. See
   * pages/docs/scumm/input.md.
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
   * Once-per-frame sentence driver: pop the newest queued sentence and start
   * the sentence script (`VAR_SENTENCE_SCRIPT`) with `[verb, objA, objB]`,
   * unless that script is already running.
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
   * SCUMM's nested `runScript`: step ONLY `slot` until it dies, yields, or
   * freezes — for scripts that must finish before the caller's next opcode
   * (cutscene #18/#19, ENCD/EXCD); queuing them instead scrambles ordering
   * and can deadlock input. Capped against runaway loops.
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
   * Mirror the cursor counters into their VARs and advance the per-jiffy
   * timers (music, audio, talk). Runs at the start of each tick, before
   * scripts, so anything polling sees the freshest state.
   */
  beginTick(): void {
    this.vars.writeGlobal(Vm.VAR_USERPUT, this.cursor.userput);
    this.vars.writeGlobal(Vm.VAR_CURSORSTATE, this.cursor.state);
    this.vars.writeGlobal(
      Vm.VAR_MUSIC_TIMER,
      this.vars.readGlobal(Vm.VAR_MUSIC_TIMER) + 1,
    );
    // Drain sound durations one jiffy at a time — the clock behind
    // sound-gated waits (see AudioBackend).
    this.audio.advance(1);
    // Talk timer: when it drains, VAR_HAVE_MSG clears and actor speech
    // disappears; system text persists (see advanceOrEndTalk).
    if (this.talkDelay > 0) {
      this.talkDelay--;
      if (this.talkDelay === 0) this.advanceOrEndTalk();
    }
  }

  /**
   * The current talk page finished (timer drained or player-skipped): flip
   * to the next queued page or end the message.
   */
  private advanceOrEndTalk(): void {
    if (this.talkPages.length > 0) {
      // Flip and re-arm; VAR_HAVE_MSG stays set until the final page.
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
      // System text is NOT dropped here — the talk timer governs only actor
      // speech and VAR_HAVE_MSG; blasted text clears via restoreCharsetBg
      // (see pages/docs/scumm/char.md).
    }
  }

  /**
   * Skip the current line of speech (the `.` key): drain the current talk
   * page, flipping to the next or ending the message. Per-line — distinct
   * from {@link abortCutscene}'s whole-scene skip.
   */
  skipText(): boolean {
    if (this.talkDelay <= 0) return false;
    this.talkDelay = 0;
    this.advanceOrEndTalk();
    return true;
  }

  /**
   * Advance one jiffy (1/60 s) — the canonical per-jiffy driver for the
   * shell loop and headless harnesses alike. Timers and `delay` countdowns
   * run every jiffy; the game frame (scripts, walks, anims) only every
   * `VAR_TIMER_NEXT` jiffies. See pages/docs/scumm/timing.md.
   */
  tick(): TickResult {
    if (this._haltInfo) return { framed: false, resumed: false, ran: 0, delaying: false };
    this.beginTick();
    // Drain `delay` countdowns per jiffy. A frozen slot's delay is paused.
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
    // Arm the per-cycle restoreCharsetBg (see systemTexts).
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
    // Camera-follow runs once per game frame, AFTER the walk — following
    // before it leaves the camera a frame behind and the actor's screen
    // position oscillates. The scripted pan steps first and detaches the
    // follow, so the two never fight over camera.x.
    this.stepCameraPan();
    this.moveCameraFollow();
    this.wdFrameCheck();
    return { framed: true, resumed, ran, delaying };
  }

  /** Jiffies per game frame from `VAR_TIMER_NEXT`, clamped; defaults to {@link DEFAULT_FRAME_INTERVAL}. */
  private frameInterval(): number {
    const v = this.vars.readGlobal(VARS.VAR_TIMER_NEXT);
    if (!Number.isFinite(v) || v < 1) return DEFAULT_FRAME_INTERVAL;
    return Math.min(v, 60);
  }

  /** Clamp a camera-centre X to the room's valid range (`roomScroll` overrides the defaults). */
  clampCameraX(x: number): number {
    const room = this.loadedRoom;
    if (!room) return x;
    const half = 160;
    const min = this.roomScroll ? this.roomScroll.min : Math.min(half, room.width);
    const max = this.roomScroll ? this.roomScroll.max : Math.max(min, room.width - half);
    return Math.max(min, Math.min(max, x));
  }

  /**
   * Move the camera centre (already clamped). A real scroll redraws the
   * background in the original and so erases transient blasted text.
   */
  moveCameraTo(x: number): void {
    if (x === this.camera.x) return;
    this.camera.x = x;
    this.eraseTransientSystemText();
  }

  /** Advance an in-progress `panCameraTo` by one frame; clears {@link cameraDest} on arrival. */
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
   * Keep the followed actor inside a central dead-zone band (±80 px): small
   * movements don't scroll, but the actor never leaves the viewport.
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
   * Mark a message as being said: set `VAR_HAVE_MSG` and a talk timer of
   * `text.length × VAR_CHARINC`, floored at {@link MIN_TALK_TICKS}.
   */
  beginTalk(text: string): void {
    const charinc = Math.max(1, this.vars.readGlobal(Vm.VAR_CHARINC));
    this.talkDelay = Math.max(MIN_TALK_TICKS, text.length * charinc);
    this.vars.writeGlobal(Vm.VAR_HAVE_MSG, 1);
    this.talkSeq++; // progress signal for the hang watchdog
  }

  /**
   * Queue the remaining pages of a multi-part message; `dlg` is the first
   * page's dialog, reused as the style/channel template. No-op for
   * single-page lines.
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

  /** Objects carried by `owner` — v5 inventory membership IS ownership. Backs `getInventoryCount`. */
  inventoryCount(owner: number): number {
    if (owner === 0) return 0;
    let n = 0;
    for (const o of this.objectOwners.values()) if (o === owner) n++;
    return n;
  }

  /**
   * An explicit entry wins; otherwise an object present in the loaded room
   * reads as {@link OF_OWNER_ROOM} (15), else 0. The room default is computed
   * here, NOT stored in {@link objectOwners}, so inventory scans (which match
   * actor ids) stay untouched.
   */
  getObjectOwner(obj: number): number {
    const explicit = this.objectOwners.get(obj);
    if (explicit !== undefined) return explicit;
    return this.loadedRoom?.objects.has(obj) ? OF_OWNER_ROOM : 0;
  }

  /**
   * The `index`-th (1-based) object owned by `owner`, in pickup order (Map
   * insertion order mirrors SCUMM's inventory append order); 0 when out of
   * range. Backs `findInventory` ($3D).
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
   * Object-or-actor display name (SCUMM's `getObjOrActorName`); `undefined`
   * when unknown so callers can fall back to a placeholder.
   */
  objectName(objId: number): string | undefined {
    // Ids within the actor table are actors; an unnamed actor returns
    // `undefined`, never falling through to the object table.
    if (objId >= 1 && objId <= this.actors.capacity) {
      const name = this.actors.get(objId).name;
      return name !== '' ? name : undefined;
    }
    // A setObjectName rename wins over both the room OBNA and the pickup
    // snapshot — SCUMM rewrites the OBNA buffer in place.
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
   * ($54/$D4); persists across rooms and saves.
   */
  setObjectName(objId: number, name: string): void {
    this.objectNameOverrides.set(objId, name);
  }

  /**
   * Snapshot an object's name into {@link inventoryNames} as it enters an
   * inventory: current room first, then the `pickupObject` room hint.
   * No-op when unresolvable.
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
   * Run the inventory script (`VAR_INVENTORY_SCRIPT`) with `arg` as
   * `local0`, killing any existing instance first (the original's
   * non-recursive `runScript`). Never throws. See pages/docs/scumm/input.md.
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
      // rather than halt.
    }
  }

  /** Walk an actor to a room coordinate via the walk-box planner; no-op for unplaced actors. */
  walkActorTo(actorId: number, x: number, y: number): void {
    if (actorId < 1 || actorId > this.actors.capacity) return;
    startWalk(this, this.actors.get(actorId), { x, y });
  }

  /**
   * Actor under room-space `(x, y)` or 0 — SCUMM's `getActorFromPos`: test
   * each visible actor's drawn box, skip Untouchable (class 32), and return
   * the highest id among overlaps (actors paint in ascending id order, so
   * that's the topmost).
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
   * The room-pixel rectangle {@link actorFromPos} hit-tests: the compositor's
   * stamped `drawBounds` when rendering, else the same box derived headlessly
   * via {@link prepareActorDraw} — clicks resolve identically either way.
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
      // Exceeding the budget is a loud halt — usually a runaway loop with
      // no breakHere.
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
    this.drawnBoxes.length = 0;
    this.shakeEnabled = false;
    this.audio.stopAll();
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
   * Dispatch one opcode WITHOUT touching the trace ring or halt recovery —
   * the expression evaluator's nested-opcode subop. The called opcode writes
   * its result to global #0 (VAR_RESULT).
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
