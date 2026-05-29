import { describe, expect, it } from 'vitest';
import { createActor, type Actor } from '../actor/actor';
import type { CostumeHeader } from '../graphics/costume';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { LoadedRoom } from '../room/loader';
import { ComposeError, composeFrame } from './compositor';

function makeRoom(width: number, height: number, fill: number): LoadedRoom {
  const indexed = new Uint8Array(width * height);
  indexed.fill(fill);
  return {
    id: 1,
    width,
    height,
    numObjects: 0,
    palette: new Uint8Array(768),
    transparentIndex: null,
    indexed,
    stripMethods: [],
    zPlanes: [],
    entryScript: null,
    exitScript: null,
    localScripts: new Map(),
    objects: new Map(),
    walkBoxes: [],
    walkableMask: new Uint8Array(0),
  };
}

describe('composeFrame', () => {
  it('copies the room background into the framebuffer', () => {
    const room = makeRoom(8, 4, 0x42);
    const fb = new Uint8Array(8 * 4);
    composeFrame({ room, framebuffer: fb });
    expect(fb).toEqual(room.indexed);
  });

  it('overwrites prior framebuffer contents', () => {
    const room = makeRoom(4, 2, 0x10);
    const fb = new Uint8Array(4 * 2);
    fb.fill(0xff);
    composeFrame({ room, framebuffer: fb });
    expect(Array.from(fb)).toEqual([0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10]);
  });

  it('clears the framebuffer to index 0 when room is null', () => {
    const fb = new Uint8Array(16);
    fb.fill(0x77);
    composeFrame({ room: null, framebuffer: fb });
    for (let i = 0; i < fb.length; i++) expect(fb[i]).toBe(0);
  });

  it('is idempotent — composing the same room twice yields identical pixels', () => {
    const room = makeRoom(8, 8, 0x55);
    const fb1 = new Uint8Array(8 * 8);
    const fb2 = new Uint8Array(8 * 8);
    composeFrame({ room, framebuffer: fb1 });
    composeFrame({ room, framebuffer: fb2 });
    expect(fb1).toEqual(fb2);
  });

  it('leaves trailing slack untouched when the framebuffer is larger than the room', () => {
    // A "max-sized" 320×200 buffer hosting a 160×100 room — trailing
    // bytes stay at whatever they were.
    const room = makeRoom(4, 4, 0x33);
    const fb = new Uint8Array(8 * 8);
    fb.fill(0xaa);
    composeFrame({ room, framebuffer: fb });
    // First 16 bytes (= 4×4 room) are 0x33
    for (let i = 0; i < 16; i++) expect(fb[i]).toBe(0x33);
    // Bytes 16..63 are unchanged
    for (let i = 16; i < fb.length; i++) expect(fb[i]).toBe(0xaa);
  });

  it('throws ComposeError when the framebuffer is smaller than the room', () => {
    const room = makeRoom(8, 8, 0);
    const tooSmall = new Uint8Array(8 * 8 - 1);
    expect(() => composeFrame({ room, framebuffer: tooSmall })).toThrow(ComposeError);
  });

  it('throws ComposeError if room.indexed length doesn’t match width × height', () => {
    const room: LoadedRoom = {
      ...makeRoom(8, 4, 0),
      indexed: new Uint8Array(7), // wrong size
    };
    const fb = new Uint8Array(64);
    expect(() => composeFrame({ room, framebuffer: fb })).toThrow(/room.indexed/);
  });
});

// ─── actor compositing ───────────────────────────────────────────────

/**
 * Build a synthetic single-limb single-frame costume. The frame is a
 * `frameW × frameH` block of palette index `pixelIdx`. The costume's
 * palette has the same index pointing at CLUT entry `clutIdx`.
 *
 * Layout (matches the costume.ts header parser exactly):
 *   [0]      numAnim - 1 = 0
 *   [1]      format = 0 (16-color, no mirror)
 *   [2..17]  16-byte palette (palette[pixelIdx] = clutIdx, rest 0)
 *   [18..19] animCmdOffset = 0
 *   [20..51] limbOffsets[0..15]: only limb 0 set to 54 (frame table loc)
 *   [52..53] animOffsets[0] = 0 (we don't actually run the anim)
 *   ─── header ends at byte 54 ───
 *   [54..55] limb 0's frame table entry 0 → frame ptr = 64 (header redirY field)
 *   [58..69] frame's 12-byte image header
 *   [70..]   RLE body
 *
 * `decodeCostumeFrame` expects framePtr to point at the redirY field
 * (= 6 bytes into the 12-byte header). With frame ptr 64 the image
 * header starts at byte 58 and the RLE body at byte 70.
 */
function makeOneFrameCostume(opts: {
  frameW: number;
  frameH: number;
  pixelIdx: number; // costume-local palette index (1..15)
  clutIdx: number;  // CLUT index the costume palette maps to
  redirX?: number;
  redirY?: number;
}): LoadedCostume {
  const { frameW, frameH, pixelIdx, clutIdx } = opts;
  const redirX = opts.redirX ?? 0;
  const redirY = opts.redirY ?? 0;

  const total = frameW * frameH;
  if (total > 255) throw new Error('keep test frames small (≤255 px)');
  const bodyBytes: number[] = [(pixelIdx << 4) | 0, total];

  const payloadParts: number[] = [];
  // Header (bytes 0..53)
  payloadParts.push(0); // numAnim - 1
  payloadParts.push(0); // format
  for (let i = 0; i < 16; i++) payloadParts.push(i === pixelIdx ? clutIdx : 0);
  payloadParts.push(0, 0); // animCmdOffset
  payloadParts.push(54, 0); // limbOffsets[0] = 54
  for (let i = 1; i < 16; i++) payloadParts.push(0, 0); // limbOffsets[1..15] = 0
  payloadParts.push(0, 0); // animOffsets[0] = 0
  // header ends at byte 54

  // Limb 0's frame table — one entry pointing at the image header's
  // redirY field at byte 64.
  payloadParts.push(64, 0);
  // We're at byte 56. Image header starts at byte 58 (framePtr - 6 = 64 - 6 = 58).
  // Pad to byte 58.
  payloadParts.push(0, 0);

  // Image header (12 bytes, 58..69)
  payloadParts.push(frameW, 0);
  payloadParts.push(frameH, 0);
  payloadParts.push(redirX & 0xff, (redirX >>> 8) & 0xff);
  payloadParts.push(redirY & 0xff, (redirY >>> 8) & 0xff);
  payloadParts.push(0, 0, 0, 0); // xinc, yinc

  // RLE body (byte 70..)
  payloadParts.push(...bodyBytes);

  const payload = new Uint8Array(payloadParts);
  const header: CostumeHeader = {
    numAnim: 1,
    format: 0,
    mirrorFlag: false,
    paletteSize: 16,
    palette: payload.subarray(2, 18),
    animCmdOffset: 0,
    limbOffsets: [54, ...Array<number>(15).fill(0)],
    animOffsets: [0],
  };
  return { id: 1, header, payload };
}

function makeActorAt(id: number, x: number, y: number, costume: number, room: number = 1): Actor {
  const a = createActor(id);
  a.x = x;
  a.y = y;
  a.costume = costume;
  a.room = room;
  a.visible = true;
  return a;
}

describe('composeFrame — actor compositing', () => {
  it('draws a single-actor single-limb frame on top of the background', () => {
    // 8×4 room filled with bg index 0x10. A 2×2 frame of pixel idx 1
    // (mapped to CLUT 0x99) drawn at (3, 1).
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    const actor = makeActorAt(1, 3, 1, 1, 1);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [actor],
      getCostume: () => cost,
    });
    expect(result.actorsDrawn).toBe(1);
    expect(result.skippedLimbs).toHaveLength(0);
    // The frame's redirX/Y are 0, so left = actorX = 3, top = actorY = 1.
    // 2×2 block of CLUT 0x99 at (3..4, 1..2).
    expect(fb[1 * 8 + 3]).toBe(0x99);
    expect(fb[1 * 8 + 4]).toBe(0x99);
    expect(fb[2 * 8 + 3]).toBe(0x99);
    expect(fb[2 * 8 + 4]).toBe(0x99);
    // Surrounding pixels unchanged.
    expect(fb[0]).toBe(0x10);
    expect(fb[1 * 8 + 2]).toBe(0x10);
    expect(fb[2 * 8 + 5]).toBe(0x10);
  });

  it('records the drawn actor\'s room-space bounds for hit-testing', () => {
    // 2×2 frame at (3,1) with redirX/Y = 0 → bounds [3,5) × [1,3).
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    const actor = makeActorAt(1, 3, 1, 1, 1);
    composeFrame({ room, framebuffer: fb, actors: [actor], getCostume: () => cost });
    expect(actor.drawBounds).toEqual({ left: 3, top: 1, right: 5, bottom: 3 });
  });

  it('offsets drawn bounds by the frame redir + clears them when the actor is skipped', () => {
    const room = makeRoom(16, 16, 0x10);
    const fb = new Uint8Array(16 * 16);
    const cost = makeOneFrameCostume({
      frameW: 3, frameH: 4, pixelIdx: 1, clutIdx: 0x99, redirX: -1, redirY: -2,
    });
    const actor = makeActorAt(1, 6, 8, 1, 1);
    composeFrame({ room, framebuffer: fb, actors: [actor], getCostume: () => cost });
    // left = 6 + (-1) = 5, top = 8 + (-2) = 6, right = 5+3 = 8, bottom = 6+4 = 10.
    expect(actor.drawBounds).toEqual({ left: 5, top: 6, right: 8, bottom: 10 });
    // Now make it undrawable — bounds must reset to null (off-screen).
    actor.visible = false;
    composeFrame({ room, framebuffer: fb, actors: [actor], getCostume: () => cost });
    expect(actor.drawBounds).toBeNull();
  });

  it('records skippedActors when an actor is invisible or has no costume', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    const invisibleActor = { ...makeActorAt(1, 3, 1, 1), visible: false };
    const noCostumeActor = makeActorAt(2, 3, 1, 0);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [invisibleActor, noCostumeActor],
      getCostume: () => cost,
    });
    expect(result.actorsDrawn).toBe(0);
    // Nothing drawn — fb stays as the background.
    for (let i = 0; i < fb.length; i++) expect(fb[i]).toBe(0x10);
    const reasons = result.skippedActors.map((s) => `${s.actorId}:${s.reason}`);
    expect(reasons).toContainEqual(expect.stringMatching(/^1:visible=false/));
    expect(reasons).toContainEqual(expect.stringMatching(/^2:costume=0/));
  });

  it('records skippedActors when getCostume returns null', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const actor = makeActorAt(1, 3, 1, 5);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [actor],
      getCostume: () => null, // costume not available
    });
    expect(result.actorsDrawn).toBe(0);
    expect(result.skippedActors).toHaveLength(1);
    expect(result.skippedActors[0]!.reason).toMatch(/getCostume\(5\) returned null/);
  });

  it('silently skips limbs whose framePtr can\'t fit a 12-byte header (broad sentinel)', () => {
    // In real costumes (MI1 Guybrush, limbs 3..15) "unused-limb"
    // group tables hold garbage values like 0xFFDD — any framePtr
    // outside [6, payload.length - 6] can't be a real frame. We
    // silently bypass instead of trying to decode and filling the
    // inspector with limb-skip noise.
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    // Frame ptr way past end of payload.
    cost.payload[54] = 0xdd;
    cost.payload[55] = 0xff;
    const actor = makeActorAt(1, 3, 1, 1);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [actor],
      getCostume: () => cost,
    });
    expect(result.actorsDrawn).toBe(0);
    // Silently bypassed — no error logged.
    expect(result.skippedLimbs).toHaveLength(0);
    // Falls through to the "all limbs had no frame data" actor skip.
    expect(result.skippedActors).toHaveLength(1);
    expect(result.skippedActors[0]!.reason).toMatch(/all limbs had no frame data/);
  });

  it('records skippedActors when every limb hits a sentinel framePtr', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    // Build a costume whose every limb table has framePtr = 0xFFFF
    // (sentinel "no frame"). Borrow makeOneFrameCostume's structure
    // then surgically nuke the frame table.
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    cost.payload[54] = 0xff;
    cost.payload[55] = 0xff;
    const actor = makeActorAt(1, 3, 1, 1);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [actor],
      getCostume: () => cost,
    });
    expect(result.actorsDrawn).toBe(0);
    expect(result.skippedLimbs).toHaveLength(0);
    expect(result.skippedActors).toHaveLength(1);
    expect(result.skippedActors[0]!.reason).toMatch(/all limbs had no frame data/);
  });

  it('records skippedLimbs when decodeCostumeFrame throws (frame ptr → garbage)', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const cost = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0x99 });
    // Point the frame ptr to an offset just inside the payload but
    // not at a valid header — small enough that the "headerStart =
    // framePtr - 6" doesn't go negative, but not enough payload
    // after to fit a valid RLE.
    cost.payload[54] = 0x06;
    cost.payload[55] = 0x00;
    const actor = makeActorAt(1, 3, 1, 1);
    const result = composeFrame({
      room,
      framebuffer: fb,
      actors: [actor],
      getCostume: () => cost,
    });
    expect(result.actorsDrawn).toBe(0);
    expect(result.skippedLimbs.length).toBeGreaterThan(0);
    expect(result.skippedLimbs[0]!.actorId).toBe(1);
  });

  it('draws actors in id order so overlapping sprites layer predictably', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(8 * 4);
    const costA = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0xaa });
    const costB = makeOneFrameCostume({ frameW: 2, frameH: 2, pixelIdx: 1, clutIdx: 0xbb });
    const a = makeActorAt(2, 3, 1, 2);  // id 2 → drawn first
    const b = makeActorAt(1, 3, 1, 1);  // id 1 → drawn first (lower id)
    composeFrame({
      room,
      framebuffer: fb,
      actors: [a, b],
      getCostume: (id) => (id === 1 ? costB : costA),
    });
    // After sort by id: id 1 (costB, 0xbb) drawn first, then id 2 (costA, 0xaa) on top.
    // Final pixel at (3, 1) = 0xaa.
    expect(fb[1 * 8 + 3]).toBe(0xaa);
  });

  it('does nothing extra when actors array is empty', () => {
    const room = makeRoom(4, 2, 0x42);
    const fb = new Uint8Array(8);
    const result = composeFrame({ room, framebuffer: fb, actors: [], getCostume: () => null });
    expect(result.actorsDrawn).toBe(0);
    expect(result.skippedLimbs).toHaveLength(0);
    // Background still copied.
    for (let i = 0; i < 8; i++) expect(fb[i]).toBe(0x42);
  });
});

// ─── object compositing ──────────────────────────────────────────────

function makeObject(id: number, x: number, y: number, w: number, h: number, fillIdx: number, state = 1) {
  const indexed = new Uint8Array(w * h);
  indexed.fill(fillIdx);
  return {
    objId: id,
    cdhd: { objId: id, x: 0, y: 0, width: w / 8, height: h / 8, flags: 0, parent: 0, walkX: 0, walkY: 0, actorDir: 0 },
    imhd: { objId: id, numImages: 1, flags: 0, x, y, width: w, height: h },
    images: new Map([[state, { state, indexed }]]),
    name: `obj${id}`,
    verbs: new Map(),
  };
}

describe('composeFrame — object compositing', () => {
  it('draws a queued object between the background and actors', () => {
    // 16×8 room filled with bg 0x10. One object at (4, 2) sized 4×2 of index 0xAA.
    const room: LoadedRoom = {
      ...makeRoom(16, 8, 0x10),
      objects: new Map([[1, makeObject(1, 4, 2, 4, 2, 0xaa)]]),
    };
    const fb = new Uint8Array(16 * 8);
    const result = composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [1],
      getObjectState: () => 1,
    });
    expect(result.objectsDrawn).toBe(1);
    expect(result.skippedObjects).toHaveLength(0);
    // Object pixels written.
    expect(fb[2 * 16 + 4]).toBe(0xaa);
    expect(fb[3 * 16 + 7]).toBe(0xaa);
    // Background outside the object intact.
    expect(fb[0]).toBe(0x10);
    expect(fb[7 * 16 + 15]).toBe(0x10);
  });

  it('honours TRNS-indexed transparency', () => {
    // Room TRNS = 0xAA. Object pixels of that index don't overwrite.
    const room: LoadedRoom = {
      ...makeRoom(8, 4, 0x42),
      transparentIndex: 0xaa,
      objects: new Map([[1, makeObject(1, 0, 0, 8, 4, 0xaa)]]),
    };
    const fb = new Uint8Array(32);
    composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [1],
      getObjectState: () => 1,
    });
    // Every pixel still bg — the object's 0xAA was transparent.
    for (let i = 0; i < fb.length; i++) expect(fb[i]).toBe(0x42);
  });

  it('skips objects with state 0 (hidden)', () => {
    const room: LoadedRoom = {
      ...makeRoom(8, 4, 0x10),
      objects: new Map([[1, makeObject(1, 0, 0, 4, 2, 0xaa)]]),
    };
    const fb = new Uint8Array(32);
    const result = composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [1],
      getObjectState: () => 0,
    });
    expect(result.objectsDrawn).toBe(0);
    expect(result.skippedObjects[0]!.reason).toMatch(/state 0/);
    for (let i = 0; i < fb.length; i++) expect(fb[i]).toBe(0x10);
  });

  it('records skippedObjects when the id isn\'t in the room', () => {
    const room = makeRoom(8, 4, 0x10);
    const fb = new Uint8Array(32);
    const result = composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [999],
    });
    expect(result.objectsDrawn).toBe(0);
    expect(result.skippedObjects).toHaveLength(1);
    expect(result.skippedObjects[0]!.reason).toMatch(/not present/);
  });

  it('records skippedObjects when no image variant matches the state', () => {
    const room: LoadedRoom = {
      ...makeRoom(8, 4, 0x10),
      // Object has only state 1; we ask for state 2.
      objects: new Map([[1, makeObject(1, 0, 0, 4, 2, 0xaa)]]),
    };
    const fb = new Uint8Array(32);
    const result = composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [1],
      getObjectState: () => 2,
    });
    expect(result.objectsDrawn).toBe(0);
    expect(result.skippedObjects[0]!.reason).toMatch(/no image for state 2/);
  });

  it('clips objects that overhang the room bounds', () => {
    // Object is 8×4 but room is only 4×2 — only the top-left quadrant draws.
    const room: LoadedRoom = {
      ...makeRoom(4, 2, 0x00),
      objects: new Map([[1, makeObject(1, 0, 0, 8, 4, 0x99)]]),
    };
    const fb = new Uint8Array(8);
    composeFrame({
      room,
      framebuffer: fb,
      objectDrawQueue: [1],
      getObjectState: () => 1,
    });
    // Every pixel of the room got overwritten by the (clipped) object.
    for (let i = 0; i < 8; i++) expect(fb[i]).toBe(0x99);
  });
});

