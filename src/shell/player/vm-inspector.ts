/**
 * VM inspector — full-state UI for the Phase 5 bytecode interpreter.
 *
 * Renders a single self-contained `<section>` that owns the live `Vm`
 * instance, the control buttons, and all the read-out panels. The
 * section re-renders the read-outs after each user action; the
 * underlying `Vm` lives across renders.
 */

import { stepAllActorWalks } from '../../engine/actor/walk';
import { stepAnim } from '../../engine/graphics/costume-anim';
import { findPath } from '../../engine/pathfinding/grid';
import { Canvas2DRenderer } from '../../engine/render/canvas2d';
import { composeFrame } from '../../engine/render/compositor';
import type { IndexFile } from '../../engine/resources/index-file';
import type { RoomOffsetTable } from '../../engine/resources/loff';
import type { ResourceFile } from '../../engine/resources/tree';
import { bootGame, type GameId } from '../../engine/vm/boot';
import type { ScriptSlot } from '../../engine/vm/slot';
import type { HaltInfo, TraceEntry, Vm } from '../../engine/vm/vm';
import { mountVmFrameInput, type ClickEvent } from './input';
import { mountPlayArea } from './play-area';

/**
 * Click captured by the inspector's input layer, with the engine tick
 * count at the moment it landed — handy for correlating a click with
 * trace entries / state changes that follow.
 */
interface RecentClick extends ClickEvent {
  readonly tickCount: number;
  /** Object id under the click, or null if the click hit empty room. */
  readonly objId: number | null;
}

const RECENT_CLICKS_CAP = 12;

/**
 * Max engine ticks per animation frame. rAF fires at the display
 * refresh (~60 Hz), so tick rates above that need >1 tick per frame to
 * keep up. The cap stops a backgrounded-then-foregrounded tab (rAF
 * paused, so a huge `elapsed`) from unleashing a catch-up avalanche.
 */
const MAX_TICKS_PER_FRAME = 64;

/**
 * Hard cap on the "Skip cutscene" fast-forward so a script that never
 * settles can't hang the tab. MI1's opening credits is ~5700 ticks.
 */
const MAX_SKIP_TICKS = 20000;

interface InspectorState {
  vm: Vm | null;
  /** How many globals to render — start small, expand on demand. */
  globalsShown: number;
  bitsShown: number;
  /** Auto-tick loop. `playing` = the rAF loop is armed. */
  playing: boolean;
  rafId: number | null;
  /** Cumulative ticks since this Vm was booted. Reset on Reset/Boot. */
  tickCount: number;
  /**
   * Fingerprint of "live slots at yield boundary" from the previous
   * tick. Stable for N consecutive ticks → the engine is in an idle
   * wait loop (the boot finished, only periodic-tick scripts left),
   * we auto-pause so the user isn't watching the trace ring spin
   * with nothing changing.
   */
  lastIdleFingerprint: string | null;
  idleStreak: number;
  /** Set when auto-pause fired — surfaced to the user. */
  idleReason: string | null;
  /** Show walk-box / walkable-mask / actor-walkPath overlay on the VM frame. */
  showWalkOverlay: boolean;
  /**
   * Target ticks per second when Play is running. 60 = full rAF
   * speed; slower values let the user inspect frame-by-frame
   * progress. Stored in Hz; the loop converts to a ms interval.
   */
  tickRateHz: number;
  /** Last wall-clock time (performance.now()) we actually ticked. */
  lastTickAt: number;
  /**
   * Most recent left/right clicks on the VM frame canvas, newest
   * first. Capped at {@link RECENT_CLICKS_CAP} so the panel stays
   * compact. Verb / object hit-testing wires onto the same input
   * pipeline in later Phase 7 tasks.
   */
  recentClicks: RecentClick[];
  /**
   * Most recent fully-decoded room palette. MI1's boot unloads to
   * "no room" between the credits and the title menu, so the play
   * area (cursor + verb bar + sentence line) would vanish during
   * that interval if we relied on `vm.loadedRoom.palette`. We cache
   * the last seen palette here so the verb-bar text keeps its colours
   * through the unload. `null` until the first `loadRoom` succeeds.
   */
  lastPalette: Uint8Array | null;
  lastTransparentIndex: number | null;
  /**
   * The frame area's stable DOM + cached renderer / play-area
   * handles. Re-mounted only when the room dimensions change (or on
   * Boot / Reset). Per-tick refreshes update pixels in place — keeps
   * clickable canvases (verb bar, room canvas) stable across rAF
   * boundaries so clicks don't drop.
   */
  mountedFrame: MountedFrame | null;
}

interface MountedFrame {
  /** Frame width (matches `loadedRoom.width` or fallback 320). */
  readonly width: number;
  /** Frame height (matches `loadedRoom.height` or fallback 144). */
  readonly height: number;
  /** Root DOM element to attach into the section. */
  readonly root: HTMLElement;
  /** Heading text node updated each tick. */
  readonly headingText: Text;
  /** Frame canvas + its Canvas2D renderer. */
  readonly frameCanvas: HTMLCanvasElement;
  readonly frameRenderer: Canvas2DRenderer | null;
  /** Reusable framebuffer; resized only when room dims change. */
  readonly framebuffer: Uint8Array;
  /** Play-area handles (cursor overlay, verb bar, sentence line). */
  readonly play: ReturnType<typeof mountPlayArea>;
  /** Bottom-of-frame caption (actors / objects / skip counts). */
  readonly metaText: Text;
  /** Detail list element for skip diagnostics. */
  readonly skipDetails: HTMLDetailsElement;
  readonly skipSummaryText: Text;
  readonly skipList: HTMLUListElement;
  /** Walk-overlay slot — present iff state.showWalkOverlay; replaced per tick when on. */
  walkOverlay: HTMLCanvasElement | null;
}

export function renderVmInspector(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'vm-inspector';

  const state: InspectorState = {
    vm: null,
    globalsShown: 64,
    bitsShown: 256,
    playing: false,
    rafId: null,
    tickCount: 0,
    lastIdleFingerprint: null,
    idleStreak: 0,
    idleReason: null,
    showWalkOverlay: false,
    tickRateHz: 60,
    lastTickAt: 0,
    recentClicks: [],
    lastPalette: null,
    lastTransparentIndex: null,
    mountedFrame: null,
  };

  /** Snapshot of every non-dead slot's (id, status, pc) plus the
   *  position of every moving actor and the anim cursor of any
   *  actively-animating actor — used to detect "we're in a wait loop
   *  where nothing observable changes". Both walks and anim cycles
   *  count as progress, so the loop keeps ticking while either is in
   *  motion.
   *
   *  We also append each slot's last few TRACE MNEMONICS. The most
   *  recent entry is always the yielding `breakHere` (worthless for
   *  change detection); the entries just before it carry the
   *  dereferenced variable values from comparison annotations
   *  (`isLE(g14=2997, 5700)`). When a script is waiting on an
   *  auto-incrementing timer, the value in the annotation changes
   *  every tick → fingerprint differs → loop keeps running through
   *  long timer waits (MI1's ~5700-tick end-of-credits hold). Pure
   *  input-wait loops (`isLess(g52=0, 0)`) carry the same value every
   *  tick → fingerprint stays stable → inspector still auto-pauses.
   */
  const MNEMONICS_PER_SLOT_IN_FINGERPRINT = 3;
  const yieldFingerprint = (vm: Vm): string => {
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
      // Sum each active limb's cursor — cheap signal that anim is
      // mutating. Static no-loop anims hit `finished=true` and stop
      // contributing to the sum once they've reached their final
      // byte.
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

  /** How many consecutive identical yield fingerprints count as
   *  "engine settled into idle". Enough to be confident, low enough
   *  to react quickly — 10 rAF frames ≈ 1/6 of a second. */
  const IDLE_STREAK_THRESHOLD = 10;

  /**
   * One engine tick: resume yielded/frozen slots, drain to next
   * round of yields, then step every walking actor toward its
   * `walkTarget`. Returns true if anything ran, was resumed, or
   * we have a moving actor — false signals "no work, stop the loop".
   */
  const oneTick = (): boolean => {
    if (!state.vm || state.vm.haltInfo) return false;
    // Mirror input + cursor state into the engine VARs *before*
    // resuming scripts so any wait loop polling VAR_LEFTBTN_DOWN /
    // VAR_USERPUT sees the freshest value this tick.
    state.vm.beginTick();
    // Sentence-script driver: if the user committed a verb+object this
    // tick (or a script pushed a follow-up), start the sentence script
    // before draining so it runs this tick.
    state.vm.processSentence();
    let resumed = false;
    for (const s of state.vm.slots) {
      if (s.status === 'yielded' || s.status === 'frozen') {
        // Slots blocked on `delay N` ticks must stay yielded until
        // their per-slot countdown drains. We decrement each tick;
        // the slot only resumes when it hits 0.
        if (s.delayRemaining > 0) {
          s.delayRemaining--;
          continue;
        }
        s.resume();
        resumed = true;
      }
    }
    const ran = state.vm.runUntilAllYield();
    stepAllActorWalks(state.vm);
    // Step every actor's anim playback. Dormant actors with no
    // active limbs are a no-op (stepAnim short-circuits).
    for (const actor of state.vm.actors.all()) {
      actor.anim = stepAnim(actor.anim);
    }
    state.tickCount++;
    const anyMoving = [...state.vm.actors.all()].some((a) => a.isMoving);
    return resumed || ran > 0 || anyMoving;
  };

  /**
   * Detect "engine in idle wait loop" — the boot has handed off to
   * periodic-tick scripts (e.g. MI1's #23 cutscene-wait and #159
   * random-number idle timer) and nothing changes between ticks
   * because no player input is firing. Without this, Play would
   * burn frames forever at the title screen.
   */
  const checkIdleAndUpdateStreak = (): boolean => {
    if (!state.vm) return false;
    const fp = yieldFingerprint(state.vm);
    if (fp === state.lastIdleFingerprint) {
      state.idleStreak++;
    } else {
      state.lastIdleFingerprint = fp;
      state.idleStreak = 1;
    }
    return state.idleStreak >= IDLE_STREAK_THRESHOLD;
  };

  // Monotonic generation counter. Every Pause / Reset / Boot bumps
  // this so any in-flight rAF callback can detect that it's stale and
  // bail. Belt-and-braces against `cancelAnimationFrame` not taking
  // (HMR reloads, browser quirks).
  let loopGeneration = 0;

  const stopLoop = (): void => {
    loopGeneration++;
    if (state.rafId !== null) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    state.playing = false;
  };

  const scheduleNextTick = (): void => {
    if (!state.playing) return;
    const myGen = loopGeneration;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      if (!state.playing || !state.vm || myGen !== loopGeneration) return;
      // Throttle: skip this rAF if the configured tick interval
      // hasn't elapsed yet. 60 Hz = no throttling (every frame
      // ticks). Slower rates mean rAF still fires but we just
      // schedule the next one without running a tick.
      const now = performance.now();
      const minIntervalMs = 1000 / state.tickRateHz;
      const elapsed = now - state.lastTickAt;
      if (elapsed < minIntervalMs - 0.5) {
        // Not time yet — try again next rAF.
        scheduleNextTick();
        return;
      }
      state.lastTickAt = now;
      // Run a batch sized to the elapsed time so rates above the
      // display refresh (e.g. 120 Hz) actually run faster instead of
      // being capped at one tick per frame. At <= refresh this is 1.
      const batch = Math.min(
        MAX_TICKS_PER_FRAME,
        Math.max(1, Math.floor(elapsed / minIntervalMs)),
      );
      for (let i = 0; i < batch; i++) {
        const progressed = oneTick();
        if (state.vm.haltInfo) {
          state.playing = false;
          state.idleReason = null;
          repaint();
          return;
        }
        if (!progressed) {
          // Truly nothing left — everything's dead. Pause cleanly.
          state.playing = false;
          state.idleReason = 'all slots dead';
          repaint();
          return;
        }
        if (checkIdleAndUpdateStreak()) {
          // We've been ticking the same set of yielded slots for
          // ~10 ticks straight. The game is in a wait-for-input
          // loop (likely the title-screen tick or a cutscene wait).
          // Pause and surface why.
          state.playing = false;
          const liveSlots = state.vm.slots
            .filter((s) => s.status !== 'dead')
            .map((s) => `#${s.scriptId}`)
            .join(', ');
          state.idleReason = `engine in idle wait loop — only ${liveSlots} live, no observable progress for ${IDLE_STREAK_THRESHOLD} ticks`;
          repaint();
          return;
        }
      }
      // Inside the rAF loop, only the live panels refresh — the
      // controls bar (buttons + tick counter) stays stable so clicks
      // mid-stride don't drop.
      repaintLive();
      scheduleNextTick();
    });
  };

  // The inspector splits into THREE subtrees:
  //   - controlsContainer: buttons. Only rebuilt on state changes
  //     (Boot / Pause / Reset). Rebuilding every tick would drop
  //     clicks (mousedown lands on a button that's destroyed before
  //     mouseup arrives).
  //   - frameContainer: the room canvas + cursor overlay + verb bar
  //     + sentence line. STABLE DOM — only re-mounted when room
  //     dimensions change. Per-tick refresh updates canvas pixels in
  //     place via the cached renderer. Same click-stability story as
  //     the controls bar: the verb bar canvas is clickable, so it
  //     must not be torn down per tick.
  //   - liveContainer: tables / trace / globals / bits panels.
  //     Rebuilt per tick. No clickable canvases inside.
  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'vm-controls-host';
  const frameContainer = document.createElement('div');
  frameContainer.className = 'vm-frame-host';
  const liveContainer = document.createElement('div');
  liveContainer.className = 'vm-live-host';
  section.appendChild(controlsContainer);
  section.appendChild(frameContainer);
  section.appendChild(liveContainer);

  const bootFresh = (): void => {
    stopLoop();
    const { vm } = bootGame(resourceFile, index, loff, gameId);
    state.vm = vm;
    state.tickCount = 0;
    state.lastIdleFingerprint = null;
    state.idleStreak = 0;
    state.idleReason = null;
    state.recentClicks = [];
    state.lastPalette = null;
    state.lastTransparentIndex = null;
    (globalThis as { __vm?: Vm }).__vm = vm;
    // Tiny dev helper: __walkActor(id, x, y) sets up an actor walk
    // through the real pathfinder so you can see the overlay light
    // up without touching the opcode handler.
    (globalThis as { __walkActor?: (id: number, x: number, y: number) => void }).__walkActor =
      (id, x, y) => {
        const actor = vm.actors.get(id);
        actor.walkTarget = { x, y };
        actor.walkPath = [];
        actor.walkPathIdx = 0;
        actor.isMoving = true;
        const mask = vm.loadedRoom?.walkableMask;
        if (mask && mask.length > 0 && !actor.ignoreBoxes) {
          const room = vm.loadedRoom!;
          const path = findPath(mask, room.width, room.height, { x: actor.x, y: actor.y }, { x, y });
          if (path.waypoints.length > 0) {
            actor.walkPath = path.waypoints.slice(1);
          }
        }
      };
    repaint();
  };

  const togglePlay = (): void => {
    if (state.playing) {
      stopLoop();
    } else if (state.vm) {
      state.playing = true;
      // Reset idle tracking so Play resumes cleanly after the user
      // pokes at state in the console (the new state will produce a
      // new fingerprint).
      state.lastIdleFingerprint = null;
      state.idleStreak = 0;
      state.idleReason = null;
      scheduleNextTick();
    }
    repaint();
  };

  // Fast-forward through a cutscene without waiting on rAF: run ticks
  // synchronously until the engine settles into an idle wait loop AND
  // the verb bar is interactive again (a verb in the `on` state) — i.e.
  // control has returned to the player. Cutscenes turn the verbs off
  // and back on, so "idle with an active verb" is the post-cutscene
  // signal. MI1's opening credits gate this at tick ~5710 (g14 > 5700).
  //
  // Idle alone is NOT enough: the credits' timer/delay wait *looks*
  // idle (stable slot fingerprint) from tick ~12, long before control
  // returns — so we also require an active verb to stop there.
  const skipCutscene = (): void => {
    if (!state.vm) return;
    stopLoop();
    state.playing = false;
    state.idleStreak = 0;
    let reached = false;
    for (let i = 0; i < MAX_SKIP_TICKS; i++) {
      if (!oneTick()) break; // everything dead
      if (state.vm.haltInfo) break;
      const interactive = [...state.vm.verbs.values()].some((v) => v.state === 'on');
      if (checkIdleAndUpdateStreak() && interactive) {
        reached = true;
        break;
      }
    }
    state.idleReason = reached
      ? 'skipped past cutscene — verb bar active (note: title menu has no room art, so the canvas is black until you start/enter a room)'
      : state.vm.haltInfo
        ? null
        : `skip ran ${MAX_SKIP_TICKS} ticks without control returning to the verb bar`;
    repaint();
  };

  const repaintControls = (): void => {
    const h2 = document.createElement('h2');
    h2.textContent = 'VM';
    const controls = renderControls(state, repaint, bootFresh, togglePlay, skipCutscene);
    controlsContainer.replaceChildren(h2, controls);
  };

  /**
   * Refresh the frame area. Re-mounts the canvases only when room
   * dimensions change; otherwise just updates pixels in place.
   */
  const refreshFrame = (): void => {
    if (!state.vm) {
      state.mountedFrame = null;
      frameContainer.replaceChildren();
      return;
    }
    const room = state.vm.loadedRoom;
    const width = room?.width ?? 320;
    const height = room?.height ?? 144;
    const palette = room?.palette ?? state.lastPalette ?? defaultGreyPalette();
    if (
      !state.mountedFrame ||
      state.mountedFrame.width !== width ||
      state.mountedFrame.height !== height
    ) {
      state.mountedFrame = buildFrame(state, resourceFile, width, height, palette, repaint);
      frameContainer.replaceChildren(state.mountedFrame.root);
    }
    updateFrame(state, state.mountedFrame, palette);
  };

  const repaintLive = (): void => {
    refreshFrame();
    liveContainer.replaceChildren(renderLive(state, repaint));
  };

  const repaint = (): void => {
    repaintControls();
    repaintLive();
  };

  repaint();
  return section;
}

/**
 * Build the live-state subtree (tables / trace / panels — things
 * that update per tick but have NO clickable canvases). The
 * controls bar and the frame area are built separately and reused
 * across tick repaints so their click targets stay stable.
 */
function renderLive(state: InspectorState, repaint: () => void): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (!state.vm) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = 'Click Boot to load global script #1 and start the VM.';
    frag.appendChild(empty);
    return frag;
  }

  // Live tick counter — moved out of the controls bar so the
  // bar can stay stable across rAF repaints without losing clicks.
  const counter = document.createElement('p');
  counter.className = 'vm-tick-counter-live';
  counter.textContent = `tick ${state.tickCount}`;
  counter.title = 'Engine ticks since this VM was booted';
  frag.appendChild(counter);

  if (state.vm.haltInfo) {
    frag.appendChild(renderHaltPanel(state.vm.haltInfo));
  }

  if (state.idleReason) {
    const idle = document.createElement('div');
    idle.className = 'vm-idle-banner';
    idle.textContent = `Auto-paused — ${state.idleReason}. Click Play to resume.`;
    frag.appendChild(idle);
  }

  frag.appendChild(renderInputPanel(state));
  frag.appendChild(renderActorTable(state.vm));
  frag.appendChild(renderSlotTable(state.vm, state.vm.haltInfo));
  frag.appendChild(renderTrace(state.vm));
  frag.appendChild(renderGlobals(state, repaint));
  frag.appendChild(renderBits(state, repaint));

  return frag;
}

function pushClick(state: InspectorState, e: ClickEvent, objId: number | null): void {
  const entry: RecentClick = { ...e, tickCount: state.tickCount, objId };
  state.recentClicks.unshift(entry);
  if (state.recentClicks.length > RECENT_CLICKS_CAP) {
    state.recentClicks.length = RECENT_CLICKS_CAP;
  }
}

/**
 * Last-resort palette used when no room has ever loaded — a 16-entry
 * grayscale ramp expanded into the 256-CLUT-entry layout the renderer
 * expects (3 bytes per entry). Verb-bar text rendering with this
 * palette is monochrome but legible, which is enough to make the
 * inspector usable in the brief pre-first-room window after Boot.
 */
function defaultGreyPalette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const v = Math.min(255, i * 4);
    p[i * 3] = v;
    p[i * 3 + 1] = v;
    p[i * 3 + 2] = v;
  }
  return p;
}

function modString(m: ClickEvent['modifiers']): string {
  const parts: string[] = [];
  if (m.shift) parts.push('Shift');
  if (m.ctrl) parts.push('Ctrl');
  if (m.alt) parts.push('Alt');
  if (m.meta) parts.push('Meta');
  return parts.join('+');
}

/**
 * Live cursor coords + recent-click ring. Read-only diagnostic — verb
 * routing / sentence building / hit-testing arrive with later Phase 7
 * tasks. Stays visible at all times so we can confirm the input layer
 * is working when scripts ignore clicks (cutscenes, userput off, …).
 */
function renderInputPanel(state: InspectorState): HTMLElement {
  const vm = state.vm!;
  const panel = document.createElement('section');
  panel.className = 'vm-input-panel';

  const heading = document.createElement('h3');
  heading.textContent = 'Input';
  panel.appendChild(heading);

  const liveRow = document.createElement('p');
  liveRow.className = 'vm-input-live';
  // VAR_VIRT_MOUSE_X/Y (room) shown alongside vm.mouseRoomX/Y — they
  // should always match; surfacing both lets us catch a divergence if
  // a script writes them directly.
  const virtX = vm.vars.readGlobal(20);
  const virtY = vm.vars.readGlobal(21);
  liveRow.textContent =
    `cursor room=(${vm.mouseRoomX}, ${vm.mouseRoomY}) · ` +
    `VAR_VIRT_MOUSE=(${virtX}, ${virtY}) · ` +
    `VAR_MOUSE=(${vm.vars.readGlobal(44)}, ${vm.vars.readGlobal(45)})`;
  panel.appendChild(liveRow);

  // Engine-truth cursor / verb state. The crosshair always paints in
  // the inspector for debug — these fields tell you what the game
  // logic actually sees.
  const engineRow = document.createElement('p');
  engineRow.className = 'vm-input-live';
  const verbBits = vm.currentVerb !== null
    ? `${vm.currentVerb} (${vm.verbs.get(vm.currentVerb)?.name ?? '?'})`
    : 'none';
  engineRow.textContent =
    `vm.cursor.visible=${vm.cursor.visible} · ` +
    `vm.cursor.userput=${vm.cursor.userput} · ` +
    `currentCharset=${vm.currentCharset} · ` +
    `currentVerb=${verbBits} · ` +
    `verbs=${vm.verbs.size}`;
  panel.appendChild(engineRow);

  const varsRow = document.createElement('p');
  varsRow.className = 'vm-input-live';
  varsRow.textContent =
    `leftHold=${vm.input.leftHold} · rightHold=${vm.input.rightHold} · ` +
    `VAR_CURSORSTATE(g52)=${vm.vars.readGlobal(52)} · ` +
    `VAR_USERPUT(g53)=${vm.vars.readGlobal(53)}`;
  panel.appendChild(varsRow);

  if (state.recentClicks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = '(no clicks yet — click on the VM frame canvas)';
    panel.appendChild(empty);
    return panel;
  }

  const list = document.createElement('ul');
  list.className = 'vm-input-clicks';
  for (const c of state.recentClicks) {
    const li = document.createElement('li');
    const mods = modString(c.modifiers);
    const objBit = c.objId !== null ? ` · obj #${c.objId}` : '';
    li.textContent =
      `tick ${c.tickCount} · ${c.button} · (${c.roomX}, ${c.roomY})` +
      objBit +
      (mods ? ` · ${mods}` : '');
    list.appendChild(li);
  }
  panel.appendChild(list);

  return panel;
}

function renderControls(
  state: InspectorState,
  repaint: () => void,
  bootFresh: () => void,
  togglePlay: () => void,
  skipCutscene: () => void,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'vm-controls';

  const boot = button('Boot', 'primary');
  boot.title = 'Reload boot script and start fresh';
  boot.addEventListener('click', bootFresh);
  bar.appendChild(boot);

  // Play/Pause sits next to Boot — most-used button when watching
  // scripts run. Toggles its label so its current state is obvious.
  const play = button(state.playing ? 'Pause' : 'Play', state.playing ? 'secondary' : 'primary');
  play.disabled = !state.vm || state.vm.isHalted || (!state.playing && !anyAdvanceable(state.vm));
  play.title = state.playing
    ? 'Stop the rAF loop'
    : 'Run the engine at the selected rate (rates above ~60 Hz run multiple ticks per frame). Auto-pauses on halt or steady state.';
  play.addEventListener('click', togglePlay);
  bar.appendChild(play);

  // Tick rate selector — at 60 Hz Play looks like an indistinguishable
  // blur for fast scripts (the boot sequence flashes past in a few
  // frames). Lower rates let the user watch state transitions.
  const rateWrap = document.createElement('label');
  rateWrap.className = 'vm-tick-rate';
  rateWrap.title = 'Target engine ticks per second when Play is running';
  rateWrap.appendChild(document.createTextNode('rate '));
  const rateSelect = document.createElement('select');
  for (const hz of [1, 5, 15, 30, 60, 120]) {
    const opt = document.createElement('option');
    opt.value = String(hz);
    opt.textContent = `${hz} Hz`;
    if (hz === state.tickRateHz) opt.selected = true;
    rateSelect.appendChild(opt);
  }
  rateSelect.addEventListener('change', () => {
    state.tickRateHz = parseInt(rateSelect.value, 10);
    repaint();
  });
  rateWrap.appendChild(rateSelect);
  bar.appendChild(rateWrap);

  const step = button('Step');
  step.disabled = !state.vm || state.vm.isHalted || !anyRunnable(state.vm);
  step.title = 'Dispatch one opcode in a currently-running slot';
  step.addEventListener('click', () => {
    state.vm?.step();
    repaint();
  });
  bar.appendChild(step);

  const run = button('Run tick');
  // Run tick resumes yielded slots before dispatching, so it stays
  // useful as long as *any* slot is in a state that resume() can
  // advance — running, yielded, or frozen. Once everything's dead the
  // boot script and its children have all finished and there's nothing
  // left to drive.
  run.disabled = !state.vm || state.vm.isHalted || !anyAdvanceable(state.vm);
  run.title = 'Resume yielded slots and dispatch until every slot yields again (one engine tick)';
  run.addEventListener('click', () => {
    if (!state.vm) return;
    state.vm.beginTick();
    for (const s of state.vm.slots) {
      if (s.delayRemaining > 0) {
        s.delayRemaining--;
        continue;
      }
      s.resume();
    }
    state.vm.runUntilAllYield();
    repaint();
  });
  bar.appendChild(run);

  // The boot script doesn't fully unwind in one tick — it has multiple
  // breakHere yields before reaching the actorOps that sets up
  // Guybrush. Clicking "Run tick" 6+ times to get there is tedious, so
  // this button just loops until everything settles. Capped at 100
  // ticks so script #159's idle-timer (which yields forever via
  // breakHere + jump back) doesn't spin us infinitely.
  const idle = button('Run to idle');
  idle.disabled = !state.vm || state.vm.isHalted || !anyAdvanceable(state.vm);
  idle.title = 'Loop Run tick until all scripts settle (capped at 100 ticks)';
  idle.addEventListener('click', () => {
    if (!state.vm) return;
    const MAX_TICKS = 100;
    for (let i = 0; i < MAX_TICKS; i++) {
      state.vm.beginTick();
      let resumed = false;
      for (const s of state.vm.slots) {
        if (s.status === 'yielded' || s.status === 'frozen') {
          if (s.delayRemaining > 0) {
            s.delayRemaining--;
            continue;
          }
          s.resume();
          resumed = true;
        }
      }
      const opcodesRun = state.vm.runUntilAllYield();
      if (state.vm.haltInfo) break;
      // Stop when neither we resumed anything nor any opcodes ran —
      // the engine has reached a steady state.
      if (!resumed && opcodesRun === 0) break;
    }
    repaint();
  });
  bar.appendChild(idle);

  // Fast-forward through the long opening cutscene (~5700 ticks) without
  // waiting on rAF. Runs ticks synchronously until the engine settles
  // into its idle wait loop (the post-cutscene title state) — the same
  // detection the Play loop uses — or halts, or hits the safety cap.
  const skip = button('Skip cutscene');
  skip.disabled = !state.vm || state.vm.isHalted || !anyAdvanceable(state.vm);
  skip.title = 'Fast-forward ticks until the engine reaches the title idle state (or halts)';
  skip.addEventListener('click', skipCutscene);
  bar.appendChild(skip);

  // Synthesises a left-button-down pulse without needing the room
  // canvas — critical for the title-menu state where no room is
  // loaded and the play-area canvas doesn't exist, but scripts are
  // still polling VAR_LEFTBTN_DOWN waiting for a click. Advances one
  // tick so the next-tick clear happens after the script consumes
  // the pulse.
  const click = button('Click ←');
  click.disabled = !state.vm || state.vm.isHalted;
  click.title = 'Queue a synthetic left-button press and advance one engine tick';
  click.addEventListener('click', () => {
    if (!state.vm) return;
    state.vm.input.leftPressQueued = true;
    state.vm.input.leftHold = true;
    state.vm.beginTick();
    for (const s of state.vm.slots) {
      if (s.delayRemaining > 0) {
        s.delayRemaining--;
        continue;
      }
      s.resume();
    }
    state.vm.runUntilAllYield();
    // Release the hold after the tick so a real script that latches
    // on hold doesn't think the user is dragging.
    state.vm.input.leftHold = false;
    repaint();
  });
  bar.appendChild(click);

  const reset = button('Reset');
  reset.disabled = !state.vm;
  reset.title = 'Wipe slots, vars, trace, halt — return to pre-Boot state';
  reset.addEventListener('click', () => {
    // Stop the rAF loop too, otherwise it would tick a null VM and
    // throw next frame.
    state.playing = false;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    state.vm?.reset();
    state.vm = null;
    state.tickCount = 0;
    state.lastIdleFingerprint = null;
    state.idleStreak = 0;
    state.idleReason = null;
    state.recentClicks = [];
    state.lastPalette = null;
    state.lastTransparentIndex = null;
    delete (globalThis as { __vm?: Vm }).__vm;
    repaint();
  });
  bar.appendChild(reset);

  return bar;
}

function renderHaltPanel(halt: HaltInfo): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'vm-halt';

  const h = document.createElement('h3');
  h.textContent = `HALTED — ${halt.reason}`;
  panel.appendChild(h);

  const meta = document.createElement('p');
  meta.className = 'vm-halt-meta';
  meta.textContent = `slot=${halt.slotIndex} · script=${halt.scriptId} · pc=0x${halt.pc
    .toString(16)
    .padStart(4, '0')} · opcode=0x${halt.opcode.toString(16).padStart(2, '0')}`;
  panel.appendChild(meta);

  const ctxLabel = document.createElement('div');
  ctxLabel.className = 'vm-halt-ctx-label';
  ctxLabel.textContent = 'Bytecode context (offending byte in red):';
  panel.appendChild(ctxLabel);

  const ctx = document.createElement('div');
  ctx.className = 'vm-halt-ctx';
  for (let i = 0; i < halt.bytecodeContext.length; i++) {
    const cell = document.createElement('span');
    cell.className = 'hex-cell';
    if (i === halt.contextOpcodeOffset) cell.classList.add('hex-here');
    cell.textContent = halt.bytecodeContext[i]!.toString(16).padStart(2, '0');
    ctx.appendChild(cell);
  }
  panel.appendChild(ctx);

  if (halt.trace.length > 0) {
    const traceLabel = document.createElement('div');
    traceLabel.className = 'vm-halt-ctx-label';
    traceLabel.textContent = 'Last opcodes leading up to halt:';
    panel.appendChild(traceLabel);
    panel.appendChild(renderTraceRows(halt.trace));
  }

  return panel;
}

/**
 * Build the stable frame-area DOM (canvas, overlays, play-area) and
 * wire its input listeners. Called once per room-dimensions change.
 * Per-tick refreshes go through {@link updateFrame} which only mutates
 * canvas pixels — keeps the verb-bar / room-canvas DOM elements
 * stable so clicks don't drop across rAF boundaries.
 */
function buildFrame(
  state: InspectorState,
  resourceFile: ResourceFile,
  width: number,
  height: number,
  palette: Uint8Array,
  repaint: () => void,
): MountedFrame {
  const vm = state.vm!;
  const root = document.createElement('div');
  root.className = 'vm-frame';

  const heading = document.createElement('h3');
  const headingText = document.createTextNode('');
  heading.appendChild(headingText);
  root.appendChild(heading);

  const stack = document.createElement('div');
  stack.className = 'vm-frame-stack';
  stack.style.width = `${width * 2}px`;
  stack.style.height = `${height * 2}px`;

  const frameCanvas = document.createElement('canvas');
  frameCanvas.className = 'vm-frame-canvas';
  frameCanvas.style.width = `${width * 2}px`;
  frameCanvas.style.height = `${height * 2}px`;
  let frameRenderer: Canvas2DRenderer | null = null;
  if (vm.loadedRoom) {
    frameRenderer = new Canvas2DRenderer(frameCanvas, width, height);
    frameRenderer.setPalette(vm.loadedRoom.palette);
    frameRenderer.setTransparentIndex(vm.loadedRoom.transparentIndex);
  } else {
    // No room loaded — paint solid black so the cursor + verb bar
    // composite on a predictable backdrop.
    frameCanvas.width = width;
    frameCanvas.height = height;
    const ctx = frameCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
    }
  }
  stack.appendChild(frameCanvas);

  const play = mountPlayArea({
    resourceFile,
    vm,
    roomWidth: width,
    roomHeight: height,
    palette,
    transparentIndex: vm.loadedRoom?.transparentIndex ?? state.lastTransparentIndex,
    onCommit: () => repaint(),
  });
  stack.appendChild(play.cursorOverlay);

  root.appendChild(stack);

  mountVmFrameInput({
    canvas: frameCanvas,
    vm,
    roomWidth: width,
    roomHeight: height,
    onMove: () => play.onPointerMove(),
    onLeftClick: (e) => {
      const { objId } = play.onRoomClick('left');
      pushClick(state, e, objId);
      repaint();
    },
    onRightClick: (e) => {
      const { objId } = play.onRoomClick('right');
      pushClick(state, e, objId);
      repaint();
    },
  });

  root.appendChild(play.sentenceLine);
  root.appendChild(play.verbBar);

  // Walk-overlay toggle row (only meaningful with a room loaded, but
  // we always build the row so the toggle survives across remounts).
  const toggleRow = document.createElement('div');
  toggleRow.className = 'vm-frame-toggles';
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = state.showWalkOverlay;
  checkbox.addEventListener('change', () => {
    state.showWalkOverlay = checkbox.checked;
    repaint();
  });
  label.appendChild(checkbox);
  label.appendChild(document.createTextNode(' walk overlay'));
  label.title = 'Draw walk-box outlines, the walkable mask tint, and any active actor walkPath';
  toggleRow.appendChild(label);
  root.appendChild(toggleRow);

  const meta = document.createElement('p');
  meta.className = 'vm-frame-meta';
  const metaText = document.createTextNode('');
  meta.appendChild(metaText);
  root.appendChild(meta);

  const skipDetails = document.createElement('details');
  skipDetails.open = true;
  skipDetails.hidden = true;
  const skipSummary = document.createElement('summary');
  const skipSummaryText = document.createTextNode('');
  skipSummary.appendChild(skipSummaryText);
  skipDetails.appendChild(skipSummary);
  const skipList = document.createElement('ul');
  skipList.className = 'vm-frame-skip-list';
  skipDetails.appendChild(skipList);
  root.appendChild(skipDetails);

  return {
    width,
    height,
    root,
    headingText,
    frameCanvas,
    frameRenderer,
    framebuffer: new Uint8Array(width * height),
    play,
    metaText,
    skipDetails,
    skipSummaryText,
    skipList,
    walkOverlay: null,
  };
}

/**
 * Per-tick refresh of the stable frame area. Recomposes the
 * framebuffer, present()s to the canvas, redraws play-area overlays,
 * and updates the caption. DOM elements (canvases, sentence-line,
 * verb-bar) stay the same so clicks remain attachable across ticks.
 */
function updateFrame(
  state: InspectorState,
  mounted: MountedFrame,
  palette: Uint8Array,
): void {
  const vm = state.vm!;
  const room = vm.loadedRoom;

  // Heading.
  mounted.headingText.data = room
    ? `VM frame — room ${room.id} (${room.width}×${room.height})`
    : `VM frame — currentRoom=${vm.currentRoom}, (no room loaded)`;

  // Cache palette for future no-room ticks.
  if (room) {
    state.lastPalette = room.palette;
    state.lastTransparentIndex = room.transparentIndex;
  }

  // Recompose + present, OR repaint black if no room.
  type ComposeResult = ReturnType<typeof composeFrame>;
  let result: ComposeResult = {
    actorsDrawn: 0,
    objectsDrawn: 0,
    skippedActors: [],
    skippedObjects: [],
    skippedLimbs: [],
  };
  const actors = room ? vm.actors.inRoom(vm.currentRoom) : [];

  if (room && mounted.frameRenderer) {
    mounted.frameRenderer.setPalette(room.palette);
    mounted.frameRenderer.setTransparentIndex(room.transparentIndex);
    mounted.framebuffer.fill(0);
    result = composeFrame({
      room,
      framebuffer: mounted.framebuffer,
      actors,
      getCostume: (id) => vm.getCostume(id),
      objectDrawQueue: vm.objectDrawQueue,
      getObjectState: (id) => vm.objectStates.get(id) ?? 1,
    });
    mounted.frameRenderer.present(mounted.framebuffer);
  } else if (!room) {
    const ctx = mounted.frameCanvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, mounted.width, mounted.height);
    }
  }

  // Walk overlay — recreated per tick when enabled (cheap; only
  // active when the user has the toggle on).
  if (mounted.walkOverlay) {
    mounted.walkOverlay.remove();
    mounted.walkOverlay = null;
  }
  if (room && state.showWalkOverlay) {
    mounted.walkOverlay = renderWalkOverlay(vm, room);
    // Stack: [frameCanvas, walkOverlay, cursorOverlay] — insert walk
    // overlay between the frame and the cursor.
    mounted.play.cursorOverlay.before(mounted.walkOverlay);
  }

  // Repaint the play-area overlays (cursor, verb bar) + sentence
  // line. Uses the latest palette + verb state from the VM.
  void palette;
  mounted.play.redraw();

  // Caption.
  const actorBits = actors.length === 0
    ? 'no actors in this room'
    : `${result.actorsDrawn}/${actors.length} actor${actors.length === 1 ? '' : 's'} drawn` +
      ` (ids: ${actors.map((a) => a.id).join(', ')})`;
  const queueSize = vm.objectDrawQueue.size;
  const objectBits = queueSize === 0
    ? ''
    : ` · ${result.objectsDrawn}/${queueSize} object${queueSize === 1 ? '' : 's'} drawn`;
  const limbSkips = result.skippedLimbs.length;
  const actorSkips = result.skippedActors.length;
  const objectSkips = result.skippedObjects.length;
  const skipBits =
    (actorSkips > 0 ? ` · ${actorSkips} actor skip${actorSkips === 1 ? '' : 's'}` : '') +
    (objectSkips > 0 ? ` · ${objectSkips} object skip${objectSkips === 1 ? '' : 's'}` : '') +
    (limbSkips > 0 ? ` · ${limbSkips} limb skip${limbSkips === 1 ? '' : 's'}` : '');
  mounted.metaText.data = `${actorBits}${objectBits}${skipBits}`;

  // Skip details — only show when something was skipped.
  if (actorSkips > 0 || objectSkips > 0 || limbSkips > 0) {
    mounted.skipDetails.hidden = false;
    mounted.skipSummaryText.data = `Skipped (${actorSkips} actor, ${objectSkips} object, ${limbSkips} limb)`;
    const items: { text: string }[] = [
      ...result.skippedActors.map((s) => ({ text: `actor ${s.actorId}: ${s.reason}` })),
      ...result.skippedObjects.map((s) => ({ text: `object ${s.objectId}: ${s.reason}` })),
      ...result.skippedLimbs.map((s) => ({
        text: `actor ${s.actorId} limb ${s.limbIdx}: ${s.reason}`,
      })),
    ];
    mounted.skipList.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item.text;
      mounted.skipList.appendChild(li);
    }
  } else {
    mounted.skipDetails.hidden = true;
  }
}

/**
 * Render the walk-box / mask / path overlay onto a transparent
 * canvas the caller stacks over the VM frame canvas.
 *
 * Layers (drawn back-to-front):
 *   1. Subtle green tint over walkable-mask pixels (alpha ~0.10).
 *   2. Walk-box outlines + id labels, one accent color per box.
 *   3. For each actor in the current room with a non-empty walkPath:
 *      polyline of the upcoming waypoints, marker on the current
 *      aim. Also draws walkTarget for actors with no path.
 *
 * Backing canvas sized to native room dimensions; CSS scales 2× the
 * same way the frame canvas does.
 */
function renderWalkOverlay(vm: Vm, room: NonNullable<Vm['loadedRoom']>): HTMLCanvasElement {
  const overlay = document.createElement('canvas');
  overlay.className = 'vm-frame-overlay';
  overlay.width = room.width;
  overlay.height = room.height;
  overlay.style.width = `${room.width * 2}px`;
  overlay.style.height = `${room.height * 2}px`;
  const ctx = overlay.getContext('2d');
  if (!ctx) return overlay;

  // 1. Walkable-mask tint via ImageData — faster than per-pixel
  //    `fillRect`s for big rooms.
  if (room.walkableMask.length === room.width * room.height) {
    const img = ctx.createImageData(room.width, room.height);
    for (let i = 0; i < room.walkableMask.length; i++) {
      if (room.walkableMask[i]) {
        img.data[i * 4 + 0] = 0;     // R
        img.data[i * 4 + 1] = 220;   // G
        img.data[i * 4 + 2] = 80;    // B
        img.data[i * 4 + 3] = 28;    // ~11% alpha — visible but not loud
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // 2. Walk-box outlines + id labels.
  const boxColors = ['#3ec1c1', '#c1973e', '#a13ec1', '#3e5dc1', '#c13e6a', '#7ec13e'];
  ctx.lineWidth = 1;
  ctx.font = '7px monospace';
  ctx.textBaseline = 'top';
  for (const box of room.walkBoxes) {
    const color = boxColors[box.id % boxColors.length]!;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(box.ulx + 0.5, box.uly + 0.5);
    ctx.lineTo(box.urx + 0.5, box.ury + 0.5);
    ctx.lineTo(box.lrx + 0.5, box.lry + 0.5);
    ctx.lineTo(box.llx + 0.5, box.lly + 0.5);
    ctx.closePath();
    ctx.stroke();
    // id label at the box's top-left, with a small black backdrop
    // so it's legible against any room art.
    const labelX = Math.min(box.ulx, box.llx) + 2;
    const labelY = Math.min(box.uly, box.ury) + 1;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(labelX, labelY, 9, 8);
    ctx.fillStyle = color;
    ctx.fillText(String(box.id), labelX + 1, labelY + 1);
  }

  // 3. Active actor paths.
  for (const actor of vm.actors.inRoom(vm.currentRoom)) {
    if (!actor.isMoving) continue;
    // Draw walkPath as a polyline.
    if (actor.walkPath.length > 0) {
      ctx.strokeStyle = '#ffd54a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(actor.x + 0.5, actor.y + 0.5);
      for (let i = actor.walkPathIdx; i < actor.walkPath.length; i++) {
        const p = actor.walkPath[i]!;
        ctx.lineTo(p.x + 0.5, p.y + 0.5);
      }
      ctx.stroke();
      // Mark each waypoint with a small dot.
      ctx.fillStyle = '#ffd54a';
      for (let i = actor.walkPathIdx; i < actor.walkPath.length; i++) {
        const p = actor.walkPath[i]!;
        ctx.fillRect(p.x - 1, p.y - 1, 3, 3);
      }
    } else if (actor.walkTarget) {
      // Straight-line walk fallback (no path planned). Show a dashed
      // line so it's visually distinct from a real path.
      ctx.strokeStyle = '#ffd54a';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(actor.x + 0.5, actor.y + 0.5);
      ctx.lineTo(actor.walkTarget.x + 0.5, actor.walkTarget.y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Mark the actor's current position.
    ctx.fillStyle = '#ff6b3a';
    ctx.fillRect(actor.x - 1, actor.y - 1, 3, 3);
  }

  return overlay;
}

/**
 * Render every populated actor in the VM's table. "Populated" =
 * something has touched the actor at least once (non-default room /
 * costume / position / movement). Dormant default actors are hidden;
 * the count in the heading shows the total so you can tell at a
 * glance whether everything is dormant or just one. Actors in the
 * current room get a highlight so the compositor's "actors drawn"
 * count maps back to specific rows.
 */
function renderActorTable(vm: Vm): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vm-actors';

  const populated: ReturnType<typeof vm.actors.get>[] = [];
  for (const a of vm.actors.all()) {
    if (a.room !== 0 || a.costume !== 0 || a.x !== 0 || a.y !== 0 || a.isMoving) {
      populated.push(a);
    }
  }

  const heading = document.createElement('h3');
  heading.textContent = `Actors (${populated.length} populated / ${vm.actors.capacity} total)`;
  wrap.appendChild(heading);

  if (populated.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = '(no actors placed yet — scripts haven’t called putActor / setCostume on any slot)';
    wrap.appendChild(empty);
    return wrap;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>id</th>
        <th>room</th>
        <th>pos</th>
        <th>costume</th>
        <th>anim</th>
        <th>facing</th>
        <th>scale</th>
        <th>moving?</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;
  for (const a of populated) {
    const tr = document.createElement('tr');
    if (a.room === vm.currentRoom && a.room !== 0) tr.classList.add('actor-in-current-room');
    if (!a.visible) tr.classList.add('actor-hidden');
    const target = a.walkTarget ? `(${a.walkTarget.x},${a.walkTarget.y})` : '—';
    // Compact anim summary: id + active-limb count, e.g. "12 (3 limbs)".
    // The detailed per-limb cursor positions show up in the
    // expansion below.
    let activeCount = 0;
    for (const limb of a.anim.limbs) if (limb.active) activeCount++;
    const animSummary = a.anim.animId === 0
      ? '—'
      : activeCount === 0
        ? `${a.anim.animId} (inert)`
        : `${a.anim.animId} (${activeCount}L)`;
    const cells = [
      String(a.id),
      a.room === 0 ? '—' : String(a.room),
      `(${a.x},${a.y})`,
      a.costume === 0 ? '—' : String(a.costume),
      animSummary,
      a.facing,
      String(a.scale),
      a.isMoving ? `→ ${target}` : '—',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);

  // Per-actor anim detail panel — only renders for actors whose anim
  // state has at least one active limb (so the panel doesn't add
  // noise for actors with no anim yet). Click to toggle expansion.
  const actorsWithAnim = populated.filter(
    (a) => a.anim.limbs.some((l) => l.active),
  );
  if (actorsWithAnim.length > 0) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Anim state (${actorsWithAnim.length} actor${actorsWithAnim.length === 1 ? '' : 's'} animating)`;
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'vm-actor-anim-list';
    for (const a of actorsWithAnim) {
      const block = document.createElement('div');
      block.className = 'vm-actor-anim-block';
      const head = document.createElement('div');
      head.className = 'vm-actor-anim-head';
      head.textContent = `actor ${a.id} · anim ${a.anim.animId} · costume ${a.costume}`;
      block.appendChild(head);
      const limbTable = document.createElement('table');
      limbTable.className = 'vm-actor-anim-limbs';
      limbTable.innerHTML = `
        <thead><tr><th>limb</th><th>start</th><th>cursor</th><th>length</th><th>noLoop</th><th>state</th></tr></thead>
        <tbody></tbody>
      `;
      const limbBody = limbTable.querySelector('tbody')!;
      for (let i = 0; i < a.anim.limbs.length; i++) {
        const limb = a.anim.limbs[i]!;
        if (!limb.active) continue;
        const ltr = document.createElement('tr');
        if (limb.finished) ltr.classList.add('limb-finished');
        const startStr = `0x${limb.start.toString(16)}`;
        const stateStr = limb.finished
          ? 'finished'
          : limb.length <= 1
            ? 'static'
            : 'playing';
        for (const c of [String(i), startStr, String(limb.cursor), String(limb.length), limb.noLoop ? 'yes' : 'no', stateStr]) {
          const td = document.createElement('td');
          td.textContent = c;
          ltr.appendChild(td);
        }
        limbBody.appendChild(ltr);
      }
      block.appendChild(limbTable);
      list.appendChild(block);
    }
    details.appendChild(list);
    wrap.appendChild(details);
  }

  return wrap;
}

function renderSlotTable(vm: Vm, halt: HaltInfo | null): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vm-slots';

  const heading = document.createElement('h3');
  heading.textContent = 'Script slots';
  wrap.appendChild(heading);

  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th><th>script</th><th>room</th><th>status</th><th>pc</th><th>bytecode</th><th>last op</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;

  const trace = vm.trace;
  const lastOpBySlot = new Map<number, TraceEntry>();
  for (const t of trace) lastOpBySlot.set(t.slotIndex, t);

  let anyPopulated = false;
  for (const s of vm.slots) {
    if (s.status === 'dead' && !lastOpBySlot.has(s.slotIndex)) continue;
    anyPopulated = true;
    const isHalted = halt !== null && halt.slotIndex === s.slotIndex;
    tbody.appendChild(renderSlotRow(s, lastOpBySlot.get(s.slotIndex), isHalted));
  }
  if (!anyPopulated) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'vm-empty-cell';
    td.textContent = '(no slots in use)';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}

function renderSlotRow(
  slot: ScriptSlot,
  last: TraceEntry | undefined,
  isHalted: boolean,
): HTMLElement {
  const tr = document.createElement('tr');
  tr.className = `slot-row slot-${slot.status}${isHalted ? ' slot-halted' : ''}`;
  const statusCell = document.createElement('td');
  statusCell.textContent = slot.status;
  if (isHalted) {
    const badge = document.createElement('span');
    badge.className = 'slot-halt-badge';
    badge.textContent = 'halted';
    statusCell.appendChild(document.createTextNode(' '));
    statusCell.appendChild(badge);
  }
  const isDead = slot.status === 'dead';
  // Prefer the human label (e.g. "ENCD-10") when set; otherwise the
  // numeric script id. Dead-but-traced slots fall through to "—".
  const scriptCell = isDead
    ? '—'
    : slot.label !== ''
      ? slot.label
      : String(slot.scriptId);
  const cells: Array<string | HTMLElement> = [
    String(slot.slotIndex),
    scriptCell,
    slot.room === 0 ? '—' : String(slot.room),
    statusCell,
    isDead ? '—' : `0x${slot.pc.toString(16).padStart(4, '0')}`,
    isDead ? '—' : `${slot.bytecode.length} B`,
    last ? `0x${last.opcode.toString(16).padStart(2, '0')} ${last.mnemonic ?? ''}` : '—',
  ];
  for (const cell of cells) {
    if (cell instanceof HTMLElement) {
      tr.appendChild(cell);
    } else {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
  }
  return tr;
}

function renderTrace(vm: Vm): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vm-trace';
  const heading = document.createElement('h3');
  const trace = vm.trace;
  heading.textContent = `Trace (${trace.length} entr${trace.length === 1 ? 'y' : 'ies'})`;
  wrap.appendChild(heading);
  if (trace.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = '(no opcodes dispatched yet)';
    wrap.appendChild(empty);
    return wrap;
  }
  wrap.appendChild(renderTraceRows([...trace].reverse()));
  return wrap;
}

function renderTraceRows(entries: ReadonlyArray<TraceEntry>): HTMLElement {
  const list = document.createElement('div');
  list.className = 'vm-trace-list';
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'vm-trace-row';
    const head = `slot ${e.slotIndex} · script ${e.scriptId} · pc 0x${e.pc
      .toString(16)
      .padStart(4, '0')} · op 0x${e.opcode.toString(16).padStart(2, '0')}`;
    const tail = e.mnemonic ? `  ${e.mnemonic}` : '';
    row.textContent = `${head}${tail}`;
    list.appendChild(row);
  }
  return list;
}

function renderGlobals(state: InspectorState, repaint: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vm-vars';
  const vm = state.vm!;
  const max = Math.min(state.globalsShown, vm.vars.globals.length);

  const heading = document.createElement('h3');
  heading.textContent = `Globals (showing 0x00..0x${(max - 1).toString(16).padStart(2, '0')} of ${vm.vars.globals.length})`;
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'vm-var-grid';
  for (let i = 0; i < max; i++) {
    const v = vm.vars.globals[i]!;
    const cell = document.createElement('div');
    cell.className = v !== 0 ? 'var-cell var-nonzero' : 'var-cell';
    const idx = document.createElement('span');
    idx.className = 'var-idx';
    idx.textContent = `0x${i.toString(16).padStart(2, '0')}`;
    const val = document.createElement('span');
    val.className = 'var-val';
    val.textContent = String(v);
    cell.appendChild(idx);
    cell.appendChild(val);
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  if (max < vm.vars.globals.length) {
    const more = button('show more');
    more.className = 'secondary';
    more.addEventListener('click', () => {
      state.globalsShown = Math.min(vm.vars.globals.length, state.globalsShown + 64);
      repaint();
    });
    wrap.appendChild(more);
  }

  return wrap;
}

function renderBits(state: InspectorState, repaint: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'vm-bits';
  const vm = state.vm!;
  const max = Math.min(state.bitsShown, vm.vars.numBits);

  const heading = document.createElement('h3');
  heading.textContent = `Bit-vars (showing 0..${max - 1} of ${vm.vars.numBits})`;
  wrap.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'vm-bit-grid';
  for (let i = 0; i < max; i++) {
    const bit = vm.vars.readBit(i);
    const cell = document.createElement('span');
    cell.className = bit ? 'bit-cell bit-on' : 'bit-cell';
    cell.title = `bit ${i} = ${bit}`;
    cell.textContent = String(bit);
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  if (max < vm.vars.numBits) {
    const more = button('show more');
    more.className = 'secondary';
    more.addEventListener('click', () => {
      state.bitsShown = Math.min(vm.vars.numBits, state.bitsShown + 256);
      repaint();
    });
    wrap.appendChild(more);
  }

  return wrap;
}

function anyRunnable(vm: Vm): boolean {
  return vm.slots.some((s) => s.status === 'running');
}

/**
 * True if any slot is in a state that `resume() + dispatch` can
 * advance. Run tick calls `resume()` on every slot before
 * `runUntilAllYield()`, so yielded and frozen slots both count.
 */
function anyAdvanceable(vm: Vm): boolean {
  return vm.slots.some(
    (s) => s.status === 'running' || s.status === 'yielded' || s.status === 'frozen',
  );
}

function button(label: string, variant: 'primary' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant === 'secondary') b.className = 'secondary';
  return b;
}
