/**
 * Shell layers over the engine's presented frame: the cursor crosshair,
 * debug overlays, and input routing. The visible game image — room band,
 * verb panel, dialog — is composed ENGINE-side (engine/render/screen.ts);
 * nothing here paints game pixels. Script semantics: pages/docs/scumm/input.md.
 */

import { objectHitBox, pickObject } from '../../engine/object/hittest';
import type { Vm } from '../../engine/vm/vm';
import { VAR_EGO } from '../../engine/vm/vars';
import { viewportLeft } from '../../engine/graphics/viewport';
import { actorOcclusionPlanes } from '../../engine/render/compositor';
import { verbAt, type VerbViewInput } from '../../engine/render/screen';
import type { ScreenPoint } from './input';

/** Cursor crosshair colour (CLUT index). */
const CURSOR_COLOR_NORMAL = 15; // bright white

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
  readonly vm: Vm;
  /** Shared screen context; the caller clears + blits the engine frame before `redraw`. */
  readonly ctx: CanvasRenderingContext2D;
  /** Room camera-window width (the room slice; ≤ screenWidth). */
  readonly roomWidth: number;
  /** Room playfield height — the verb panel begins at this canvas row. */
  readonly roomHeight: number;
  /** Full screen canvas native width. */
  readonly screenWidth: number;
  /** Full screen canvas native height (roomHeight + verb panel height). */
  readonly screenHeight: number;
  /** CLUT palette of the current room — used to tint the cursor. */
  readonly palette: Uint8Array;
  readonly debug?: DebugOverlayFlags;
  /** Called after the engine has handled a verb / scene click. */
  readonly onCommit: () => void;
}

export interface PlayAreaHandles {
  /** Records the cursor position; the repaint is the caller's. */
  readonly onPointerMove: (p: ScreenPoint) => void;
  /** Routes a click to verb panel or room by band; returns the object id under a room click. */
  readonly onScreenClick: (p: ScreenPoint, button: 'left' | 'right') => { objId: number | null };
  /** Paint the shell layers on top; the caller clears + blits the engine frame first. */
  readonly redraw: () => void;
  readonly setDebugFlags: (flags: DebugOverlayFlags) => void;
}

export function mountPlayArea(args: PlayAreaArgs): PlayAreaHandles {
  const { vm, roomWidth, roomHeight, palette } = args;
  // `roomWidth` is the VIEWPORT width (pages/docs/engine/session.md §4); the
  // real room may be wider. Drawing camera-relative via this offset matches
  // the slice the engine presents underneath.
  const cameraLeftPx = (): number =>
    viewportLeft(vm.camera.x, vm.loadedRoom?.width ?? roomWidth, roomWidth);

  const ctx = args.ctx;
  const { screenWidth, screenHeight } = args;
  let debugFlags: DebugOverlayFlags = args.debug ?? { walk: false, hit: false, zplane: false };

  let cursor: ScreenPoint | null = null;

  // The same verb table the engine's frame composer paints from, so a click
  // can never land on a verb the player doesn't see.
  const verbView = (): VerbViewInput => ({
    verbs: [...vm.verbs.values()],
    isVerbArchived: (id) => vm.savedVerbStates.has(id),
    currentCharsetId: vm.currentCharset,
    getCharset: (id) => vm.getCharset(id),
    getRoom: (id) => vm.getRoom(id),
  });

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

  /** Room object (or non-ego actor) under a room-band point — feeds the click log. */
  const roomObjectAt = (roomX: number, roomY: number): number | null => {
    const room = vm.loadedRoom;
    if (!room) return null;
    // findObject precedence: a room OBJECT wins over an actor — the SCUMM-Bar
    // pirates are drawn by an actor but their hotspot is an object, so the
    // nameless actor must not mask it.
    const objHit = pickObject({
      objects: room.objects,
      x: roomX,
      y: roomY,
      // Untouchable class (32) → not hoverable; matches the engine's findObject.
      isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
      getObjectState: (id) => vm.objectStates.get(id),
      getObjectPosition: (id) => vm.objectDrawPositions.get(id),
    });
    if (objHit !== null) return objHit;
    // Fall back to an actor (enables Talk-to on actor-only targets); the ego
    // is never a click target.
    const ego = vm.vars.readGlobal(VAR_EGO) || 1;
    const actorHit = vm.actorFromPos(roomX, roomY);
    return actorHit !== 0 && actorHit !== ego ? actorHit : null;
  };

  const onPointerMove = (p: ScreenPoint): void => {
    cursor = p;
  };

  // ─── click routing ───
  // Verb-band clicks fire the verb-input script with the slot's verb id; room
  // clicks route to the engine's scene-click handler (script #4 — see
  // pages/docs/scumm/input.md). Both gate on vm.cursor.userput, so a cutscene
  // can't let a click walk ego or arm a verb.
  const onScreenClick = (p: ScreenPoint, button: 'left' | 'right'): { objId: number | null } => {
    cursor = p;
    const btn = button === 'right' ? 2 : 1;
    if (p.inVerbBand) {
      if (vm.cursor.userput <= 0) return { objId: null };
      const v = verbAt(verbView(), p.x, p.screenY);
      if (v && v.state === 'on') {
        vm.handleVerbClick(v.id, btn);
        args.onCommit();
      }
      return { objId: null };
    }
    const objId = roomObjectAt(p.roomX, p.roomY);
    if (vm.cursor.userput <= 0) return { objId };
    vm.handleSceneClick(btn);
    args.onCommit();
    return { objId };
  };

  // Per-tick: repaint the shell layers; the caller clears + blits the engine
  // frame (which already carries verbs + dialog) first.
  const redraw = (): void => {
    drawDebugOverlay();
    drawCrosshair();
  };

  return {
    onPointerMove,
    onScreenClick,
    redraw,
    setDebugFlags,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

function clutCss(palette: Uint8Array, idx: number): string {
  const o = idx * 3;
  const r = palette[o] ?? 0;
  const g = palette[o + 1] ?? 0;
  const b = palette[o + 2] ?? 0;
  return `rgb(${r}, ${g}, ${b})`;
}
