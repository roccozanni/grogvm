/**
 * The play area — the game UI painted on top of the room: the cursor
 * crosshair, dialog/system text, the verb + inventory panel with its hover
 * highlight, the sentence line, and the walk-box / hit-area debug overlays.
 *
 * # Architecture
 *
 * The room slice and the verb panel share ONE canvas (ARCHITECTURE §7): rows
 * `0..roomHeight-1` are the room camera window (blitted by the caller from the
 * engine compositor), rows `roomHeight..` are the verb panel. {@link
 * mountPlayArea} is handed that canvas's 2D context and paints every layer
 * onto it, in order, after the caller has cleared the surface and blitted the
 * room. A single {@link mountScreenInput} feeds it pointer moves / clicks in
 * unified screen coordinates, so the cursor crosshair glides continuously from
 * the room into the inventory with no seam.
 *
 * The crosshair / dialog / verb-panel visuals are a minimal first pass —
 * getting the click+verb+object flow right matters more than pixel-fidelity to
 * the original. Custom-cursor-image decoding (the charset-glyph-as-cursor
 * convention from `setCursorImage`) is a polish item for later; moving the
 * verb-panel rendering into the engine compositor (the fully faithful
 * end-state) is the deferred Phase B in PROGRESS.md.
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
import type { ScreenPoint } from './input';

/**
 * MI1 verb area starts at screen y = 144 (rooms are 200 tall total,
 * verb area = 56 lines). Verb x/y from scripts are screen-space —
 * subtract this to get verb-panel-local y.
 *
 * v5 games other than MI1 may use different layouts; revisit when MI2
 * boot exercises the verb bar.
 */
const VERB_BAR_START_Y = 144;
/** Height of the verb panel in native pixels (the bottom strip of the screen). */
const VERB_BAR_HEIGHT = 56;
/**
 * The SCUMM v5 virtual screen height. Fixed at 200 regardless of room height:
 * a 144-tall gameplay room leaves the bottom 56 rows for the verb panel; a
 * 200-tall cutscene room fills the whole screen with no panel below it. (The
 * canvas only grows past this for the pathological case of a room taller than
 * the screen — see play.ts.)
 */
export const SCREEN_HEIGHT = VERB_BAR_START_Y + VERB_BAR_HEIGHT;

/**
 * On-screen viewport width. The room canvas is drawn at the full room
 * width (a debug view — rooms can be 640+ wide and scroll), but the
 * verb bar and sentence line are fixed *screen* UI: MI1 lays verbs out
 * in screen-space coords (0..319, via `verbOps setXY`), and the player
 * only ever sees a 320-wide slice. So those strips are sized to this,
 * NOT to the room width.
 */
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
const DEFAULT_VERB_DIM_COLOR = 8; // dark grey

/** Verb-panel background fill (CLUT index). Black for now: a flat magenta fill
 *  (CLUT 2) wrongly painted the sentence-line band magenta too. The real MI1
 *  panel has a dark sentence band with the verbs showing magenta behind them —
 *  needs the per-region layout worked out, not a single fill. */
const VERB_BAR_BG_COLOR = 0;

/** Cursor crosshair colour (CLUT index). */
const CURSOR_COLOR_NORMAL = 15; // bright white

/**
 * MI1 game global holding the active (armed) verb, set by the verb-input
 * script #4. `11` (Vai/Walk-to) is the resting default — treated here as
 * "nothing armed". Used for the verb-bar highlight + sentence preview;
 * the engine no longer tracks an armed verb itself.
 */
const G_ACTIVE_VERB = 107;
const VERB_WALK_TO = 11;
// MI1's hover poller #23 reads the screen-space cursor VARs (44/45) to hit-test
// the bottom panel: over the inventory (g45 ≥ 152, g44 ≥ 160) it arms the item's
// default verb (g107 ← Look at, saving the prior verb in g394 to restore on
// hover-out) and sets the object-under-cursor (g108). The unified input layer
// writes the true screen position to 44/45 on every move — including the verb
// band — so #23 sees the inventory exactly as on the original single screen,
// with no shell-side coordinate feed.
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
}

export interface PlayAreaArgs {
  readonly resourceFile: ResourceFile;
  readonly vm: Vm;
  /**
   * The shared screen 2D context. Every layer is painted onto this; the caller
   * clears it and blits the room slice before calling {@link
   * PlayAreaHandles.redraw}.
   */
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
  /** Initial debug-overlay flags (default both off). */
  readonly debug?: DebugOverlayFlags;
  /**
   * Called when the user clicks a verb or selects an object — lets the caller
   * react (e.g. log / repaint) after the engine has handled the click.
   */
  readonly onCommit: () => void;
}

export interface PlayAreaHandles {
  /**
   * Call from {@link mountScreenInput}'s `onMove` — records the cursor
   * position and recomputes hover. The actual repaint is the caller's
   * `refresh()` (clear + blit room + {@link PlayAreaHandles.redraw}).
   */
  readonly onPointerMove: (p: ScreenPoint) => void;
  /**
   * Call from `onLeftClick` / `onRightClick`. Routes the click to the verb
   * panel or the room depending on the band, and returns the object id under a
   * room click (or null) so the caller can log it.
   */
  readonly onScreenClick: (p: ScreenPoint, button: 'left' | 'right') => { objId: number | null };
  /**
   * Paint every layer (verb panel, debug overlay, dialog, crosshair) onto the
   * shared context, in order. The caller clears the surface and blits the room
   * slice first; this draws on top.
   */
  readonly redraw: () => void;
  /** Update which debug overlays are drawn. */
  readonly setDebugFlags: (flags: DebugOverlayFlags) => void;
}

/**
 * Build the Phase 7 play-area DOM + cursor logic. The caller decides
 * where to mount the returned canvases / elements.
 */
export function mountPlayArea(args: PlayAreaArgs): PlayAreaHandles {
  const { vm, roomWidth, roomHeight, palette } = args;
  // `roomWidth` here is the VIEWPORT width (the overlay is a fixed camera
  // window — see ARCHITECTURE §5.4 / the viewport module). The real room may
  // be wider; the overlay draws camera-relative via this offset, matching the
  // slice the session presents into the frame canvas underneath.
  const cameraLeftPx = (): number =>
    viewportLeft(vm.camera.x, vm.loadedRoom?.width ?? roomWidth, roomWidth);
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

  // The shared screen context. The room slice fills rows 0..roomHeight-1 (blitted
  // by the caller); the verb panel fills the strip below it, starting at `verbTop`.
  const ctx = args.ctx;
  const { screenWidth, screenHeight } = args;
  const verbTop = roomHeight;
  const verbBarHeight = screenHeight - roomHeight;
  let debugFlags: DebugOverlayFlags = args.debug ?? { walk: false, hit: false };

  /** Last pointer position (unified screen coords); null until the first move. */
  let cursor: ScreenPoint | null = null;
  /** Most recently computed hovered object id (or null). */
  let hoveredObject: number | null = null;
  /** Most recently computed hovered verb id (or null). */
  let hoveredVerb: number | null = null;
  /** Inventory item under the cursor when hovering an inventory slot (or null). */
  let hoveredInvItem: number | null = null;

  /**
   * Run `paint` with the context clipped to the room region and translated by
   * the camera's left edge — so room-space geometry (dialog, walk boxes) maps
   * to the on-screen slice and never bleeds into the verb panel below.
   */
  const inRoomSpace = (paint: (c: CanvasRenderingContext2D) => void): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, screenWidth, roomHeight);
    ctx.clip();
    ctx.translate(-cameraLeftPx(), 0);
    paint(ctx);
    ctx.restore();
  };

  // The crosshair is drawn in SCREEN space (not room space), so it glides
  // continuously across the room and the verb panel as one surface. Drawn last,
  // on top of everything. Skipped until the first pointer move.
  const drawCrosshair = (): void => {
    if (!cursor) return;
    const cx = cursor.x;
    const cy = cursor.y;
    ctx.fillStyle = clutCss(palette, CURSOR_COLOR_NORMAL);
    // 7×1 horizontal + 1×7 vertical centred at (cx, cy).
    ctx.fillRect(cx - 3, cy, 7, 1);
    ctx.fillRect(cx, cy - 3, 1, 7);
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
    // The context is translated by `-cameraLeft` (see inRoomSpace), so we
    // compute positions in ROOM coordinates here. SCUMM print `at(x, y)`
    // is in SCREEN coords, so add `cameraLeft` to get room space; actor-
    // overhead positions are already room-space. Uses the SAME clamped
    // `cameraLeft` as the frame slice so text and pixels line up.
    const VIEWPORT_HALF = VIEWPORT_W / 2;
    const cameraLeft = cameraLeftPx();
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
    // Keep the bubble on screen, matching SCUMM (talk text never runs off the
    // edge). `dx` is the centre when `d.center`, else the left edge.
    const maxW = measureText(charset.payload, charset.header, text).width;
    if (d.center) {
      const halfW = Math.floor(maxW / 2) + 2;
      const lo = cameraLeft + halfW;
      const hi = cameraLeft + VIEWPORT_W - halfW;
      if (lo <= hi) dx = Math.max(lo, Math.min(hi, dx));
    } else {
      // Left-aligned: clamp so a script-positioned line (`print at x,y`) can't
      // overflow the right margin — e.g. room 51's `print a=3 at 240,64
      // "--penseremo noi al resto."`, which otherwise ran off the right edge.
      const lo = cameraLeft;
      const hi = cameraLeft + VIEWPORT_W - maxW;
      dx = hi >= lo ? Math.max(lo, Math.min(hi, dx)) : lo;
    }
    dy = Math.max(vm.screen.top, dy);
    // Actor-talk ink is read LIVE from the speaker's current talkColor (SCUMM
    // reads it every frame the line is up) — so a colour set by a helper
    // script that ran *after* the print still tints the line. This is what
    // makes the SCUMM-Bar pirates reliably yellow: script 220 prints the line
    // before its `startScript 221` helper runs `actorOps a=3 talkColor=14`.
    // System text / explicit SO_COLOR lines keep their print-time snapshot.
    const ink =
      d.colorFromActor && d.actorId >= 1 && d.actorId <= vm.actors.capacity
        ? vm.actors.get(d.actorId).talkColor
        : d.color;
    drawText(ctx, charset, text, dx, dy, palette, ink, d.center);
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
    if (!imgCtx) return;
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
    ctx.drawImage(imgCanvas, destX, destY);
  };

  const paintVerbBar = (): void => {
    const charset = activeCharset();

    // Panel background fill (the bottom strip below the room). See
    // VERB_BAR_BG_COLOR — flat black for now; the correct MI1 look (dark
    // sentence band + magenta behind the verbs) needs the per-region layout,
    // not a single rect fill.
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
      // A verb that's currently saved/archived (saveRestoreVerbs) is not drawn
      // — SCUMM hides verbs with a non-zero saveid until they're restored.
      // During a conversation the action verbs AND the sentence line (#100)
      // are archived this way, leaving only the dialog replies; without this
      // the sentence line draws across the first reply (overlap).
      if (vm.savedVerbStates.has(v.id)) continue;
      const x = v.x;
      // Verb y is screen-space (144+); map it into the panel strip on the
      // shared canvas (which starts at `verbTop`).
      const local = v.y - VERB_BAR_START_Y;
      if (local < 0 || local >= verbBarHeight) continue;
      const y = verbTop + local;
      // Image verbs (inventory slots) draw an object sprite; text verbs
      // draw their name. A verb is one or the other.
      if (v.image) {
        drawVerbImage(v.image, x, y);
        continue;
      }
      // Verb #100 is MI1's sentence line — a real verb in the top black
      // band of the panel (at 160,145, the smaller dialogue font, hence
      // "Vai" reads smaller than the verbs). The engine rebuilds its name
      // every frame from the verb-input/hover scripts via #100's `0xFF NN`
      // substitution codes (active verb g107, object A g108, preposition
      // g110, object B g109), so it carries the full two-object "Usa X con
      // Y" form. We render it like any other text verb — one faithful
      // source of truth, no shell-side synthesis. (The mouse coords the
      // room canvas / verb bar feed #23 each frame are what keep it current.)
      const text = v.name;
      if (!text) continue;
      // Each verb renders in the charset it was defined under (MI1's verb
      // panel uses charset 6, a tall serif font — not the dialogue font).
      const vCharset = charsetById(v.charset) ?? charset;
      const ink = pickInk(v, v.id === hoveredVerb, v.id === armedVerb(vm));
      // MI1's charsetColor map ([0,6,2]) gives glyph value 2 (the shadow) its
      // dark-magenta CLUT index — use it for the verb panel's coloured shadow.
      const shadow = vm.charsetColorMap[2];
      drawText(ctx, vCharset, text, x, y, palette, ink, v.centered, shadow);
    }
  };

  // Debug overlay colours: one per walk box (cycled), a single hue for hit
  // areas, and the warm pair the original used for actor paths / positions.
  const WALK_BOX_COLORS = ['#3ec1c1', '#c1973e', '#a13ec1', '#3e5dc1', '#c13e6a', '#7ec13e'];
  const HIT_AREA_COLOR = '#ff66cc';

  const labelAt = (ctx: CanvasRenderingContext2D, id: number, x: number, y: number, color: string): void => {
    const txt = String(id);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x, y, txt.length * 5 + 2, 8);
    ctx.fillStyle = color;
    ctx.fillText(txt, x + 1, y + 1);
  };

  const drawDebugOverlay = (): void => {
    const room = vm.loadedRoom;
    if (!room || (!debugFlags.walk && !debugFlags.hit)) return;

    // Geometry below is in ROOM coords; inRoomSpace clips to the room region
    // and translates by the camera's left edge to map it onto the slice.
    inRoomSpace((c) => {
      c.lineWidth = 1;
      c.font = '7px monospace';
      c.textBaseline = 'top';

      if (debugFlags.hit) {
        for (const obj of room.objects.values()) {
          // Only what's interactable right now: skip the static untouchable flag
          // and the runtime Untouchable class (class 32) — the same gates the
          // engine's findObject / pickObject use, so the overlay shows real
          // targets, not every box defined in the room.
          if (obj.cdhd.flags & 0x80) continue;
          if ((vm.objectClasses.get(obj.objId) ?? 0) & (1 << 31)) continue;
          const w = obj.cdhd.width * 8;
          const h = obj.cdhd.height * 8;
          if (w <= 0 || h <= 0) continue;
          // SO_AT-repositioned objects (room 58's forest tiles) draw away from
          // their design x; track the hotspot to where the object actually is.
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
        // Active actor walk paths (waypoint polyline, or a dashed straight-line
        // fallback when no path was planned) + a marker on the actor.
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
    // Paint order on the shared surface (room already blitted by the caller):
    // verb panel (its own strip), then debug overlay + dialog in the room
    // region, then the crosshair on top of everything.
    paintVerbBar();
    drawDebugOverlay();
    inRoomSpace(drawDialog);
    drawCrosshair();
  };
  // ─── verb hit-test (screen coords) ───
  const verbAt = (sx: number, sy: number): VerbSlot | null => {
    const charset = activeCharset();
    // Verb y is screen-space (144+); the cursor is screen-space too. Map both
    // into the panel-local space the slot layout uses.
    const localY = sy - verbTop;
    // Prefer an interactive ('on') hit over a 'dim' one. MI1's verb panel
    // background is itself a (dim) image verb (verb 1, obj 1030, 144×48) that
    // covers the whole command-verb region — without this preference it would
    // shadow every command verb and swallow clicks.
    let dimHit: VerbSlot | null = null;
    for (const v of vm.verbs.values()) {
      if (v.state !== 'on' && v.state !== 'dim') continue;
      if (vm.savedVerbStates.has(v.id)) continue; // archived → not hittable
      const y = v.y - VERB_BAR_START_Y;
      let hit = false;
      if (v.image) {
        // Image verbs (inventory slots / arrows / panel bg): bbox is the
        // sprite's own dimensions starting at (x, y). No charset needed.
        const obj = imageVerbObject(v.image);
        if (!obj) continue;
        hit =
          sx >= v.x &&
          sx < v.x + obj.imhd.width &&
          localY >= y &&
          localY < y + obj.imhd.height;
      } else {
        // Text verbs: bbox is the measured name width × fontHeight.
        // centred verbs shift left by half the measured width.
        if (!charset || !v.name) continue;
        const measured = measureName(charset, v.name);
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
    // In the verb band the cursor hovers a verb / inventory slot, never a room
    // object. The mouse VARs (44/45) already carry the true screen position, so
    // the hover poller #23 arms an inventory item itself — no shell-side feed.
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
    // Faithful to SCUMM's findObject precedence: a room OBJECT under the
    // cursor wins. The SCUMM-Bar pirates are *drawn* by actor 3 but their
    // hotspot is object 322 — so object hit-testing must take precedence,
    // or the nameless actor would mask the named object ("obj #3").
    const objHit = pickObject({
      objects: room.objects,
      drawQueue: vm.objectDrawQueue,
      x: vm.mouseRoomX,
      y: vm.mouseRoomY,
      // Untouchable class (32) → not hoverable (e.g. the not-yet-docked
      // ship in room 33). Matches the engine's findObject.
      isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
      getObjectPosition: (id) => vm.objectDrawPositions.get(id),
    });
    if (objHit !== null) {
      hoveredObject = objHit;
      return;
    }
    // No object under the cursor — fall back to an actor (enables Talk-to
    // for actor-only targets). The ego is never a hover target: you can't
    // act on yourself.
    const ego = vm.vars.readGlobal(VAR_EGO) || 1;
    const actorHit = vm.actorFromPos(vm.mouseRoomX, vm.mouseRoomY);
    hoveredObject = actorHit !== 0 && actorHit !== ego ? actorHit : null;
  };

  const onPointerMove = (p: ScreenPoint): void => {
    cursor = p;
    recomputeHover();
  };

  // ─── click routing ───
  // A click in the verb band fires the verb-input script with the slot's verb
  // id (command verb OR inventory item 200..207 — #4 reads the mapping). A
  // click in the room band routes into the engine's scene-click handler, which
  // fires MI1's verb-input script #4: with a verb armed + an object hit it
  // builds the sentence (#2 walks-to/faces/acts), and on a bare floor click it
  // walks ego to the clicked point (it reads the mouse-coord VARs the input
  // layer wrote). Both paths gate on user-input being enabled (vm.cursor.userput),
  // so a cutscene (`userputSoftOff`) can't let a click walk ego or arm a verb.
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

  // Per-tick refresh: recompute hover (the engine may have shifted objects /
  // the drawObject queue) and repaint every layer onto the shared surface
  // (catches verbOps name / state / colour changes since the last paint). The
  // caller clears the surface + blits the room slice before calling this.
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
  // SCUMM drawVerb highlights ONLY when the verb actually carries a hicolor
  // (`mode && vs->hicolor ? hicolor : color`). A verb with hicolor 0 draws in
  // its normal colour even under the cursor — so the sentence line (#100,
  // hicolor 0) must not flash like an interactive button. Falling back to a
  // default hi-colour here made every hicolor-less verb light up on hover.
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
  shadowColor?: number,
): void {
  const colorMap = new Uint8Array(charset.header.colorMap);
  colorMap[1] = inkColor; // fill = text colour
  if (charset.header.bpp === 2) {
    // The 2bpp glyph's value-2/3 pixels are the shadow/outline. Default to
    // black; the verb panel passes MI1's charsetColor shadow (CLUT 2, a dark
    // magenta) so the verbs read with their proper coloured shadow.
    const sh = shadowColor ?? 0;
    colorMap[2] = sh;
    colorMap[3] = sh;
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
        // Composite the glyph, don't blit it. putImageData overwrites the
        // destination rectangle wholesale — its transparent (alpha-0) pixels
        // would erase whatever was painted underneath (e.g. the verb panel's
        // plum box), leaving a black rectangle around the text. Stamp the
        // glyph onto a scratch canvas and drawImage it instead, which honours
        // alpha and composites source-over the existing content.
        const scratch = glyphScratch(r.width, r.height);
        scratch.ctx.clearRect(0, 0, r.width, r.height);
        scratch.ctx.putImageData(img, 0, 0);
        // Draw only the w×h sub-region — the scratch canvas may be larger
        // (reused across calls; it only ever grows).
        ctx.drawImage(scratch.canvas, 0, 0, r.width, r.height, startX, lineY, r.width, r.height);
      }
    }
    lineY += charset.header.fontHeight;
  }
}

/** Lazily-created scratch canvas for compositing a single glyph run (see
 *  drawText). Module-level so it's reused across calls rather than allocated
 *  per glyph. */
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

/**
 * No-CHAR fallback so the verb bar still shows *something* even when
 * the charset lookup fails (broken resource file, etc.). Uses the
 * browser's built-in text — no CLUT tinting, just legibility.
 */
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

