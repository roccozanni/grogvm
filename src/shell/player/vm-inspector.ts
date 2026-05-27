/**
 * VM inspector — full-state UI for the Phase 5 bytecode interpreter.
 *
 * Renders a single self-contained `<section>` that owns the live `Vm`
 * instance, the control buttons, and all the read-out panels. The
 * section re-renders the read-outs after each user action; the
 * underlying `Vm` lives across renders.
 */

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
}

export function renderVmInspector(
  resourceFile: ResourceFile,
  index: IndexFile,
  loff: RoomOffsetTable,
  gameId: GameId,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'vm-inspector';

  const state: InspectorState = { vm: null, globalsShown: 64, bitsShown: 256 };

  const repaint = (): void => {
    section.replaceChildren(renderInner(state, () => repaint(), () => {
      const { vm } = bootGame(resourceFile, index, loff, gameId);
      state.vm = vm;
      repaint();
    }));
  };

  repaint();
  return section;
}

function renderInner(
  state: InspectorState,
  repaint: () => void,
  bootFresh: () => void,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  const h2 = document.createElement('h2');
  h2.textContent = 'VM';
  frag.appendChild(h2);

  frag.appendChild(renderControls(state, repaint, bootFresh));

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
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'vm-controls';

  const boot = button('Boot', 'primary');
  boot.title = 'Reload boot script and start fresh';
  boot.addEventListener('click', bootFresh);
  bar.appendChild(boot);

  const step = button('Step');
  step.disabled = !state.vm || state.vm.isHalted || !anyRunnable(state.vm);
  step.title = 'Dispatch one opcode';
  step.addEventListener('click', () => {
    state.vm?.step();
    repaint();
  });
  bar.appendChild(step);

  const run = button('Run tick');
  run.disabled = !state.vm || state.vm.isHalted || !anyRunnable(state.vm);
  run.title = 'Run until every slot has yielded (one engine tick)';
  run.addEventListener('click', () => {
    if (!state.vm) return;
    // Resume yielded slots before running another tick, mirroring the
    // role the main loop will play in Phase 6.
    for (const s of state.vm.slots) s.resume();
    state.vm.runUntilAllYield();
    repaint();
  });
  bar.appendChild(run);

  const reset = button('Reset');
  reset.disabled = !state.vm;
  reset.title = 'Wipe slots, vars, trace, halt — return to pre-Boot state';
  reset.addEventListener('click', () => {
    state.vm?.reset();
    state.vm = null;
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
  const cells: Array<string | HTMLElement> = [
    String(slot.slotIndex),
    slot.scriptId === 0 ? '—' : String(slot.scriptId),
    slot.room === 0 ? '—' : String(slot.room),
    statusCell,
    slot.scriptId === 0 ? '—' : `0x${slot.pc.toString(16).padStart(4, '0')}`,
    slot.scriptId === 0 ? '—' : `${slot.bytecode.length} B`,
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

function button(label: string, variant: 'primary' | 'secondary' = 'secondary'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (variant === 'secondary') b.className = 'secondary';
  return b;
}
