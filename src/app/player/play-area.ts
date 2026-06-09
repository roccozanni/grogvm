/**
 * Game UI painted over the room blit: cursor, dialog text, verb/inventory
 * panel, and debug overlays. Room slice and verb panel share one canvas
 * (rows 0..roomHeight-1 = room). Script semantics: pages/docs/scumm/input.md.
 */

import {
  CHARSET_TRANSPARENT,
  parseCharHeader,
  walkCharsets,
  type CharsetEntry,
  type CharsetHeader,
} from '../../engine/graphics/charset';
import { measureText, renderText, wrapText } from '../../engine/graphics/text';
import { objectHitBox, pickObject } from '../../engine/object/hittest';
import type { ResourceFile } from '../../engine/resources/tree';
import type { Vm, VerbSlot } from '../../engine/vm/vm';
import { VAR_EGO } from '../../engine/vm/vars';
import { VIEWPORT_W, viewportLeft } from '../../engine/graphics/viewport';
import { actorOcclusionPlanes } from '../../engine/render/compositor';
import type { ScreenPoint } from './input';

// MI1's verb area starts at screen y = 144; verb x/y from scripts are
// screen-space — subtract this for panel-local y. Other v5 layouts may differ.
const VERB_BAR_START_Y = 144;
const VERB_BAR_HEIGHT = 56;
/**
 * SCUMM v5 virtual screen height — fixed at 200 regardless of room height
 * (a 200-tall cutscene room fills the screen, no verb panel below).
 */
export const SCREEN_HEIGHT = VERB_BAR_START_Y + VERB_BAR_HEIGHT;

type ActiveCharset = { header: CharsetHeader; payload: Uint8Array };
// ~16px margin each side of the 320-wide screen so centred bubbles don't
// kiss the edges.
const TALK_MAX_WIDTH = VIEWPORT_W - 32;

// MI1's inventory is verb ids 200..207 (4×2 image-slot grid; 208/209 are the
// scroll arrows); slot 200+i shows the i-th `findInventory` item. No scroll
// offset yet, so slot 200 = item 1.
const INVENTORY_VERB_FIRST = 200;
const INVENTORY_VERB_LAST = 207;

/** Default CLUT colours when a verb's slot doesn't specify one. */
const DEFAULT_VERB_COLOR = 7; // light-grey ink
const DEFAULT_VERB_DIM_COLOR = 8; // dark grey

// Verb-panel background fill (CLUT index). Flat black: a magenta fill (CLUT 2)
// wrongly painted the sentence-line band too — the real MI1 look needs a
// per-region layout, not a single fill.
const VERB_BAR_BG_COLOR = 0;

/** Cursor crosshair colour (CLUT index). */
const CURSOR_COLOR_NORMAL = 15; // bright white

// g107 holds the armed verb (set by verb-input script #4); 11 (Walk-to) is
// the resting default, treated as "nothing armed".
const G_ACTIVE_VERB = 107;
const VERB_WALK_TO = 11;
function armedVerb(vm: Vm): number | null {
  const v = vm.vars.readGlobal(G_ACTIVE_VERB);
  return v > 0 && v !== VERB_WALK_TO ? v : null;
}

/** Debug visualisations drawn over the frame (toggled from the play bar). */
export interface DebugOverlayFlags {
  /** Walk-box outlines + ids, plus any active actor walk paths. */
  readonly walk: boolean;
  /** Object CDHD hit-area rectangles + ids. */
  readonly hit: boolean;
  /** Z-plane occlusion masks (room + drawn-object planes), tinted per plane. */
  readonly zplane: boolean;
}

export interface PlayAreaArgs {
  readonly resourceFile: ResourceFile;
  readonly vm: Vm;
  /** Shared screen context; the caller clears + blits the room slice before `redraw`. */
  readonly ctx: CanvasRenderingContext2D;
  /** Room camera-window width (the room slice; ≤ screenWidth). */
  readonly roomWidth: number;
  /** Room playfield height — the verb panel begins at this canvas row. */
  readonly roomHeight: number;
  /** Full screen canvas native width. */
  readonly screenWidth: number;
  /** Full screen canvas native height (roomHeight + verb panel height). */
  readonly screenHeight: number;
  /** CLUT palette of the current room — used to tint cursor + text. */
  readonly palette: Uint8Array;
  /** TRNS index for the current room, for the verb-bar background. */
  readonly transparentIndex: number | null;
  readonly debug?: DebugOverlayFlags;
  /** Called after the engine has handled a verb / scene click. */
  readonly onCommit: () => void;
}

export interface PlayAreaHandles {
  /** Records the cursor position and recomputes hover; the repaint is the caller's. */
  readonly onPointerMove: (p: ScreenPoint) => void;
  /** Routes a click to verb panel or room by band; returns the object id under a room click. */
  readonly onScreenClick: (p: ScreenPoint, button: 'left' | 'right') => { objId: number | null };
  /** Paint every layer on top; the caller clears + blits the room slice first. */
  readonly redraw: () => void;
  readonly setDebugFlags: (flags: DebugOverlayFlags) => void;
}

export function mountPlayArea(args: PlayAreaArgs): PlayAreaHandles {
  const { vm, roomWidth, roomHeight, palette } = args;
  // `roomWidth` is the VIEWPORT width (pages/docs/engine/session.md §4); the
  // real room may be wider. Drawing camera-relative via this offset matches
  // the slice the session presents underneath.
  const cameraLeftPx = (): number =>
    viewportLeft(vm.camera.x, vm.loadedRoom?.width ?? roomWidth, roomWidth);
  // The active charset changes at runtime (`cursorCommand initCharset`), so
  // resolve live from `vm.currentCharset` — cached per id to avoid re-walking
  // the LECF tree every repaint.
  const charsetCache = new Map<number, ActiveCharset | null>();
  const charsetById = (id: number): ActiveCharset | null => {
    let c = charsetCache.get(id);
    if (c === undefined) {
      // Index-backed resolver first; file-walk order only when it can't
      // resolve (e.g. the built-in null charsets 0/5).
      c = vm.resolveCharset?.(id) ?? loadCharset(args.resourceFile, id);
      charsetCache.set(id, c);
    }
    return c;
  };
  const activeCharset = (): ActiveCharset | null => charsetById(vm.currentCharset);

  const ctx = args.ctx;
  const { screenWidth, screenHeight } = args;
  const verbTop = roomHeight;
  const verbBarHeight = screenHeight - roomHeight;
  let debugFlags: DebugOverlayFlags = args.debug ?? { walk: false, hit: false, zplane: false };

  let cursor: ScreenPoint | null = null;
  let hoveredObject: number | null = null;
  let hoveredVerb: number | null = null;
  let hoveredInvItem: number | null = null;

  // Runs `paint` clipped to the room region and translated by the camera's
  // left edge — room-space geometry maps onto the on-screen slice and never
  // bleeds into the verb panel below.
  const inRoomSpace = (paint: (c: CanvasRenderingContext2D) => void): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, screenWidth, roomHeight);
    ctx.clip();
    ctx.translate(-cameraLeftPx(), 0);
    paint(ctx);
    ctx.restore();
  };

  // Drawn in SCREEN space (not room space) so the crosshair glides seamlessly
  // from the room into the verb panel; painted last, on top of everything.
  const drawCrosshair = (): void => {
    if (!cursor) return;
    const cx = cursor.x;
    const cy = cursor.y;
    ctx.fillStyle = clutCss(palette, CURSOR_COLOR_NORMAL);
    ctx.fillRect(cx - 3, cy, 7, 1);
    ctx.fillRect(cx, cy - 3, 1, 7);
  };

  // No charset → render nothing: better to drop a line than halt the engine
  // on a missing font.
  const drawDialog = (ctx: CanvasRenderingContext2D): void => {
    const charset = activeCharset();
    if (!charset) return;
    // Two channels coexist: blasted system text underneath (can stack several
    // lines), transient actor speech on top — a sign stays visible while
    // Guybrush talks.
    for (const line of vm.systemTexts) paintDialog(ctx, charset, line);
    if (vm.activeDialog) paintDialog(ctx, charset, vm.activeDialog);
  };

  const paintDialog = (
    ctx: CanvasRenderingContext2D,
    charset: ActiveCharset,
    d: NonNullable<typeof vm.activeDialog>,
  ): void => {
    // The context is translated by `-cameraLeft` (inRoomSpace), so positions
    // here are ROOM coords. SCUMM print `at(x, y)` is SCREEN coords — add
    // `cameraLeft`; actor-overhead positions are already room-space.
    const VIEWPORT_HALF = VIEWPORT_W / 2;
    const cameraLeft = cameraLeftPx();
    // SCUMM v5 word-wraps talk text at spaces against the screen margin.
    const text = wrapText(charset.payload, charset.header, d.text, TALK_MAX_WIDTH);
    const fontH = charset.header.fontHeight;
    const lineCount = text.split('\n').length;
    const blockH = lineCount * fontH;
    let dx: number;
    let dy: number;
    if (d.x !== null && d.y !== null) {
      dx = d.x + cameraLeft;
      dy = d.y;
    } else if (d.overhead) {
      const speaker =
        d.actorId > 0 && d.actorId <= vm.actors.capacity
          ? vm.actors.get(d.actorId)
          : null;
      dx = speaker?.x ?? Math.floor(roomWidth / 2);
      // Anchor the block's bottom just above the drawn head so the bubble
      // grows upward. `drawBounds.top` is the compositor-recorded sprite top;
      // estimate from the feet when the actor hasn't been drawn yet.
      const head = speaker?.drawBounds
        ? speaker.drawBounds.top
        : (speaker?.y ?? Math.floor(roomHeight / 2)) - 40;
      dy = head - 2 - blockH;
    } else {
      // v5 fallback: bottom-centre of the camera viewport, growing upward.
      dx = cameraLeft + VIEWPORT_HALF;
      dy = roomHeight - blockH - 2;
    }
    // Talk text never runs off the screen edge in SCUMM; `dx` is the centre
    // when `d.center`, else the left edge.
    const maxW = measureText(charset.payload, charset.header, text).width;
    if (d.center) {
      const halfW = Math.floor(maxW / 2) + 2;
      const lo = cameraLeft + halfW;
      const hi = cameraLeft + VIEWPORT_W - halfW;
      if (lo <= hi) dx = Math.max(lo, Math.min(hi, dx));
    } else {
      // Clamp so a script-positioned `print at x,y` can't overflow the right
      // margin (e.g. room 51's print at 240,64).
      const lo = cameraLeft;
      const hi = cameraLeft + VIEWPORT_W - maxW;
      dx = hi >= lo ? Math.max(lo, Math.min(hi, dx)) : lo;
    }
    dy = Math.max(vm.screen.top, dy);
    // Actor-talk ink is read LIVE from talkColor (SCUMM reads it every frame),
    // so a colour set by a helper script *after* the print still tints the
    // line. System text / explicit SO_COLOR lines keep their snapshot.
    const ink =
      d.colorFromActor && d.actorId >= 1 && d.actorId <= vm.actors.capacity
        ? vm.actors.get(d.actorId).talkColor
        : d.color;
    drawText(ctx, charset, text, dx, dy, palette, ink, d.center);
  };

  // ─── image verbs (inventory slots) ───
  // Image verbs (verbOps setImage) draw object sprites from rooms that may
  // NOT be the loaded room (MI1's UI room 99) — cache LoadedRoom by id
  // (room data is immutable).
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

  const imageVerbObject = (image: { obj: number; room: number }) =>
    resolveRoomCached(image.room)?.objects.get(image.obj) ?? null;

  /** Inventory item shown in an inventory-slot verb, or null for non-slot / empty slots. */
  const inventoryItemForVerb = (verbId: number): number | null => {
    if (verbId < INVENTORY_VERB_FIRST || verbId > INVENTORY_VERB_LAST) return null;
    const ego = vm.vars.readGlobal(VAR_EGO) || 1;
    const obj = vm.findInventory(ego, verbId - INVENTORY_VERB_FIRST + 1);
    return obj || null;
  };

  // Colours resolve through the *current* room's palette (SCUMM draws verb
  // images with the active palette); transparency uses the sprite's own
  // room's TRNS index.
  const drawVerbImage = (
    image: { obj: number; room: number },
    destX: number,
    destY: number,
  ): void => {
    if (!imgCtx) return;
    const srcRoom = resolveRoomCached(image.room);
    const obj = srcRoom?.objects.get(image.obj);
    if (!srcRoom || !obj) return;
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
    ctx.drawImage(imgCanvas, destX, destY);
  };

  const paintVerbBar = (): void => {
    const charset = activeCharset();

    ctx.fillStyle = clutCss(palette, VERB_BAR_BG_COLOR);
    ctx.fillRect(0, verbTop, screenWidth, verbBarHeight);

    if (!charset) {
      ctx.fillStyle = '#888';
      ctx.font = '8px monospace';
      ctx.fillText('(no charset loaded)', 4, verbTop + 12);
      drawVerbsFallback(ctx, vm, verbTop);
      return;
    }

    for (const v of vm.verbs.values()) {
      if (v.state === 'deleted' || v.state === 'off') continue;
      // SCUMM hides verbs archived by saveRestoreVerbs until restored; during
      // a conversation that's the action verbs AND the sentence line (#100) —
      // without this the sentence line draws across the first dialog reply.
      if (vm.savedVerbStates.has(v.id)) continue;
      const x = v.x;
      // Verb y is screen-space (144+); map into the panel strip.
      const local = v.y - VERB_BAR_START_Y;
      if (local < 0 || local >= verbBarHeight) continue;
      const y = verbTop + local;
      if (v.image) {
        drawVerbImage(v.image, x, y);
        continue;
      }
      // The sentence line (#100) is a real verb whose name the scripts rebuild
      // every frame via 0xFF substitution codes (pages/docs/scumm/input.md §6)
      // — render it like any other text verb, no shell-side synthesis.
      const text = v.name;
      if (!text) continue;
      // Each verb renders in its OWN charset (MI1's panel uses charset 6, a
      // tall serif font — not the dialogue font).
      const vCharset = charsetById(v.charset) ?? charset;
      const ink = pickInk(v, v.id === hoveredVerb, v.id === armedVerb(vm));
      // charsetColorMap[2] carries MI1's dark-magenta shadow CLUT index.
      const shadow = vm.charsetColorMap[2];
      drawText(ctx, vCharset, text, x, y, palette, ink, v.centered, shadow);
    }
  };

  const WALK_BOX_COLORS = ['#3ec1c1', '#c1973e', '#a13ec1', '#3e5dc1', '#c13e6a', '#7ec13e'];
  const HIT_AREA_COLOR = '#ff66cc';
  const ZPLANE_COLORS = [
    'rgba(255, 0, 220, 0.45)',
    'rgba(0, 200, 255, 0.45)',
    'rgba(255, 196, 0, 0.45)',
    'rgba(80, 255, 120, 0.45)',
  ];

  const labelAt = (ctx: CanvasRenderingContext2D, id: number, x: number, y: number, color: string): void => {
    const txt = String(id);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x, y, txt.length * 5 + 2, 8);
    ctx.fillStyle = color;
    ctx.fillText(txt, x + 1, y + 1);
  };

  const drawDebugOverlay = (): void => {
    const room = vm.loadedRoom;
    if (!room || (!debugFlags.walk && !debugFlags.hit && !debugFlags.zplane)) return;

    // Geometry below is in ROOM coords — inRoomSpace maps it onto the slice.
    inRoomSpace((c) => {
      c.lineWidth = 1;
      c.font = '7px monospace';
      c.textBaseline = 'top';

      if (debugFlags.zplane) {
        // The SAME merged stack (room + drawn-object planes) the compositor
        // masks actors with, so the overlay shows the true occluders.
        const planes = actorOcclusionPlanes(room, {
          objectDrawQueue: vm.objectDrawQueue,
          getObjectState: (id) => vm.objectStates.get(id) ?? 1,
          getObjectPosition: (id) => vm.objectDrawPositions.get(id),
        });
        const W = room.width;
        planes.forEach((plane, i) => {
          c.fillStyle = ZPLANE_COLORS[i % ZPLANE_COLORS.length]!;
          // Coalesce horizontal runs into one fillRect each — a handful of
          // draws per row instead of one per pixel.
          for (let y = 0; y < plane.height; y++) {
            let runStart = -1;
            for (let x = 0; x <= W; x++) {
              const on = x < W && plane.mask[y * W + x] === 1;
              if (on && runStart < 0) runStart = x;
              else if (!on && runStart >= 0) {
                c.fillRect(runStart, y, x - runStart, 1);
                runStart = -1;
              }
            }
          }
        });
      }

      if (debugFlags.hit) {
        for (const obj of room.objects.values()) {
          // Skip the static untouchable flag and the runtime Untouchable class
          // (32) — the same gates findObject/pickObject use, so the overlay
          // shows real targets only.
          if (obj.cdhd.flags & 0x80) continue;
          if ((vm.objectClasses.get(obj.objId) ?? 0) & (1 << 31)) continue;
          const w = obj.cdhd.width * 8;
          const h = obj.cdhd.height * 8;
          if (w <= 0 || h <= 0) continue;
          // SO_AT-repositioned objects draw away from their design x; track
          // the hotspot to where the object actually is.
          const { left, top } = objectHitBox(obj, vm.objectDrawPositions.get(obj.objId));
          c.strokeStyle = HIT_AREA_COLOR;
          c.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1);
          labelAt(c, obj.objId, left + 2, top + 1, HIT_AREA_COLOR);
        }
      }

      if (debugFlags.walk) {
        for (const box of room.walkBoxes) {
          const color = WALK_BOX_COLORS[box.id % WALK_BOX_COLORS.length]!;
          c.strokeStyle = color;
          c.beginPath();
          c.moveTo(box.ulx + 0.5, box.uly + 0.5);
          c.lineTo(box.urx + 0.5, box.ury + 0.5);
          c.lineTo(box.lrx + 0.5, box.lry + 0.5);
          c.lineTo(box.llx + 0.5, box.lly + 0.5);
          c.closePath();
          c.stroke();
          labelAt(c, box.id, Math.min(box.ulx, box.llx) + 2, Math.min(box.uly, box.ury) + 1, color);
        }
        for (const actor of vm.actors.inRoom(vm.currentRoom)) {
          if (!actor.isMoving) continue;
          c.strokeStyle = '#ffd54a';
          if (actor.walkPath.length > 0) {
            c.beginPath();
            c.moveTo(actor.x + 0.5, actor.y + 0.5);
            for (let i = actor.walkPathIdx; i < actor.walkPath.length; i++) {
              const p = actor.walkPath[i]!;
              c.lineTo(p.x + 0.5, p.y + 0.5);
            }
            c.stroke();
            c.fillStyle = '#ffd54a';
            for (let i = actor.walkPathIdx; i < actor.walkPath.length; i++) {
              const p = actor.walkPath[i]!;
              c.fillRect(p.x - 1, p.y - 1, 3, 3);
            }
          } else if (actor.walkTarget) {
            c.setLineDash([2, 2]);
            c.beginPath();
            c.moveTo(actor.x + 0.5, actor.y + 0.5);
            c.lineTo(actor.walkTarget.x + 0.5, actor.walkTarget.y + 0.5);
            c.stroke();
            c.setLineDash([]);
          }
          c.fillStyle = '#ff6b3a';
          c.fillRect(actor.x - 1, actor.y - 1, 3, 3);
        }
      }
    });
  };

  const setDebugFlags = (flags: DebugOverlayFlags): void => {
    debugFlags = flags;
  };

  const drawAll = (): void => {
    // Paint order (room already blitted): verb panel, then debug overlay +
    // dialog in room space, crosshair last.
    paintVerbBar();
    drawDebugOverlay();
    inRoomSpace(drawDialog);
    drawCrosshair();
  };
  // ─── verb hit-test (screen coords) ───
  const verbAt = (sx: number, sy: number): VerbSlot | null => {
    const charset = activeCharset();
    const localY = sy - verbTop;
    // Prefer an interactive ('on') hit over a 'dim' one: MI1's panel
    // background is itself a dim image verb (verb 1, obj 1030) covering the
    // whole command-verb region — it would otherwise swallow every click.
    let dimHit: VerbSlot | null = null;
    for (const v of vm.verbs.values()) {
      if (v.state !== 'on' && v.state !== 'dim') continue;
      if (vm.savedVerbStates.has(v.id)) continue; // archived → not hittable
      const y = v.y - VERB_BAR_START_Y;
      let hit = false;
      if (v.image) {
        const obj = imageVerbObject(v.image);
        if (!obj) continue;
        hit =
          sx >= v.x &&
          sx < v.x + obj.imhd.width &&
          localY >= y &&
          localY < y + obj.imhd.height;
      } else {
        // Measure in the verb's OWN charset, not the dialogue one: the scroll
        // arrows draw glyphs that exist only in the verb-panel charset, and a
        // zero-width measurement would make the click miss.
        const vCharset = charsetById(v.charset) ?? charset;
        if (!vCharset || !v.name) continue;
        const measured = measureName(vCharset, v.name);
        const x = v.centered ? v.x - Math.floor(measured.width / 2) : v.x;
        hit =
          sx >= x &&
          sx < x + measured.width &&
          localY >= y &&
          localY < y + measured.height;
      }
      if (!hit) continue;
      if (v.state === 'on') return v; // interactive wins immediately
      dimHit ??= v; // remember the first dim match as a fallback
    }
    return dimHit;
  };

  const recomputeHover = (): void => {
    // In the verb band the cursor hovers a verb / inventory slot, never a
    // room object; the hover poller #23 arms inventory items itself from the
    // mouse VARs.
    if (cursor?.inVerbBand) {
      hoveredObject = null;
      const v = verbAt(cursor.x, cursor.y);
      hoveredVerb = v?.id ?? null;
      hoveredInvItem = v ? inventoryItemForVerb(v.id) : null;
      return;
    }
    hoveredVerb = null;
    hoveredInvItem = null;

    const room = vm.loadedRoom;
    if (!room) {
      hoveredObject = null;
      return;
    }
    // findObject precedence: a room OBJECT wins over an actor — the SCUMM-Bar
    // pirates are drawn by an actor but their hotspot is an object, so the
    // nameless actor must not mask it.
    const objHit = pickObject({
      objects: room.objects,
      drawQueue: vm.objectDrawQueue,
      x: vm.mouseRoomX,
      y: vm.mouseRoomY,
      // Untouchable class (32) → not hoverable; matches the engine's findObject.
      isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
      getObjectPosition: (id) => vm.objectDrawPositions.get(id),
    });
    if (objHit !== null) {
      hoveredObject = objHit;
      return;
    }
    // Fall back to an actor (enables Talk-to on actor-only targets); the ego
    // is never a hover target.
    const ego = vm.vars.readGlobal(VAR_EGO) || 1;
    const actorHit = vm.actorFromPos(vm.mouseRoomX, vm.mouseRoomY);
    hoveredObject = actorHit !== 0 && actorHit !== ego ? actorHit : null;
  };

  const onPointerMove = (p: ScreenPoint): void => {
    cursor = p;
    recomputeHover();
  };

  // ─── click routing ───
  // Verb-band clicks fire the verb-input script with the slot's verb id; room
  // clicks route to the engine's scene-click handler (script #4 — see
  // pages/docs/scumm/input.md). Both gate on vm.cursor.userput, so a cutscene
  // can't let a click walk ego or arm a verb.
  const onScreenClick = (p: ScreenPoint, button: 'left' | 'right'): { objId: number | null } => {
    cursor = p;
    recomputeHover();
    const btn = button === 'right' ? 2 : 1;
    if (p.inVerbBand) {
      if (vm.cursor.userput <= 0) return { objId: null };
      const v = verbAt(p.x, p.y);
      if (v && v.state === 'on') {
        vm.handleVerbClick(v.id, btn);
        args.onCommit();
      }
      return { objId: null };
    }
    if (vm.cursor.userput <= 0) return { objId: hoveredObject };
    vm.handleSceneClick(btn);
    args.onCommit();
    return { objId: hoveredObject };
  };

  // Per-tick: recompute hover (the engine may have shifted objects) and
  // repaint every layer; the caller clears + blits the room slice first.
  const redraw = (): void => {
    recomputeHover();
    drawAll();
  };

  return {
    onPointerMove,
    onScreenClick,
    redraw,
    setDebugFlags,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/** File-walk fallback charset lookup; null if the file has no charsets. */
function loadCharset(
  file: ResourceFile,
  id: number,
): { entry: CharsetEntry; header: CharsetHeader; payload: Uint8Array } | null {
  const all = walkCharsets(file);
  if (all.length === 0) return null;
  // CHAR indexes are typically 1-based; out-of-range ids fall back to the first.
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
  // SCUMM highlights ONLY verbs that carry a hicolor: one with hicolor 0
  // draws its normal colour even under the cursor (the sentence line #100
  // must not flash like a button) — so no default hi-colour fallback here.
  if ((hovered || armed) && v.hiColor) return v.hiColor;
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
  // Measure by running a colourless render — cheap at a few verb names per repaint.
  const colorMap = new Uint8Array(charset.header.colorMap);
  try {
    const r = renderText(charset.payload, charset.header, text, colorMap);
    return { width: r.width, height: r.height };
  } catch {
    return { width: text.length * 6, height: charset.header.fontHeight };
  }
}

/**
 * Render text via the CHAR renderer + room CLUT. Glyph value 1 is the fill
 * (ink); the embedded `colorMap[2..3]` are editor placeholders, not render
 * colours (pages/docs/scumm/char.md §5), so the outline is forced below.
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
  shadowColor?: number,
): void {
  const colorMap = new Uint8Array(charset.header.colorMap);
  colorMap[1] = inkColor; // fill = text colour
  if (charset.header.bpp === 2) {
    // Values 2/3 are the shadow/outline: black by default, or the caller's
    // charsetColor shadow (the verb panel's dark magenta).
    const sh = shadowColor ?? 0;
    colorMap[2] = sh;
    colorMap[3] = sh;
  }
  // Render each line separately so a centred multi-line block centres every
  // line on `x` independently (a whole-block render would left-align them).
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
        // putImageData overwrites the destination wholesale — alpha-0 pixels
        // would erase what's underneath. Stamp onto a scratch canvas and
        // drawImage instead, which composites source-over.
        const scratch = glyphScratch(r.width, r.height);
        scratch.ctx.clearRect(0, 0, r.width, r.height);
        scratch.ctx.putImageData(img, 0, 0);
        // Draw only the w×h sub-region — the reused scratch canvas may be larger.
        ctx.drawImage(scratch.canvas, 0, 0, r.width, r.height, startX, lineY, r.width, r.height);
      }
    }
    lineY += charset.header.fontHeight;
  }
}

// Module-level scratch canvas, reused across drawText calls rather than
// allocated per glyph run.
let glyphScratchCanvas: HTMLCanvasElement | null = null;
let glyphScratchCtx: CanvasRenderingContext2D | null = null;
function glyphScratch(
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!glyphScratchCanvas) {
    glyphScratchCanvas = document.createElement('canvas');
    glyphScratchCtx = glyphScratchCanvas.getContext('2d');
  }
  if (glyphScratchCanvas.width < w) glyphScratchCanvas.width = w;
  if (glyphScratchCanvas.height < h) glyphScratchCanvas.height = h;
  return { canvas: glyphScratchCanvas, ctx: glyphScratchCtx! };
}

/** Browser-font fallback so the verb bar shows something when the charset lookup fails. */
function drawVerbsFallback(ctx: CanvasRenderingContext2D, vm: Vm, yOffset: number): void {
  ctx.fillStyle = '#dde';
  ctx.font = '10px monospace';
  let yi = yOffset + 24;
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

