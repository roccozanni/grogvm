/**
 * Costumes dossier panel. Costumes ship inside the room's LFLF, so the shell
 * hands this panel the costumes bucketed for the current room. A prev/next
 * picker keeps one costume on screen at a time (rendering every frame of every
 * costume at once would be a wall of canvases); the selected costume's limb
 * frames are decoded with the same `decodeCostumeFrame` the compositor uses and
 * shown as thumbnails, mapped through the current room's CLUT.
 */
import { signal, effect, el, append, clear, bindText } from '../reactive';
import { payloadOf, type ResourceFile } from '../../engine/resources/tree';
import {
  parseCostumeHeader,
  decodeLimbTables,
  type CostumeEntry,
  type CostumeHeader,
} from '../../engine/graphics/costume';
import { decodeCostumeFrame, COSTUME_FRAME_TRANSPARENT, type DecodedCostumeFrame } from '../../engine/graphics/costume-frame';
import { panel } from './panels';

const FRAME_SCALE = 4;

export function costumesPanel(
  costumes: readonly CostumeEntry[],
  file: ResourceFile,
  roomPalette: Uint8Array | null,
): HTMLElement | null {
  if (costumes.length === 0) return null;

  const idx = signal(0);
  const view = el('div', { class: 'costume-view-host' });
  // Nested inside the shell's room effect → re-rendered on costume change and
  // disposed when the room (and thus this panel) is rebuilt.
  effect(() => {
    clear(view);
    append(view, renderCostume(costumes[idx()]!, file, roomPalette));
  });

  const prev = el('button', { class: 'secondary', type: 'button', text: '◄ prev' });
  prev.addEventListener('click', () => idx.set(Math.max(0, idx.peek() - 1)));
  const next = el('button', { class: 'secondary', type: 'button', text: 'next ►' });
  next.addEventListener('click', () => idx.set(Math.min(costumes.length - 1, idx.peek() + 1)));
  const label = el('span', { class: 'object-nav-label' });
  bindText(label, () => `Costume ${idx() + 1} of ${costumes.length}`);
  const nav = el('div', { class: 'costume-nav' }, prev, next, label);

  return panel('Costumes', el('div', { class: 'costume-panel' }, nav, view), { count: costumes.length });
}

function renderCostume(entry: CostumeEntry, file: ResourceFile, roomPalette: Uint8Array | null): HTMLElement {
  const wrap = el('div', { class: 'costume-card' });

  let payload: Uint8Array;
  let cost: CostumeHeader;
  try {
    payload = payloadOf(file, entry.costBlock);
    cost = parseCostumeHeader(payload);
  } catch (err) {
    append(wrap, el('p', { class: 'dossier-error', text: `decode failed: ${(err as Error).message}` }));
    return wrap;
  }

  append(
    wrap,
    el('div', {
      class: 'object-meta',
      text:
        `${cost.numAnim} anim${cost.numAnim === 1 ? '' : 's'} · ${cost.paletteSize}-color · ` +
        `format 0x${cost.format.toString(16).padStart(2, '0')} · mirror ${cost.mirrorFlag ? 'on' : 'off'}`,
    }),
  );

  const frames = el('div', { class: 'costume-frames' });
  let drawn = 0;
  for (const table of decodeLimbTables(payload, cost)) {
    // Frames are valid up to the first "suspicious" entry (trailing junk / the
    // shared sentinel unused limbs point at).
    let valid = 0;
    while (valid < table.entries.length && !table.suspicious[valid]) valid++;
    if (valid === 0) continue;

    const group = el('div', { class: 'costume-limb' });
    const limbLabel = table.usedByLimbs.length === 1 ? `limb ${table.usedByLimbs[0]}` : `limbs ${table.usedByLimbs.join(',')}`;
    append(group, el('span', { class: 'costume-limb-label', text: limbLabel }));
    const thumbs = el('div', { class: 'costume-limb-frames' });
    for (let i = 0; i < valid; i++) {
      let frame: DecodedCostumeFrame;
      try {
        frame = decodeCostumeFrame(payload, table.entries[i]!, { paletteSize: cost.paletteSize });
      } catch {
        continue;
      }
      const cell = el('div', { class: 'costume-frame-cell' }, frameCanvas(frame, cost.palette, roomPalette));
      cell.title = `frame ${i} · ${frame.width}×${frame.height} · redir ${frame.redirX},${frame.redirY}`;
      append(thumbs, cell);
      drawn++;
    }
    append(group, thumbs);
    append(frames, group);
  }
  if (drawn === 0) append(frames, el('p', { class: 'dossier-empty', text: '(no renderable frames)' }));
  append(wrap, frames);
  return wrap;
}

/** frame pixel → costPalette[index] = CLUT index → room CLUT RGB (gray ramp if no room loaded). */
function frameCanvas(frame: DecodedCostumeFrame, costPalette: Uint8Array, roomPalette: Uint8Array | null): HTMLCanvasElement {
  const canvas = el('canvas', { class: 'frame-preview-canvas' });
  canvas.width = Math.max(1, frame.width);
  canvas.height = Math.max(1, frame.height);
  canvas.style.width = `${canvas.width * FRAME_SCALE}px`;
  canvas.style.height = `${canvas.height * FRAME_SCALE}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(canvas.width, canvas.height);
  for (let p = 0; p < frame.pixels.length; p++) {
    const idx = frame.pixels[p]!;
    const o = p * 4;
    if (idx === COSTUME_FRAME_TRANSPARENT) {
      img.data[o + 3] = 0;
      continue;
    }
    let r: number, g: number, b: number;
    if (roomPalette && idx < costPalette.length) {
      const c = costPalette[idx]!;
      r = roomPalette[c * 3] ?? 0;
      g = roomPalette[c * 3 + 1] ?? 0;
      b = roomPalette[c * 3 + 2] ?? 0;
    } else {
      r = g = b = Math.round((idx / 31) * 255);
    }
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
