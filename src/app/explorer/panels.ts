/**
 * Dossier panels for the Explorer. Each renders one slice of a
 * {@link RoomDossier}, showing a decode error inline instead of throwing.
 */
import { signal, effect, el, append, clear, bindClass, bindText, type Child } from '../reactive';
import type { Signal } from '../reactive';
import { disassemble } from '../../engine/vm/disasm';
import { Canvas2DRenderer } from '../../platform/render/canvas2d';
import { objectHitBox } from '../../engine/object/hittest';
import type {
  RoomRef,
  RoomDossier,
  RoomBackground,
  RoomScript,
  ReferencedScript,
  Section,
} from '../../engine/room/extract';
import type { LoadedObject } from '../../engine/object/loader';
import type { WalkBox } from '../../engine/pathfinding/boxes';
import type { DecodedZPlane } from '../../engine/graphics/zplane';

const BG_SCALE = 2;

/** Collapsible dossier section; `count` renders as a badge after the title. */
export function panel(
  title: string,
  body: Child,
  opts: { collapsed?: boolean; count?: number | string } = {},
): HTMLElement {
  const head = el(
    'button',
    { class: 'dossier-panel-head', type: 'button' },
    el('span', { class: 'dossier-panel-title', text: title }),
    opts.count != null ? el('span', { class: 'dossier-panel-count', text: String(opts.count) }) : null,
  );
  const bodyWrap = el('div', { class: 'dossier-panel-body' }, body);
  let open = !opts.collapsed;
  const setOpen = (next: boolean): void => {
    open = next;
    bodyWrap.hidden = !open;
    head.classList.toggle('collapsed', !open);
  };
  setOpen(open);
  head.addEventListener('click', () => setOpen(!open));
  return el('section', { class: 'dossier-panel' }, head, bodyWrap);
}

function sectionError(error: string): HTMLElement {
  return el('p', { class: 'dossier-error', text: `decode failed: ${error}` });
}

// ── Background ──────────────────────────────────────────────────────────

export function backgroundPanel(
  bg: Section<RoomBackground>,
  objects: readonly LoadedObject[],
  walkBoxes: readonly WalkBox[],
  zPlanes: readonly DecodedZPlane[],
  selected: Signal<number | null>,
): HTMLElement {
  if (!bg.ok) return panel('Background', sectionError(bg.error));
  const { width, height, palette, transparentIndex, indexed, stripMethods } = bg.value;

  const canvas = el('canvas', { class: 'room-canvas' });
  canvas.style.width = `${width * BG_SCALE}px`;
  canvas.style.height = `${height * BG_SCALE}px`;
  const renderer = new Canvas2DRenderer(canvas, width, height);
  renderer.setPalette(palette);
  renderer.setTransparentIndex(transparentIndex);
  renderer.present(indexed);

  // Transparent overlay stacked over the room; pointer-events pass through to
  // the room canvas, which hit-tests clicks against the boxes.
  const overlay = el('canvas', { class: 'object-overlay' });
  overlay.width = width;
  overlay.height = height;
  overlay.style.width = `${width * BG_SCALE}px`;
  overlay.style.height = `${height * BG_SCALE}px`;

  const showObjects = signal(readFlag(OBJECT_BOXES_KEY, true));
  const showWalk = signal(readFlag(WALK_BOXES_KEY, false));
  const showZplanes = signal(readFlag(ZPLANES_KEY, false));
  effect(() => {
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    // putImageData replaces rather than blends, so the z-plane fill must go
    // down before the stroked box overlays.
    if (showZplanes()) drawZPlanes(ctx, zPlanes, width, height);
    if (showWalk()) for (const box of walkBoxes) drawWalkBox(ctx, box);
    if (showObjects()) {
      const sel = selected();
      for (const obj of objects) drawObjectBox(ctx, obj, obj.objId === sel);
    }
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const y = ((e.clientY - rect.top) / rect.height) * height;
    const hit = pickObjectAt(objects, x, y);
    if (hit !== null) selected.set(hit); // clicking empty space keeps the current object
  });

  const stack = el('div', { class: 'room-canvas-stack' }, canvas, overlay);
  stack.style.width = `${width * BG_SCALE}px`;
  stack.style.height = `${height * BG_SCALE}px`;

  // Wide rooms exceed the dossier column; scroll strip + canvas together.
  const scroll = el('div', { class: 'room-scroll' }, stripBar(stripMethods, width), stack);
  const body = el('div', { class: 'background-panel' }, scroll);
  const toggles = el('div', { class: 'overlay-toggles' });
  if (objects.length > 0) append(toggles, overlayToggle(showObjects, OBJECT_BOXES_KEY, `Object boxes (${objects.length})`));
  if (walkBoxes.length > 0) append(toggles, overlayToggle(showWalk, WALK_BOXES_KEY, `Walk boxes (${walkBoxes.length})`));
  if (zPlanes.length > 0) append(toggles, overlayToggle(showZplanes, ZPLANES_KEY, `Z-planes (${zPlanes.length})`));
  if (toggles.children.length > 0) append(body, toggles);
  const summary = `${width}×${height} · ${stripMethods.length} strips · transparent ${transparentIndex ?? 'none'}`;
  return panel('Background', body, { count: summary });
}

const BOX_COLOR = 'rgba(120,180,255,0.55)';
const BOX_SELECTED = 'rgba(255,220,80,0.95)';
const WALK_COLOR = 'rgba(255,120,200,0.85)';

function drawObjectBox(ctx: CanvasRenderingContext2D, obj: LoadedObject, isSelected: boolean): void {
  const box = objectHitBox(obj);
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  if (w > 0 && h > 0) {
    ctx.lineWidth = 1;
    if (isSelected) {
      ctx.fillStyle = 'rgba(255,220,80,0.18)';
      ctx.fillRect(box.left, box.top, w, h);
    }
    ctx.strokeStyle = isSelected ? BOX_SELECTED : BOX_COLOR;
    ctx.strokeRect(box.left + 0.5, box.top + 0.5, w - 1, h - 1);
  }
  // Walk-to point is in pixel coords (unlike the /8 hit-box fields).
  if (obj.cdhd.walkX > 0 || obj.cdhd.walkY > 0) {
    ctx.fillStyle = isSelected ? BOX_SELECTED : WALK_COLOR;
    ctx.fillRect(obj.cdhd.walkX - 1, obj.cdhd.walkY - 1, 3, 3);
  }
}

// Matches the player's walk-box debug overlay palette.
const WALK_BOX_COLORS = ['#3ec1c1', '#c1973e', '#a13ec1', '#3e5dc1', '#c13e6a', '#7ec13e'];

function drawWalkBox(ctx: CanvasRenderingContext2D, box: WalkBox): void {
  ctx.strokeStyle = WALK_BOX_COLORS[box.id % WALK_BOX_COLORS.length]!;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.ulx + 0.5, box.uly + 0.5);
  ctx.lineTo(box.urx + 0.5, box.ury + 0.5);
  ctx.lineTo(box.lrx + 0.5, box.lry + 0.5);
  ctx.lineTo(box.llx + 0.5, box.lly + 0.5);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillText(String(box.id), box.ulx + 1, box.uly + 7);
}

// Semi-transparent fills; overlapping planes max-blend brighter.
const ZPLANE_TINTS: readonly [number, number, number][] = [
  [255, 80, 80],
  [80, 255, 80],
  [80, 160, 255],
  [255, 220, 80],
  [220, 80, 255],
  [80, 255, 220],
  [255, 160, 80],
  [200, 200, 200],
];

function drawZPlanes(ctx: CanvasRenderingContext2D, planes: readonly DecodedZPlane[], width: number, height: number): void {
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < planes.length; i++) {
    const tint = ZPLANE_TINTS[i % ZPLANE_TINTS.length]!;
    const mask = planes[i]!.mask;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      const o = p * 4;
      img.data[o] = Math.max(img.data[o]!, tint[0]);
      img.data[o + 1] = Math.max(img.data[o + 1]!, tint[1]);
      img.data[o + 2] = Math.max(img.data[o + 2]!, tint[2]);
      img.data[o + 3] = 150;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Smallest hit box containing (x,y) — the most specific object under the click. */
function pickObjectAt(objects: readonly LoadedObject[], x: number, y: number): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  for (const obj of objects) {
    const b = objectHitBox(obj);
    if (x >= b.left && x < b.right && y >= b.top && y < b.bottom) {
      const area = (b.right - b.left) * (b.bottom - b.top);
      if (area < bestArea) {
        bestArea = area;
        best = obj.objId;
      }
    }
  }
  return best;
}

const OBJECT_BOXES_KEY = 'grogvm:explorer:object-boxes';
const WALK_BOXES_KEY = 'grogvm:explorer:walk-boxes';
const ZPLANES_KEY = 'grogvm:explorer:zplanes';

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? '1' : '0');
  } catch {
    /* no localStorage → the toggle just won't persist */
  }
}

// Inline SVG rather than an emoji glyph (code conventions ban emoji).
const BOX_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="3.5" y="6" width="17" height="12" /><circle cx="8" cy="15" r="1.3" fill="currentColor" stroke="none" />
</svg>`;

function iconSpan(svg: string): HTMLElement {
  const span = el('span', { class: 'btn-icon' });
  span.innerHTML = svg;
  return span;
}

function overlayToggle(show: Signal<boolean>, key: string, label: string): HTMLElement {
  const btn = el('button', { class: 'secondary overlay-toggle-btn', type: 'button' }, iconSpan(BOX_ICON_SVG), label);
  btn.classList.toggle('is-on', show.peek());
  btn.addEventListener('click', () => {
    show.set(!show.peek());
    writeFlag(key, show.peek());
    btn.classList.toggle('is-on', show.peek());
  });
  return btn;
}

interface SmapMethodFamily {
  readonly name: string;
  readonly color: string;
}

function classifySmapMethod(code: number): SmapMethodFamily {
  if (code === 0x01) return { name: 'uncompressed', color: '#666' };
  if (code >= 0x0e && code <= 0x12) return { name: `M1 V  pb=${code - 0x0a}`, color: '#4a8' };
  if (code >= 0x18 && code <= 0x1c) return { name: `M1 H  pb=${code - 0x14}`, color: '#39a' };
  if (code >= 0x22 && code <= 0x26) return { name: `M1 V·t  pb=${code - 0x1e}`, color: '#6b9' };
  if (code >= 0x2c && code <= 0x30) return { name: `M1 H·t  pb=${code - 0x28}`, color: '#5ab' };
  if (code >= 0x40 && code <= 0x44) return { name: `M2 H  pb=${code - 0x3c}`, color: '#d83' };
  if (code >= 0x54 && code <= 0x58) return { name: `M2 H·t  pb=${code - 0x50}`, color: '#e96' };
  if (code >= 0x68 && code <= 0x6c) return { name: `M2 H·t  pb=${code - 0x64}`, color: '#e96' };
  if (code >= 0x7c && code <= 0x80) return { name: `M2 H  pb=${code - 0x78}`, color: '#d83' };
  return { name: `unknown 0x${code.toString(16)}`, color: '#c33' };
}

function stripBar(methods: readonly number[], roomWidth: number): HTMLElement {
  const bar = el('div', { class: 'strip-methods-bar' });
  bar.style.width = `${roomWidth * BG_SCALE}px`;
  for (let i = 0; i < methods.length; i++) {
    const code = methods[i]!;
    const family = classifySmapMethod(code);
    const cell = el('div', { class: 'strip-method-cell', text: String(code) });
    cell.style.width = `${8 * BG_SCALE}px`;
    cell.style.backgroundColor = family.color;
    cell.title = `strip ${i} · code ${code} (0x${code.toString(16)}) · ${family.name}`;
    append(bar, cell);
  }
  return bar;
}

// ── Objects ─────────────────────────────────────────────────────────────

export function objectsPanel(
  objects: Section<ReadonlyMap<number, LoadedObject>>,
  selected: Signal<number | null>,
  roomPalette: Uint8Array | null,
  transparentIndex: number | null,
): HTMLElement | null {
  if (!objects.ok) return panel('Objects', sectionError(objects.error));
  const list = [...objects.value.values()];
  if (list.length === 0) return null;

  // `selected` is shared with the canvas overlay; default to the first object
  // so panel and overlay always agree on a current object.
  if (!list.some((o) => o.objId === selected.peek())) selected.set(list[0]!.objId);

  const indexOf = (): number => list.findIndex((o) => o.objId === selected.peek());
  const step = (delta: number): void => {
    const next = list[indexOf() + delta];
    if (next) selected.set(next.objId);
  };
  const prev = el('button', { class: 'secondary', type: 'button', text: '◄ prev' });
  prev.addEventListener('click', () => step(-1));
  const next = el('button', { class: 'secondary', type: 'button', text: 'next ►' });
  next.addEventListener('click', () => step(1));
  const label = el('span', { class: 'object-nav-label' });
  bindText(label, () => `Object ${indexOf() + 1} of ${list.length}`);

  const host = el('div', { class: 'object-view-host' });
  effect(() => {
    const obj = list.find((o) => o.objId === selected());
    clear(host);
    if (obj) append(host, renderObject(obj, roomPalette, transparentIndex));
  });

  return panel('Objects', el('div', { class: 'object-panel' }, el('div', { class: 'object-nav' }, prev, next, label), host), {
    count: list.length,
  });
}

function renderObject(obj: LoadedObject, roomPalette: Uint8Array | null, transparentIndex: number | null): HTMLElement {
  const left = el(
    'div',
    { class: 'object-detail-left' },
    el(
      'div',
      { class: 'object-title' },
      el('span', { class: 'object-id', text: `#${obj.objId}` }),
      el('span', { class: 'object-name', text: obj.name || '(unnamed)' }),
    ),
    el('div', {
      class: 'object-meta',
      text:
        `hit box ${obj.cdhd.x * 8},${obj.cdhd.y * 8} ${obj.cdhd.width * 8}×${obj.cdhd.height * 8} · ` +
        `walk-to (${obj.cdhd.walkX},${obj.cdhd.walkY}) dir ${obj.cdhd.actorDir}` +
        (obj.cdhd.parent ? ` · parent #${obj.cdhd.parent}` : ''),
    }),
  );

  // Object image pixels are room CLUT indices directly (no costume palette).
  const images = [...obj.images.values()];
  if (images.length > 0) {
    const strip = el('div', { class: 'object-images' });
    for (const image of images) {
      const w = obj.imhd.width;
      const h = w > 0 ? Math.floor(image.indexed.length / w) : 0;
      append(
        strip,
        el(
          'div',
          { class: 'object-image-cell' },
          objectImageCanvas(image.indexed, w, h, roomPalette, transparentIndex),
          el('span', { class: 'object-image-label', text: `state ${image.state}` }),
        ),
      );
    }
    append(left, strip);
  }

  const card = el('div', { class: 'object-card' }, left);
  const verbs = verbsPane(obj.verbs);
  if (verbs) append(card, verbs);
  return card;
}

function tabbedDisasm(items: readonly { label: string; bytecode: Uint8Array }[]): HTMLElement {
  const active = signal(0);
  const tabs = el('div', { class: 'disasm-tabs' });
  items.forEach((item, i) => {
    const tab = el('button', { class: 'disasm-tab', type: 'button', text: item.label });
    tab.addEventListener('click', () => active.set(i));
    bindClass(tab, 'active', () => active() === i);
    append(tabs, tab);
  });

  const code = el('pre', { class: 'disasm disasm-pane' });
  effect(() => {
    clear(code);
    renderDisasm(code, items[active()]!.bytecode);
  });

  return el('div', { class: 'tabbed-disasm' }, tabs, code);
}

// Verb entry id 255 is the object's default verb.
function verbsPane(verbs: ReadonlyMap<number, Uint8Array>): HTMLElement | null {
  if (verbs.size === 0) return null;
  const items = [...verbs].map(([id, bytecode]) => ({ label: id === 255 ? 'default' : `verb ${id}`, bytecode }));
  return tabbedDisasm(items);
}

const OBJECT_IMAGE_SCALE = 2;

function objectImageCanvas(
  indexed: Uint8Array,
  width: number,
  height: number,
  roomPalette: Uint8Array | null,
  transparentIndex: number | null,
): HTMLCanvasElement {
  const canvas = el('canvas', { class: 'frame-preview-canvas' });
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  canvas.style.width = `${canvas.width * OBJECT_IMAGE_SCALE}px`;
  canvas.style.height = `${canvas.height * OBJECT_IMAGE_SCALE}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let p = 0; p < indexed.length; p++) {
    const idx = indexed[p]!;
    const o = p * 4;
    if (idx === transparentIndex) {
      img.data[o + 3] = 0;
      continue;
    }
    if (roomPalette) {
      img.data[o] = roomPalette[idx * 3] ?? 0;
      img.data[o + 1] = roomPalette[idx * 3 + 1] ?? 0;
      img.data[o + 2] = roomPalette[idx * 3 + 2] ?? 0;
    } else {
      img.data[o] = img.data[o + 1] = img.data[o + 2] = idx;
    }
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ── Scripts ─────────────────────────────────────────────────────────────

export function scriptsPanel(
  scripts: Section<readonly RoomScript[]>,
  globals: Section<readonly ReferencedScript[]>,
): HTMLElement | null {
  if (!scripts.ok) return panel('Scripts', sectionError(scripts.error));
  const roomScripts = scripts.value;
  const globalList = globals.ok ? globals.value : [];
  if (roomScripts.length === 0 && globalList.length === 0) return null;

  type Item = { label: string; bytecode: Uint8Array };
  const pick = (kind: RoomScript['kind']): Item[] =>
    roomScripts.filter((s) => s.kind === kind).map((s) => ({ label: s.label, bytecode: s.bytecode }));
  const numbered: (Item & { id: number })[] = [
    ...roomScripts.filter((s) => s.kind === 'local').map((s) => ({ id: s.id!, label: s.label, bytecode: s.bytecode })),
    ...globalList.map((g) => ({ id: g.id, label: `global #${g.id}`, bytecode: g.bytecode })),
  ].sort((a, b) => a.id - b.id);
  const ordered: Item[] = [...pick('entry'), ...pick('exit'), ...numbered];
  return panel('Scripts', tabbedDisasm(ordered), { count: ordered.length });
}

function renderDisasm(host: HTMLElement, bytecode: Uint8Array): void {
  const lines = disassemble(bytecode);
  for (const line of lines) {
    append(
      host,
      el(
        'div',
        { class: 'disasm-line' },
        el('span', { class: 'disasm-off', text: line.offset.toString().padStart(5) }),
        el('span', { class: line.aligned ? 'disasm-text' : 'disasm-text misaligned', text: ` ${line.text}` }),
      ),
    );
  }
  if (lines.length > 0 && !lines[lines.length - 1]!.aligned) {
    append(host, el('div', { class: 'disasm-note', text: '(misaligned — sweep stopped)' }));
  }
}

// ── Room rail (navigation) ────────────────────────────────────────────────

export function roomRail(rooms: readonly RoomRef[], currentRoomId: Signal<number>): HTMLElement {
  const list = el('div', { class: 'room-rail-list' });
  for (const room of rooms) {
    const item = el('button', { class: 'room-rail-item', type: 'button', text: String(room.roomId) });
    item.title = `Room ${room.roomId} · LFLF #${room.lflfIndex}`;
    item.addEventListener('click', () => currentRoomId.set(room.roomId));
    bindClass(item, 'selected', () => currentRoomId() === room.roomId);
    append(list, item);
  }

  const indexOfCurrent = (): number => rooms.findIndex((r) => r.roomId === currentRoomId.peek());
  const step = (delta: number): void => {
    const i = indexOfCurrent();
    const next = rooms[i + delta];
    if (next) currentRoomId.set(next.roomId);
  };
  const prev = el('button', { class: 'secondary', type: 'button', text: '◄ prev' });
  prev.addEventListener('click', () => step(-1));
  const next = el('button', { class: 'secondary', type: 'button', text: 'next ►' });
  next.addEventListener('click', () => step(1));

  return el(
    'aside',
    { class: 'room-rail' },
    el('h2', { class: 'room-rail-title', text: 'Rooms' }),
    el('div', { class: 'room-rail-nav' }, prev, next),
    list,
  );
}
