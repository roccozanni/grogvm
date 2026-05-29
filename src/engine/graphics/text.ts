/**
 * Text layout + rendering against a decoded SCUMM v5 CHAR (charset).
 *
 * Single-line semantics with explicit `\n` newline handling: each
 * glyph is stamped at the cursor with its `(xOffset, yOffset)` applied,
 * then the cursor advances by the glyph's `width`. A newline resets
 * the cursor X to 0 and advances Y by `fontHeight`. No word wrap, no
 * alignment, no kerning beyond what the per-glyph `xOffset` encodes —
 * those are downstream concerns (text boxes, dialog UI) that Phase 4
 * doesn't aim to solve.
 *
 * Output pixels are a `width × height` `Uint8Array` of CLUT indices.
 * Transparent pixels are emitted as `CHARSET_TRANSPARENT` (`0xFF`) —
 * same sentinel costume frames use, so the room compositor (and any
 * future text-bubble compositor) can treat them uniformly.
 */

import {
  CHARSET_TRANSPARENT,
  type CharsetHeader,
  decodeGlyph,
  glyphPayloadOffset,
} from './charset';

export interface MeasuredText {
  /** Bounding-box width in pixels. */
  readonly width: number;
  /** Bounding-box height in pixels. */
  readonly height: number;
}

export interface RenderedText extends MeasuredText {
  /**
   * `width × height` indexed pixels. `CHARSET_TRANSPARENT` for "do not
   * draw"; everything else is a CLUT index.
   */
  readonly pixels: Uint8Array;
}

/**
 * Compute the bounding box a `renderText` call would produce, without
 * actually emitting pixels. Useful for upstream layout (e.g. dialog
 * bubble sizing) and as the size of the buffer `renderText` allocates.
 */
export function measureText(
  payload: Uint8Array,
  header: CharsetHeader,
  text: string,
): MeasuredText {
  if (text.length === 0) return { width: 0, height: 0 };

  let curX = 0;
  let curY = 0;
  let maxRight = 0;
  let maxBottom = header.fontHeight;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      curX = 0;
      curY += header.fontHeight;
      maxBottom = Math.max(maxBottom, curY + header.fontHeight);
      continue;
    }
    const code = ch.charCodeAt(0);
    const off = glyphPayloadOffset(header, code);
    if (off === null) continue; // unknown character — silently skipped
    const g = decodeGlyph(payload, off, header.bpp, header.reversedBits);
    // The glyph extends from `curX + xOffset` to `curX + xOffset +
    // width` horizontally and similarly in Y from `curY + yOffset`.
    // Track the max so a glyph whose xOffset pushes right past its
    // declared advance still grows the bounding box.
    if (g.width > 0 && g.height > 0) {
      const right = curX + g.xOffset + g.width;
      if (right > maxRight) maxRight = right;
      const bottom = curY + g.yOffset + g.height;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    curX += g.width;
    // Even a blank glyph advances by its (possibly zero) width, then
    // tracks the cursor for the next character. The cursor itself sets
    // a lower bound on `maxRight` so trailing whitespace still counts.
    if (curX > maxRight) maxRight = curX;
  }
  return { width: maxRight, height: maxBottom };
}

/**
 * Word-wrap `text` to a maximum pixel `width`, returning the text with
 * `\n` inserted at the chosen break points. Greedy line-packing on
 * space boundaries — the SCUMM v5 convention (CHARSET_1 breaks talk
 * text at spaces against the right margin). Explicit `\n` already in the
 * text is preserved (each pre-split segment wraps independently). A
 * single word wider than `width` is left whole on its own line (overflow
 * rather than mid-word break), matching the original.
 */
export function wrapText(
  payload: Uint8Array,
  header: CharsetHeader,
  text: string,
  maxWidth: number,
): string {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line === '' || measureText(payload, header, candidate).width <= maxWidth) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Render `text` to an indexed pixel buffer.
 *
 * `colorMap` maps glyph bit-pattern values to CLUT indices: index 0 is
 * always transparent (regardless of what `colorMap[0]` contains), and
 * indices 1..N (where N = 2^bpp − 1) get whatever CLUT index the
 * caller wants. For a 1-bpp charset, `colorMap[1]` is the "ink"; for
 * 2-bpp, indices 1..3 typically correspond to outline / fill / shadow
 * tones and you'd usually pass `header.colorMap` straight through.
 */
export function renderText(
  payload: Uint8Array,
  header: CharsetHeader,
  text: string,
  colorMap: Uint8Array,
): RenderedText {
  const { width, height } = measureText(payload, header, text);
  if (width === 0 || height === 0) {
    return { width: 0, height: 0, pixels: new Uint8Array(0) };
  }
  if (colorMap.length < (1 << header.bpp)) {
    throw new Error(
      `renderText: colorMap length ${colorMap.length} is too small for bpp ${header.bpp}.`,
    );
  }
  const pixels = new Uint8Array(width * height).fill(CHARSET_TRANSPARENT);

  let curX = 0;
  let curY = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      curX = 0;
      curY += header.fontHeight;
      continue;
    }
    const code = ch.charCodeAt(0);
    const off = glyphPayloadOffset(header, code);
    if (off === null) continue;
    const g = decodeGlyph(payload, off, header.bpp, header.reversedBits);
    if (g.width === 0 || g.height === 0) {
      curX += g.width;
      continue;
    }
    const stampX = curX + g.xOffset;
    const stampY = curY + g.yOffset;
    for (let y = 0; y < g.height; y++) {
      const py = stampY + y;
      if (py < 0 || py >= height) continue;
      for (let x = 0; x < g.width; x++) {
        const v = g.pixels[y * g.width + x]!;
        if (v === 0) continue; // bit pattern 0 = transparent
        const px = stampX + x;
        if (px < 0 || px >= width) continue;
        pixels[py * width + px] = colorMap[v]!;
      }
    }
    curX += g.width;
  }

  return { width, height, pixels };
}
