/**
 * Debug-panel renderers, built on the reactive core: each panel constructs its
 * DOM ONCE and updates through signal-driven effects — no per-tick subtree
 * rebuilds. The heavy tables (slots/globals/bits/trace/actors/input) re-read
 * the live VM whenever the `live` bump fires; the saves panel is rebuilt only
 * on discrete actions (so the slot-name input keeps focus).
 */

import { effect, el, clear, signal, bindClass, bindAttr, type Signal } from '../../reactive';
import type { ActiveSoundInfo } from '../../../engine/sound/backend';
import { type SaveState } from '../../../engine/vm/savestate';
import type { Actor } from '../../../engine/actor/actor';
import type { ScriptSlot } from '../../../engine/vm/slot';
import type { HaltInfo, TraceEntry, Vm } from '../../../engine/vm/vm';
import { deleteSave, listSaves, readSave, SaveStoreError, writeSave } from '../../../platform/storage/savegames';
import { type ClickEvent } from '../input';

/** A click plus the engine tick count when it landed, for correlating with trace entries. */
export interface RecentClick extends ClickEvent {
  readonly tickCount: number;
  /** Object id under the click, or null if the click hit empty room. */
  readonly objId: number | null;
}

/**
 * What the live panels read. `vm` is an accessor (not a captured reference)
 * because restore swaps the VM; `live` is the throttled bump that drives the
 * heavy tables — every effect below reads it to re-run.
 */
export interface LiveDeps {
  /** The session's current VM, read fresh each update (swaps on restore). */
  readonly vm: () => Vm;
  /** Heavy-table repaint bump: full-rate when paused, throttled while playing. */
  readonly live: () => number;
  /** Auto-pause reason from the session, or null. */
  readonly idleReason: () => string | null;
  /** Recent room clicks, newest first (its own signal — updates on click only). */
  readonly recentClicks: () => readonly RecentClick[];
  /** Globals shown count; the "show more" button writes it. */
  readonly globalsShown: Signal<number>;
  /** Bit-vars shown count; the "show more" button writes it. */
  readonly bitsShown: Signal<number>;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

/**
 * The two conditional alerts (halt + idle), kept OUT of the tabbed panels so a
 * HALTED VM or an auto-pause is always visible — never hidden behind an
 * inactive tab. Built once; each toggles its own display through an effect.
 */
export function alertBanners(d: LiveDeps): HTMLElement {
  return el('div', { class: 'vm-alerts' }, haltPanel(d), idleBanner(d));
}

/**
 * One inspector tab: a stable id (its persisted key + DOM id), a label, and a
 * builder that constructs the pane content given an `isActive` accessor. The
 * builder gets `isActive` so it can freeze its live updates while hidden (see
 * gateDeps); a tab that doesn't update live (Saves) just ignores it.
 */
export interface InspectorTab {
  readonly id: string;
  readonly label: string;
  readonly build: (isActive: () => boolean) => HTMLElement;
}

/**
 * A per-pane view of the deps whose `live` bump is FROZEN while the pane is
 * hidden. The mirror signal only tracks the global bump when `isActive()` is
 * true, so a hidden pane's effects don't re-run (the kernel dedupes equal
 * sets — reactivity.ts). On reveal the mirror catches up to the current bump
 * in one step, so the pane repaints once from the live VM and is never stale.
 * Panel builders are unchanged — they still just read `d.live()`.
 */
function gateDeps(d: LiveDeps, isActive: () => boolean): LiveDeps {
  const paneLive = signal(0);
  effect(() => {
    const bump = d.live();
    if (isActive()) paneLive.set(bump);
  });
  return { ...d, live: paneLive };
}

/**
 * The live panels grouped into tabs by what you read together: script flow
 * (slots + trace), variable state (globals + bits), what's on stage (room +
 * actors + sound), and input. Each pane's panels read a gated `live`, so only
 * the visible pane repaints. The Saves panel is appended by the caller — it
 * rebuilds on discrete actions, so the session owns it.
 */
export function livePanelTabs(d: LiveDeps): InspectorTab[] {
  const group = (...kids: HTMLElement[]): HTMLElement => el('div', { class: 'vm-pane-group' }, ...kids);
  return [
    { id: 'exec', label: 'Execution', build: (a) => { const g = gateDeps(d, a); return group(slotPanel(g), tracePanel(g)); } },
    { id: 'state', label: 'State', build: (a) => { const g = gateDeps(d, a); return group(varsPanel(g, globalsModel(g)), varsPanel(g, bitsModel(g))); } },
    { id: 'stage', label: 'Stage', build: (a) => { const g = gateDeps(d, a); return group(roomPanel(g), actorPanel(g), soundPanel(g)); } },
    { id: 'input', label: 'Input', build: (a) => inputPanel(gateDeps(d, a)) },
  ];
}

export interface TabbedOptions {
  /** Tab id shown first (falls back to the first tab if the id is unknown). */
  readonly initialTab: string;
  /** Called with the new tab id on every switch — for persistence. */
  readonly onTabChange: (id: string) => void;
}

/**
 * Lay panes out as tabs. Every pane is built ONCE and stays in the DOM
 * (preserving the build-once contract — the anim <details> open state, reused
 * var cells, the Saves input's focus); switching only toggles which pane is
 * shown, so the live effects never rebuild and a freshly-shown tab is already
 * current. Reuses the explorer's tab-strip look, but NOT its
 * rebuild-on-switch pane.
 */
export function tabbedPanels(tabs: readonly InspectorTab[], opts: TabbedOptions): HTMLElement {
  const startIdx = Math.max(0, tabs.findIndex((t) => t.id === opts.initialTab));
  const active = signal(startIdx);
  const buttons: HTMLElement[] = [];

  const strip = el('div', { class: 'vm-tabs', role: 'tablist', 'aria-label': 'VM inspector panels' });
  const panes = el('div', { class: 'vm-tabpanes' });

  const select = (i: number): void => {
    active.set(i);
    opts.onTabChange(tabs[i]!.id);
  };

  tabs.forEach((t, i) => {
    const btn = el('button', {
      class: 'vm-tab',
      type: 'button',
      role: 'tab',
      id: `vm-tab-${t.id}`,
      'aria-controls': `vm-pane-${t.id}`,
      text: t.label,
    });
    btn.addEventListener('click', () => select(i));
    bindClass(btn, 'active', () => active() === i);
    bindAttr(btn, 'aria-selected', () => (active() === i ? 'true' : 'false'));
    bindAttr(btn, 'tabindex', () => (active() === i ? '0' : '-1'));
    buttons.push(btn);
    strip.append(btn);

    const pane = el(
      'div',
      { class: 'vm-tabpane', role: 'tabpanel', id: `vm-pane-${t.id}`, 'aria-labelledby': `vm-tab-${t.id}` },
      t.build(() => active() === i),
    );
    bindAttr(pane, 'hidden', () => (active() === i ? null : 'true'));
    panes.append(pane);
  });

  // Roving-tabindex arrow / Home / End navigation across the strip.
  strip.addEventListener('keydown', (e) => {
    let next: number;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (active() + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (active() - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    select(next);
    buttons[next]!.focus();
  });

  return el('div', { class: 'vm-tabbed' }, strip, panes);
}

function modString(m: ClickEvent['modifiers']): string {
  const parts: string[] = [];
  if (m.shift) parts.push('Shift');
  if (m.ctrl) parts.push('Ctrl');
  if (m.alt) parts.push('Alt');
  if (m.meta) parts.push('Meta');
  return parts.join('+');
}

// ── halt + idle banners (conditional; toggled, never rebuilt wholesale) ──

function haltPanel(d: LiveDeps): HTMLElement {
  const panel = el('div', { class: 'vm-halt', style: { display: 'none' } });
  effect(() => {
    d.live();
    const halt = d.vm().haltInfo;
    clear(panel);
    panel.style.display = halt ? '' : 'none';
    if (halt) renderHalt(panel, halt);
  });
  return panel;
}

function renderHalt(panel: HTMLElement, halt: HaltInfo): void {
  panel.append(
    el('h3', {}, `HALTED — ${halt.reason}`),
    el(
      'p',
      { class: 'vm-halt-meta' },
      `slot=${halt.slotIndex} · script=${halt.scriptId} · pc=0x${hex4(halt.pc)} · opcode=0x${hex2(halt.opcode)}`,
    ),
    el('div', { class: 'vm-halt-ctx-label' }, 'Bytecode context (offending byte in red):'),
  );
  const ctx = el('div', { class: 'vm-halt-ctx' });
  for (let i = 0; i < halt.bytecodeContext.length; i++) {
    ctx.append(
      el('span', { class: i === halt.contextOpcodeOffset ? 'hex-cell hex-here' : 'hex-cell' }, hex2(halt.bytecodeContext[i]!)),
    );
  }
  panel.append(ctx);
  if (halt.trace.length > 0) {
    panel.append(
      el('div', { class: 'vm-halt-ctx-label' }, 'Last opcodes leading up to halt:'),
      traceRows(halt.trace),
    );
  }
}

function idleBanner(d: LiveDeps): HTMLElement {
  const banner = el('div', { class: 'vm-idle-banner', style: { display: 'none' } });
  effect(() => {
    d.live();
    const reason = d.idleReason();
    banner.style.display = reason ? '' : 'none';
    banner.textContent = reason ? `Auto-paused — ${reason}. Click Play to resume.` : '';
  });
  return banner;
}

// ── input panel ──

/**
 * Live cursor coords + recent-click ring — read-only diagnostic for when
 * scripts ignore clicks (cutscenes, userput off, …).
 */
function inputPanel(d: LiveDeps): HTMLElement {
  const liveRow = el('p', { class: 'vm-input-live' });
  const engineRow = el('p', { class: 'vm-input-live' });
  const sysRow = el('p', { class: 'vm-input-live', style: { display: 'none' } });
  const fxRow = el('p', { class: 'vm-input-live', style: { display: 'none' } });
  const varsRow = el('p', { class: 'vm-input-live' });
  const clicksHost = el('div', { class: 'vm-input-clicks-host' });

  effect(() => {
    d.live();
    const vm = d.vm();
    // VAR_VIRT_MOUSE should always match vm.mouseRoom*; surfacing both catches
    // a divergence if a script writes the VARs directly.
    liveRow.textContent =
      `cursor room=(${vm.mouseRoomX}, ${vm.mouseRoomY}) · ` +
      `VAR_VIRT_MOUSE=(${vm.vars.readGlobal(20)}, ${vm.vars.readGlobal(21)}) · ` +
      `VAR_MOUSE=(${vm.vars.readGlobal(44)}, ${vm.vars.readGlobal(45)})`;

    // Engine-truth cursor / verb state — what the game logic actually sees.
    // The armed verb lives in MI1 global g107 (set by script #4).
    const activeVerb = vm.vars.readGlobal(107);
    const verbBits = activeVerb > 0 ? `${activeVerb} (${vm.verbs.get(activeVerb)?.name ?? '?'})` : 'none';
    engineRow.textContent =
      `vm.cursor.state=${vm.cursor.state} · ` +
      `vm.cursor.userput=${vm.cursor.userput} · ` +
      `currentCharset=${vm.currentCharset} · ` +
      `g107(verb)=${verbBits} · ` +
      `verbs=${vm.verbs.size}`;

    // systemOps restart/pause/quit requests are ignored (the inspector keeps
    // running); surfaced only when set.
    sysRow.style.display = vm.systemRequest ? '' : 'none';
    if (vm.systemRequest) {
      sysRow.textContent = `systemOps requested "${vm.systemRequest}" — ignored; inspector keeps running.`;
    }

    // roomOps screenEffect transitions are recorded but not animated; surfaced
    // only when a script set a non-default effect.
    const fx = vm.screenEffect;
    const showFx = fx.switchRoomEffect !== 0 || fx.switchRoomEffect2 !== 0 || fx.requestFadeIn;
    fxRow.style.display = showFx ? '' : 'none';
    if (showFx) {
      fxRow.textContent =
        `screenEffect in=${fx.switchRoomEffect} out=${fx.switchRoomEffect2}` +
        (fx.requestFadeIn ? ' · fadeIn requested' : '') +
        ' (recorded; transition not animated)';
    }

    varsRow.textContent =
      `leftHold=${vm.input.leftHold} · rightHold=${vm.input.rightHold} · ` +
      `VAR_CURSORSTATE(g52)=${vm.vars.readGlobal(52)} · ` +
      `VAR_USERPUT(g53)=${vm.vars.readGlobal(53)}`;
  });

  // The click ring changes only on a click, so it rides its own signal rather
  // than the per-frame live bump.
  effect(() => {
    const clicks = d.recentClicks();
    clear(clicksHost);
    if (clicks.length === 0) {
      clicksHost.append(el('p', { class: 'vm-empty' }, '(no clicks yet — click on the VM frame canvas)'));
      return;
    }
    const list = el('ul', { class: 'vm-input-clicks' });
    for (const c of clicks) {
      const mods = modString(c.modifiers);
      const objBit = c.objId !== null ? ` · obj #${c.objId}` : '';
      list.append(
        el('li', {}, `tick ${c.tickCount} · ${c.button} · (${c.roomX}, ${c.roomY})${objBit}${mods ? ` · ${mods}` : ''}`),
      );
    }
    clicksHost.append(list);
  });

  return el('section', { class: 'vm-input-panel' }, el('h3', {}, 'Input'), liveRow, engineRow, sysRow, fxRow, varsRow, clicksHost);
}

// ── room (leads the Stage tab) ──

/** Current room id + loaded-room dimensions — the Stage tab's header line. */
function roomPanel(d: LiveDeps): HTMLElement {
  const label = el('p', { class: 'vm-room-label' });
  effect(() => {
    d.live();
    const v = d.vm();
    label.textContent = v.loadedRoom
      ? `Room ${v.currentRoom} · ${v.loadedRoom.width}×${v.loadedRoom.height}`
      : `Room ${v.currentRoom} · none loaded`;
  });
  return el('div', { class: 'vm-room' }, el('h3', {}, 'Room'), label);
}

// ── actor table (+ persistent anim <details>) ──

/**
 * Render every populated (touched-at-least-once) actor; dormant defaults are
 * hidden, and actors in the current room get a highlight. The anim column
 * carries the live-useful summary (id, active limb count, inert); raw per-limb
 * costume state belongs in static tooling, not a running session.
 */
function actorPanel(d: LiveDeps): HTMLElement {
  const heading = el('h3');
  const empty = el('p', { class: 'vm-empty', style: { display: 'none' } }, '(no actors placed yet — scripts haven’t called putActor / setCostume on any slot)');
  const table = el('table', { style: { display: 'none' } });
  table.innerHTML = `
    <thead>
      <tr>
        <th>id</th><th>room</th><th>pos</th><th>costume</th><th>anim</th><th>facing</th><th>scale</th><th>moving?</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;

  effect(() => {
    d.live();
    const vm = d.vm();
    const populated: Actor[] = [];
    for (const a of vm.actors.all()) {
      if (a.room !== 0 || a.costume !== 0 || a.x !== 0 || a.y !== 0 || a.isMoving) populated.push(a);
    }
    heading.textContent = `Actors (${populated.length} populated / ${vm.actors.capacity} total)`;

    const hasActors = populated.length > 0;
    empty.style.display = hasActors ? 'none' : '';
    table.style.display = hasActors ? '' : 'none';
    clear(tbody);
    for (const a of populated) tbody.append(actorRow(a, vm));
  });

  return el('div', { class: 'vm-actors' }, heading, empty, table);
}

function actorRow(a: Actor, vm: Vm): HTMLElement {
  const tr = el('tr');
  if (a.room === vm.currentRoom && a.room !== 0) tr.classList.add('actor-in-current-room');
  if (!a.visible) tr.classList.add('actor-hidden');
  const target = a.walkTarget ? `(${a.walkTarget.x},${a.walkTarget.y})` : '—';
  // Compact anim summary; per-limb detail is in the expansion below.
  let activeCount = 0;
  for (const limb of a.anim.limbs) if (limb.active) activeCount++;
  const anim = a.anim.animId === 0 ? '—' : activeCount === 0 ? `${a.anim.animId} (inert)` : `${a.anim.animId} (${activeCount}L)`;
  for (const c of [
    String(a.id),
    a.room === 0 ? '—' : String(a.room),
    `(${a.x},${a.y})`,
    a.costume === 0 ? '—' : String(a.costume),
    anim,
    String(a.facing),
    String(a.scale),
    a.isMoving ? `→ ${target}` : '—',
  ]) {
    tr.append(el('td', {}, c));
  }
  return tr;
}

// ── sound ──

/**
 * Live sound table: every sound the VM's timing authority counts as active —
 * what it *believes* is playing, the way the actor panel shows what's on stage.
 * PCM and CD renditions are audible; MIDI (the AdLib effects) and silent ones
 * are timed but produce no output yet, so they list with a "disabled" status —
 * a missing effect reads as not-implemented, not broken. A sound restored from
 * a save shows "restored" until the game next starts it (the snapshot carries
 * no rendition). See pages/docs/engine/audio.md.
 */
function soundPanel(d: LiveDeps): HTMLElement {
  const heading = el('h3');
  const empty = el('p', { class: 'vm-empty', style: { display: 'none' } }, '(nothing playing)');
  const table = el('table', { style: { display: 'none' } });
  table.innerHTML = `
    <thead><tr><th>id</th><th>kind</th><th>status</th><th>length</th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;

  effect(() => {
    d.live();
    const sounds = d.vm().audio.inspect();
    heading.textContent = `Sound (${sounds.length} active)`;
    const any = sounds.length > 0;
    empty.style.display = any ? 'none' : '';
    table.style.display = any ? '' : 'none';
    clear(tbody);
    // Music first, then by id — a stable order so the rebuilt rows don't jump
    // as the active set changes from bump to bump.
    const ordered = [...sounds].sort((a, b) => Number(b.isMusic) - Number(a.isMusic) || a.id - b.id);
    for (const s of ordered) tbody.append(soundRow(s));
  });

  return el('div', { class: 'vm-sounds' }, heading, empty, table);
}

function soundRow(s: ActiveSoundInfo): HTMLElement {
  const disabled = s.kind === 'midi' || s.kind === 'silent';
  const tr = el('tr', { class: `sound-row${disabled ? ' sound-disabled' : ''}${s.isMusic ? ' sound-music' : ''}` });

  // MIDI shows its device (adl/rol/spk) — that's the distinguishing detail.
  const kind = s.kind === 'midi' ? (s.device ?? 'midi').toLowerCase() : s.kind;
  // MIDI is the parked AdLib synth (not implemented); a 'silent' rendition is a
  // genuinely empty/unrecognized SOU — distinct reasons for the same silence.
  const status =
    s.kind === 'unknown'
      ? 'restored'
      : s.kind === 'midi'
        ? 'disabled (not implemented)'
        : s.kind === 'silent'
          ? 'silent (no audio)'
          : 'playing';
  // The sound's full duration — not a countdown; it doesn't tick down per bump.
  const length = s.looping ? 'looping' : s.total > 0 ? secs(s.total) : '—';

  const idCell = el('td', {}, `#${s.id}`);
  if (s.isMusic) idCell.append(document.createTextNode(' '), el('span', { class: 'sound-music-badge' }, 'music'));
  tr.append(idCell, el('td', {}, kind), el('td', {}, status), el('td', {}, length));
  return tr;
}

/** Jiffies (1/60 s) → a compact seconds label. */
function secs(jiffies: number): string {
  return `${(jiffies / 60).toFixed(1)}s`;
}

// ── script slots ──

function slotPanel(d: LiveDeps): HTMLElement {
  const table = el('table');
  table.innerHTML = `
    <thead>
      <tr><th>#</th><th>script</th><th>room</th><th>status</th><th>pc</th><th>bytecode</th><th>last op</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody')!;

  effect(() => {
    d.live();
    const vm = d.vm();
    const halt = vm.haltInfo;
    const lastOpBySlot = new Map<number, TraceEntry>();
    for (const t of vm.trace) lastOpBySlot.set(t.slotIndex, t);

    clear(tbody);
    let anyPopulated = false;
    for (const s of vm.slots) {
      if (s.status === 'dead' && !lastOpBySlot.has(s.slotIndex)) continue;
      anyPopulated = true;
      tbody.append(slotRow(s, lastOpBySlot.get(s.slotIndex), halt !== null && halt.slotIndex === s.slotIndex));
    }
    if (!anyPopulated) {
      const td = el('td', { class: 'vm-empty-cell' }, '(no slots in use)');
      td.colSpan = 7;
      tbody.append(el('tr', {}, td));
    }
  });

  return el('div', { class: 'vm-slots' }, el('h3', {}, 'Script slots'), table);
}

function slotRow(slot: ScriptSlot, last: TraceEntry | undefined, isHalted: boolean): HTMLElement {
  const tr = el('tr', { class: `slot-row slot-${slot.status}${isHalted ? ' slot-halted' : ''}` });
  const statusCell = el('td', {}, slot.status);
  if (isHalted) {
    statusCell.append(document.createTextNode(' '), el('span', { class: 'slot-halt-badge' }, 'halted'));
  }
  const isDead = slot.status === 'dead';
  const scriptCell = isDead ? '—' : slot.label !== '' ? slot.label : String(slot.scriptId);
  tr.append(
    el('td', {}, String(slot.slotIndex)),
    el('td', {}, scriptCell),
    el('td', {}, slot.room === 0 ? '—' : String(slot.room)),
    statusCell,
    el('td', {}, isDead ? '—' : `0x${hex4(slot.pc)}`),
    el('td', {}, isDead ? '—' : `${slot.bytecode.length} B`),
    el('td', {}, last ? `0x${hex2(last.opcode)} ${last.mnemonic ?? ''}` : '—'),
  );
  return tr;
}

// ── trace ──

function tracePanel(d: LiveDeps): HTMLElement {
  const heading = el('h3');
  const body = el('div', { class: 'vm-trace-body' });
  effect(() => {
    d.live();
    const trace = d.vm().trace;
    heading.textContent = `Trace (${trace.length} entr${trace.length === 1 ? 'y' : 'ies'})`;
    clear(body);
    if (trace.length === 0) body.append(el('p', { class: 'vm-empty' }, '(no opcodes dispatched yet)'));
    else body.append(traceRows([...trace].reverse()));
  });
  return el('div', { class: 'vm-trace' }, heading, body);
}

function traceRows(entries: ReadonlyArray<TraceEntry>): HTMLElement {
  const list = el('div', { class: 'vm-trace-list' });
  for (const e of entries) {
    const tail = e.mnemonic ? `  ${e.mnemonic}` : '';
    list.append(
      el('div', { class: 'vm-trace-row' }, `slot ${e.slotIndex} · script ${e.scriptId} · pc 0x${hex4(e.pc)} · op 0x${hex2(e.opcode)}${tail}`),
    );
  }
  return list;
}

// ── globals + bit-vars (persistent bound cells, reconciled on count change) ──

interface VarsModel {
  /** Total available (globals length / bit count). */
  total: (vm: Vm) => number;
  /** How many are shown right now. */
  shown: Signal<number>;
  /** Step the "show more" button adds. */
  step: number;
  /** Heading prefix + the address span of `count` entries. */
  heading: (count: number, total: number) => string;
  /** Grid CSS class. */
  gridClass: string;
  /** Build one (persistent) cell for index `i`. */
  cell: (i: number) => HTMLElement;
  /** Update cell `i` to the VM's current value. */
  update: (cell: HTMLElement, i: number, vm: Vm) => void;
}

function globalsModel(d: LiveDeps): VarsModel {
  return {
    total: (vm) => vm.vars.globals.length,
    shown: d.globalsShown,
    step: 64,
    heading: (count, total) => `Globals (showing 0x00..0x${hex2(count - 1)} of ${total})`,
    gridClass: 'vm-var-grid',
    cell: (i) => el('div', { class: 'var-cell' }, el('span', { class: 'var-idx' }, `0x${hex2(i)}`), el('span', { class: 'var-val' })),
    update: (cell, i, vm) => {
      const v = vm.vars.globals[i]!;
      cell.classList.toggle('var-nonzero', v !== 0);
      (cell.lastChild as HTMLElement).textContent = String(v);
    },
  };
}

function bitsModel(d: LiveDeps): VarsModel {
  return {
    total: (vm) => vm.vars.numBits,
    shown: d.bitsShown,
    step: 256,
    heading: (count, total) => `Bit-vars (showing 0..${count - 1} of ${total})`,
    gridClass: 'vm-bit-grid',
    cell: () => el('span', { class: 'bit-cell' }),
    update: (cell, i, vm) => {
      const bit = vm.vars.readBit(i);
      cell.classList.toggle('bit-on', bit !== 0);
      cell.title = `bit ${i} = ${bit}`;
      cell.textContent = String(bit);
    },
  };
}

function varsPanel(d: LiveDeps, model: VarsModel): HTMLElement {
  const heading = el('h3');
  const grid = el('div', { class: model.gridClass });
  const more = el('button', {
    class: 'secondary',
    style: { display: 'none' },
    onClick: () => model.shown.set((n) => Math.min(model.total(d.vm()), n + model.step)),
  }, 'show more');

  const cells: HTMLElement[] = [];
  effect(() => {
    d.live();
    const vm = d.vm();
    const total = model.total(vm);
    const count = Math.min(model.shown(), total);
    heading.textContent = model.heading(count, total);
    // Grow/shrink the persistent cell set only when the count changes; values
    // are written every bump (cheap) rather than recreating the grid.
    while (cells.length < count) {
      const c = model.cell(cells.length);
      grid.append(c);
      cells.push(c);
    }
    while (cells.length > count) cells.pop()!.remove();
    for (let i = 0; i < count; i++) model.update(cells[i]!, i, vm);
    more.style.display = count < total ? '' : 'none';
  });

  return el('div', { class: 'vm-vars' }, heading, grid, more);
}

// ── saves panel (rebuilt only on discrete actions; keeps input focus) ──

/**
 * Save / load panel: named localStorage slots plus file import/export.
 * Rebuilt only on discrete actions (never per tick) so the slot-name input
 * keeps focus while the engine is running.
 */
export function savesPanel(
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
    fileInput.value = ''; // let the same file be re-imported later
    if (!file) return;
    void file.text().then((txt) => {
      let snap: SaveState;
      try {
        snap = JSON.parse(txt) as SaveState;
      } catch {
        setStatus('import failed: not valid JSON', true);
        return;
      }
      // load() validates the save (throwing on a version / shape mismatch)
      // and rebuilds the panel; on failure leave the message up (no refresh).
      try {
        load(snap);
      } catch (err) {
        setStatus(`import failed: ${err instanceof Error ? err.message : String(err)}`, true);
        return;
      }
      // Loaded fine — also persist it to a named slot so the import sticks in
      // the list instead of being a one-shot load that vanishes on reboot.
      const slot = nameInput.value.trim() || importNameFor(file.name, snap);
      try {
        writeSave(saveKey, slot, snap);
      } catch (err) {
        setStatus(`loaded, but couldn’t add to the list: ${err instanceof SaveStoreError ? err.message : String(err)}`, true);
        return;
      }
      nameInput.value = '';
      refresh(); // rebuild the list so the imported slot shows
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

function defaultSaveName(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `save ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Slot name for an imported save: the label it was saved under, else the
 * file's base name (sans the exporter's .websave/.json suffix), else a
 * timestamp. Capped to the slot-name input's maxLength.
 */
function importNameFor(fileName: string, snap: SaveState): string {
  const label = snap.label?.trim();
  const stem = fileName.replace(/\.websave\.json$|\.json$/i, '').trim();
  return (label || stem || defaultSaveName()).slice(0, 40);
}

function formatWhen(ms: number): string {
  return ms ? new Date(ms).toLocaleString() : 'unknown time';
}

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

function button(label: string, variant: 'primary' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant === 'secondary') b.className = 'secondary';
  return b;
}
