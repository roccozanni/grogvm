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
        │   ├── VERB        verb-id → script-offset table
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

A variable-length header. The first 16 bytes are consistent across
MI1 / MI2 objects; longer IMHDs add per-state hotspot tables that
interactive UI overlays use to determine which exact pixel of the
object the player clicked. Rendering only requires the first 16
bytes:

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

**`@` (0x40) is name padding, not text.** Many names are padded with
trailing `0x40` bytes (`il pezzo di carne@@@@…@`) up to some fixed width,
*before* any NUL. SCUMM renders it as a blank glyph, so it's invisible
in-game; the text renderer must skip `0x40` rather than draw it (see
[`text.ts`](../src/engine/graphics/text.ts) `SCUMM_NAME_PAD`). Don't trim
it out of the stored name — the substitution codes that splice names into
the sentence line ([INPUT §6](SCUMM-V5-INPUT.md)) rely on the renderer's
skip, and the padded length is the original byte layout.

## 6. VERB — verb-id → script-offset table

The OBCD's `VERB` block holds the **verb scripts** that fire when
the player performs verb actions on this object. One sub-script per
supported verb, typically `Look at`, `Open`, `Pick up`, `Use`,
`Talk to`. GrogVM captures the block on parse but verb dispatch
is not yet wired.

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

**`drawObject` always sets state.** `o5_drawObject`'s whole job is to
make an object visible, so it sets `state = 1` by default (only
`SO_IMAGE` overrides the value). A bare or `SO_AT` `drawObject` on a
state-0 (hidden) object reveals it. Close-up rooms rely on this: ENCD
hides every scenery object (`drawObject … at x,y` then `setState 0`),
then reveals a piece later with a *bare* `drawObject` expecting the flip
to state 1.

**Retained-mode draw queue vs. SCUMM's strip overwrite.** The original
restores the background strips under an object's box on each redraw, so a
fresh `drawObject` *erases* the previous frame — only the latest shows.
Our queue is retained (every queued object redraws each frame), and MI1
animates background fixtures as **several single-frame objects that share
one bounding box** (the swinging chandelier pirate, table pirates: ids
357/358 share `(32,120) 40×24`; 354/355/356 share `(208,96)`), cycled by
a loop's bare `drawObject`. Without intervention they all accumulate and
the fixture freezes after one cycle. **Fix:** before (re-)queuing a drawn
object, evict any already-queued object covering the **exact same box**,
and append the drawn one last (freshest on top). Exact-box match (not
overlap) leaves a legitimately distinct object resting over a larger
fixture untouched.

**`setState` renders too.** Setting an object's state to a non-zero,
image-backed value marks it dirty in SCUMM → it redraws. So `setState`
queues a current-room object, and `applyRoomResources` queues every
object already in a non-zero image-backed state at room (re)entry — that
keeps an opened door drawn open when you leave and return, and across
save/restore.

**`pickupObject` is four steps, not one.** `o5_pickupObject` does *all* of:
`putOwner(obj, VAR_EGO)` (inventory membership = ownership, INPUT §7),
`putState(obj, 1)` + mark-dirty, **`putClass(obj, Untouchable, 1)`**, and
`runInventoryScript`. MI1 bakes pickable items into the room-background
SMAP, so the state-1 image is the *eraser patch* that paints over the
baked-in item — pickup must **draw** the object (queue it), not drop it,
or the item lingers on the table. And the Untouchable class is what makes
the now-taken item's room hit-box stop responding (§7a / `findObject`);
omit it and the sprite vanishes yet you can still click the empty spot.
Doing only the draw leaves that hit-area half open.

## 7a. Object owner, state, and class — the `DOBJ` seed

Three per-object attributes drive interaction, seeded from the index
**`DOBJ`** directory (`.000`) *before* any script runs:

- **owner** — who holds the object. A room-present object defaults to
  `OF_OWNER_ROOM` (**15**), not 0; MI1's sentence script gates the
  walk-to-object approach on `owner == 15`, so a wrong 0 default makes the
  ego never walk over ("can't reach"). Explicit `pickupObject` /
  `setOwnerOf` still win. Inventory membership *is* ownership (see
  INPUT §7).
- **state** — the current image variant (§7; 0 = hidden).
- **class** — a bitmask. The one that matters early is **Untouchable**
  (class 32, bit `1<<31`): SCUMM's `findObject` skips Untouchable
  objects, so they are neither hoverable nor clickable. MI1 ships ~510
  objects initially Untouchable (e.g. the not-yet-docked ship #430, a
  solid sprite sitting in the sea) — a script clears the flag when the
  object becomes interactive. Both the engine's `findObject` and the
  shell's hover pass must honour it.

`parseDobj` decodes `DOBJ → {owner, state, classMask}` per global id;
boot seeds the non-default rows (owner≠15 / state≠0 / class≠0). The
seeded maps are captured in the save snapshot and re-applied on restore.

**Distance uses the walk-to point, not the image.** `getObjectXYPos`
(and the proximity gate for "is the ego close enough to act?") reads the
object's **walk-to point** (`walkX/walkY` from the OBCD) — the exact spot
`walkActorToObject` sends the ego — *not* the image's top-left. They can
differ by tens of pixels (a door image at `(696,80)` with walk-to
`(715,130)`), so measuring against the image makes the ego arrive yet
still read as too far away.

**A held item's position is its holder's position.** `getObjectOrActorXY`
has a `WIO_INVENTORY` case: for an object in someone's inventory it returns
the *owning actor's* position (if in the current room), else "not found".
So the proximity gate `getDist(ego, heldItem)` = `dist(ego, ego)` = 0 →
always reachable, and a verb on an inventory item runs instead of aborting
with "Non riesco ad arrivarci". The room-object lookup alone is wrong for
a held item: it isn't in the current room's table, so it resolves to "far"
(0xFF) and *every* verb on a held item fails the gate. Owner codes ≥ the
actor-table size (e.g. `OF_OWNER_ROOM` = 15) are not actors → the normal
room/walk-to branch.

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
   only OBCD (no image) and orphans a loader would drop. Trust the
   size of the parsed object map.
4. **Drawing a queued object whose state is 0** — by spec, state 0
   means hidden. Scripts often explicitly set an object's state to
   0 immediately before a cutscene to remove a piece of scenery
   that's about to be replaced by a sprite.
