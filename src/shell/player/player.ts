import type { App } from '../app';
import type { StoredGame } from '../storage/games';
import type { GameId } from '../install/detect';
import { parseResourceFile } from '../../engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import type { Block } from '../../engine/resources/block';
import type { ResourceFile } from '../../engine/resources/tree';
import { describeBlock } from '../../engine/resources/catalog';
import { walkRooms, decodeRoom, type RoomEntry } from '../../engine/graphics/room';
import { decodeZPlanes, type DecodedZPlane } from '../../engine/graphics/zplane';
import {
  walkCostumes,
  parseCostumeHeader,
  decodeLimbTables,
  type CostumeEntry,
  type CostumeHeader,
  type LimbTable,
} from '../../engine/graphics/costume';
import { payloadOf } from '../../engine/resources/tree';
import {
  decodeCostumeFrame,
  COSTUME_FRAME_TRANSPARENT,
  type DecodedCostumeFrame,
} from '../../engine/graphics/costume-frame';
import { compositeActor } from '../../engine/graphics/composite';
import { Canvas2DRenderer } from '../../engine/render/canvas2d';

const ROOM_DISPLAY_SCALE = 2;

export function renderPlayer(app: App, game: StoredGame): HTMLElement {
  const container = document.createElement('div');
  container.className = 'player';
  container.innerHTML = `
    <header>
      <button class="back secondary">← Library</button>
      <h1></h1>
      <p class="subtitle"></p>
    </header>
    <main>
      <div class="loading">Loading game files…</div>
    </main>
  `;

  container.querySelector('h1')!.textContent = game.displayName;
  container.querySelector('.subtitle')!.textContent = `${game.gameId} · ${game.directoryHandle.name}`;
  container.querySelector('.back')!.addEventListener('click', () => {
    app.navigate({ kind: 'library' });
  });

  const main = container.querySelector('main')!;
  void loadAndRender(game, main);

  return container;
}

async function loadAndRender(game: StoredGame, target: HTMLElement): Promise<void> {
  try {
    const indexName = indexFilenameFor(game.gameId);
    const resourcesName = resourcesFilenameFor(game.gameId);

    const [indexFile, resourcesFile] = await Promise.all([
      findFile(game.directoryHandle, indexName),
      findFile(game.directoryHandle, resourcesName),
    ]);

    if (!indexFile) throw new Error(`Could not find ${indexName} in "${game.directoryHandle.name}".`);
    if (!resourcesFile) throw new Error(`Could not find ${resourcesName} in "${game.directoryHandle.name}".`);

    const [indexBytes, resourceBytes] = await Promise.all([
      readBytes(indexFile),
      readBytes(resourcesFile),
    ]);

    const indexFileBundle = parseResourceFile(indexBytes, SCUMM_V5_XOR_KEY);
    const resourceFileBundle = parseResourceFile(resourceBytes, SCUMM_V5_XOR_KEY);
    const rooms = walkRooms(resourceFileBundle);
    const costumes = walkCostumes(resourceFileBundle);

    // Resources live inside LFLFs, and the player browses them
    // hierarchically: pick a room (= pick an LFLF), see the costumes
    // (and later: scripts, sounds, charsets) that ship in the same
    // LFLF. Pre-bucket the flat costume list so the lookup is O(1) per
    // room change.
    const costumesByLflf = new Map<number, CostumeEntry[]>();
    for (const c of costumes) {
      let list = costumesByLflf.get(c.lflfIndex);
      if (!list) {
        list = [];
        costumesByLflf.set(c.lflfIndex, list);
      }
      list.push(c);
    }

    // Track the currently-selected room's CLUT so the costume frame
    // preview can map costume indices through real game colors. The ref
    // is shared with the costume viewer; updating .value here makes
    // subsequent frame-chip clicks pick up the new palette.
    const currentRoomPalette: PaletteRef = { value: null };
    const setRoomPalette = (roomIdx: number): void => {
      const room = rooms[roomIdx];
      if (!room) return;
      try {
        currentRoomPalette.value = decodeRoom(resourceFileBundle, room.roomBlock).palette;
      } catch {
        currentRoomPalette.value = null;
      }
    };

    const roomSection = document.createElement('section');
    roomSection.className = 'room-viewer';
    const costumeSection = document.createElement('section');
    costumeSection.className = 'costume-viewer';

    // Shared "actor on the current room" state. The costume viewer
    // writes to this; the room viewer reads from it and composites
    // when present. `refresh` and the room dims are filled in by the
    // room viewer once it knows the current room's geometry.
    const actorRef: ActorRef = {
      value: null,
      roomWidth: 320,
      roomHeight: 200,
      refresh: () => {},
    };

    // Drag state lives at loadAndRender level so it survives the full
    // room-section re-renders we do on every pointermove tick.
    const dragState = { active: false };

    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No rooms found in this resource file.';
      roomSection.appendChild(empty);
    } else {
      let currentRoomIdx = 0;
      let currentCostumeIdx = 0;
      setRoomPalette(currentRoomIdx);

      const currentLflfCostumes = (): readonly CostumeEntry[] =>
        costumesByLflf.get(rooms[currentRoomIdx]!.lflfIndex) ?? [];

      const showCostumes = (): void => {
        const lflfIdx = rooms[currentRoomIdx]!.lflfIndex;
        const list = currentLflfCostumes();
        if (list.length === 0) {
          costumeSection.replaceChildren(renderCostumesEmpty(lflfIdx));
          return;
        }
        if (currentCostumeIdx >= list.length) currentCostumeIdx = 0;
        costumeSection.replaceChildren(
          renderCostumeView(list, currentCostumeIdx, resourceFileBundle, currentRoomPalette, actorRef, {
            onPrev: () => {
              currentCostumeIdx = Math.max(0, currentCostumeIdx - 1);
              showCostumes();
            },
            onNext: () => {
              currentCostumeIdx = Math.min(list.length - 1, currentCostumeIdx + 1);
              showCostumes();
            },
          }),
        );
      };

      const showRoom = (): void => {
        roomSection.replaceChildren(
          renderRoomView(rooms, currentRoomIdx, resourceFileBundle, actorRef, dragState, {
            onPrev: () => {
              currentRoomIdx = Math.max(0, currentRoomIdx - 1);
              setRoomPalette(currentRoomIdx);
              currentCostumeIdx = 0;
              actorRef.value = null; // costume's palette won't match a new room
              showRoom();
              showCostumes();
            },
            onNext: () => {
              currentRoomIdx = Math.min(rooms.length - 1, currentRoomIdx + 1);
              setRoomPalette(currentRoomIdx);
              currentCostumeIdx = 0;
              actorRef.value = null;
              showRoom();
              showCostumes();
            },
          }),
        );
      };

      actorRef.refresh = showRoom;
      showRoom();
      showCostumes();
    }

    target.replaceChildren(
      roomSection,
      costumeSection,
      renderSection(`Index (${indexName})`, indexBytes.length, indexFileBundle.tree),
      renderSection(`Resources (${resourcesName})`, resourceBytes.length, resourceFileBundle.tree),
    );
  } catch (err) {
    target.replaceChildren(renderError(err as Error));
  }
}

interface RoomNavCallbacks {
  onPrev(): void;
  onNext(): void;
}

function renderRoomView(
  rooms: readonly RoomEntry[],
  idx: number,
  file: ResourceFile,
  actorRef: ActorRef,
  dragState: { active: boolean },
  nav: RoomNavCallbacks,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'room-view';

  const header = document.createElement('div');
  header.className = 'room-header';

  const prev = document.createElement('button');
  prev.className = 'secondary';
  prev.textContent = '← prev';
  prev.disabled = idx === 0;
  prev.addEventListener('click', nav.onPrev);
  header.appendChild(prev);

  const label = document.createElement('span');
  label.className = 'room-label';
  const entry = rooms[idx]!;
  label.textContent = `Room ${idx + 1} of ${rooms.length} · LFLF #${entry.lflfIndex}`;
  header.appendChild(label);

  const next = document.createElement('button');
  next.className = 'secondary';
  next.textContent = 'next →';
  next.disabled = idx === rooms.length - 1;
  next.addEventListener('click', nav.onNext);
  header.appendChild(next);

  wrap.appendChild(header);

  const canvasArea = document.createElement('div');
  canvasArea.className = 'room-canvas-area';
  wrap.appendChild(canvasArea);

  try {
    const decoded = decodeRoom(file, entry.roomBlock);
    actorRef.roomWidth = decoded.width;
    actorRef.roomHeight = decoded.height;
    const zplanes = decodeZPlanes(file, entry.roomBlock, decoded.width, decoded.height);

    const stack = document.createElement('div');
    stack.className = 'room-canvas-stack';
    stack.style.width = `${decoded.width * ROOM_DISPLAY_SCALE}px`;
    stack.style.height = `${decoded.height * ROOM_DISPLAY_SCALE}px`;
    canvasArea.appendChild(stack);

    const canvas = document.createElement('canvas');
    canvas.className = 'room-canvas';
    canvas.style.width = `${decoded.width * ROOM_DISPLAY_SCALE}px`;
    canvas.style.height = `${decoded.height * ROOM_DISPLAY_SCALE}px`;
    const renderer = new Canvas2DRenderer(canvas, decoded.width, decoded.height);
    renderer.setPalette(decoded.palette);
    renderer.setTransparentIndex(decoded.transparentIndex);

    // Composite-and-present once, reusable by the drag handlers below.
    // Mutates the original `decoded.indexed` into a per-call copy so we
    // never corrupt the source bitmap between calls.
    const presentWithActor = (): void => {
      const a = actorRef.value;
      if (!a) {
        renderer.present(decoded.indexed);
        return;
      }
      const fb = new Uint8Array(decoded.indexed);
      compositeActor({
        framebuffer: fb,
        fbWidth: decoded.width,
        fbHeight: decoded.height,
        frame: a.frame,
        costPalette: a.costPalette,
        actorX: a.x,
        actorY: a.y,
        actorZ: a.z,
        zPlanes: zplanes.planes,
      });
      renderer.present(fb);
    };
    presentWithActor();
    const actor = actorRef.value;
    stack.appendChild(canvas);

    // Z-plane overlay canvas stacks on top of the room.
    const overlay = document.createElement('canvas');
    overlay.className = 'zplane-overlay';
    overlay.width = decoded.width;
    overlay.height = decoded.height;
    overlay.style.width = `${decoded.width * ROOM_DISPLAY_SCALE}px`;
    overlay.style.height = `${decoded.height * ROOM_DISPLAY_SCALE}px`;
    stack.appendChild(overlay);

    canvasArea.appendChild(renderStripMethodsBar(decoded.stripMethods, decoded.width));
    canvasArea.appendChild(renderMethodHistogram(decoded.stripMethods));

    const info = document.createElement('p');
    info.className = 'room-info';
    info.textContent = `${decoded.width}×${decoded.height} · ${decoded.numObjects} object${decoded.numObjects === 1 ? '' : 's'}`;
    canvasArea.appendChild(info);

    // Z-planes (already decoded above for the compositor) get a per-plane
    // overlay toggle row underneath the canvas stack.
    canvasArea.appendChild(renderZPlaneToggles(zplanes, overlay));

    // If an actor is currently placed on this room, expose its position
    // controls so the user can adjust x/y/z without round-tripping
    // through the costume viewer.
    if (actor) {
      canvasArea.appendChild(renderActorControls(actor, decoded.width, decoded.height, actorRef));

      // Click + drag on the canvas to move the actor. During the drag
      // we use a "light refresh" — re-composite onto the same canvas
      // without rebuilding any DOM — so the canvas element stays alive
      // and pointer events keep flowing to the same captured target.
      // The full `actorRef.refresh()` (which rebuilds the section, in
      // turn refreshing the x/y/z input fields) fires once on
      // pointerup.
      const clientToRoom = (e: PointerEvent): { x: number; y: number } => {
        const rect = canvas.getBoundingClientRect();
        return {
          x: Math.round(((e.clientX - rect.left) / rect.width) * canvas.width),
          y: Math.round(((e.clientY - rect.top) / rect.height) * canvas.height),
        };
      };
      const moveTo = (e: PointerEvent): void => {
        const a = actorRef.value;
        if (!a) return;
        const p = clientToRoom(e);
        a.x = p.x;
        a.y = p.y;
        presentWithActor();
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (!actorRef.value) return;
        dragState.active = true;
        canvas.setPointerCapture(e.pointerId);
        moveTo(e);
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!dragState.active) return;
        moveTo(e);
      });
      const endDrag = (e: PointerEvent): void => {
        if (!dragState.active) return;
        dragState.active = false;
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        // Resync x/y input fields and any other section UI to the final
        // dragged position.
        actorRef.refresh();
      };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', endDrag);
      canvas.style.cursor = 'grab';
    }
  } catch (err) {
    const errBox = document.createElement('div');
    errBox.className = 'error';
    errBox.textContent = (err as Error).message;
    canvasArea.appendChild(errBox);
  }

  return wrap;
}

/**
 * Position + z-level controls for the actor currently composited on
 * the room. Number-input fields trigger a room re-render on every
 * change so positioning feels live.
 */
function renderActorControls(
  actor: ActorOnRoom,
  roomWidth: number,
  roomHeight: number,
  actorRef: ActorRef,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'actor-controls';

  const label = document.createElement('span');
  label.className = 'actor-controls-label';
  label.textContent = `Actor: ${actor.frame.width}×${actor.frame.height} —`;
  wrap.appendChild(label);

  const numField = (name: string, value: number, min: number, max: number): HTMLInputElement => {
    const wrap = document.createElement('label');
    wrap.className = 'actor-control-field';
    wrap.textContent = `${name} `;
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.min = String(min);
    input.max = String(max);
    wrap.appendChild(input);
    return Object.assign(input, { _wrap: wrap });
  };

  const xInput = numField('x', actor.x, -actor.frame.width, roomWidth + actor.frame.width);
  const yInput = numField('y', actor.y, -actor.frame.height, roomHeight + actor.frame.height);
  const zInput = numField('z', actor.z, 0, 7);

  for (const i of [xInput, yInput, zInput]) {
    wrap.appendChild((i as unknown as { _wrap: HTMLElement })._wrap);
  }

  const onChange = (): void => {
    if (!actorRef.value) return;
    actorRef.value.x = parseInt(xInput.value, 10) || 0;
    actorRef.value.y = parseInt(yInput.value, 10) || 0;
    actorRef.value.z = Math.max(0, parseInt(zInput.value, 10) || 0);
    actorRef.refresh();
  };
  xInput.addEventListener('input', onChange);
  yInput.addEventListener('input', onChange);
  zInput.addEventListener('input', onChange);

  const clear = document.createElement('button');
  clear.className = 'secondary';
  clear.textContent = 'remove';
  clear.addEventListener('click', () => {
    actorRef.value = null;
    actorRef.refresh();
  });
  wrap.appendChild(clear);

  return wrap;
}

/** Distinct tints for up to 8 z-planes. */
const ZPLANE_OVERLAY_TINTS: readonly [number, number, number][] = [
  [255, 80, 80],
  [80, 255, 80],
  [80, 160, 255],
  [255, 220, 80],
  [220, 80, 255],
  [80, 255, 220],
  [255, 160, 80],
  [200, 200, 200],
];

function renderZPlaneToggles(
  zplanes: { declaredCount: number; planes: readonly DecodedZPlane[] },
  overlay: HTMLCanvasElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'zplane-toggles';

  const label = document.createElement('span');
  label.className = 'zplane-toggles-label';
  if (zplanes.planes.length === 0) {
    label.textContent = `Z-planes: 0 (RMIH declares ${zplanes.declaredCount})`;
    wrap.appendChild(label);
    return wrap;
  }
  label.textContent =
    `Z-planes: ${zplanes.planes.length}` +
    (zplanes.declaredCount !== zplanes.planes.length
      ? ` (RMIH declares ${zplanes.declaredCount})`
      : '') +
    ' — ';
  wrap.appendChild(label);

  const enabled = new Set<number>();

  const repaint = (): void => {
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (enabled.size === 0) return;
    const img = ctx.createImageData(overlay.width, overlay.height);
    for (const i of enabled) {
      const plane = zplanes.planes[i]!;
      const tint = ZPLANE_OVERLAY_TINTS[i % ZPLANE_OVERLAY_TINTS.length]!;
      for (let p = 0; p < plane.mask.length; p++) {
        if (!plane.mask[p]) continue;
        const o = p * 4;
        // Mix tints if multiple planes are stacked — naive max.
        img.data[o] = Math.max(img.data[o]!, tint[0]);
        img.data[o + 1] = Math.max(img.data[o + 1]!, tint[1]);
        img.data[o + 2] = Math.max(img.data[o + 2]!, tint[2]);
        img.data[o + 3] = 160; // semi-transparent
      }
    }
    ctx.putImageData(img, 0, 0);
  };

  for (let i = 0; i < zplanes.planes.length; i++) {
    const btn = document.createElement('button');
    btn.className = 'zplane-toggle';
    btn.textContent = `ZP0${i + 1}`;
    const tint = ZPLANE_OVERLAY_TINTS[i % ZPLANE_OVERLAY_TINTS.length]!;
    btn.style.borderLeftColor = `rgb(${tint[0]},${tint[1]},${tint[2]})`;
    btn.addEventListener('click', () => {
      if (enabled.has(i)) {
        enabled.delete(i);
        btn.classList.remove('active');
      } else {
        enabled.add(i);
        btn.classList.add('active');
      }
      repaint();
    });
    wrap.appendChild(btn);
  }

  return wrap;
}

interface SmapMethodFamily {
  readonly name: string;
  readonly color: string;
}

function classifySmapMethod(code: number): SmapMethodFamily {
  if (code === 0x01) return { name: 'uncompressed', color: '#666' };
  if (code >= 0x0E && code <= 0x12) return { name: `M1 V  pb=${code - 0x0A}`, color: '#4a8' };
  if (code >= 0x18 && code <= 0x1C) return { name: `M1 H  pb=${code - 0x14}`, color: '#39a' };
  if (code >= 0x22 && code <= 0x26) return { name: `M1 V·t  pb=${code - 0x1E}`, color: '#6b9' };
  if (code >= 0x2C && code <= 0x30) return { name: `M1 H·t  pb=${code - 0x28}`, color: '#5ab' };
  if (code >= 0x40 && code <= 0x44) return { name: `M2 H  pb=${code - 0x3C}`, color: '#d83' };
  if (code >= 0x54 && code <= 0x58) return { name: `M2 H·t  pb=${code - 0x50}`, color: '#e96' };
  if (code >= 0x68 && code <= 0x6C) return { name: `M2 H·t  pb=${code - 0x64}`, color: '#e96' };
  if (code >= 0x7C && code <= 0x80) return { name: `M2 H  pb=${code - 0x78}`, color: '#d83' };
  return { name: `unknown 0x${code.toString(16)}`, color: '#c33' };
}

function renderStripMethodsBar(methods: readonly number[], roomWidth: number): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'strip-methods-bar';
  bar.style.width = `${roomWidth * ROOM_DISPLAY_SCALE}px`;

  for (let i = 0; i < methods.length; i++) {
    const code = methods[i]!;
    const family = classifySmapMethod(code);
    const cell = document.createElement('div');
    cell.className = 'strip-method-cell';
    cell.style.width = `${8 * ROOM_DISPLAY_SCALE}px`;
    cell.style.backgroundColor = family.color;
    cell.title = `strip ${i} · code ${code} (0x${code.toString(16)}) · ${family.name}`;
    cell.textContent = code.toString();
    bar.appendChild(cell);
  }
  return bar;
}

interface CostumeNavCallbacks {
  onPrev(): void;
  onNext(): void;
}

interface PaletteRef {
  value: Uint8Array | null;
}

interface ActorOnRoom {
  readonly frame: DecodedCostumeFrame;
  readonly costPalette: Uint8Array;
  x: number;
  y: number;
  z: number;
}

interface ActorRef {
  value: ActorOnRoom | null;
  /**
   * Dimensions of the currently-selected room, kept in sync by the
   * room viewer so the "Place on room" button can pick a sensible
   * default position that works for both 200-tall and 144-tall rooms.
   */
  roomWidth: number;
  roomHeight: number;
  refresh(): void;
}

function renderCostumesEmpty(lflfIdx: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'costume-view';

  const heading = document.createElement('h2');
  heading.className = 'costume-heading';
  heading.textContent = 'Costumes';
  wrap.appendChild(heading);

  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = `No costumes in LFLF #${lflfIdx}.`;
  wrap.appendChild(empty);
  return wrap;
}

function renderCostumeView(
  costumes: readonly CostumeEntry[],
  idx: number,
  file: ResourceFile,
  roomPalette: PaletteRef,
  actorRef: ActorRef,
  nav: CostumeNavCallbacks,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'costume-view';

  const heading = document.createElement('h2');
  heading.className = 'costume-heading';
  heading.textContent = 'Costumes';
  wrap.appendChild(heading);

  const header = document.createElement('div');
  header.className = 'costume-header';

  const prev = document.createElement('button');
  prev.className = 'secondary';
  prev.textContent = '← prev';
  prev.disabled = idx === 0;
  prev.addEventListener('click', nav.onPrev);
  header.appendChild(prev);

  const label = document.createElement('span');
  label.className = 'costume-label';
  const entry = costumes[idx]!;
  label.textContent =
    `Costume ${idx + 1} of ${costumes.length} in LFLF #${entry.lflfIndex}`;
  header.appendChild(label);

  const next = document.createElement('button');
  next.className = 'secondary';
  next.textContent = 'next →';
  next.disabled = idx === costumes.length - 1;
  next.addEventListener('click', nav.onNext);
  header.appendChild(next);

  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'costume-body';
  wrap.appendChild(body);

  try {
    const payload = payloadOf(file, entry.costBlock);
    const cost = parseCostumeHeader(payload);

    body.appendChild(renderCostumeSummary(cost, payload.length));
    body.appendChild(renderCostumePalette(cost));
    body.appendChild(renderCostumeOffsets('Limb offsets', cost.limbOffsets, payload.length));
    body.appendChild(renderCostumeOffsets('Anim offsets', cost.animOffsets, payload.length));
    const limbTables = decodeLimbTables(payload, cost);
    body.appendChild(renderLimbTables(payload, limbTables, cost.palette, roomPalette, actorRef));
    body.appendChild(renderCostumeHex(payload, cost));
  } catch (err) {
    const errBox = document.createElement('div');
    errBox.className = 'error';
    errBox.textContent = (err as Error).message;
    body.appendChild(errBox);
  }

  return wrap;
}

function renderCostumeSummary(cost: CostumeHeader, payloadLength: number): HTMLElement {
  const summary = document.createElement('p');
  summary.className = 'costume-summary';
  const mirror = cost.mirrorFlag ? 'flag set' : 'flag clear';
  summary.textContent =
    `${cost.numAnim} animation${cost.numAnim === 1 ? '' : 's'} · ` +
    `format=0x${cost.format.toString(16).padStart(2, '0')} ` +
    `(${cost.paletteSize}-color, mirror ${mirror}) · ` +
    `animCmdOffset=0x${cost.animCmdOffset.toString(16).padStart(4, '0')} · ` +
    `payload ${payloadLength} B`;
  return summary;
}

function renderCostumePalette(cost: CostumeHeader): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'costume-palette';
  const heading = document.createElement('span');
  heading.className = 'costume-section-label';
  heading.textContent = `Palette (${cost.paletteSize}):`;
  wrap.appendChild(heading);
  for (let i = 0; i < cost.palette.length; i++) {
    const cell = document.createElement('span');
    cell.className = 'costume-palette-cell';
    cell.textContent = String(cost.palette[i]);
    cell.title = `costume index ${i} → CLUT index ${cost.palette[i]}`;
    wrap.appendChild(cell);
  }
  return wrap;
}

function renderCostumeOffsets(
  title: string,
  offsets: readonly number[],
  payloadLength: number,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'costume-offsets';
  const heading = document.createElement('span');
  heading.className = 'costume-section-label';
  heading.textContent = `${title} (${offsets.length}):`;
  wrap.appendChild(heading);
  for (let i = 0; i < offsets.length; i++) {
    const cell = document.createElement('span');
    cell.className = 'costume-offset-cell';
    const off = offsets[i]!;
    const outOfRange = off >= payloadLength;
    if (outOfRange) cell.classList.add('out-of-range');
    cell.textContent = `${i}:0x${off.toString(16).padStart(4, '0')}`;
    cell.title = outOfRange
      ? `entry ${i} offset 0x${off.toString(16)} is outside payload (${payloadLength} B)`
      : `entry ${i} → byte 0x${off.toString(16)}`;
    wrap.appendChild(cell);
  }
  return wrap;
}

function renderLimbTables(
  payload: Uint8Array,
  tables: readonly LimbTable[],
  costPalette: Uint8Array,
  roomPalette: PaletteRef,
  actorRef: ActorRef,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'limb-tables';

  const heading = document.createElement('p');
  heading.className = 'costume-section-label';
  heading.textContent = `Limb frame tables (${tables.length} group${tables.length === 1 ? '' : 's'}):`;
  wrap.appendChild(heading);

  if (tables.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '(no limbs in use)';
    wrap.appendChild(empty);
    return wrap;
  }

  for (const t of tables) {
    wrap.appendChild(renderLimbTable(payload, t, costPalette, roomPalette, actorRef));
  }
  return wrap;
}

function renderLimbTable(
  payload: Uint8Array,
  t: LimbTable,
  costPalette: Uint8Array,
  roomPalette: PaletteRef,
  actorRef: ActorRef,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'limb-table';

  // Count valid entries up to the first suspicious one. Everything past
  // that point is trailing junk — the format leaves bytes between a
  // limb's real frames and the next limb's table that happen to land
  // here, plus the "shared sentinel" offset that unused limbs point at.
  let validCount = 0;
  while (validCount < t.entries.length && !t.suspicious[validCount]) {
    validCount++;
  }
  const trailingCount = t.entries.length - validCount;
  const looksUnused =
    validCount === 0 && t.usedByLimbs.length >= 4; // shared-sentinel heuristic

  const label = document.createElement('div');
  label.className = 'limb-table-label';
  const limbList = t.usedByLimbs.length === 1
    ? `limb ${t.usedByLimbs[0]}`
    : `limbs ${t.usedByLimbs.join(',')}`;
  if (looksUnused) {
    label.textContent =
      `${limbList} @ 0x${t.tableOffset.toString(16).padStart(4, '0')} · ` +
      `unused (shared sentinel — points into frame-picture region)`;
    label.classList.add('limb-table-unused');
    wrap.appendChild(label);
    return wrap;
  }
  const trailingNote = trailingCount > 0
    ? ` · +${trailingCount} trailing byte${trailingCount === 1 ? '' : 's'}`
    : '';
  label.textContent =
    `${limbList} @ 0x${t.tableOffset.toString(16).padStart(4, '0')} · ` +
    `${validCount} frame${validCount === 1 ? '' : 's'}${trailingNote}`;
  wrap.appendChild(label);

  const chips = document.createElement('div');
  chips.className = 'limb-table-chips';
  for (let i = 0; i < validCount; i++) {
    chips.appendChild(makeFrameChip(payload, wrap, i, t.entries[i]!, false, costPalette, roomPalette, actorRef));
  }
  wrap.appendChild(chips);

  if (trailingCount > 0) {
    const toggle = document.createElement('button');
    toggle.className = 'limb-table-trailing-toggle secondary';
    toggle.textContent = `show ${trailingCount} trailing byte-pair${trailingCount === 1 ? '' : 's'}`;
    const trailingChips = document.createElement('div');
    trailingChips.className = 'limb-table-chips limb-table-trailing';
    trailingChips.hidden = true;
    for (let i = validCount; i < t.entries.length; i++) {
      trailingChips.appendChild(
        makeFrameChip(payload, wrap, i, t.entries[i]!, true, costPalette, roomPalette, actorRef),
      );
    }
    toggle.addEventListener('click', () => {
      trailingChips.hidden = !trailingChips.hidden;
      toggle.textContent = trailingChips.hidden
        ? `show ${trailingCount} trailing byte-pair${trailingCount === 1 ? '' : 's'}`
        : `hide trailing byte-pairs`;
    });
    wrap.appendChild(toggle);
    wrap.appendChild(trailingChips);
  }

  return wrap;
}

function makeFrameChip(
  payload: Uint8Array,
  detailHost: HTMLElement,
  index: number,
  value: number,
  suspicious: boolean,
  costPalette: Uint8Array,
  roomPalette: PaletteRef,
  actorRef: ActorRef,
): HTMLElement {
  const chip = document.createElement('button');
  chip.className = 'limb-frame-chip';
  if (suspicious) chip.classList.add('suspicious');
  chip.textContent = `${index}:0x${value.toString(16).padStart(4, '0')}`;
  chip.title = suspicious
    ? `entry ${index} — value 0x${value.toString(16)} doesn't look like a payload pointer`
    : `frame ${index} → byte 0x${value.toString(16)}`;
  chip.addEventListener('click', () => {
    const existing = detailHost.querySelector('.limb-frame-detail');
    if (existing) existing.remove();
    detailHost.appendChild(renderFramePointerDetail(payload, value, index, costPalette, roomPalette, actorRef));
  });
  return chip;
}

/**
 * Show the bytes around a candidate frame pointer with several
 * plausible header interpretations. Lets us decide empirically which
 * layout the format uses without committing the decoder yet.
 */
function renderFramePointerDetail(
  payload: Uint8Array,
  framePtr: number,
  frameIdx: number,
  costPalette: Uint8Array,
  roomPalette: PaletteRef,
  actorRef: ActorRef,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'limb-frame-detail';

  const heading = document.createElement('p');
  heading.className = 'costume-section-label';
  heading.textContent = `Frame ${frameIdx} → byte 0x${framePtr.toString(16)}:`;
  wrap.appendChild(heading);

  // Pre-context: 8 bytes before, 16 bytes after.
  const from = Math.max(0, framePtr - 8);
  const to = Math.min(payload.length, framePtr + 24);

  const dump = document.createElement('pre');
  dump.className = 'limb-frame-hex';
  for (let row = from; row < to; row += 16) {
    const line = document.createElement('div');
    const addr = document.createElement('span');
    addr.className = 'costume-hex-addr';
    addr.textContent = `0x${row.toString(16).padStart(4, '0')}  `;
    line.appendChild(addr);
    for (let i = 0; i < 16 && row + i < to; i++) {
      const off = row + i;
      const byte = document.createElement('span');
      byte.className = 'costume-hex-byte';
      if (off === framePtr) {
        byte.style.color = '#ffd966';
        byte.style.fontWeight = '700';
      }
      byte.textContent = payload[off]!.toString(16).padStart(2, '0');
      line.appendChild(byte);
    }
    dump.appendChild(line);
  }
  wrap.appendChild(dump);

  // Candidate interpretations.
  const u16 = (off: number): number =>
    off + 1 < payload.length ? payload[off]! | (payload[off + 1]! << 8) : NaN;
  const i16 = (off: number): number => {
    const v = u16(off);
    return v >= 0x8000 ? v - 0x10000 : v;
  };

  const candidates: { label: string; fields: Record<string, number> }[] = [];
  // Layout A: pointer points to start of 12-byte header.
  candidates.push({
    label: 'A: pointer → start of header',
    fields: {
      width: u16(framePtr),
      height: u16(framePtr + 2),
      redirX: i16(framePtr + 4),
      redirY: i16(framePtr + 6),
      extra1: u16(framePtr + 8),
      extra2: u16(framePtr + 10),
    },
  });
  // Layout B: pointer → 4 bytes into header (skipping width/height).
  candidates.push({
    label: 'B: pointer skips 4 (header begins ptr−4)',
    fields: {
      width: u16(framePtr - 4),
      height: u16(framePtr - 2),
      redirX: i16(framePtr),
      redirY: i16(framePtr + 2),
      extra1: u16(framePtr + 4),
      extra2: u16(framePtr + 6),
    },
  });
  // Layout C: pointer → 6 bytes into header (width is at ptr−6).
  candidates.push({
    label: 'C: pointer skips 6 (header begins ptr−6)',
    fields: {
      width: u16(framePtr - 6),
      height: u16(framePtr - 4),
      redirX: i16(framePtr - 2),
      redirY: i16(framePtr),
      extra1: u16(framePtr + 2),
      extra2: u16(framePtr + 4),
    },
  });

  for (const c of candidates) {
    const row = document.createElement('p');
    row.className = 'frame-candidate';
    const parts = Object.entries(c.fields).map(([k, v]) => `${k}=${v}`);
    row.textContent = `${c.label}  →  ${parts.join('  ')}`;
    wrap.appendChild(row);
  }

  // Attempt to decode and render the frame with our chosen layout (C).
  try {
    const decoded = decodeCostumeFrame(payload, framePtr);
    const info = document.createElement('p');
    info.className = 'frame-candidate';
    info.textContent =
      `Decoded: ${decoded.width}×${decoded.height}  ` +
      `redirX=${decoded.redirX} redirY=${decoded.redirY}  ` +
      `${decoded.rleByteCount} RLE bytes`;
    wrap.appendChild(info);
    wrap.appendChild(renderFrameCanvas(decoded, costPalette, roomPalette.value));

    const place = document.createElement('button');
    place.className = 'frame-place primary';
    place.textContent = 'Place on current room ↑';
    place.addEventListener('click', () => {
      // Centered-ish anchor: middle horizontally, one pixel above the
      // bottom (a SCUMM actor's anchor is conventionally the feet).
      // Uses the *current* room dimensions so the default lands on-
      // screen for both 200-tall outdoor rooms and 144-tall interiors.
      actorRef.value = {
        frame: decoded,
        costPalette,
        x: Math.floor(actorRef.roomWidth / 2),
        y: actorRef.roomHeight - 1,
        z: 0,
      };
      actorRef.refresh();
    });
    wrap.appendChild(place);
  } catch (err) {
    const errRow = document.createElement('p');
    errRow.className = 'frame-candidate frame-error';
    errRow.textContent = `Decode error: ${(err as Error).message}`;
    wrap.appendChild(errRow);
  }

  return wrap;
}

const FRAME_PREVIEW_SCALE = 6;

/**
 * Render a decoded costume frame onto a small canvas. Each pixel is a
 * costume-local palette index; the lookup chain is
 *
 *   frame pixel → costPalette[index] = CLUT index → roomCLUT RGB triple
 *
 * If the room CLUT isn't available yet (no room decoded), fall back to
 * a neutral gray ramp so the structure stays legible without giving the
 * misleading impression of "real" game colors.
 */
function renderFrameCanvas(
  frame: { width: number; height: number; pixels: Uint8Array },
  costPalette: Uint8Array,
  roomPalette: Uint8Array | null,
): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'frame-preview-canvas';
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.style.width = `${frame.width * FRAME_PREVIEW_SCALE}px`;
  canvas.style.height = `${frame.height * FRAME_PREVIEW_SCALE}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(frame.width, frame.height);
  for (let p = 0; p < frame.pixels.length; p++) {
    const idx = frame.pixels[p]!;
    const o = p * 4;
    if (idx === COSTUME_FRAME_TRANSPARENT) {
      img.data[o + 3] = 0;
      continue;
    }
    let r: number, g: number, b: number;
    if (roomPalette && idx < costPalette.length) {
      const clutIdx = costPalette[idx]!;
      r = roomPalette[clutIdx * 3] ?? 0;
      g = roomPalette[clutIdx * 3 + 1] ?? 0;
      b = roomPalette[clutIdx * 3 + 2] ?? 0;
    } else {
      // Fallback: gray ramp.
      const gray = Math.round((idx / 31) * 255);
      r = g = b = gray;
    }
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface HexFieldSpan {
  readonly from: number; // inclusive byte offset in payload
  readonly to: number;   // exclusive
  readonly label: string;
  readonly color: string;
}

function buildCostumeFieldSpans(cost: CostumeHeader): HexFieldSpan[] {
  const spans: HexFieldSpan[] = [];
  spans.push({ from: 0, to: 1, label: 'numAnim-1', color: '#e08c4a' });
  spans.push({ from: 1, to: 2, label: 'format', color: '#5ec27a' });
  spans.push({ from: 2, to: 2 + cost.paletteSize, label: 'palette', color: '#5ab3c2' });
  const acOff = 2 + cost.paletteSize;
  spans.push({ from: acOff, to: acOff + 2, label: 'animCmdOffset', color: '#d6a93c' });
  const limbsOff = acOff + 2;
  spans.push({ from: limbsOff, to: limbsOff + 32, label: 'limbOffsets', color: '#b478e0' });
  const animsOff = limbsOff + 32;
  spans.push({
    from: animsOff,
    to: animsOff + 2 * cost.numAnim,
    label: 'animOffsets',
    color: '#e07ab0',
  });
  return spans;
}

function renderCostumeHex(payload: Uint8Array, cost: CostumeHeader): HTMLElement {
  const spans = buildCostumeFieldSpans(cost);
  const bytesPerRow = 16;
  // Show enough to cover the whole fixed header plus a tail of payload bytes,
  // capped so we don't blow up the page for huge costumes.
  const headerEnd = spans[spans.length - 1]!.to;
  const previewEnd = Math.min(payload.length, Math.max(headerEnd, 64));

  const wrap = document.createElement('div');
  wrap.className = 'costume-hex-wrap';

  const legend = document.createElement('div');
  legend.className = 'costume-hex-legend';
  for (const span of spans) {
    const chip = document.createElement('span');
    chip.className = 'costume-hex-legend-chip';
    chip.style.backgroundColor = span.color;
    chip.textContent = `${span.label} (${span.to - span.from} B @ 0x${span.from
      .toString(16)
      .padStart(2, '0')})`;
    legend.appendChild(chip);
  }
  wrap.appendChild(legend);

  const dump = document.createElement('pre');
  dump.className = 'costume-hex-dump';

  for (let rowStart = 0; rowStart < previewEnd; rowStart += bytesPerRow) {
    const row = document.createElement('div');
    row.className = 'costume-hex-row';

    const addr = document.createElement('span');
    addr.className = 'costume-hex-addr';
    addr.textContent = `0x${rowStart.toString(16).padStart(4, '0')}  `;
    row.appendChild(addr);

    for (let i = 0; i < bytesPerRow; i++) {
      const off = rowStart + i;
      const cell = document.createElement('span');
      cell.className = 'costume-hex-byte';
      if (off < previewEnd) {
        const span = spans.find((s) => off >= s.from && off < s.to);
        if (span) {
          cell.style.color = span.color;
          cell.title = `byte 0x${off.toString(16)} · ${span.label}`;
        }
        cell.textContent = payload[off]!.toString(16).padStart(2, '0');
      } else {
        cell.textContent = '  ';
      }
      row.appendChild(cell);
      // Extra space between groups of 8 for readability.
      if (i === 7) {
        const gap = document.createElement('span');
        gap.textContent = ' ';
        row.appendChild(gap);
      }
    }

    dump.appendChild(row);
  }

  wrap.appendChild(dump);

  if (previewEnd < payload.length) {
    const more = document.createElement('p');
    more.className = 'costume-hex-more';
    more.textContent = `… ${payload.length - previewEnd} more bytes`;
    wrap.appendChild(more);
  }

  return wrap;
}

function renderMethodHistogram(methods: readonly number[]): HTMLElement {
  const counts = new Map<number, number>();
  for (const m of methods) {
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }

  const wrap = document.createElement('div');
  wrap.className = 'strip-method-histogram';

  const sorted = Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  for (const [code, count] of sorted) {
    const family = classifySmapMethod(code);
    const entry = document.createElement('span');
    entry.className = 'histogram-entry';
    entry.style.borderLeftColor = family.color;
    entry.textContent = `${code} (0x${code.toString(16)}) · ${family.name} · ×${count}`;
    wrap.appendChild(entry);
  }

  return wrap;
}

function indexFilenameFor(gameId: GameId): string {
  return gameId === 'MI1' ? 'MONKEY.000' : 'MONKEY2.000';
}

function resourcesFilenameFor(gameId: GameId): string {
  return gameId === 'MI1' ? 'MONKEY.001' : 'MONKEY2.001';
}

async function findFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  const target = name.toUpperCase();
  for await (const [entryName, entry] of dir.entries()) {
    if (entry.kind === 'file' && entryName.toUpperCase() === target) {
      return entry.getFile();
    }
  }
  return null;
}

async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function renderSection(title: string, fileSize: number, blocks: readonly Block[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'block-tree';

  const h2 = document.createElement('h2');
  h2.textContent = title;
  section.appendChild(h2);

  const stats = document.createElement('p');
  stats.className = 'stats';
  stats.textContent =
    `${countBlocks(blocks)} blocks · ` +
    `${blocks.length} top-level · ` +
    `${formatBytes(fileSize)} on disk`;
  section.appendChild(stats);

  const tree = document.createElement('div');
  tree.className = 'tree';
  appendTree(tree, blocks);
  section.appendChild(tree);

  return section;
}

function renderError(err: Error): HTMLElement {
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = err.message;
  return div;
}

function appendTree(parent: HTMLElement, blocks: readonly Block[], depth = 0): void {
  for (const b of blocks) {
    parent.appendChild(renderTreeLine(b, depth));
    if (b.children) appendTree(parent, b.children, depth + 1);
  }
}

function renderTreeLine(b: Block, depth: number): HTMLElement {
  const line = document.createElement('div');
  line.className = 'tree-line';
  if (depth > 0) line.style.paddingLeft = `${depth * 1.25}em`;

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = b.tag;
  line.appendChild(tag);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const childCount = b.children
    ? ` (${b.children.length} child${b.children.length === 1 ? '' : 'ren'})`
    : '';
  const offset = `0x${b.offset.toString(16).padStart(8, '0')}`;
  meta.textContent = `  ${offset}  size=${b.size}${childCount}`;
  line.appendChild(meta);

  const info = describeBlock(b.tag);
  if (info) {
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = `  — ${info.shortName}: ${info.description}`;
    line.appendChild(desc);
  }

  return line;
}

function countBlocks(blocks: readonly Block[]): number {
  let count = blocks.length;
  for (const b of blocks) {
    if (b.children) count += countBlocks(b.children);
  }
  return count;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
