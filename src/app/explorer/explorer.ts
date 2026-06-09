/**
 * Session-free resource Explorer: parses the opened files directly (no VM, no
 * EngineSession), so it works even when the game can't boot.
 */
import type { StoredGame } from '../../platform/storage/games';
import type { GameId } from '../../platform/detect';
import { parseResourceFile } from '../../engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../../engine/resources/xor';
import { parseLoff } from '../../engine/resources/loff';
import { parseIndexFile } from '../../engine/resources/index-file';
import { listRooms, extractRoom, referencedGlobalScripts } from '../../engine/room/extract';
import { currentRoomParam, searchWithRoom } from '../../platform/routing/routing';
import { walkCostumes } from '../../engine/graphics/costume';
import { walkCharsets } from '../../engine/graphics/charset';
import { signal, effect, el, clear, createRoot } from '../reactive';
import { backgroundPanel, objectsPanel, scriptsPanel, roomRail } from './panels';
import { costumesPanel } from './costume-panel';
import { charsetsPanel } from './charset-panel';

export function renderExplorer(game: StoredGame): HTMLElement {
  const container = el('div', { class: 'player' });
  container.innerHTML = `
    <header>
      <h1></h1>
      <p class="subtitle"></p>
    </header>
    <main><div class="loading">Loading game files…</div></main>
  `;
  container.querySelector('h1')!.textContent = game.displayName;
  container.querySelector('.subtitle')!.textContent = `${game.gameId} · ${game.directoryHandle.name}`;

  void loadAndRender(game, container.querySelector('main')!);
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

    const [indexBytes, resourceBytes] = await Promise.all([readBytes(indexFile), readBytes(resourcesFile)]);
    // The index's DSCR directory resolves the global scripts a room references.
    const index = parseIndexFile(parseResourceFile(indexBytes, SCUMM_V5_XOR_KEY));
    const resourceBundle = parseResourceFile(resourceBytes, SCUMM_V5_XOR_KEY);

    const loff = parseLoff(resourceBundle);
    const rooms = listRooms(resourceBundle, loff);
    if (rooms.length === 0) {
      target.replaceChildren(el('p', { class: 'empty', text: 'No rooms found in this resource file.' }));
      return;
    }

    // Costumes + charsets ship in the room's LFLF; bucket once up front.
    const costumesByLflf = byLflf(walkCostumes(resourceBundle));
    const charsetsByLflf = byLflf(walkCharsets(resourceBundle));

    const requested = currentRoomParam();
    const startRoom = requested != null && rooms.some((r) => r.roomId === requested) ? requested : rooms[0]!.roomId;

    createRoot(() => {
      const currentRoomId = signal(startRoom);
      const dossier = el('div', { class: 'dossier' });

      effect(() => {
        const id = currentRoomId();
        history.replaceState(null, '', searchWithRoom(location.search, id));
        const ref = rooms.find((r) => r.roomId === id)!;
        const d = extractRoom(resourceBundle, ref);
        const roomPalette = d.background.ok ? d.background.value.palette : null;
        const transparentIndex = d.background.ok ? d.background.value.transparentIndex : null;
        // Shared by the Objects picker and the canvas highlight; created
        // inside the effect so selection resets on room change.
        const selected = signal<number | null>(null);
        const objectList = d.objects.ok ? [...d.objects.value.values()] : [];
        const walkBoxes = d.walkBoxes.ok ? d.walkBoxes.value : [];
        const zPlanes = d.zPlanes.ok ? d.zPlanes.value : [];
        const panels = [
          backgroundPanel(d.background, objectList, walkBoxes, zPlanes, selected),
          objectsPanel(d.objects, selected, roomPalette, transparentIndex),
          costumesPanel(costumesByLflf.get(ref.lflfIndex) ?? [], resourceBundle, roomPalette),
          charsetsPanel(charsetsByLflf.get(ref.lflfIndex) ?? [], resourceBundle, roomPalette),
          scriptsPanel(d.scripts, referencedGlobalScripts(d, resourceBundle, index, loff)),
        ].filter((p): p is HTMLElement => p !== null);
        clear(dossier);
        dossier.append(el('div', { class: 'dossier-head', text: `Room ${d.roomId} · LFLF #${d.lflfIndex}` }), ...panels);
      });

      target.replaceChildren(el('div', { class: 'explorer-shell' }, roomRail(rooms, currentRoomId), dossier));
    });
  } catch (err) {
    target.replaceChildren(el('div', { class: 'error', text: (err as Error).message }));
  }
}

function byLflf<T extends { lflfIndex: number }>(items: readonly T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const list = map.get(item.lflfIndex);
    if (list) list.push(item);
    else map.set(item.lflfIndex, [item]);
  }
  return map;
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
    if (entry.kind === 'file' && entryName.toUpperCase() === target) return entry.getFile();
  }
  return null;
}

async function readBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
