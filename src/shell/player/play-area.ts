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
import { measureText, renderText, wrapText } from '../../engine/graphics/text';
import { pickObject } from '../../engine/object/hittest';
import type { ResourceFile } from '../../engine/resources/tree';
import type { Vm, VerbSlot } from '../../engine/vm/vm';
import { VAR_EGO } from '../../engine/vm/vars';

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

/**
 * On-screen viewport width. The room canvas is drawn at the full room
 * width (a debug view — rooms can be 640+ wide and scroll), but the
 * verb bar and sentence line are fixed *screen* UI: MI1 lays verbs out
 * in screen-space coords (0..319, via `verbOps setXY`), and the player
 * only ever sees a 320-wide slice. So those strips are sized to this,
 * NOT to the room width.
 */
const VIEWPORT_W = 320;
/** The minimal charset shape the text renderer needs (header + payload). */
type ActiveCharset = { header: CharsetHeader; payload: Uint8Array };
// Max pixel width for a talk/dialog line before word-wrap kicks in.
// Leaves a ~16px margin each side of the 320-wide screen so centred
// bubbles don't kiss the edges.
const TALK_MAX_WIDTH = VIEWPORT_W - 32;

/**
 * MI1's inventory occupies verb ids 200..207 (a 4×2 grid of image
 * slots; 208/209 are the scroll arrows). Slot `200 + i` shows the
 * `i`-th inventory item (1-based via `findInventory`) — the order #9
 * assigns them. No scroll offset yet, so slot 200 = item 1.
 */
const INVENTORY_VERB_FIRST = 200;
const INVENTORY_VERB_LAST = 207;

/** Default CLUT colours when a verb's slot doesn't specify one. */
const DEFAULT_VERB_COLOR = 7; // light-grey ink
const DEFAULT_VERB_HI_COLOR = 14; // light yellow
/** MI1's sentence-line verb — drawn in the top band of the verb panel. */
const VERB_SENTENCE = 100;
const DEFAULT_VERB_DIM_COLOR = 8; // dark grey

/** Cursor crosshair colours (CLUT indices). */
const CURSOR_COLOR_NORMAL = 15; // bright white
const CURSOR_COLOR_HOVER_OBJECT = 14; // yellow when over an interactable

/**
 * MI1 game global holding the active (armed) verb, set by the verb-input
 * script #4. `11` (Vai/Walk-to) is the resting default — treated here as
 * "nothing armed". Used for the verb-bar highlight + sentence preview;
 * the engine no longer tracks an armed verb itself.
 */
const G_ACTIVE_VERB = 107;
const VERB_WALK_TO = 11;
function armedVerb(vm: Vm): number | null {
  const v = vm.vars.readGlobal(G_ACTIVE_VERB);
  return v > 0 && v !== VERB_WALK_TO ? v : null;
}

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
  /**
   * The verb panel. Append below the frame stack. Its top black band is
   * MI1's sentence line (verb #100) — drawn inside this canvas, not a
   * separate element.
   */
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
  const { vm, roomWidth, roomHeight, palette } = args;
  // The active charset changes at runtime (`cursorCommand initCharset`):
  // the credits use charset 4 (a 2-bpp serif title font), gameplay
  // dialog/verbs another. Loading it once at mount froze us on whatever
  // was current then — wrong glyphs for everything after. Resolve it
  // live from `vm.currentCharset`, cached per id so we don't re-walk the
  // LECF tree every repaint.
  const charsetCache = new Map<number, ActiveCharset | null>();
  const charsetById = (id: number): ActiveCharset | null => {
    let c = charsetCache.get(id);
    if (c === undefined) {
      // Resolve by SCUMM charset id via the engine's index-backed
      // resolver (correct font); fall back to file-walk order only when
      // it can't resolve (e.g. the built-in null charsets 0/5).
      c = vm.resolveCharset?.(id) ?? loadCharset(args.resourceFile, id);
      charsetCache.set(id, c);
    }
    return c;
  };
  const activeCharset = (): ActiveCharset | null => charsetById(vm.currentCharset);

  // ─── cursor overlay ───
  const cursorOverlay = document.createElement('canvas');
  cursorOverlay.className = 'vm-frame-cursor';
  cursorOverlay.width = roomWidth;
  cursorOverlay.height = roomHeight;
  cursorOverlay.style.width = `${roomWidth * CSS_SCALE}px`;
  cursorOverlay.style.height = `${roomHeight * CSS_SCALE}px`;
  const cctx = cursorOverlay.getContext('2d');

  // ─── verb bar ───
  // The sentence line is NOT a separate element — MI1 draws it as verb
  // #100 in the top black band of the verb panel, so it's rendered inside
  // the verb-bar canvas below (see paintVerbBar).
  // The verb bar is a fixed 320-wide screen element (verbs are placed in
  // screen-space coords), so its backing canvas is VIEWPORT_W — not the
  // room width, which would over-size it on wide/scrolling rooms.
  const verbBar = document.createElement('canvas');
  verbBar.className = 'vm-verb-bar';
  verbBar.width = VIEWPORT_W;
  verbBar.height = VERB_BAR_HEIGHT;
  verbBar.style.width = `${VIEWPORT_W * CSS_SCALE}px`;
  verbBar.style.height = `${VERB_BAR_HEIGHT * CSS_SCALE}px`;
  const vbctx = verbBar.getContext('2d');

  /** Most recently computed hovered object id (or null). */
  let hoveredObject: number | null = null;
  /** Most recently computed hovered verb id (or null). */
  let hoveredVerb: number | null = null;
  /** Inventory item under the cursor when hovering an inventory slot (or null). */
  let hoveredInvItem: number | null = null;

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

    // Hover highlight box around the hovered object — or, when an actor
    // is hovered, around its last-drawn bounds (Talk-to feedback).
    if (hoveredObject !== null) {
      const obj = vm.loadedRoom?.objects.get(hoveredObject);
      let box: { left: number; top: number; w: number; h: number } | null = null;
      if (obj) {
        box = { left: obj.cdhd.x * 8, top: obj.cdhd.y * 8, w: obj.cdhd.width * 8, h: obj.cdhd.height * 8 };
      } else if (hoveredObject >= 1 && hoveredObject <= vm.actors.capacity) {
        const b = vm.actors.get(hoveredObject).drawBounds;
        if (b) box = { left: b.left, top: b.top, w: b.right - b.left, h: b.bottom - b.top };
      }
      if (box) {
        cctx.strokeStyle = clutCss(palette, CURSOR_COLOR_HOVER_OBJECT);
        cctx.lineWidth = 1;
        cctx.strokeRect(box.left + 0.5, box.top + 0.5, box.w - 1, box.h - 1);
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
    const charset = activeCharset();
    if (!charset) return;
    // Two text channels coexist on screen: the blasted system text
    // (signs / narrator / credits / part-titles) underneath, and the
    // transient actor speech on top. Painting both — instead of sharing
    // one slot — is what keeps a sign visible while Guybrush talks. The
    // system channel can hold several stacked lines at once (e.g. the
    // "Le tre prove" part-title: "Parte Uno" + "Le Tre Prove").
    for (const line of vm.systemTexts) paintDialog(ctx, charset, line);
    if (vm.activeDialog) paintDialog(ctx, charset, vm.activeDialog);
  };

  const paintDialog = (
    ctx: CanvasRenderingContext2D,
    charset: ActiveCharset,
    d: NonNullable<typeof vm.activeDialog>,
  ): void => {
    // SCUMM print `at(x, y)` is in SCREEN coords — relative to the
    // camera's viewport. To paint into the room canvas (which spans
    // the full room width), add the camera's left edge:
    //   roomX = screenX + (camera.x - VIEWPORT_HALF)
    // Actor-overhead positions are already in room coords (they read
    // actor.x which is room-space), so no offset there.
    const VIEWPORT_HALF = 160;
    const cameraLeft = vm.camera.x - VIEWPORT_HALF;
    // Word-wrap to the talk text box so long lines don't overrun the
    // viewport. SCUMM v5 breaks talk text at spaces against the screen
    // margin; `drawText` then centres each wrapped line independently.
    const text = wrapText(charset.payload, charset.header, d.text, TALK_MAX_WIDTH);
    const fontH = charset.header.fontHeight;
    const lineCount = text.split('\n').length;
    const blockH = lineCount * fontH;
    let dx: number;
    let dy: number;
    if (d.x !== null && d.y !== null) {
      // Explicit SO_AT — the script positioned it; honour it as the top.
      dx = d.x + cameraLeft;
      dy = d.y;
    } else if (d.overhead) {
      const speaker =
        d.actorId > 0 && d.actorId <= vm.actors.capacity
          ? vm.actors.get(d.actorId)
          : null;
      dx = speaker?.x ?? Math.floor(roomWidth / 2);
      // Anchor the BLOCK's bottom just above the actor's drawn head so the
      // bubble sits *above* the speaker (not over them) and grows upward.
      // `drawBounds.top` is the real sprite top recorded by the compositor;
      // fall back to an estimate from the feet when the actor hasn't been
      // drawn yet (e.g. before the first composite).
      const head = speaker?.drawBounds
        ? speaker.drawBounds.top
        : (speaker?.y ?? Math.floor(roomHeight / 2)) - 40;
      dy = head - 2 - blockH;
    } else {
      // Default fallback — bottom-centre of the camera viewport, block
      // bottom a few px above the frame edge (grows upward).
      dx = cameraLeft + VIEWPORT_HALF;
      dy = roomHeight - blockH - 2;
    }
    // Keep the (centred) bubble on screen: clamp the centre so the
    // widest line stays inside the viewport, and the top below screen.top.
    if (d.center) {
      const maxW = measureText(charset.payload, charset.header, text).width;
      const halfW = Math.floor(maxW / 2) + 2;
      const lo = cameraLeft + halfW;
      const hi = cameraLeft + VIEWPORT_W - halfW;
      if (lo <= hi) dx = Math.max(lo, Math.min(hi, dx));
    }
    dy = Math.max(vm.screen.top, dy);
    drawText(ctx, charset, text, dx, dy, palette, d.color, d.center);
  };

  // ─── image verbs (inventory slots) ───
  // Verbs can show an object sprite instead of text (verbOps setImage /
  // setImageInRoom) — MI1's inventory slots draw the frame objects from
  // the UI room (99). Resolving an object's image means loading the
  // room it lives in (which may NOT be the current room), so we cache
  // LoadedRoom by id (room data is immutable). `vm.resolveRoom` is the
  // same loader the `loadRoom` opcode uses.
  const roomCache = new Map<number, ReturnType<NonNullable<Vm['resolveRoom']>> | null>();
  const resolveRoomCached = (roomId: number): ReturnType<NonNullable<Vm['resolveRoom']>> | null => {
    if (!roomCache.has(roomId)) {
      let r: ReturnType<NonNullable<Vm['resolveRoom']>> | null = null;
      try {
        r = vm.resolveRoom ? vm.resolveRoom(roomId) : null;
      } catch {
        r = null;
      }
      roomCache.set(roomId, r);
    }
    return roomCache.get(roomId) ?? null;
  };

  // Scratch canvas for per-image alpha-blended compositing.
  const imgCanvas = document.createElement('canvas');
  const imgCtx = imgCanvas.getContext('2d');

  /** Resolve an image verb's bound object (cross-room, cached). */
  const imageVerbObject = (image: { obj: number; room: number }) =>
    resolveRoomCached(image.room)?.objects.get(image.obj) ?? null;

  /**
   * The inventory item shown in an inventory-slot verb (200..207), or
   * null for non-slot / empty slots. Maps the slot's grid position to
   * the owner's `findInventory` index (no scroll offset yet).
   */
  const inventoryItemForVerb = (verbId: number): number | null => {
    if (verbId < INVENTORY_VERB_FIRST || verbId > INVENTORY_VERB_LAST) return null;
    const ego = vm.vars.readGlobal(VAR_EGO) || 1;
    const obj = vm.findInventory(ego, verbId - INVENTORY_VERB_FIRST + 1);
    return obj || null;
  };

  /**
   * Composite an image verb's object sprite into the verb bar at
   * (destX, destY). Colours resolve through the *current* room's
   * palette (SCUMM draws verb images with the active palette);
   * transparency uses the sprite's own room's TRNS index. No-op if the
   * room/object/image can't be resolved (stale or absent).
   */
  const drawVerbImage = (
    image: { obj: number; room: number },
    destX: number,
    destY: number,
  ): void => {
    if (!vbctx || !imgCtx) return;
    const srcRoom = resolveRoomCached(image.room);
    const obj = srcRoom?.objects.get(image.obj);
    if (!srcRoom || !obj) return;
    // Prefer the object's current state image; fall back to its first.
    const state = vm.objectStates.get(obj.objId) ?? obj.images.keys().next().value;
    const img = state !== undefined ? obj.images.get(state) : undefined;
    const w = obj.imhd.width;
    const h = obj.imhd.height;
    if (!img || w <= 0 || h <= 0 || img.indexed.length !== w * h) return;
    const pal = vm.loadedRoom?.palette ?? palette;
    const trns = srcRoom.transparentIndex;
    imgCanvas.width = w;
    imgCanvas.height = h;
    const id = imgCtx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const idx = img.indexed[i]!;
      const o = i * 4;
      if (trns !== null && idx === trns) {
        id.data[o + 3] = 0;
        continue;
      }
      id.data[o] = pal[idx * 3] ?? 0;
      id.data[o + 1] = pal[idx * 3 + 1] ?? 0;
      id.data[o + 2] = pal[idx * 3 + 2] ?? 0;
      id.data[o + 3] = 255;
    }
    imgCtx.putImageData(id, 0, 0);
    vbctx.drawImage(imgCanvas, destX, destY);
  };

  const paintVerbBar = (): void => {
    if (!vbctx) return;
    const charset = activeCharset();
    vbctx.clearRect(0, 0, VIEWPORT_W, VERB_BAR_HEIGHT);

    // Background: CLUT colour 0 (black in MI1). NB: do NOT use the
    // room's transparent index here — that's a transparency *key*, not a
    // background colour (room 33's is idx 5 = magenta), and filling with
    // it painted the bar's uncovered strip purple.
    vbctx.fillStyle = clutCss(palette, 0);
    vbctx.fillRect(0, 0, VIEWPORT_W, VERB_BAR_HEIGHT);

    if (!charset) {
      vbctx.fillStyle = '#888';
      vbctx.font = '8px monospace';
      vbctx.fillText('(no charset loaded)', 4, 12);
      drawVerbsFallback(vbctx, vm);
      return;
    }

    for (const v of vm.verbs.values()) {
      if (v.state === 'deleted' || v.state === 'off') continue;
      const x = v.x;
      const y = v.y - VERB_BAR_START_Y;
      if (y < 0 || y >= VERB_BAR_HEIGHT) continue;
      // Image verbs (inventory slots) draw an object sprite; text verbs
      // draw their name. A verb is one or the other.
      if (v.image) {
        drawVerbImage(v.image, x, y);
        continue;
      }
      // Verb #100 is MI1's sentence line — a real verb in the top black
      // band of the panel (at 160,145, charset 2 = the smaller dialogue
      // font, hence "Vai" reads smaller than the verbs). The engine builds
      // its text from the active verb+object; we synthesise the same here
      // and draw it in #100's own slot, so it sits where the original does.
      const text =
        v.id === VERB_SENTENCE
          ? sentenceText(vm, hoveredInvItem ?? hoveredObject, hoveredVerb)
          : v.name;
      if (!text) continue;
      // Each verb renders in the charset it was defined under (MI1's verb
      // panel uses charset 6, a tall serif font — not the dialogue font).
      const vCharset = charsetById(v.charset) ?? charset;
      const ink = pickInk(v, v.id === hoveredVerb, v.id === armedVerb(vm));
      drawText(vbctx, vCharset, text, x, y, palette, ink, v.centered);
    }
  };

  const drawAll = (): void => {
    drawCursor();
    // The sentence line lives in the verb-bar canvas (verb #100), so a
    // hover change that alters the sentence repaints the bar too.
    paintVerbBar();
  };

  const recomputeHover = (): void => {
    const room = vm.loadedRoom;
    if (!room) {
      hoveredObject = null;
      return;
    }
    // Actors paint on top of room objects, so an actor under the cursor
    // wins the hover (enables Talk-to). Its id feeds the scene-click /
    // sentence the same way an object id does — SCUMM sentences carry
    // actor ids as objectA. Falls back to object hit-testing.
    const actorHit = vm.actorFromPos(vm.mouseRoomX, vm.mouseRoomY);
    hoveredObject =
      actorHit !== 0
        ? actorHit
        : pickObject({
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
    // Prefer an interactive ('on') hit over a 'dim' one. MI1's verb
    // panel background is itself a (dim) image verb (verb 1, obj 1030,
    // 144×48) that covers the whole command-verb region — without this
    // preference it would shadow every command verb and swallow clicks.
    let dimHit: VerbSlot | null = null;
    for (const v of vm.verbs.values()) {
      if (v.state !== 'on' && v.state !== 'dim') continue;
      const y = v.y - VERB_BAR_START_Y;
      let hit = false;
      if (v.image) {
        // Image verbs (inventory slots / arrows / panel bg): bbox is the
        // sprite's own dimensions starting at (x, y). No charset needed.
        const obj = imageVerbObject(v.image);
        if (!obj) continue;
        hit =
          canvasX >= v.x &&
          canvasX < v.x + obj.imhd.width &&
          canvasY >= y &&
          canvasY < y + obj.imhd.height;
      } else {
        // Text verbs: bbox is the measured name width × fontHeight.
        // centred verbs shift left by half the measured width.
        if (!charset || !v.name) continue;
        const measured = measureName(charset, v.name);
        const x = v.centered ? v.x - Math.floor(measured.width / 2) : v.x;
        hit =
          canvasX >= x &&
          canvasX < x + measured.width &&
          canvasY >= y &&
          canvasY < y + measured.height;
      }
      if (!hit) continue;
      if (v.state === 'on') return v; // interactive wins immediately
      dimHit ??= v; // remember the first dim match as a fallback
    }
    return dimHit;
  };

  const localToCanvas = (ev: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = verbBar.getBoundingClientRect();
    const sx = rect.width > 0 ? rect.width / VIEWPORT_W : 1;
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
    const newInv = v ? inventoryItemForVerb(v.id) : null;
    if (newHover !== hoveredVerb || newInv !== hoveredInvItem) {
      hoveredVerb = newHover;
      hoveredInvItem = newInv;
      paintVerbBar();
    }
  });
  verbBar.addEventListener('pointerleave', () => {
    if (hoveredVerb !== null || hoveredInvItem !== null) {
      hoveredVerb = null;
      hoveredInvItem = null;
      paintVerbBar();
    }
  });
  verbBar.addEventListener('pointerdown', (ev) => {
    // Same user-input gate as the scene: a cutscene (userput off) must
    // not let verb-bar clicks arm verbs / fire the input script.
    if (vm.cursor.userput <= 0) return;
    const { x, y } = localToCanvas(ev);
    const v = verbAt(x, y);
    if (!v || v.state !== 'on') return;
    // Every verb-bar slot — command verb OR inventory item (verbs
    // 200..207) — is a verb click in checkExecVerbs terms: fire the
    // verb-input script with the slot's verb id. #4 arms it / reads the
    // inventory mapping itself.
    vm.handleVerbClick(v.id, ev.button === 2 ? 2 : 1);
    paintVerbBar();
    args.onCommit();
  });

  // ─── room-click handler (wired from the inspector's pointerdown).
  //     Routes the click into the engine's scene-click handler, which
  //     fires MI1's verb-input script (VAR_VERB_SCRIPT = #4 in room 33).
  //     That script does the faithful work for BOTH cases: with a verb
  //     armed + an object hit it builds the sentence (#2 walks-to/faces/
  //     acts), and on a bare floor click it walks ego to the clicked
  //     point itself — it reads the mouse-coord vars the input layer
  //     wrote. Confirmed in scratch/inspect-walk-click.ts: ego walks to
  //     the click with no engine-side walkActorTo shortcut. Returns the
  //     hit-tested object id so the inspector can still log the click.
  const onRoomClick = (button: 'left' | 'right'): { objId: number | null } => {
    recomputeHover();
    // The engine only accepts scene input while user-input is enabled
    // (VAR_USERPUT / vm.cursor.userput). Cutscenes turn it off via #18's
    // `userputSoftOff`, so this gate stops a floor click from walking
    // ego — or an object click from firing a verb — mid-cutscene. We
    // still return the hover so the inspector can log the click.
    if (vm.cursor.userput <= 0) return { objId: hoveredObject };
    const btn = button === 'left' ? 1 : 2;
    vm.handleSceneClick(btn);
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
  };

  return {
    cursorOverlay,
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
  charset: ActiveCharset,
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
 * the room CLUT.
 *
 * Colour model: glyph value 1 is the **fill** → painted in `inkColor`
 * (the text / actor-talk colour). In MI1's 2-bpp fonts the higher glyph
 * values form the **outline**, which SCUMM draws as a black shadow — the
 * charset's *embedded* `colorMap[2..3]` holds editor-time placeholder
 * colours (teal / red), NOT render colours, so we must not use them or
 * the outline comes out teal. Force the outline levels to CLUT 0.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  charset: ActiveCharset,
  text: string,
  x: number,
  y: number,
  palette: Uint8Array,
  inkColor: number,
  centered: boolean,
): void {
  const colorMap = new Uint8Array(charset.header.colorMap);
  colorMap[1] = inkColor; // fill = text colour
  if (charset.header.bpp === 2) {
    colorMap[2] = 0; // outline / shadow = black
    colorMap[3] = 0;
  }
  // Render each line separately so a centred multi-line block centres
  // every line on `x` independently (a single whole-block render would
  // left-align the lines within the widest line's bbox). Lines advance
  // by the declared fontHeight.
  let lineY = y;
  for (const line of text.split('\n')) {
    if (line.length > 0) {
      let r;
      try {
        r = renderText(charset.payload, charset.header, line, colorMap);
      } catch {
        return;
      }
      if (r.width > 0 && r.height > 0) {
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
        ctx.putImageData(img, startX, lineY);
      }
    }
    lineY += charset.header.fontHeight;
  }
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
  const previewVerbId = hoveredVerb ?? armedVerb(vm);
  const previewVerb =
    previewVerbId !== null ? vm.verbs.get(previewVerbId) : null;
  // Idle default = the game's walk-to verb name ("Vai" in the Italian
  // build), read from verb #11 — not a hardcoded English string.
  const verbName =
    previewVerb?.name || vm.verbs.get(VERB_WALK_TO)?.name || 'Walk to';
  const objName =
    hoveredObject !== null
      ? vm.objectName(hoveredObject) ?? `obj #${hoveredObject}`
      : '';
  return objName ? `${verbName} ${objName}` : verbName;
}
