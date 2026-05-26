import type { App } from '../app';
import type { StoredGame } from '../storage/games';
import type { GameId } from '../install/detect';
import { parseResourceFile } from '../../engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import type { Block } from '../../engine/resources/block';
import type { ResourceFile } from '../../engine/resources/tree';
import { describeBlock } from '../../engine/resources/catalog';
import { walkRooms, decodeRoom, type RoomEntry } from '../../engine/graphics/room';
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

    const roomSection = document.createElement('section');
    roomSection.className = 'room-viewer';
    if (rooms.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No rooms found in this resource file.';
      roomSection.appendChild(empty);
    } else {
      let currentRoomIdx = 0;
      const showRoom = (): void => {
        roomSection.replaceChildren(
          renderRoomView(rooms, currentRoomIdx, resourceFileBundle, {
            onPrev: () => {
              currentRoomIdx = Math.max(0, currentRoomIdx - 1);
              showRoom();
            },
            onNext: () => {
              currentRoomIdx = Math.min(rooms.length - 1, currentRoomIdx + 1);
              showRoom();
            },
          }),
        );
      };
      showRoom();
    }

    target.replaceChildren(
      roomSection,
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
    const canvas = document.createElement('canvas');
    canvas.className = 'room-canvas';
    canvas.style.width = `${decoded.width * ROOM_DISPLAY_SCALE}px`;
    canvas.style.height = `${decoded.height * ROOM_DISPLAY_SCALE}px`;
    const renderer = new Canvas2DRenderer(canvas, decoded.width, decoded.height);
    renderer.setPalette(decoded.palette);
    renderer.setTransparentIndex(decoded.transparentIndex);
    renderer.present(decoded.indexed);
    canvasArea.appendChild(canvas);

    canvasArea.appendChild(renderStripMethodsBar(decoded.stripMethods, decoded.width));
    canvasArea.appendChild(renderMethodHistogram(decoded.stripMethods));

    const info = document.createElement('p');
    info.className = 'room-info';
    info.textContent = `${decoded.width}×${decoded.height} · ${decoded.numObjects} object${decoded.numObjects === 1 ? '' : 's'}`;
    canvasArea.appendChild(info);
  } catch (err) {
    const errBox = document.createElement('div');
    errBox.className = 'error';
    errBox.textContent = (err as Error).message;
    canvasArea.appendChild(errBox);
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
