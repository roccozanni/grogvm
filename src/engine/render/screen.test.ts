import { describe, expect, it } from 'vitest';
import type { Actor } from '../actor/actor';
import { parseCharHeader, type LoadedCharset } from '../graphics/charset';
import type { LoadedObject } from '../object/loader';
import type { LoadedRoom } from '../room/loader';
import type { ActiveDialog, VerbSlot } from '../vm/vm';
import {
  composeScreen,
  SCREEN_HEIGHT,
  VERB_BAR_START_Y,
  verbAt,
  type ComposeScreenInput,
} from './screen';

// ─── fixtures ─────────────────────────────────────────────────────────

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

/**
 * 1-bpp charset whose listed glyphs are FULLY FILLED `width × 8` blocks —
 * every glyph pixel is bit-pattern 1 (the ink slot), so assertions reduce to
 * "this rect is the ink colour".
 */
function makeCharset(width: number, chars: string): LoadedCharset {
  const numChars = 128;
  const fontHeight = 8;
  const bitmapBytes = Math.ceil((width * fontHeight) / 8);
  const header: number[] = [];
  header.push(...u32le(0));
  header.push(...u16le(0x0363));
  header.push(0, 0xf, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  header.push(1, fontHeight);
  header.push(...u16le(numChars));
  const tableSize = numChars * 4;
  let cursor = 25 + tableSize;
  const offsets: number[] = [];
  for (let i = 0; i < numChars; i++) {
    if (chars.includes(String.fromCharCode(i))) {
      offsets.push(cursor - 21);
      cursor += 4 + bitmapBytes;
    } else {
      offsets.push(0);
    }
  }
  for (const o of offsets) header.push(...u32le(o));
  const out = [...header];
  for (let i = 0; i < numChars; i++) {
    if (!chars.includes(String.fromCharCode(i))) continue;
    out.push(width, fontHeight, 0, 0);
    for (let b = 0; b < bitmapBytes; b++) out.push(0xff);
  }
  const payload = new Uint8Array(out);
  return { header: parseCharHeader(payload), payload };
}

function makeVerb(over: Partial<VerbSlot> & { id: number }): VerbSlot {
  return {
    name: '',
    color: 0,
    hiColor: 0,
    dimColor: 0,
    backColor: 0,
    x: 0,
    y: VERB_BAR_START_Y,
    key: 0,
    charset: 1,
    centered: false,
    image: null,
    state: 'on',
    ...over,
  };
}

function makeDialog(over: Partial<ActiveDialog>): ActiveDialog {
  return {
    actorId: 0,
    text: 'A',
    x: null,
    y: null,
    color: 15,
    center: false,
    overhead: false,
    clipped: null,
    ...over,
  };
}

const W = 320;
const ROOM_H = VERB_BAR_START_Y;
const ROOM_PIXEL = 5;

function makeInput(over: Partial<ComposeScreenInput> = {}): ComposeScreenInput {
  const charset = makeCharset(4, 'A');
  return {
    roomBand: new Uint8Array(W * ROOM_H).fill(ROOM_PIXEL),
    viewportWidth: W,
    roomHeight: ROOM_H,
    framebuffer: new Uint8Array(W * SCREEN_HEIGHT).fill(0xee),
    screenWidth: W,
    screenHeight: SCREEN_HEIGHT,
    cameraLeft: 0,
    verbs: [],
    isVerbArchived: () => false,
    currentCharsetId: 1,
    getCharset: (id) => (id === 1 ? charset : null),
    getRoom: () => null,
    activeDialog: null,
    systemTexts: [],
    getActor: () => null,
    screenTop: 0,
    charsetColorMap: [],
    armedVerbId: null,
    mouse: null,
    getObjectState: () => undefined,
    ...over,
  };
}

function px(input: ComposeScreenInput, x: number, y: number): number {
  return input.framebuffer[y * input.screenWidth + x]!;
}

/** An image verb's backing room: one object with a 4×2 sprite, TRNS 9. */
function makeImageRoom(): { room: LoadedRoom; indexed: Uint8Array } {
  const indexed = new Uint8Array([1, 9, 2, 9, 3, 9, 4, 9]);
  const obj = {
    objId: 1030,
    imhd: { width: 4, height: 2 },
    images: new Map([[3, { indexed, width: 4, height: 2 }]]),
  } as unknown as LoadedObject;
  const room = {
    id: 99,
    objects: new Map([[1030, obj]]),
    transparentIndex: 9,
  } as unknown as LoadedRoom;
  return { room, indexed };
}

// ─── frame assembly ───────────────────────────────────────────────────

describe('composeScreen frame assembly', () => {
  it('blits the room band at the top and fills the verb band with CLUT 0', () => {
    const input = makeInput();
    composeScreen(input);
    expect(px(input, 0, 0)).toBe(ROOM_PIXEL);
    expect(px(input, W - 1, ROOM_H - 1)).toBe(ROOM_PIXEL);
    expect(px(input, 0, ROOM_H)).toBe(0);
    expect(px(input, W - 1, SCREEN_HEIGHT - 1)).toBe(0);
  });

  it('a 200-tall room fills the screen — no verb band, verbs unpainted', () => {
    const input = makeInput({
      roomBand: new Uint8Array(W * SCREEN_HEIGHT).fill(ROOM_PIXEL),
      roomHeight: SCREEN_HEIGHT,
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12 })],
    });
    composeScreen(input);
    for (let y = 0; y < SCREEN_HEIGHT; y += 7) {
      expect(px(input, 10, y)).toBe(ROOM_PIXEL);
    }
  });

  it('fills columns right of a narrow room band with CLUT 0', () => {
    const input = makeInput({
      viewportWidth: 300,
      roomBand: new Uint8Array(300 * ROOM_H).fill(ROOM_PIXEL),
    });
    composeScreen(input);
    expect(px(input, 299, 10)).toBe(ROOM_PIXEL);
    expect(px(input, 300, 10)).toBe(0);
    expect(px(input, 319, 10)).toBe(0);
  });

  it('throws when the framebuffer is too small for the screen', () => {
    const input = makeInput({ framebuffer: new Uint8Array(10) });
    expect(() => composeScreen(input)).toThrow(/framebuffer/);
  });
});

// ─── verb band ────────────────────────────────────────────────────────

describe('composeScreen verb band', () => {
  it('paints a text verb at its screen position in its slot colour', () => {
    const input = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12 })],
    });
    composeScreen(input);
    // 4×8 filled glyph at (10, 152): band-local row 8.
    expect(px(input, 10, 152)).toBe(12);
    expect(px(input, 13, 159)).toBe(12);
    expect(px(input, 14, 152)).toBe(0);
  });

  it('skips off / deleted / archived verbs', () => {
    const input = makeInput({
      verbs: [
        makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12, state: 'off' }),
        makeVerb({ id: 3, name: 'A', x: 30, y: 152, color: 12, state: 'deleted' }),
        makeVerb({ id: 4, name: 'A', x: 50, y: 152, color: 12 }),
      ],
      isVerbArchived: (id) => id === 4,
    });
    composeScreen(input);
    expect(px(input, 10, 152)).toBe(0);
    expect(px(input, 30, 152)).toBe(0);
    expect(px(input, 50, 152)).toBe(0);
  });

  it('centres each line of a multi-line name independently on x', () => {
    const input = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A\nAAA', x: 20, y: 144, color: 12, centered: true })],
    });
    composeScreen(input);
    // Line 1 (4 wide) → starts at 18; line 2 (12 wide) → starts at 14.
    expect(px(input, 18, 144)).toBe(12);
    expect(px(input, 17, 144)).toBe(0);
    expect(px(input, 14, 152)).toBe(12);
    expect(px(input, 13, 152)).toBe(0);
  });

  it('clips a centred verb at the left edge without wrapping to the previous row', () => {
    const input = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 1, y: 152, color: 12, centered: true })],
    });
    composeScreen(input);
    // startX = -1: column 0..2 painted, nothing wraps to x=319 of the row above.
    expect(px(input, 0, 152)).toBe(12);
    expect(px(input, W - 1, 151)).toBe(0);
  });

  it('uses dimColor (default 8) for dim verbs', () => {
    const input = makeInput({
      verbs: [
        makeVerb({ id: 2, name: 'A', x: 10, y: 152, state: 'dim', dimColor: 3 }),
        makeVerb({ id: 3, name: 'A', x: 30, y: 152, state: 'dim' }),
      ],
    });
    composeScreen(input);
    expect(px(input, 10, 152)).toBe(3);
    expect(px(input, 30, 152)).toBe(8);
  });

  it('highlights a hovered verb with hiColor — but never one whose hiColor is 0', () => {
    const input = makeInput({
      verbs: [
        makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12, hiColor: 14 }),
        makeVerb({ id: 3, name: 'A', x: 30, y: 152, color: 12, hiColor: 0 }),
      ],
      mouse: { x: 11, y: 152 },
    });
    composeScreen(input);
    expect(px(input, 10, 152)).toBe(14);

    const hovered3 = makeInput({
      verbs: [makeVerb({ id: 3, name: 'A', x: 30, y: 152, color: 12, hiColor: 0 })],
      mouse: { x: 31, y: 152 },
    });
    composeScreen(hovered3);
    expect(px(hovered3, 30, 152)).toBe(12);
  });

  it('highlights the armed verb like a hover', () => {
    const input = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12, hiColor: 14 })],
      armedVerbId: 2,
    });
    composeScreen(input);
    expect(px(input, 10, 152)).toBe(14);
  });

  it('uses charsetColorMap[2] as the shadow ink for 2-bpp verb glyphs', () => {
    // 2-bpp glyph: 4×1 pixels, patterns [1,2,3,0] → ink, shadow, shadow, transparent.
    const header: number[] = [];
    header.push(...u32le(0));
    header.push(...u16le(0x0363));
    header.push(0, 0xf, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    header.push(2, 1);
    header.push(...u16le(66));
    let cursor = 25 + 66 * 4;
    for (let i = 0; i < 66; i++) {
      header.push(...u32le(i === 65 ? cursor - 21 : 0));
    }
    header.push(4, 1, 0, 0, 0b01_10_11_00);
    const payload = new Uint8Array(header);
    const charset: LoadedCharset = { header: parseCharHeader(payload), payload };
    const input = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152, color: 12 })],
      getCharset: () => charset,
      charsetColorMap: [0, 0, 10],
    });
    composeScreen(input);
    expect(px(input, 10, 152)).toBe(12); // pattern 1 → ink
    expect(px(input, 11, 152)).toBe(10); // pattern 2 → shadow
    expect(px(input, 12, 152)).toBe(10); // pattern 3 → shadow
    expect(px(input, 13, 152)).toBe(0); // pattern 0 → transparent (band fill)
  });

  it('blits an image verb with the source room TRNS transparent', () => {
    const { room } = makeImageRoom();
    const input = makeInput({
      verbs: [makeVerb({ id: 2, x: 10, y: 150, image: { obj: 1030, room: 99 } })],
      getRoom: (id) => (id === 99 ? room : null),
      getObjectState: () => 3,
    });
    composeScreen(input);
    expect(px(input, 10, 150)).toBe(1);
    expect(px(input, 12, 150)).toBe(2);
    expect(px(input, 11, 150)).toBe(0); // TRNS pixel → band fill shows through
    expect(px(input, 10, 151)).toBe(3);
  });

  it("falls back to the object's first image when its state is unset", () => {
    const { room } = makeImageRoom();
    const input = makeInput({
      verbs: [makeVerb({ id: 2, x: 10, y: 150, image: { obj: 1030, room: 99 } })],
      getRoom: (id) => (id === 99 ? room : null),
      getObjectState: () => undefined, // map miss → images key 3 (the only one)
    });
    composeScreen(input);
    expect(px(input, 10, 150)).toBe(1);
  });

  it('still paints image verbs (band intact) when no charset resolves', () => {
    const { room } = makeImageRoom();
    const input = makeInput({
      verbs: [
        makeVerb({ id: 2, x: 10, y: 150, image: { obj: 1030, room: 99 } }),
        makeVerb({ id: 3, name: 'A', x: 30, y: 152, color: 12 }),
      ],
      getCharset: () => null,
      getRoom: (id) => (id === 99 ? room : null),
      getObjectState: () => 3,
      activeDialog: makeDialog({}),
    });
    composeScreen(input); // and no throw
    expect(px(input, 10, 150)).toBe(1);
    expect(px(input, 30, 152)).toBe(0); // text verb skipped
  });
});

// ─── verb hit-test ────────────────────────────────────────────────────

describe('verbAt', () => {
  it('hits a text verb measured in its OWN charset, not the dialogue one', () => {
    const narrow = makeCharset(4, 'A');
    const wide = makeCharset(8, 'A');
    const view = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152, charset: 6 })],
      getCharset: (id) => (id === 6 ? wide : narrow),
    });
    // x=16 is inside the 8-wide own-charset glyph, outside a 4-wide one.
    expect(verbAt(view, 16, 152)?.id).toBe(2);
    expect(verbAt(view, 18, 152)).toBeNull();
  });

  it('hits an image verb by its IMHD box', () => {
    const { room } = makeImageRoom();
    const view = makeInput({
      verbs: [makeVerb({ id: 2, x: 10, y: 150, image: { obj: 1030, room: 99 } })],
      getRoom: (id) => (id === 99 ? room : null),
    });
    expect(verbAt(view, 13, 151)?.id).toBe(2);
    expect(verbAt(view, 14, 151)).toBeNull();
    expect(verbAt(view, 13, 152)).toBeNull();
  });

  it("prefers an 'on' hit over an overlapping 'dim' one", () => {
    const { room } = makeImageRoom();
    const view = makeInput({
      verbs: [
        // Dim background plate first in iteration order (like MI1's verb 1).
        makeVerb({ id: 1, x: 0, y: 144, image: { obj: 1030, room: 99 }, state: 'dim' }),
        makeVerb({ id: 2, name: 'A', x: 1, y: 145 }),
      ],
      getRoom: (id) => (id === 99 ? room : null),
    });
    // Inside both: the interactive verb wins despite iteration order.
    expect(verbAt(view, 2, 145)?.id).toBe(2);
    // Inside only the plate: dim is still reported (click routing rejects it).
    // (plate box is 4×2 at (0,144))
    expect(verbAt(view, 0, 144)?.id).toBe(1);
  });

  it('never hits archived verbs', () => {
    const view = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 10, y: 152 })],
      isVerbArchived: () => true,
    });
    expect(verbAt(view, 11, 152)).toBeNull();
  });

  it('centres the hit box for centred verbs', () => {
    const view = makeInput({
      verbs: [makeVerb({ id: 2, name: 'A', x: 20, y: 152, centered: true })],
    });
    expect(verbAt(view, 18, 152)?.id).toBe(2);
    expect(verbAt(view, 17, 152)).toBeNull();
  });
});

// ─── dialog ───────────────────────────────────────────────────────────

describe('composeScreen dialog', () => {
  const INK = 15;

  it('anchors un-positioned talk at the bottom-centre of the viewport', () => {
    const input = makeInput({ activeDialog: makeDialog({ center: true, color: INK }) });
    composeScreen(input);
    // blockH 8 → dy = 144 - 8 - 2 = 134; centred 4-wide → startX 158.
    expect(px(input, 158, 134)).toBe(INK);
    expect(px(input, 161, 141)).toBe(INK);
    expect(px(input, 157, 134)).toBe(ROOM_PIXEL);
  });

  it('treats explicit at(x,y) as screen coords — camera offset cancels out', () => {
    const input = makeInput({
      cameraLeft: 50,
      activeDialog: makeDialog({ x: 100, y: 20, color: INK }),
    });
    composeScreen(input);
    expect(px(input, 100, 20)).toBe(INK);
    expect(px(input, 100, 19)).toBe(ROOM_PIXEL);
  });

  it('anchors overhead talk above the drawn sprite top, falling back to feet−40', () => {
    const drawn = {
      x: 60,
      y: 100,
      talkColor: 0,
      drawBounds: { left: 50, top: 50, right: 70, bottom: 100 },
    } as unknown as Actor;
    const input = makeInput({
      activeDialog: makeDialog({ actorId: 7, overhead: true, center: true, color: INK }),
      getActor: (id) => (id === 7 ? drawn : null),
    });
    composeScreen(input);
    // dy = 50 - 2 - 8 = 40; centred on x=60 → startX 58.
    expect(px(input, 58, 40)).toBe(INK);

    const undrawn = { x: 60, y: 100, talkColor: 0, drawBounds: null } as unknown as Actor;
    const fallback = makeInput({
      activeDialog: makeDialog({ actorId: 7, overhead: true, center: true, color: INK }),
      getActor: (id) => (id === 7 ? undrawn : null),
    });
    composeScreen(fallback);
    // head = 100 - 40 = 60 → dy = 60 - 2 - 8 = 50.
    expect(px(fallback, 58, 50)).toBe(INK);
  });

  it('reads the ink LIVE from talkColor when colorFromActor is set', () => {
    const actor = { x: 60, y: 100, talkColor: 13, drawBounds: null } as unknown as Actor;
    const input = makeInput({
      activeDialog: makeDialog({ actorId: 7, color: 5, colorFromActor: true, x: 100, y: 20 }),
      getActor: (id) => (id === 7 ? actor : null),
    });
    composeScreen(input);
    expect(px(input, 100, 20)).toBe(13);
  });

  it('clamps a right-edge print into the viewport', () => {
    const input = makeInput({
      activeDialog: makeDialog({ x: 319, y: 20, color: INK }),
    });
    composeScreen(input);
    // hi = 320 - 4 = 316 → text starts at 316, ends flush with the edge.
    expect(px(input, 316, 20)).toBe(INK);
    expect(px(input, 319, 20)).toBe(INK);
  });

  it('clamps dialog top to screenTop', () => {
    const input = makeInput({
      screenTop: 10,
      activeDialog: makeDialog({ x: 100, y: 2, color: INK }),
    });
    composeScreen(input);
    expect(px(input, 100, 10)).toBe(INK);
    expect(px(input, 100, 9)).toBe(ROOM_PIXEL);
  });

  it('never paints dialog into the verb band', () => {
    const input = makeInput({
      activeDialog: makeDialog({ x: 100, y: 140, color: INK }),
    });
    composeScreen(input);
    expect(px(input, 100, 143)).toBe(INK);
    expect(px(input, 100, 144)).toBe(0); // clipped at the band boundary
  });

  it('stacks system text under the active talk line', () => {
    const input = makeInput({
      systemTexts: [makeDialog({ x: 10, y: 30, color: 6, keepText: true })],
      activeDialog: makeDialog({ x: 10, y: 60, color: INK }),
    });
    composeScreen(input);
    expect(px(input, 10, 30)).toBe(6);
    expect(px(input, 10, 60)).toBe(INK);
  });
});
