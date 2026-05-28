# SCUMM v5 — Room Objects (`OBCD` + `OBIM`)

A SCUMM v5 *object* is anything in a room the player can interact
with: doors, mugs, keys, sign-posts, the chickens behind the Scumm
Bar, the inventory items before they're picked up. Each one lives as
a **pair** of blocks under `ROOM`:

- **`OBCD`** — object *code*: metadata (position, parent, walk-to
  point) and the verb-script table the engine dispatches on player
  interaction.
- **`OBIM`** — object *image*: the per-state sprite variants
  (image-1, image-2, …) that get blitted onto the room background.

The two blocks share an `obj_id` field in their respective headers
and are looked up by that id. The room loader pairs them; orphan
OBCDs (no matching OBIM) or OBIMs (no matching OBCD) get silently
dropped — the compositor has nothing to draw for an orphan.

## Sources

- ScummVM Technical Reference — Object resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Object_resources>.
  Documents the CDHD / IMHD field layouts and the OBNA name string.
- Cross-checked against MI1 room 10's six objects (the title-screen
  artwork at obj 109 + five 16×32 placeholder sprites at obj 110-114).

## 1. Where they live

```
LECF
└── LFLF
    └── ROOM
        ├── ... (RMHD, CLUT, SMAP, etc.)
        ├── OBIM            ← per object: image
        │   ├── IMHD        image header
        │   ├── IM01        state-1 image (SMAP + optional ZP##)
        │   ├── IM02        state-2 image
        │   └── …
        ├── OBIM            ← next object's image
        ├── OBCD            ← per object: code
        │   ├── CDHD        code header
        │   ├── VERB        verb-id → script-offset table  (Phase 7)
        │   └── OBNA        NUL-terminated object name
        └── OBCD            ← next object's code
```

OBIM and OBCD don't have to interleave — the canonical order is
"all OBIMs, then all OBCDs," which is what real MI1 rooms use.

## 2. CDHD — object code header

A fixed 13-byte header at the start of every OBCD's payload:

| Offset | Size | Field        | Meaning                                                          |
|--------|------|--------------|------------------------------------------------------------------|
| 0      | u16  | `obj_id`     | Pairing key with the matching OBIM.                              |
| 2      | u8   | `x`          | Room x in **8-pixel units** (multiply by 8 for px).              |
| 3      | u8   | `y`          | Room y in 8-pixel units.                                         |
| 4      | u8   | `width`      | Bounding-box width in 8-pixel units.                             |
| 5      | u8   | `height`     | Bounding-box height in 8-pixel units.                            |
| 6      | u8   | `flags`      | Per-object flags. Bit 0x80 = "untouchable".                      |
| 7      | u8   | `parent`     | Parent object id (0 = no parent). Used for inventory groupings.  |
| 8      | u16  | `walkX`      | "Walk to" target x in **pixels**. Where an actor stands to use this object. |
| 10     | u16  | `walkY`      | "Walk to" target y in pixels.                                    |
| 12     | u8   | `actorDir`   | Suggested actor facing on interaction (N/S/E/W encoding).        |

The `x/y/width/height` fields are in 8-pixel units because the
original SCUMM engine snapped object bounding boxes to character
cells. Most renderers don't actually use these — the **IMHD's**
pixel-precise position drives compositing — but the engine reads
CDHD for parent / walk-to / verb routing.

## 3. IMHD — object image header

A variable-length header. The first 16 bytes match every MI1 / MI2
object we've inspected; longer IMHDs add per-state hotspot tables
that interactive UI overlays use to determine "which exact pixel of
this object did the player click?" We don't need hotspots for Phase
6 rendering, so we read the first 16 bytes only:

| Offset | Size | Field        | Meaning                                                  |
|--------|------|--------------|----------------------------------------------------------|
| 0      | u16  | `obj_id`     | Pairing key with the matching OBCD.                      |
| 2      | u16  | `numImages`  | Number of `IMxx` child blocks present (state count).     |
| 4      | u8   | `flags`      | Per-image flags. Mostly unused at the engine level.      |
| 5      | u8   | _padding_    | Often zero.                                              |
| 6      | u16  | `numHotspots`| Per-state hotspot count. Ignored for static rendering.   |
| 8      | u16  | `x`          | Image position in **pixels** (overrides CDHD's snapped x).|
| 10     | u16  | `y`          | Image position in pixels.                                |
| 12     | u16  | `width`      | Image width in pixels.                                   |
| 14     | u16  | `height`     | Image height in pixels.                                  |

## 4. IMxx — per-state image variants

Inside each OBIM, sibling blocks named `IM01`, `IM02`, … hold the
sprite for one *state* of the object. Each `IMxx` mirrors the layout
of `RMIM > IM00` (the room background): an `SMAP` child carrying the
RLE-encoded indexed bitmap, plus zero or more `ZP##` children for
per-state z-planes.

The width / height of the bitmap are the IMHD's `width` / `height`
(not the SMAP's — SMAP carries the strip count via its offsets table
but doesn't restate dimensions). Decoded image = `width × height`
palette-indexed bytes, ready to blit at the IMHD's `(x, y)`.

State semantics:

- **State 0 = invisible**. The object is in the room but not drawn.
  No `IM00` exists; state 0 is the absence of any image.
- **State 1 = `IM01`** — the "default" appearance (door closed, mug
  full, lamp lit, …).
- **State N = `IMnn`** — alternate appearances (door open, mug
  empty, lamp dark, …).

A simple object with only one appearance has `numImages = 1` and
only `IM01`. State-machine objects (doors that open/close, switches)
have several.

## 5. OBNA — object name

A NUL-terminated ASCII string. What the verb UI shows when the
player hovers over the object: "key", "rusty cup", "the Voodoo
Lady". Optional — some objects (e.g. invisible trigger zones) have
empty OBNA payloads or none at all.

## 6. VERB — verb-id → script-offset table

The OBCD's `VERB` block holds the **verb scripts** that fire when
the player performs verb actions on this object. One sub-script per
supported verb, typically `Look at`, `Open`, `Pick up`, `Use`,
`Talk to`. Phase 6 captures the block but doesn't decode it; Phase
7 wires verb dispatch.

## 7. The runtime: state tracking + draw queue

Three pieces of VM state govern object rendering:

- **`vm.objectStates`** — `Map<obj_id, state>`. Written by the
  `setState` opcode (`0x07` / `0x47` / `0x87` / `0xC7`). Defaults to
  state 1 for objects that have an image but no explicit state set —
  the "default state is the first variant" convention from the
  format spec.
- **`vm.objectStates.get(obj_id) === 0`** means the object is
  hidden, even if it's queued for drawing.
- **`vm.objectDrawQueue`** — `Set<obj_id>`. The `drawObject`
  opcode (`0x05` / `0x25` / …) adds an object's id to this set.
  `vm.enterRoom` clears it on room change — a fresh room starts
  with an empty queue, and the new `ENCD` decides what to redraw.

The frame compositor (`composeFrame` in
`src/engine/render/compositor.ts`) iterates the queue in id order
between background and actors. For each id it looks up the loaded
object, picks the IMxx matching the current state, and blits at
the IMHD's `(x, y)` with TRNS-indexed transparency.

Skipped objects are surfaced in `ComposeFrameResult.skippedObjects`
with a reason — "not present in room", "state 0 (hidden)", "no image
for state N" — so the inspector can explain why an expected object
didn't appear.

## 8. Reference implementation

- Parser:
  [`src/engine/object/loader.ts`](../src/engine/object/loader.ts) —
  `parseCDHD`, `parseIMHD`, `parseRoomObjects(file, roomBlock) →
  Map<obj_id, LoadedObject>`.
- Pairing logic: walks the ROOM's children once to index OBIMs by id
  (via their IMHD), then walks again iterating OBCDs and pairing by
  CDHD's id. Orphans on either side are silently dropped.
- Per-state image decoding via the existing `decodeSmap` from the
  background loader.
- Tests:
  [`src/engine/object/loader.test.ts`](../src/engine/object/loader.test.ts)
  — synthetic OBCD/OBIM fixtures covering happy path, multi-state
  variants, orphans, missing OBNA, empty rooms.

## 9. Pitfalls cheat-sheet

1. **Forgetting that `IM00` is reserved for the room background** —
   it's a child of `RMIM`, never an OBIM child. Object state 0 is
   the *absence* of an image; the first per-state OBIM child is
   `IM01`.
2. **Reading CDHD's position as pixels instead of 8-pixel units** —
   produces objects positioned 1/8 of where they should be.
3. **Trusting RMHD.numObjects** — that count includes objects with
   only OBCD (no image) and orphans the loader drops. Trust the
   `objects.size` of the parsed map.
4. **Drawing a queued object whose state is 0** — the compositor
   correctly skips these but logs a `skippedObjects` entry. If you
   see "state 0 (hidden)" in the inspector for an object you expect
   visible, the script has explicitly hidden it (often via
   `setState(obj, 0)` immediately before a cutscene).
