import type { App } from '../app';
import type { StoredGame } from '../storage/games';
import type { GameId } from '../install/detect';
import { parseResourceFile } from '../../engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import type { Block } from '../../engine/resources/block';
import { describeBlock } from '../../engine/resources/catalog';

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

    const indexBlocks = parseResourceFile(indexBytes, SCUMM_V5_XOR_KEY);
    const resourceBlocks = parseResourceFile(resourceBytes, SCUMM_V5_XOR_KEY);

    target.replaceChildren(
      renderSection(`Index (${indexName})`, indexBytes.length, indexBlocks),
      renderSection(`Resources (${resourcesName})`, resourceBytes.length, resourceBlocks),
    );
  } catch (err) {
    target.replaceChildren(renderError(err as Error));
  }
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

function renderSection(title: string, fileSize: number, blocks: Block[]): HTMLElement {
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
