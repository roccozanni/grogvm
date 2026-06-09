/**
 * Text layout + rendering against a decoded SCUMM v5 CHAR charset.
 * Layout semantics: pages/docs/scumm/char.md §6. Transparent pixels use
 * the same 0xFF sentinel as costume frames so compositors treat them uniformly.
 */

import {
  CHARSET_TRANSPARENT,
  type CharsetHeader,
  decodeGlyph,
  glyphPayloadOffset,
} from './charset';

/**
 * `@` (0x40) is OBNA name-padding, skipped unconditionally — the fonts DO
 * carry a visible `@` glyph, so skipping can't be left to the font.
 * See pages/docs/scumm/char.md §"`@` is name padding".
 */
const SCUMM_NAME_PAD = 0x40;

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

/** The bounding box a `renderText` call would produce, without emitting pixels. */
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
    if (code === SCUMM_NAME_PAD) continue;
    const off = glyphPayloadOffset(header, code);
    if (off === null) continue; // unknown character — silently skipped
    const g = decodeGlyph(payload, off, header.bpp, header.reversedBits);
    // xOffset/yOffset can push a glyph past its declared advance — track
    // the stamped extent, not just the cursor.
    if (g.width > 0 && g.height > 0) {
      const right = curX + g.xOffset + g.width;
      if (right > maxRight) maxRight = right;
      const bottom = curY + g.yOffset + g.height;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    curX += g.width;
    // The bare cursor lower-bounds maxRight so trailing whitespace counts.
    if (curX > maxRight) maxRight = curX;
  }
  return { width: maxRight, height: maxBottom };
}

/**
 * Greedy word-wrap on spaces to `maxWidth` pixels (the SCUMM v5
 * convention). Existing `\n` is preserved; an over-wide word overflows
 * whole on its own line rather than breaking mid-word, like the original.
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
 * Render `text` to an indexed pixel buffer. `colorMap` maps glyph
 * bit-patterns 1..2^bpp−1 to CLUT indices; pattern 0 is always
 * transparent regardless of `colorMap[0]` (char.md §5).
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
    if (code === SCUMM_NAME_PAD) continue;
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
