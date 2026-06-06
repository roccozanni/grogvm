/**
 * Debug-panel renderers — the pure read-out panels extracted from the
 * legacy inspector (Phase 10 task 7). These build the live
 * inspection subtree (slot table, globals / bits grids, trace, actor
 * table, input panel, halt) and the saves panel. They are stateless
 * apart from the `InspectorState` they read; the EngineSession owns the
 * loop / frame / lifecycle that the old god-object used to carry.
 */

import { type SaveState } from '../../../engine/vm/savestate';
import type { ScriptSlot } from '../../../engine/vm/slot';
import type { HaltInfo, TraceEntry, Vm } from '../../../engine/vm/vm';
import { deleteSave, listSaves, readSave, SaveStoreError, writeSave } from '../../../platform/storage/savegames';
import { type ClickEvent } from '../input';

/**
 * Click captured by the inspector's input layer, with the engine tick
 * count at the moment it landed — handy for correlating a click with
 * trace entries / state changes that follow.
 */
export interface RecentClick extends ClickEvent {
  readonly tickCount: number;
  /** Object id under the click, or null if the click hit empty room. */
  readonly objId: number | null;
}

export interface InspectorState {
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
  /** Room id for the debug "Warp to room" control. */
  warpRoomId: number;
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
  mountedFrame: null;
}

/**
 * Build the live-state subtree (tables / trace / panels — things
 * that update per tick but have NO clickable canvases). The
 * controls bar and the frame area are built separately and reused
 * across tick repaints so their click targets stay stable.
 */
export function renderLive(state: InspectorState, repaint: () => void): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (!state.vm) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = 'Click Boot to load global script #1 and start the VM.';
    frag.appendChild(empty);
    return frag;
  }

  // (The tick counter lives in the Debug controls bar, next to the room
  // readout — see shell/player/debug. No separate live counter here.)

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

function modString(m: ClickEvent['modifiers']): string {
  const parts: string[] = [];
  if (m.shift) parts.push('Shift');
  if (m.ctrl) parts.push('Ctrl');
  if (m.alt) parts.push('Alt');
  if (m.meta) parts.push('Meta');
  return parts.join('+');
}

/**
 * Save / load panel — named slots in localStorage plus file import/
 * export. Rebuilt only on discrete actions (never per tick) so the
 * slot-name input keeps focus while the engine is running.
 *
 * Save snapshots the live VM; load boots a fresh VM and restores the
 * snapshot into it (see `loadSnapshot` in the closure). Export downloads
 * a slot as JSON; import loads a JSON file straight into the engine.
 */
export function renderSavesPanel(
  state: InspectorState,
  saveKey: string,
  saveLabel: string,
  capture: (label: string) => SaveState | null,
  load: (snap: SaveState) => void,
  refresh: () => void,
): HTMLElement {
  const panel = document.createElement('section');
  panel.className = 'vm-saves-panel';

  const heading = document.createElement('h3');
  heading.textContent = 'Saves';
  panel.appendChild(heading);

  const status = document.createElement('p');
  status.className = 'vm-saves-status';
  const setStatus = (msg: string, isError = false): void => {
    status.textContent = msg;
    status.classList.toggle('vm-saves-error', isError);
  };

  // ── Save + Import row ──
  const row = document.createElement('div');
  row.className = 'vm-saves-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'vm-saves-name';
  nameInput.placeholder = 'slot name';
  nameInput.maxLength = 40;

  const saveBtn = button('Save', 'primary');
  saveBtn.disabled = !state.vm;
  if (!state.vm) saveBtn.title = 'Boot the game first';
  const doSave = (): void => {
    const name = nameInput.value.trim() || defaultSaveName();
    const snap = capture(name);
    if (!snap) {
      setStatus('nothing to save — boot the game first', true);
      return;
    }
    try {
      writeSave(saveKey, name, snap);
      nameInput.value = '';
      refresh();
    } catch (err) {
      setStatus(err instanceof SaveStoreError ? err.message : String(err), true);
    }
  };
  saveBtn.addEventListener('click', doSave);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSave();
  });

  const importBtn = button('Import file');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((txt) => {
      try {
        load(JSON.parse(txt) as SaveState);
      } catch (err) {
        setStatus(`import failed: ${err instanceof Error ? err.message : String(err)}`, true);
        refresh();
      }
    });
  });

  row.append(nameInput, saveBtn, importBtn, fileInput);
  panel.append(row, status);

  // ── Slot list ──
  const slots = listSaves(saveKey);
  if (slots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vm-empty';
    empty.textContent = '(no saved games yet)';
    panel.appendChild(empty);
    return panel;
  }

  const list = document.createElement('ul');
  list.className = 'vm-saves-list';
  for (const meta of slots) {
    const li = document.createElement('li');
    li.className = 'vm-saves-item';

    const info = document.createElement('span');
    info.className = 'vm-saves-info';
    info.textContent = `${meta.name} — room ${meta.room} · ${formatWhen(meta.savedAt)}`;

    const loadBtn = button('Load');
    loadBtn.addEventListener('click', () => {
      const snap = readSave(saveKey, meta.name);
      if (snap) {
        load(snap);
      } else {
        setStatus(`slot "${meta.name}" is missing or corrupt`, true);
        refresh();
      }
    });

    const exportBtn = button('Export');
    exportBtn.addEventListener('click', () => {
      const snap = readSave(saveKey, meta.name);
      if (snap) downloadJson(`${saveLabel}-${meta.name}.websave.json`, JSON.stringify(snap));
    });

    const delBtn = button('Delete');
    delBtn.addEventListener('click', () => {
      deleteSave(saveKey, meta.name);
      refresh();
    });

    li.append(info, loadBtn, exportBtn, delBtn);
    list.appendChild(li);
  }
  panel.appendChild(list);
  return panel;
}

/** A timestamp-based default slot name when the user leaves the field blank. */
function defaultSaveName(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `save ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatWhen(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : 'unknown time';
}

/** Trigger a browser download of `text` as `filename`. */
function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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
  // Active verb lives in MI1 game global g107 now (set by script #4).
  const activeVerb = vm.vars.readGlobal(107);
  const verbBits = activeVerb > 0
    ? `${activeVerb} (${vm.verbs.get(activeVerb)?.name ?? '?'})`
    : 'none';
  engineRow.textContent =
    `vm.cursor.state=${vm.cursor.state} · ` +
    `vm.cursor.userput=${vm.cursor.userput} · ` +
    `currentCharset=${vm.currentCharset} · ` +
    `g107(verb)=${verbBits} · ` +
    `verbs=${vm.verbs.size}`;
  panel.appendChild(engineRow);

  // systemOps (0x98) request — a script asked to restart/pause/quit.
  // We ignore it (the inspector keeps running); surface it only when
  // set so the row is silent during normal play, when it stays null.
  if (vm.systemRequest) {
    const sysRow = document.createElement('p');
    sysRow.className = 'vm-input-live';
    sysRow.textContent =
      `systemOps requested "${vm.systemRequest}" — ignored; inspector keeps running.`;
    panel.appendChild(sysRow);
  }

  // roomOps screenEffect (0x0A) — the room-transition fade effects. We
  // record but don't yet animate them (the intro path is all instant);
  // surface them only when a script has set a non-default effect so the
  // row stays silent during normal play.
  const fx = vm.screenEffect;
  if (fx.switchRoomEffect !== 0 || fx.switchRoomEffect2 !== 0 || fx.requestFadeIn) {
    const fxRow = document.createElement('p');
    fxRow.className = 'vm-input-live';
    fxRow.textContent =
      `screenEffect in=${fx.switchRoomEffect} out=${fx.switchRoomEffect2}` +
      (fx.requestFadeIn ? ' · fadeIn requested' : '') +
      ' (recorded; transition not animated)';
    panel.appendChild(fxRow);
  }

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

function button(label: string, variant: 'primary' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant === 'secondary') b.className = 'secondary';
  return b;
}
