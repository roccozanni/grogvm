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
  };

  /** Snapshot of every non-dead slot's (id, status, pc) plus the
   *  position of every moving actor and the anim cursor of any
   *  actively-animating actor — used to detect "we're in a wait loop
   *  where nothing observable changes". Both walks and anim cycles
   *  count as progress, so the loop keeps ticking while either is in
   *  motion. */
  const yieldFingerprint = (vm: Vm): string => {
    const parts: string[] = [];
    for (const s of vm.slots) {
      if (s.status === 'dead') continue;
      parts.push(`s${s.slotIndex}:${s.status}:${s.scriptId}@${s.pc}`);
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
    let resumed = false;
    for (const s of state.vm.slots) {
      if (s.status === 'yielded' || s.status === 'frozen') {
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

  const stopLoop = (): void => {
    if (state.rafId !== null) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    state.playing = false;
  };

  const scheduleNextTick = (): void => {
    if (!state.playing) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = null;
      if (!state.playing || !state.vm) return;
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
        // ~10 frames straight. The game is in a wait-for-input
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
      repaint();
      scheduleNextTick();
    });
  };

  const repaint = (): void => {
    section.replaceChildren(
      renderInner(
        state,
        () => repaint(),
        () => {
          stopLoop();
          const { vm } = bootGame(resourceFile, index, loff, gameId);
          state.vm = vm;
          state.tickCount = 0;
          state.lastIdleFingerprint = null;
          state.idleStreak = 0;
          state.idleReason = null;
          (globalThis as { __vm?: Vm }).__vm = vm;
          // Tiny dev helper: __walkActor(id, x, y) sets up an actor
          // walk through the real pathfinder so you can see the
          // overlay light up without touching the opcode handler.
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
        },
        () => {
          if (state.playing) {
            stopLoop();
          } else if (state.vm) {
            state.playing = true;
            // Reset idle tracking so Play resumes cleanly after the
            // user pokes at state in the console (the new state will
            // produce a new fingerprint).
            state.lastIdleFingerprint = null;
            state.idleStreak = 0;
            state.idleReason = null;
            scheduleNextTick();
          }
          repaint();
        },
      ),
    );
  };

  repaint();
  return section;
}

function renderInner(
  state: InspectorState,
  repaint: () => void,
  bootFresh: () => void,
  togglePlay: () => void,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  const h2 = document.createElement('h2');
  h2.textContent = 'VM';
  frag.appendChild(h2);

  frag.appendChild(renderControls(state, repaint, bootFresh, togglePlay));

  if (!state.vm) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = 'Click Boot to load global script #1 and start the VM.';
    frag.appendChild(empty);
    return frag;
  }

  if (state.vm.haltInfo) {
    frag.appendChild(renderHaltPanel(state.vm.haltInfo));
  }

  if (state.idleReason) {
    const idle = document.createElement('div');
    idle.className = 'vm-idle-banner';
    idle.textContent = `Auto-paused — ${state.idleReason}. Click Play to resume.`;
    frag.appendChild(idle);
  }

  frag.appendChild(renderVmFrame(state, repaint));
  frag.appendChild(renderActorTable(state.vm));
  frag.appendChild(renderSlotTable(state.vm, state.vm.haltInfo));
  frag.appendChild(renderTrace(state.vm));
  frag.appendChild(renderGlobals(state, repaint));
  frag.appendChild(renderBits(state, repaint));

  return frag;
}

function renderControls(
  state: InspectorState,
  repaint: () => void,
  bootFresh: () => void,
  togglePlay: () => void,
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
    : 'Run an engine tick every animation frame (~60 Hz). Auto-pauses on halt or steady state.';
  play.addEventListener('click', togglePlay);
  bar.appendChild(play);

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
    for (const s of state.vm.slots) s.resume();
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
      let resumed = false;
      for (const s of state.vm.slots) {
        if (s.status === 'yielded' || s.status === 'frozen') {
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
    delete (globalThis as { __vm?: Vm }).__vm;
    repaint();
  });
  bar.appendChild(reset);

  if (state.vm) {
    const counter = document.createElement('span');
    counter.className = 'vm-tick-counter';
    counter.textContent = `tick ${state.tickCount}`;
    counter.title = 'Engine ticks since this VM was booted';
    bar.appendChild(counter);
  }

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
 * Render the VM's current "frame" — the room background as the engine
 * currently sees it. Phase 6 sub-task: actors are not yet composited
 * (the actor opcodes are still stubs at the engine level), so this is
 * the room bitmap rendered through its CLUT, with TRNS pixels exposed
 * as transparent (the canvas's CSS checkerboard backdrop shows
 * through).
 */
function renderVmFrame(state: InspectorState, repaint: () => void): HTMLElement {
  const vm = state.vm!;
  const wrap = document.createElement('div');
  wrap.className = 'vm-frame';

  const heading = document.createElement('h3');
  const room = vm.loadedRoom;
  heading.textContent = room
    ? `VM frame — room ${room.id} (${room.width}×${room.height})`
    : `VM frame — currentRoom=${vm.currentRoom}, (no room loaded)`;
  wrap.appendChild(heading);

  if (vm.lastRoomLoadError) {
    const err = document.createElement('p');
    err.className = 'vm-frame-err';
    err.textContent = `Last room-load attempt: ${vm.lastRoomLoadError}`;
    wrap.appendChild(err);
  }

  if (!room) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = '(scripts haven’t loaded a renderable room yet)';
    wrap.appendChild(empty);
    return wrap;
  }

  // Stack the frame canvas + a transparent overlay canvas in a
  // position:relative wrapper so they line up pixel-perfect under the
  // same 2× CSS scale.
  const stack = document.createElement('div');
  stack.className = 'vm-frame-stack';
  stack.style.width = `${room.width * 2}px`;
  stack.style.height = `${room.height * 2}px`;

  const canvas = document.createElement('canvas');
  canvas.className = 'vm-frame-canvas';
  canvas.style.width = `${room.width * 2}px`;
  canvas.style.height = `${room.height * 2}px`;
  const renderer = new Canvas2DRenderer(canvas, room.width, room.height);
  renderer.setPalette(room.palette);
  renderer.setTransparentIndex(room.transparentIndex);

  const framebuffer = new Uint8Array(room.width * room.height);
  const actors = vm.actors.inRoom(vm.currentRoom);
  const result = composeFrame({
    room,
    framebuffer,
    actors,
    getCostume: (id) => vm.getCostume(id),
    objectDrawQueue: vm.objectDrawQueue,
    // Default to state 1 when the script hasn't explicitly set state
    // — most room ENCDs drawObject things without touching state, so
    // treating "default state" as "state 1" matches what real MI1
    // does at room load. If a script wants the object hidden, it
    // calls setState(0).
    getObjectState: (id) => vm.objectStates.get(id) ?? 1,
  });
  renderer.present(framebuffer);
  stack.appendChild(canvas);

  if (state.showWalkOverlay) {
    stack.appendChild(renderWalkOverlay(vm, room));
  }
  wrap.appendChild(stack);

  // Toggle row below the frame.
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
  if (state.showWalkOverlay) {
    const info = document.createElement('span');
    info.className = 'vm-frame-toggles-info';
    info.textContent = `${room.walkBoxes.length} walk box${room.walkBoxes.length === 1 ? '' : 'es'}`;
    toggleRow.appendChild(info);
  }
  wrap.appendChild(toggleRow);

  // Caption: actors + objects drawn, with skip counts so the user
  // can see at a glance why something didn't appear.
  const meta = document.createElement('p');
  meta.className = 'vm-frame-meta';
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
  meta.textContent = `${actorBits}${objectBits}${skipBits}`;
  wrap.appendChild(meta);

  if (actorSkips > 0 || limbSkips > 0 || objectSkips > 0) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = `Skipped (${actorSkips} actor, ${objectSkips} object, ${limbSkips} limb)`;
    details.appendChild(summary);
    const list = document.createElement('ul');
    list.className = 'vm-frame-skip-list';
    for (const s of result.skippedActors) {
      const li = document.createElement('li');
      li.textContent = `actor ${s.actorId}: ${s.reason}`;
      list.appendChild(li);
    }
    for (const s of result.skippedObjects) {
      const li = document.createElement('li');
      li.textContent = `object ${s.objectId}: ${s.reason}`;
      list.appendChild(li);
    }
    for (const s of result.skippedLimbs) {
      const li = document.createElement('li');
      li.textContent = `actor ${s.actorId} limb ${s.limbIdx}: ${s.reason}`;
      list.appendChild(li);
    }
    details.appendChild(list);
    wrap.appendChild(details);
  }

  return wrap;
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
    const cells = [
      String(a.id),
      a.room === 0 ? '—' : String(a.room),
      `(${a.x},${a.y})`,
      a.costume === 0 ? '—' : String(a.costume),
      a.anim.animId === 0 ? '—' : String(a.anim.animId),
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
