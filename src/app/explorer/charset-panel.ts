/**
 * Charsets dossier panel. Like costumes, charsets ship in the room's LFLF (in
 * MI1 they all sit in one LFLF, so most rooms show none). Each charset renders
 * its populated glyphs as thumbnails and a live text renderer — type a string,
 * pick an ink, see it laid out by the real `renderText`. Glyph/text colours map
 * through the current room's CLUT (gray ramp when no room palette is available).
 */
import { el, append } from '../reactive';
import {
  charsetPayload,
  parseCharHeader,
  glyphPayloadOffset,
  decodeGlyph,
  CHARSET_TRANSPARENT,
  type CharsetEntry,
  type CharsetHeader,
  type DecodedGlyph,
} from '../../engine/graphics/charset';
import { renderText } from '../../engine/graphics/text';
import type { ResourceFile } from '../../engine/resources/tree';
import { panel } from './panels';

const GLYPH_SCALE = 2;
const TEXT_SCALE = 2;

export function charsetsPanel(
  charsets: readonly CharsetEntry[],
  file: ResourceFile,
  roomPalette: Uint8Array | null,
): HTMLElement | null {
  if (charsets.length === 0) return null;
  const body = el('div', { class: 'charset-panel' });
  for (let i = 0; i < charsets.length; i++) append(body, renderCharset(charsets[i]!, i, charsets.length, file, roomPalette));
  return panel('Charsets', body, { count: charsets.length });
}

function renderCharset(
  entry: CharsetEntry,
  index: number,
  total: number,
  file: ResourceFile,
  roomPalette: Uint8Array | null,
): HTMLElement {
  const card = el('div', { class: 'charset-card' });
  append(card, el('div', { class: 'charset-card-label', text: `Charset ${index + 1} of ${total} · LFLF #${entry.lflfIndex}` }));

  let payload: Uint8Array;
  let header: CharsetHeader;
  try {
    payload = charsetPayload(file, entry);
    header = parseCharHeader(payload);
  } catch (err) {
    append(card, el('p', { class: 'dossier-error', text: `decode failed: ${(err as Error).message}` }));
    return card;
  }

  let populated = 0;
  for (const off of header.glyphOffsets) if (off !== 0) populated++;
  append(
    card,
    el('div', {
      class: 'object-meta',
      text: `${header.bpp} bpp · height ${header.fontHeight} · ${populated} / ${header.numChars} glyphs`,
    }),
  );
  append(card, glyphGrid(payload, header, roomPalette));
  append(card, textRenderer(payload, header, roomPalette));
  return card;
}

function glyphGrid(payload: Uint8Array, header: CharsetHeader, roomPalette: Uint8Array | null): HTMLElement {
  const grid = el('div', { class: 'glyph-grid' });
  for (let c = 0; c < header.numChars; c++) {
    const off = glyphPayloadOffset(header, c);
    if (off === null) continue;
    let glyph: DecodedGlyph;
    try {
      glyph = decodeGlyph(payload, off, header.bpp, header.reversedBits);
    } catch {
      continue;
    }
    if (glyph.width === 0 || glyph.height === 0) continue;
    const cell = el('div', { class: 'glyph-cell' }, glyphCanvas(glyph, header.colorMap, roomPalette));
    cell.title =
      `char 0x${c.toString(16).padStart(2, '0')} (${c})` +
      (c >= 32 && c < 127 ? ` '${String.fromCharCode(c)}'` : '') +
      ` · ${glyph.width}×${glyph.height}`;
    append(grid, cell);
  }
  return grid;
}

function textRenderer(payload: Uint8Array, header: CharsetHeader, roomPalette: Uint8Array | null): HTMLElement {
  const input = el('input', { class: 'charset-text-input', type: 'text', value: 'GUYBRUSH THREEPWOOD' }) as HTMLInputElement;
  const ink = el('input', { class: 'charset-ink-input', type: 'number', min: '0', max: '255', value: String(header.colorMap[1]) }) as HTMLInputElement;
  const canvas = el('canvas', { class: 'frame-preview-canvas' }) as HTMLCanvasElement;

  const repaint = (): void => {
    const map = new Uint8Array(header.colorMap);
    map[1] = Math.max(0, Math.min(255, parseInt(ink.value, 10) || 0));
    let r: { width: number; height: number; pixels: Uint8Array };
    try {
      r = renderText(payload, header, input.value, map);
    } catch {
      r = { width: 0, height: 0, pixels: new Uint8Array(0) };
    }
    canvas.width = Math.max(1, r.width);
    canvas.height = Math.max(1, r.height);
    canvas.style.width = `${canvas.width * TEXT_SCALE}px`;
    canvas.style.height = `${canvas.height * TEXT_SCALE}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    const img = ctx.createImageData(canvas.width, canvas.height);
    for (let p = 0; p < r.pixels.length; p++) {
      const v = r.pixels[p]!;
      const o = p * 4;
      if (v === CHARSET_TRANSPARENT) {
        img.data[o + 3] = 0;
        continue;
      }
      const rgb = roomRgb(roomPalette, v) ?? [v, v, v];
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  };
  input.addEventListener('input', repaint);
  ink.addEventListener('input', repaint);
  repaint();

  return el(
    'div',
    { class: 'charset-text-renderer' },
    el('div', { class: 'charset-text-controls' }, input, el('label', { class: 'charset-ink-label' }, 'ink ', ink)),
    canvas,
  );
}

function glyphCanvas(glyph: DecodedGlyph, colorMap: Uint8Array, roomPalette: Uint8Array | null): HTMLCanvasElement {
  const canvas = el('canvas', { class: 'frame-preview-canvas' });
  canvas.width = Math.max(1, glyph.width);
  canvas.height = Math.max(1, glyph.height);
  canvas.style.width = `${canvas.width * GLYPH_SCALE}px`;
  canvas.style.height = `${canvas.height * GLYPH_SCALE}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(canvas.width, canvas.height);
  // Fallback ramp keeps glyphs legible before any room palette is selected.
  const fallback: ([number, number, number] | null)[] = [null, [255, 255, 255], [180, 180, 180], [110, 110, 110]];
  for (let p = 0; p < glyph.pixels.length; p++) {
    const v = glyph.pixels[p]!;
    const o = p * 4;
    if (v === 0) {
      img.data[o + 3] = 0;
      continue;
    }
    const rgb = roomRgb(roomPalette, colorMap[v]!) ?? fallback[v] ?? [255, 255, 255];
    img.data[o] = rgb[0];
    img.data[o + 1] = rgb[1];
    img.data[o + 2] = rgb[2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function roomRgb(palette: Uint8Array | null, clutIdx: number): [number, number, number] | null {
  if (!palette) return null;
  const base = clutIdx * 3;
  if (base + 2 >= palette.length) return null;
  return [palette[base]!, palette[base + 1]!, palette[base + 2]!];
}
