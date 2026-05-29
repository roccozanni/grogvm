/**
 * Phase 7 "play area" — the part of the inspector that simulates the
 * actual game UI: cursor overlay, hover highlight on interactable
 * objects, sentence-line preview, verb bar.
 *
 * # Architecture
 *
 * The inspector calls {@link mountPlayArea} after building the frame
 * canvas. The play area:
 *   - takes ownership of a cursor-overlay canvas it stacks above the
 *     frame canvas (pointer-events: none so clicks pass through),
 *   - subscribes to pointermove via the existing
 *     {@link mountVmFrameInput} callback (so the input layer stays the
 *     single source of truth for coordinate translation),
 *   - keeps the verb bar + sentence line as sibling DOM nodes the
 *     caller appends below the frame stack,
 *   - updates the cursor, hover highlight, and sentence line directly
 *     on every move WITHOUT triggering a full inspector repaint.
 *     The verb bar's hover/click state IS repainted on each click
 *     (less frequent — full repaint is cheap there).
 *
 * The crosshair / hover/sentence/verb-bar visuals are deliberately
 * minimal first-pass — getting click+verb+object flow visible matters
 * more than visual fidelity to the original game. Custom-cursor-image
 * decoding (the charset-glyph-as-cursor convention from
 * `setCursorImage`) is a polish item for later.
 */

import {
  CHARSET_TRANSPARENT,
  parseCharHeader,
  walkCharsets,
  type CharsetEntry,
  type CharsetHeader,
} from '../../engine/graphics/charset';
import { renderText } from '../../engine/graphics/text';
import { pickObject } from '../../engine/object/hittest';
import type { ResourceFile } from '../../engine/resources/tree';
import type { Vm, VerbSlot } from '../../engine/vm/vm';

/**
 * MI1 verb area starts at screen y = 144 (rooms are 200 tall total,
 * verb area = 56 lines). Verb x/y from scripts are screen-space —
 * subtract this to get verb-bar-local y.
 *
 * v5 games other than MI1 may use different layouts; revisit when MI2
 * boot exercises the verb bar.
 */
const VERB_BAR_START_Y = 144;
const VERB_BAR_HEIGHT = 56;
const CSS_SCALE = 2;

/** Default CLUT colours when a verb's slot doesn't specify one. */
const DEFAULT_VERB_COLOR = 7; // light-grey ink
const DEFAULT_VERB_HI_COLOR = 14; // light yellow
const DEFAULT_VERB_DIM_COLOR = 8; // dark grey

/** Cursor crosshair colours (CLUT indices). */
const CURSOR_COLOR_NORMAL = 15; // bright white
const CURSOR_COLOR_HOVER_OBJECT = 14; // yellow when over an interactable

export interface PlayAreaArgs {
  readonly resourceFile: ResourceFile;
  readonly vm: Vm;
  readonly roomWidth: number;
  readonly roomHeight: number;
  /** CLUT palette of the current room — used to tint cursor + text. */
  readonly palette: Uint8Array;
  /** TRNS index for the current room, for the verb-bar background. */
  readonly transparentIndex: number | null;
  /**
   * Called when the user clicks the verb bar or selects an object —
   * triggers a full inspector repaint so the verb-bar hover/selected
   * state + sentence panel update.
   */
  readonly onCommit: () => void;
}

export interface PlayAreaHandles {
  /** Append this above the frame canvas inside `.vm-frame-stack`. */
  readonly cursorOverlay: HTMLCanvasElement;
  /** Append this below the frame stack. */
  readonly sentenceLine: HTMLElement;
  /** Append this below the sentence line. */
  readonly verbBar: HTMLCanvasElement;
  /**
   * Call from {@link mountVmFrameInput}'s `onMove` — drives live
   * cursor + hover + sentence updates without a full repaint.
   */
  readonly onPointerMove: () => void;
  /**
   * Call from `onLeftClick` / `onRightClick`. Returns the object id
   * under the click (or null) so the inspector can route the sentence
   * dispatch in future tasks.
   */
  readonly onRoomClick: (button: 'left' | 'right') => { objId: number | null };
  /**
   * Per-tick redraw of every overlay canvas (cursor, verb bar) plus
   * the sentence line. Called by the inspector from its rAF loop —
   * unlike a full re-mount, this only updates canvas pixels so the
   * DOM elements survive across ticks and clicks don't drop.
   */
  readonly redraw: () => void;
}

/**
 * Build the Phase 7 play-area DOM + cursor logic. The caller decides
 * where to mount the returned canvases / elements.
 */
export function mountPlayArea(args: PlayAreaArgs): PlayAreaHandles {
  const { vm, roomWidth, roomHeight, palette, transparentIndex } = args;
  // The active charset changes at runtime (`cursorCommand initCharset`):
  // the credits use charset 4 (a 2-bpp serif title font), gameplay
  // dialog/verbs another. Loading it once at mount froze us on whatever
  // was current then — wrong glyphs for everything after. Resolve it
  // live from `vm.currentCharset`, cached per id so we don't re-walk the
  // LECF tree every repaint.
  const charsetCache = new Map<number, ReturnType<typeof loadCharset>>();
  const activeCharset = (): ReturnType<typeof loadCharset> => {
    const id = vm.currentCharset;
    let c = charsetCache.get(id);
    if (c === undefined) {
      c = loadCharset(args.resourceFile, id);
      charsetCache.set(id, c);
    }
    return c;
  };

  // ─── cursor overlay ───
  const cursorOverlay = document.createElement('canvas');
  cursorOverlay.className = 'vm-frame-cursor';
  cursorOverlay.width = roomWidth;
  cursorOverlay.height = roomHeight;
  cursorOverlay.style.width = `${roomWidth * CSS_SCALE}px`;
  cursorOverlay.style.height = `${roomHeight * CSS_SCALE}px`;
  const cctx = cursorOverlay.getContext('2d');

  // ─── sentence line ───
  const sentenceLine = document.createElement('div');
  sentenceLine.className = 'vm-sentence-line';
  sentenceLine.textContent = sentenceText(vm, null, null);

  // ─── verb bar ───
  const verbBar = document.createElement('canvas');
  verbBar.className = 'vm-verb-bar';
  verbBar.width = roomWidth;
  verbBar.height = VERB_BAR_HEIGHT;
  verbBar.style.width = `${roomWidth * CSS_SCALE}px`;
  verbBar.style.height = `${VERB_BAR_HEIGHT * CSS_SCALE}px`;
  const vbctx = verbBar.getContext('2d');

  /** Most recently computed hovered object id (or null). */
  let hoveredObject: number | null = null;
  /** Most recently computed hovered verb id (or null). */
  let hoveredVerb: number | null = null;

  const drawCursor = (): void => {
    if (!cctx) return;
    cctx.clearRect(0, 0, roomWidth, roomHeight);

    // Camera viewport indicator — outlines the 320-wide slice of the
    // room the player would actually see on screen. Debug-only;
    // helps explain why on-camera content appears off-centre on the
    // full-room debug view.
    drawViewportRect(cctx);

    // Active dialog text (from `print` / `printEgo`). Painted before
    // the cursor so the crosshair stays on top.
    drawDialog(cctx);

    // Hover highlight box around the hovered object.
    if (hoveredObject !== null) {
      const obj = vm.loadedRoom?.objects.get(hoveredObject);
      if (obj) {
        const left = obj.cdhd.x * 8;
        const top = obj.cdhd.y * 8;
        const w = obj.cdhd.width * 8;
        const h = obj.cdhd.height * 8;
        cctx.strokeStyle = clutCss(palette, CURSOR_COLOR_HOVER_OBJECT);
        cctx.lineWidth = 1;
        cctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
      }
    }

    // Crosshair — always painted in the inspector context so the
    // user can validate input wiring even before the boot script
    // enables the cursor. Engine-truth `vm.cursor.visible` is surfaced
    // in the Input panel for diagnosis; the game would normally skip
    // this paint when it's false.
    const cx = vm.mouseRoomX;
    const cy = vm.mouseRoomY;
    const color = hoveredObject !== null ? CURSOR_COLOR_HOVER_OBJECT : CURSOR_COLOR_NORMAL;
    cctx.fillStyle = clutCss(palette, color);
    // 7×1 horizontal + 1×7 vertical centred at (cx, cy).
    cctx.fillRect(cx - 3, cy, 7, 1);
    cctx.fillRect(cx, cy - 3, 1, 7);
  };

  /**
   * Render `vm.activeDialog` over the frame. Position semantics:
   *   - If `SO_AT` provided explicit (x, y), use that directly.
   *   - Else if `overhead` and the speaking actor is in the current
   *     room, position above the actor (current placement is rough —
   *     a few px above the actor's head, no animation tail).
   *   - Else center horizontally near the bottom of the frame (the
   *     v5 fallback "system text" position).
   *
   * Uses the active charset chosen by `cursorCommand initCharset`.
   * If the charset hasn't loaded the dialog renders nothing — better
   * to silently drop than to halt the engine on a missing font.
   */
  /**
   * Paint a dashed outline showing the player-visible camera viewport.
   * Rect = `[cameraLeft, screen.top]` extending `[VIEWPORT_W,
   * screen.bottom - screen.top]`. With the room canvas showing the
   * full 640×200 (debug view), this rect tells the user exactly which
   * slice of pixels the real game would display on screen.
   */
  const drawViewportRect = (ctx: CanvasRenderingContext2D): void => {
    const VIEWPORT_W = 320;
    const cameraLeft = vm.camera.x - VIEWPORT_W / 2;
    const top = vm.screen.top;
    const height = Math.max(1, vm.screen.bottom - vm.screen.top);
    // Subtle: a few-pixel outline with a half-pixel offset so the
    // dashes sit on integer rows, plus an inset shadow on the inside
    // so it reads against either light or dark backgrounds.
    ctx.save();
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.strokeRect(cameraLeft + 0.5, top + 0.5, VIEWPORT_W - 1, height - 1);
    ctx.restore();
  };

  const drawDialog = (ctx: CanvasRenderingContext2D): void => {
    const d = vm.activeDialog;
    const charset = activeCharset();
    if (!d || !charset) return;
    // SCUMM print `at(x, y)` is in SCREEN coords — relative to the
    // camera's viewport. To paint into the room canvas (which spans
    // the full room width), add the camera's left edge:
    //   roomX = screenX + (camera.x - VIEWPORT_HALF)
    // Actor-overhead positions are already in room coords (they read
    // actor.x which is room-space), so no offset there.
    const VIEWPORT_HALF = 160;
    const cameraLeft = vm.camera.x - VIEWPORT_HALF;
    let dx: number;
    let dy: number;
    if (d.x !== null && d.y !== null) {
      dx = d.x + cameraLeft;
      dy = d.y;
    } else if (d.overhead) {
      const speaker = d.actorId > 0 ? vm.actors.get(d.actorId) : null;
      dx = speaker?.x ?? Math.floor(roomWidth / 2);
      dy = (speaker?.y ?? Math.floor(roomHeight / 2)) - 24;
    } else {
      // Default fallback — bottom-centre of the camera viewport. Anchor
      // the BLOCK's bottom a few px above the frame edge: `drawText`
      // paints downward from `dy`, so we must subtract the full rendered
      // height (lineCount × fontHeight) or a tall / multi-line font runs
      // off the bottom (charset 4 is 14px vs the old 8px default).
      const lineCount = d.text.split('\n').length;
      const blockH = lineCount * charset.header.fontHeight;
      dx = cameraLeft + VIEWPORT_HALF;
      dy = roomHeight - blockH - 2;
    }
    drawText(ctx, charset, d.text, dx, dy, palette, d.color, d.center);
  };

  const updateSentence = (): void => {
    sentenceLine.textContent = sentenceText(vm, hoveredObject, hoveredVerb);
  };

  const paintVerbBar = (): void => {
    if (!vbctx) return;
    const charset = activeCharset();
    vbctx.clearRect(0, 0, roomWidth, VERB_BAR_HEIGHT);

    // Background: solid CLUT colour or transparent (caller has CSS
    // backdrop). MI1 verb-bar background is the room palette's
    // colour 0 (typically black).
    const bgIdx = transparentIndex ?? 0;
    if (bgIdx !== null) {
      vbctx.fillStyle = clutCss(palette, bgIdx);
      vbctx.fillRect(0, 0, roomWidth, VERB_BAR_HEIGHT);
    }

    if (!charset) {
      vbctx.fillStyle = '#888';
      vbctx.font = '8px monospace';
      vbctx.fillText('(no charset loaded)', 4, 12);
      drawVerbsFallback(vbctx, vm);
      return;
    }

    for (const v of vm.verbs.values()) {
      if (v.state === 'deleted' || v.state === 'off') continue;
      if (!v.name) continue;
      const x = v.x;
      const y = v.y - VERB_BAR_START_Y;
      if (y < 0 || y >= VERB_BAR_HEIGHT) continue;
      const ink = pickInk(v, v.id === hoveredVerb, v.id === vm.currentVerb);
      drawText(vbctx, charset, v.name, x, y, palette, ink, v.centered);
    }
  };

  const drawAll = (): void => {
    drawCursor();
    updateSentence();
  };

  const recomputeHover = (): void => {
    const room = vm.loadedRoom;
    if (!room) {
      hoveredObject = null;
      return;
    }
    hoveredObject = pickObject({
      objects: room.objects,
      drawQueue: vm.objectDrawQueue,
      x: vm.mouseRoomX,
      y: vm.mouseRoomY,
    });
  };

  const onPointerMove = (): void => {
    recomputeHover();
    drawAll();
  };

  // Initial paint.
  recomputeHover();
  paintVerbBar();
  drawAll();

  // ─── verb-bar input ───
  const verbAt = (canvasX: number, canvasY: number): VerbSlot | null => {
    const charset = activeCharset();
    if (!charset) return null;
    // Hit-test: a verb's bbox is its measured name width × fontHeight
    // starting at (verb.x, verb.y - VERB_BAR_START_Y). centred verbs
    // shift left by half the measured width.
    for (const v of vm.verbs.values()) {
      if (v.state !== 'on' && v.state !== 'dim') continue;
      if (!v.name) continue;
      const y = v.y - VERB_BAR_START_Y;
      const measured = measureName(charset, v.name);
      const x = v.centered ? v.x - Math.floor(measured.width / 2) : v.x;
      if (
        canvasX >= x &&
        canvasX < x + measured.width &&
        canvasY >= y &&
        canvasY < y + measured.height
      ) {
        return v;
      }
    }
    return null;
  };

  const localToCanvas = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = verbBar.getBoundingClientRect();
    const sx = rect.width > 0 ? rect.width / roomWidth : 1;
    const sy = rect.height > 0 ? rect.height / VERB_BAR_HEIGHT : 1;
    return {
      x: Math.floor((ev.clientX - rect.left) / sx),
      y: Math.floor((ev.clientY - rect.top) / sy),
    };
  };

  verbBar.addEventListener('pointermove', (ev) => {
    const { x, y } = localToCanvas(ev);
    const v = verbAt(x, y);
    const newHover = v?.id ?? null;
    if (newHover !== hoveredVerb) {
      hoveredVerb = newHover;
      paintVerbBar();
      updateSentence();
    }
  });
  verbBar.addEventListener('pointerleave', () => {
    if (hoveredVerb !== null) {
      hoveredVerb = null;
      paintVerbBar();
      updateSentence();
    }
  });
  verbBar.addEventListener('pointerdown', (ev) => {
    const { x, y } = localToCanvas(ev);
    const v = verbAt(x, y);
    if (!v || v.state !== 'on') return;
    // Engine click handling: arm the verb + fire the input-script hook.
    vm.handleVerbClick(v.id);
    paintVerbBar();
    updateSentence();
    args.onCommit();
  });

  // ─── room-click handler (wired from the inspector's pointerdown).
  //     Routes the click into the engine's scene-click handler, which
  //     fires the input-script hook and — when a verb is armed — builds
  //     a sentence for the per-tick sentence driver to run. Returns the
  //     hit-tested object id so the inspector can still log the click.
  const onRoomClick = (button: 'left' | 'right'): { objId: number | null } => {
    recomputeHover();
    // Right-click as the v5 "look-at" shortcut isn't wired yet (needs
    // the look-at verb id); for now both buttons use the armed verb.
    vm.handleSceneClick(hoveredObject ?? 0, button === 'left' ? 1 : 2);
    return { objId: hoveredObject };
  };

  /**
   * Full per-tick refresh: recompute hover (in case the engine
   * shifted objects / drawObject queue), repaint cursor + dialog,
   * repaint the verb bar (catches name / state / colour changes
   * from verbOps that ran since the last paint), refresh sentence
   * line text.
   */
  const redraw = (): void => {
    recomputeHover();
    drawAll();
    paintVerbBar();
  };

  return {
    cursorOverlay,
    sentenceLine,
    verbBar,
    onPointerMove,
    onRoomClick,
    redraw,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Cached charset lookup. We walk the LECF tree and pick the entry
 * matching `id`, falling back to the first charset present. Returns
 * `null` if the resource file has no charsets (shouldn't happen for
 * MI1/MI2 but keeps the renderer defensive).
 */
function loadCharset(
  file: ResourceFile,
  id: number,
): { entry: CharsetEntry; header: CharsetHeader; payload: Uint8Array } | null {
  const all = walkCharsets(file);
  if (all.length === 0) return null;
  // CHAR indexes are typically a 1-based id; treat 0 as "default to
  // the first available". Fallback to 0-th if id out of range.
  const wanted = id >= 0 && id < all.length ? all[id]! : all[0]!;
  try {
    const payload = file.bytes.subarray(
      wanted.charBlock.offset + 8,
      wanted.charBlock.offset + wanted.charBlock.size,
    );
    const header = parseCharHeader(payload);
    return { entry: wanted, header, payload };
  } catch {
    return null;
  }
}

function pickInk(v: VerbSlot, hovered: boolean, armed: boolean): number {
  if (v.state === 'dim') return v.dimColor || DEFAULT_VERB_DIM_COLOR;
  if (hovered || armed) return v.hiColor || DEFAULT_VERB_HI_COLOR;
  return v.color || DEFAULT_VERB_COLOR;
}

interface MeasuredName {
  readonly width: number;
  readonly height: number;
}

function measureName(
  charset: NonNullable<ReturnType<typeof loadCharset>>,
  text: string,
): MeasuredName {
  // Reuse the CHAR-aware renderer's measurement implicitly by running
  // a colourless render and reading the dims. Cheap enough at the
  // sizes we're dealing with (a few verb names per repaint).
  const colorMap = new Uint8Array(charset.header.colorMap);
  try {
    const r = renderText(charset.payload, charset.header, text, colorMap);
    return { width: r.width, height: r.height };
  } catch {
    return { width: text.length * 6, height: charset.header.fontHeight };
  }
}

/**
 * Render `text` at (`x`, `y`) on a 2D context, using the CHAR
 * renderer to produce indexed pixels and converting to RGBA through
 * the room CLUT. `inkColor` overrides `colorMap[1]` (the ink slot for
 * 1-bpp charsets); 2-bpp text falls back to the charset's natural
 * `colorMap[2..3]` outline / fill.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  charset: NonNullable<ReturnType<typeof loadCharset>>,
  text: string,
  x: number,
  y: number,
  palette: Uint8Array,
  inkColor: number,
  centered: boolean,
): void {
  const colorMap = new Uint8Array(charset.header.colorMap);
  colorMap[1] = inkColor;
  let r;
  try {
    r = renderText(charset.payload, charset.header, text, colorMap);
  } catch {
    return;
  }
  if (r.width === 0 || r.height === 0) return;

  const startX = centered ? x - Math.floor(r.width / 2) : x;
  const img = ctx.createImageData(r.width, r.height);
  for (let p = 0; p < r.pixels.length; p++) {
    const v = r.pixels[p]!;
    const o = p * 4;
    if (v === CHARSET_TRANSPARENT) {
      img.data[o + 3] = 0;
      continue;
    }
    const rgb = clutRgb(palette, v);
    img.data[o] = rgb[0];
    img.data[o + 1] = rgb[1];
    img.data[o + 2] = rgb[2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, startX, y);
}

/**
 * No-CHAR fallback so the verb bar still shows *something* even when
 * the charset lookup fails (broken resource file, etc.). Uses the
 * browser's built-in text — no CLUT tinting, just legibility.
 */
function drawVerbsFallback(ctx: CanvasRenderingContext2D, vm: Vm): void {
  ctx.fillStyle = '#dde';
  ctx.font = '10px monospace';
  let yi = 24;
  for (const v of vm.verbs.values()) {
    if (v.state === 'deleted' || v.state === 'off') continue;
    if (!v.name) continue;
    ctx.fillText(v.name, 4, yi);
    yi += 12;
  }
}

function clutRgb(palette: Uint8Array, idx: number): [number, number, number] {
  const o = idx * 3;
  return [palette[o] ?? 0, palette[o + 1] ?? 0, palette[o + 2] ?? 0];
}

function clutCss(palette: Uint8Array, idx: number): string {
  const [r, g, b] = clutRgb(palette, idx);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Build the sentence-preview string from the current verb + hovered
 * object. Format follows the v5 convention:
 *
 *   "{verb} {obj1}"                        single-object verb
 *   "{verb} {obj1} {preposition} {obj2}"   two-object verb (later)
 *
 * `hoveredVerb` takes priority when set so the bar previews the
 * verb the mouse is over BEFORE the user clicks to commit it —
 * matches the original MI1 UX.
 *
 * For the visible-only milestone we render the single-object form
 * only — the second object slot lands once we have inventory wired.
 */
function sentenceText(
  vm: Vm,
  hoveredObject: number | null,
  hoveredVerb: number | null,
): string {
  // Verb name precedence: the verb under the cursor (live preview)
  // beats the armed verb (last click). Falls back to 'Walk to' (the
  // implicit verb when nothing is selected and nothing's hovered).
  const previewVerbId = hoveredVerb ?? vm.currentVerb;
  const previewVerb =
    previewVerbId !== null ? vm.verbs.get(previewVerbId) : null;
  const verbName = previewVerb?.name || 'Walk to';
  const objName =
    hoveredObject !== null
      ? vm.loadedRoom?.objects.get(hoveredObject)?.name ?? `obj #${hoveredObject}`
      : '';
  return objName ? `${verbName} ${objName}` : verbName;
}
