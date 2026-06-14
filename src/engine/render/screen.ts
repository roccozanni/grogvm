/**
 * Screen assembly — the layer above {@link composeFrame}: takes the composed
 * (camera-sliced, post-shake) room band and emits the COMPLETE visible
 * screen as one indexed framebuffer: room band, verb/inventory panel, dialog
 * and system text. What the Renderer presents is the whole game image — no
 * layer paints pixels after it. Script semantics: pages/docs/scumm/input.md.
 */

import type { Actor } from '../actor/actor';
import { CHARSET_TRANSPARENT, type LoadedCharset } from '../graphics/charset';
import { measureText, renderText, wrapText } from '../graphics/text';
import { VIEWPORT_W } from '../graphics/viewport';
import type { LoadedRoom } from '../room/loader';
import type { ActiveDialog, VerbSlot } from '../vm/vm';

// MI1's verb area starts at screen y = 144; verb x/y from scripts are
// screen-space. Other v5 layouts may differ.
export const VERB_BAR_START_Y = 144;
export const VERB_BAR_HEIGHT = 56;
/**
 * SCUMM v5 virtual screen height — fixed at 200 regardless of room height
 * (a 200-tall cutscene room fills the screen, no verb panel below).
 */
export const SCREEN_HEIGHT = VERB_BAR_START_Y + VERB_BAR_HEIGHT;

// ~16px margin each side of the 320-wide screen so centred bubbles don't
// kiss the edges.
const TALK_MAX_WIDTH = VIEWPORT_W - 32;

/** Default CLUT colours when a verb's slot doesn't specify one. */
const DEFAULT_VERB_COLOR = 7; // light-grey ink
const DEFAULT_VERB_DIM_COLOR = 8; // dark grey

// Verb-panel background fill (CLUT index). Flat black: a magenta fill (CLUT 2)
// wrongly painted the sentence-line band too — the real MI1 look needs a
// per-region layout, not a single fill.
const VERB_BAR_BG_COLOR = 0;

/**
 * What verb painting AND hit-testing both need — assembled from Vm accessors
 * at each call site (the session per frame; the shell per click).
 */
export interface VerbViewInput {
  // An array, NOT Iterable: composeScreen walks it twice (hover + paint), so
  // a one-shot iterator like `map.values()` would silently drop the verbs.
  readonly verbs: ReadonlyArray<VerbSlot>;
  /** Archived by `saveRestoreVerbs` → neither painted nor hittable. */
  readonly isVerbArchived: (id: number) => boolean;
  /** The dialogue charset (`cursorCommand initCharset`) — fallback for verbs whose own id can't resolve. */
  readonly currentCharsetId: number;
  readonly getCharset: (id: number) => LoadedCharset | null;
  /** Image verbs draw object sprites from rooms other than the loaded one (MI1's UI room 99). */
  readonly getRoom: (roomId: number) => LoadedRoom | null;
}

export interface ComposeScreenInput extends VerbViewInput {
  /** Post-slice, post-shake room pixels (`viewportWidth × roomHeight`). */
  readonly roomBand: Uint8Array;
  readonly viewportWidth: number;
  /** The verb band begins at this screen row; a 200-tall room leaves no band. */
  readonly roomHeight: number;
  /** Output `screenWidth × screenHeight` indexed buffer, mutated in place. */
  readonly framebuffer: Uint8Array;
  readonly screenWidth: number;
  readonly screenHeight: number;
  /** Camera window's left edge in room px — maps room-space dialog onto the band. */
  readonly cameraLeft: number;
  readonly activeDialog: ActiveDialog | null;
  readonly systemTexts: ReadonlyArray<ActiveDialog>;
  /** Actor lookup for overhead anchoring + live talkColor; `null` for out-of-range ids. */
  readonly getActor: (id: number) => Actor | null;
  /** `vm.screen.top` — dialog never renders above the playable screen top. */
  readonly screenTop: number;
  /** `charsetColorMap[2]` carries MI1's dark-magenta verb-shadow CLUT index. */
  readonly charsetColorMap: ArrayLike<number>;
  /** Verb armed by the input script (MI1 global #107); highlights like hover. */
  readonly armedVerbId: number | null;
  /** Mouse in script-screen coords (VAR 44/45) — drives the hover highlight. */
  readonly mouse: { readonly x: number; readonly y: number } | null;
  /** Raw state-map lookup; the first-image fallback for unset states is ours. */
  readonly getObjectState: (objectId: number) => number | undefined;
}

/** Pixel-rect clip for {@link stampText}; max bounds are exclusive. */
interface ClipRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Assemble the full screen frame. Runs after the room compose so actor
 * `drawBounds` (overhead-dialog anchors) reflect this frame's sprites.
 */
export function composeScreen(input: ComposeScreenInput): void {
  const { framebuffer, screenWidth, screenHeight, viewportWidth, roomHeight } = input;
  if (framebuffer.length < screenWidth * screenHeight) {
    throw new Error(
      `composeScreen: framebuffer ${framebuffer.length} < ${screenWidth}×${screenHeight}`,
    );
  }

  // Room band at the top; columns right of a narrow room fill with CLUT 0.
  for (let y = 0; y < roomHeight; y++) {
    framebuffer.set(
      input.roomBand.subarray(y * viewportWidth, (y + 1) * viewportWidth),
      y * screenWidth,
    );
    framebuffer.fill(0, y * screenWidth + viewportWidth, (y + 1) * screenWidth);
  }

  paintVerbBand(input);
  paintDialog(input);
}

// ─── verb band ────────────────────────────────────────────────────────

function paintVerbBand(input: ComposeScreenInput): void {
  const { framebuffer, screenWidth, screenHeight, roomHeight } = input;
  framebuffer.fill(VERB_BAR_BG_COLOR, roomHeight * screenWidth, screenHeight * screenWidth);

  // A hovered dialog/panel row highlights wherever a verb actually sits — the
  // band below a 144-tall room OR, for a full-height (200) close-up, over the
  // room itself (the navigator-head talk, room 86).
  const hovered =
    input.mouse && input.mouse.y >= VERB_BAR_START_Y
      ? verbAt(input, input.mouse.x, input.mouse.y)
      : null;
  const clip: ClipRect = { x0: 0, y0: 0, x1: screenWidth, y1: screenHeight };

  const charset = input.getCharset(input.currentCharsetId);
  for (const v of input.verbs) {
    if (v.state === 'deleted' || v.state === 'off') continue;
    // SCUMM hides verbs archived by saveRestoreVerbs until restored; during
    // a conversation that's the action verbs AND the sentence line (#100) —
    // without this the sentence line draws across the first dialog reply.
    if (input.isVerbArchived(v.id)) continue;
    // Verb rows are screen-space (the 200-tall surface): the panel band below a
    // 144-tall room maps row→row, but a conversation in a FULL-HEIGHT (200)
    // close-up draws its dialog options OVER the room image. Paint any verb at
    // or below the band start, clipped to the surface — not just the strip
    // below the room, which is empty for a full-height room. The shell's input
    // splits band clicks at the same fixed 144, so render and hit-test agree.
    const y = v.y;
    if (y < VERB_BAR_START_Y || y >= screenHeight) continue;
    if (v.image) {
      blitVerbImage(input, v.image, v.x, y);
      continue;
    }
    // The sentence line (#100) is a real verb whose name the scripts rebuild
    // every frame via 0xFF substitution codes (pages/docs/scumm/input.md §6)
    // — render it like any other text verb, no shell-side synthesis.
    if (!v.name) continue;
    // Each verb renders in its OWN charset (MI1's panel uses charset 6, a
    // tall serif font — not the dialogue font).
    const vCharset = input.getCharset(v.charset) ?? charset;
    if (!vCharset) continue;
    const ink = pickInk(v, v.id === hovered?.id, v.id === input.armedVerbId);
    stampText(input, vCharset, v.name, v.x, y, ink, v.centered, input.charsetColorMap[2], clip);
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

/**
 * Blit an image verb's object sprite (verbOps setImage). Indices copy raw —
 * colours resolve through the presented palette — while transparency uses
 * the sprite's own room's TRNS index.
 */
function blitVerbImage(
  input: ComposeScreenInput,
  image: { readonly obj: number; readonly room: number },
  destX: number,
  destY: number,
): void {
  const srcRoom = input.getRoom(image.room);
  const obj = srcRoom?.objects.get(image.obj);
  if (!srcRoom || !obj) return;
  const state = input.getObjectState(obj.objId) ?? obj.images.keys().next().value;
  const img = state !== undefined ? obj.images.get(state) : undefined;
  const w = obj.imhd.width;
  const h = obj.imhd.height;
  if (!img || w <= 0 || h <= 0 || img.indexed.length !== w * h) return;
  const trns = srcRoom.transparentIndex;
  const { framebuffer, screenWidth, screenHeight } = input;
  for (let y = 0; y < h; y++) {
    const py = destY + y;
    if (py < 0 || py >= screenHeight) continue;
    for (let x = 0; x < w; x++) {
      const px = destX + x;
      if (px < 0 || px >= screenWidth) continue;
      const idx = img.indexed[y * w + x]!;
      if (trns !== null && idx === trns) continue;
      framebuffer[py * screenWidth + px] = idx;
    }
  }
}

// ─── verb hit-test (script-screen coords) ─────────────────────────────

/**
 * The verb under script-screen point (`x`, `y`) — the space VAR 44/45 hold,
 * where the band starts at y = {@link VERB_BAR_START_Y} regardless of the
 * room's height. Shared by the hover highlight and the shell's click routing
 * so the two can never disagree.
 *
 * Prefers an interactive ('on') hit over a 'dim' one: MI1's panel background
 * is itself a dim image verb (verb 1, obj 1030) covering the whole
 * command-verb region — it would otherwise swallow every click.
 */
export function verbAt(view: VerbViewInput, x: number, y: number): VerbSlot | null {
  const charset = view.getCharset(view.currentCharsetId);
  let dimHit: VerbSlot | null = null;
  for (const v of view.verbs) {
    if (v.state !== 'on' && v.state !== 'dim') continue;
    if (view.isVerbArchived(v.id)) continue;
    let hit = false;
    if (v.image) {
      const obj = view.getRoom(v.image.room)?.objects.get(v.image.obj);
      if (!obj) continue;
      hit = x >= v.x && x < v.x + obj.imhd.width && y >= v.y && y < v.y + obj.imhd.height;
    } else {
      // Measure in the verb's OWN charset, not the dialogue one: the scroll
      // arrows draw glyphs that exist only in the verb-panel charset, and a
      // zero-width measurement would make the click miss.
      const vCharset = view.getCharset(v.charset) ?? charset;
      if (!vCharset || !v.name) continue;
      const measured = measureName(vCharset, v.name);
      const x0 = v.centered ? v.x - Math.floor(measured.width / 2) : v.x;
      hit = x >= x0 && x < x0 + measured.width && y >= v.y && y < v.y + measured.height;
    }
    if (!hit) continue;
    if (v.state === 'on') return v; // interactive wins immediately
    dimHit ??= v; // remember the first dim match as a fallback
  }
  return dimHit;
}

function measureName(
  charset: LoadedCharset,
  text: string,
): { width: number; height: number } {
  try {
    return measureText(charset.payload, charset.header, text);
  } catch {
    return { width: text.length * 6, height: charset.header.fontHeight };
  }
}

// ─── dialog / system text ─────────────────────────────────────────────

// No charset → render nothing: better to drop a line than halt the engine
// on a missing font.
function paintDialog(input: ComposeScreenInput): void {
  const fallback = input.getCharset(input.currentCharsetId);
  // Each line renders in the charset captured at its print (like verbs do):
  // the recipe close-up prints 8px-pitch parchment lines in charset 1, then
  // restores charset 2 before the frame composes — re-rendering them in the
  // taller dialogue font smears them illegible.
  const paint = (d: ActiveDialog): void => {
    const charset = input.getCharset(d.charset) ?? fallback;
    if (charset) paintDialogText(input, charset, d);
  };
  // Two channels coexist: blasted system text underneath (can stack several
  // lines), transient actor speech on top — a sign stays visible while
  // Guybrush talks.
  for (const line of input.systemTexts) paint(line);
  if (input.activeDialog) paint(input.activeDialog);
}

function paintDialogText(
  input: ComposeScreenInput,
  charset: LoadedCharset,
  d: ActiveDialog,
): void {
  // Positions below are ROOM coords, stamped at `dx - cameraLeft`. SCUMM
  // print `at(x, y)` is SCREEN coords — add `cameraLeft`; actor-overhead
  // positions are already room-space.
  const VIEWPORT_HALF = VIEWPORT_W / 2;
  const { cameraLeft, roomHeight } = input;
  // SCUMM v5 word-wraps talk text at spaces against the screen margin.
  const text = wrapText(charset.payload, charset.header, d.text, TALK_MAX_WIDTH);
  const fontH = charset.header.fontHeight;
  const blockH = text.split('\n').length * fontH;
  let dx: number;
  let dy: number;
  if (d.x !== null && d.y !== null) {
    dx = d.x + cameraLeft;
    dy = d.y;
  } else if (d.overhead) {
    const speaker = d.actorId > 0 ? input.getActor(d.actorId) : null;
    dx = speaker?.x ?? Math.floor(input.viewportWidth / 2);
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
  dy = Math.max(input.screenTop, dy);
  // Actor-talk ink is read LIVE from talkColor (SCUMM reads it every frame),
  // so a colour set by a helper script *after* the print still tints the
  // line. System text / explicit SO_COLOR lines keep their snapshot.
  const speaker = d.colorFromActor && d.actorId > 0 ? input.getActor(d.actorId) : null;
  const ink = speaker ? speaker.talkColor : d.color;
  // Dialog never bleeds into the verb panel below (the room-band clip).
  const clip: ClipRect = { x0: 0, y0: 0, x1: input.screenWidth, y1: roomHeight };
  stampText(input, charset, text, dx - cameraLeft, dy, ink, d.center, undefined, clip);
}

// ─── indexed text stamping ────────────────────────────────────────────

/**
 * Render text via the CHAR renderer and stamp the indexed pixels into the
 * framebuffer. Glyph value 1 is the fill (ink); the embedded `colorMap[2..3]`
 * are editor placeholders, not render colours (pages/docs/scumm/char.md §5),
 * so the outline is forced below.
 */
function stampText(
  input: ComposeScreenInput,
  charset: LoadedCharset,
  text: string,
  x: number,
  y: number,
  inkColor: number,
  centered: boolean,
  shadowColor: number | undefined,
  clip: ClipRect,
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
  const { framebuffer, screenWidth } = input;
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
        for (let py = 0; py < r.height; py++) {
          const fy = lineY + py;
          if (fy < clip.y0 || fy >= clip.y1) continue;
          for (let px = 0; px < r.width; px++) {
            const fx = startX + px;
            if (fx < clip.x0 || fx >= clip.x1) continue;
            const v = r.pixels[py * r.width + px]!;
            if (v === CHARSET_TRANSPARENT) continue;
            framebuffer[fy * screenWidth + fx] = v;
          }
        }
      }
    }
    lineY += charset.header.fontHeight;
  }
}
