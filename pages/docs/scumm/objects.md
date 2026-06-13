# SCUMM v5 — Room Objects (`OBCD` + `OBIM`)

A SCUMM v5 *object* is anything in a room the player can interact
with: doors, mugs, keys, sign-posts, the chickens behind the Scumm
Bar, the inventory items before they're picked up.

## At a glance

```
        one object  =  two blocks  +  three runtime attributes

  OBCD — code                        OBIM — image
  ┌─────────────────────────┐       ┌─────────────────────────┐
  │ CDHD  position, walk-to │       │ IMHD  pixel x/y, w/h    │
  │       point, facing     │       │ IM01  state-1 sprite    │
  │ VERB  verb → script     │       │ IM02  state-2 sprite    │
  │ OBNA  display name      │       │ …     each with optional│
  └────────────┬────────────┘       │       per-state ZP##    │
               │                    └────────────┬────────────┘
               └────── paired by shared obj_id ──┘

  runtime:  owner — who holds it (room = 15, or an actor)
            state — which IMxx is showing (0 = hidden)
            class — bitmask; Untouchable removes it from hit-tests
            seeded from the index's DOBJ directory, then script-driven
```

The pairing is by the `obj_id` field both headers carry. The room
loader pairs them; orphan OBCDs (no matching OBIM) or OBIMs (no
matching OBCD) get silently dropped — the compositor has nothing to
draw for an orphan.

## Sources

- ScummVM Technical Reference — Object resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Object_resources>.
  Documents the CDHD / IMHD field layouts and the OBNA name string.
- Cross-checked against MI1 room 10's six objects (the title-screen
  artwork at obj 109 + five 16×32 placeholder sprites at obj 110-114).

---

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

There is no object → home-room directory in the index: finding which
room owns an object means an index over every room's OBCDs (MI1 has
~83 rooms), so engines build that lookup lazily.

## 2. CDHD — object code header

A fixed 13-byte header at the start of every OBCD's payload:

| Offset | Size | Field        | Meaning                                                          |
|--------|------|--------------|------------------------------------------------------------------|
| 0      | u16  | `obj_id`     | Pairing key with the matching OBIM.                              |
| 2      | u8   | `x`          | Room x in **8-pixel units** (multiply by 8 for px).              |
| 3      | u8   | `y`          | Room y in 8-pixel units.                                         |
| 4      | u8   | `width`      | Bounding-box width in 8-pixel units.                             |
| 5      | u8   | `height`     | Bounding-box height in 8-pixel units.                            |
| 6      | u8   | `flags`      | Bit 0x80 = required **parent state**: set → parent must be non-0 ("open"), clear → parent must be 0 ("closed"). Only meaningful with `parent` ≠ 0 (§7a). |
| 7      | u8   | `parent`     | **1-based source-order index** (not an object id) of the container object in this room's OBCD sequence; 0 = no parent. Gates hit-testing on the container's state (§7a). |
| 8      | i16  | `walkX`      | "Walk to" target x in **pixels**, **signed**. Where an actor stands to use this object — an edge exit's walk-to point can be *off-screen* (e.g. x = −25), so reading it unsigned (→ 65511) marches the actor off into space. |
| 10     | i16  | `walkY`      | "Walk to" target y in pixels, signed.                            |
| 12     | u8   | `actorDir`   | Suggested actor facing on interaction (N/S/E/W encoding).        |

The `x/y/width/height` fields are in 8-pixel units because the
original SCUMM engine snapped object bounding boxes to character
cells. Most renderers don't actually use these — the **IMHD's**
pixel-precise position drives compositing — but the engine reads
CDHD for parent / walk-to / verb routing.

**Fine print — `actorDir` values.** The four codes map `0 → E`, `1 → W`,
`2 → N`, `3 → S` — the pairwise *opposite* of the costume old-direction
order, so the byte can't be handed straight to the costume layer unmapped.
Pinned against observed entries (a bar interior rests facing E, a jail W,
cliff steps N, a doorway front/S).

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

The `ZP##` chunks stay **per plane** — never collapse them into one
mask. `ZP0k` masks clip-`k` actors alone: MI1's general-store sword
(object #388) carries its mask only in `ZP02`, occluding the clip-2
shopkeeper while the clip-1 ego buying it passes in front. A collapsed
mask gets both wrong — it clips the ego and never occludes the
shopkeeper. See [`zplane.md`](zplane.md).

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
in-game; the text renderer must skip `0x40` rather than draw it. Don't trim
it out of the stored name — the substitution codes that splice names into
the sentence line ([INPUT §6](input.md)) rely on the renderer's
skip, and the padded length is the original byte layout.

**`setObjectName` ($54/$D4) renames in place — and that's *why* OBNA is
padded.** The opcode is `object[p16] name[c]… $00`: a 16-bit object id then
a NUL-terminated SCUMM string (which can carry `0xFF NN` control codes, so
it must be consumed with the same reader as `print`, not byte-scanned — a
short read leaves the PC mid-string and the next byte decodes as a bogus
opcode). SCUMM overwrites the OBNA buffer where it sits, so the trailing
`@` padding is the slack a longer replacement uses (obj 488's verb-91:
`@@@@@ pezzi da otto@@@@` → `500 pezzi da otto`). The overwrite is modelled
as a name-override that wins over both the room OBNA and the pickup-time
inventory snapshot, and is persisted in the save state.

## 6. VERB — verb-id → script-offset table

The OBCD's `VERB` block holds the **verb scripts** that fire when
the player performs verb actions on this object — typically `Look at`,
`Open`, `Pick up`, `Use`, `Talk to`. The layout is a table of
**3-byte entries** — verb id (u8) then offset (u16le) — closed by a
single `0x00` terminator byte, followed by the verb scripts' bytecode
concatenated. The stored offsets are relative to the **block header**,
so the payload index is `offset − 8`.

Two things in real data are normal, not corruption:

- **Shared offsets** — several verb ids may point at the same
  bytecode; the script reads the verb variable and branches internally.
- **Verb id `0xFF`** is the **catch-all default handler**: dispatch
  falls back to it when no entry matches the performed verb.

## 7. The runtime: state tracking + draw queue

Two pieces of runtime state govern object rendering:

- **Object state** — a per-object-id state value, written by the
  `setState` opcode (`0x07` / `0x47` / `0x87` / `0xC7`). Objects that have
  an image but no explicit state default to **state 1** — the "default
  state is the first variant" convention from the format spec. **State 0
  means hidden**, even if the object is queued for drawing.
- **The draw queue** — the set of object ids to composite. The
  `drawObject` opcode (`0x05` / `0x25` / …) adds an id; a room change
  clears the queue, so a fresh room starts empty and its new `ENCD`
  decides what to redraw.

The frame compositor iterates the queue in id order between background and
actors. For each id it looks up the loaded object, picks the `IMxx`
matching the current state, and blits at the object's **current position**
(see SO_AT below; the `IMHD` `(x, y)` is the default) with TRNS-indexed
transparency. Skipped objects are surfaced with a reason ("not present in
room", "state 0 (hidden)", "no image for state N") so a diagnostic can
explain why an expected object didn't appear.

### `drawObject … at x,y` (SO_AT) repositions the object

Both operands are in **strips**, so the object moves to `(x·8, y·8)` and
draws there until the next reposition (a bare/`SO_IMAGE` draw keeps the
last position). This runtime position — not the `IMHD` default — is the
single source of truth for everything tied to the object: the image blit,
its z-plane occlusion ([ZPLANE](zplane.md)), the hit-box (`findObject`,
§7a), and the walk-to point (`getObjectXYPos`, §7a). MI1's forest maze
(room 58) leans on it hard: each screen is built by repositioning ~10
shared tile objects, and the floor bands of one screen are a top tile
(height 88) at strip-y 0 plus a bottom tile (height 56) at strip-y 11 →
88px, which butt together to fill the 144-row room. (Treating the y
operand as pixels collapses the screen into its top ~99 rows.)

### `drawObject` always sets state

`o5_drawObject`'s whole job is to make an object visible, so it sets
`state = 1` by default (only `SO_IMAGE` overrides the value). A bare or
`SO_AT` `drawObject` on a state-0 (hidden) object reveals it. Close-up
rooms rely on this: ENCD hides every scenery object
(`drawObject … at x,y` then `setState 0`), then reveals a piece later
with a *bare* `drawObject` expecting the flip to state 1.

### The retained draw queue and same-box eviction

The original engine restores the background strips under an object's box
on each redraw, so a fresh `drawObject` *erases* the previous frame —
only the latest shows. Our queue is retained (every queued object redraws
each frame), and MI1 animates background fixtures as **several
single-frame objects that share one bounding box** (the swinging
chandelier pirate, table pirates: ids 357/358 share `(32,120) 40×24`;
354/355/356 share `(208,96)`), cycled by a loop's bare `drawObject`.
Without intervention they all accumulate and the fixture freezes after
one cycle. **Fix:** before (re-)queuing a drawn object, evict any
already-queued object covering the **exact same box**, and append the
drawn one last (freshest on top). Exact-box match (not overlap) leaves a
legitimately distinct object resting over a larger fixture untouched.

The eviction must also **revert the overdrawn object's state to 0** — in
SCUMM the strip overwrite erases it, and erased means hidden. The prison's
rat-hole (room 31, three local-#207 loops) is the witness: each loop
re-picks one of the hole's three same-box frames *whose state is 0* and
draws it. `drawObject` sets the drawn frame to state 1; without the revert
all three latch at 1 after one pass and the picker spins forever (the VM
froze on a 100k-step guard). With it, the displaced frame returns to the
pick pool and the animation cycles like the original.

### `setState` renders too

Setting an object's state to a non-zero, image-backed value marks it
dirty in SCUMM → it redraws. So `setState` queues a current-room object,
and room (re)entry queues every object already in a non-zero
image-backed state — that keeps an opened door drawn open when you leave
and return, and across save/restore.

### `pickupObject` is four steps, not one

`o5_pickupObject` does *all* of: `putOwner(obj, VAR_EGO)` (inventory
membership = ownership, INPUT §8), `putState(obj, 1)` + mark-dirty,
**`putClass(obj, Untouchable, 1)`**, and `runInventoryScript`. MI1 bakes
pickable items into the room-background SMAP, so the state-1 image is the
*eraser patch* that paints over the baked-in item — pickup must **draw**
the object (queue it), not drop it, or the item lingers on the table. And
the Untouchable class is what makes the now-taken item's room hit-box
stop responding (§7a / `findObject`); omit it and the sprite vanishes yet
you can still click the empty spot. Doing only the draw leaves that
hit-area half open.

## 7a. Object owner, state, and class — the `DOBJ` seed

Three per-object attributes drive interaction, seeded from the index
**`DOBJ`** directory (`.000`) *before* any script runs:

- **owner** — who holds the object. A room-present object defaults to
  `OF_OWNER_ROOM` (**15**), not 0; MI1's sentence script gates the
  walk-to-object approach on `owner == 15`, so a wrong 0 default makes the
  ego never walk over ("can't reach"). Explicit `pickupObject` /
  `setOwnerOf` still win. Inventory membership *is* ownership (see
  INPUT §8).
- **state** — the current image variant (§7; 0 = hidden).
- **class** — a bitmask. The one that matters early is **Untouchable**
  (class 32, bit `1<<31`): SCUMM's `findObject` skips Untouchable
  objects, so they are neither hoverable nor clickable. MI1 ships ~510
  objects initially Untouchable (e.g. the not-yet-docked ship #430, a
  solid sprite sitting in the sea) — a script clears the flag when the
  object becomes interactive. Both the engine's `findObject` and the
  shell's hover pass must honour it.

`DOBJ` decodes to `{owner, state, classMask}` per global id; boot seeds the
non-default rows (owner≠15 / state≠0 / class≠0). The seeded maps are
captured in the save snapshot and re-applied on restore.

**`findObject` selection: source order + the parent chain, never draw
order.** Among the objects whose box contains the point, the **first in
OBCD source order** wins — rooms author nested hotspots *before* their
containers (MI1's store declares "la maniglia" #390 right before its
safe #389, the jail declares each "la serratura" before its cell). Two
gates filter candidates:

- the runtime **Untouchable class** (32), as above — this is how the
  nameless full-shelf "zone" parents (the voodoo shop's #383–385) sit
  early in source order without swallowing their children's hovers;
- the **parent chain**: an object with CDHD `parent` ≠ 0 is hit-testable
  only while its container — the parent-th object *in source order* —
  sits in the required state (`flags` 0x80: set → non-0, clear → 0),
  recursively up the chain. The closed-safe handle (flags clear)
  vanishes the moment the safe opens; the cabin's "il baule" (flags
  set, chained through an untouchable interior zone to "l'armadio")
  appears only once the cupboard opens. An untouchable link still
  *gates* — untouchability hides it from hits, not from being a state
  switch.

Drawn-ness plays no part: a hotspot needs no image, and a drawn
container must not shadow the un-drawn hotspot nested inside it.

**Distance uses the walk-to point, not the image.** `getObjectXYPos`
(and the proximity gate for "is the ego close enough to act?") reads the
object's **walk-to point** (`walkX/walkY` from the OBCD) — the exact spot
`walkActorToObject` sends the ego — *not* the image's top-left. They can
differ by tens of pixels (a door image at `(696,80)` with walk-to
`(715,130)`), so measuring against the image makes the ego arrive yet
still read as too far away. The walk-to point also **follows a SO_AT
reposition** (§7): it's shifted by the object's draw displacement, so for a
repositioned forest tile the ego walks to where the tile *is*, not its
design x. The hit-box (`findObject`) shifts by the same displacement — so
hover/click resolve where the object draws.

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

## 8. Pitfalls cheat-sheet

1. **Forgetting that `IM00` is reserved for the room background** —
   it's a child of `RMIM`, never an OBIM child. Object state 0 is
   the *absence* of an image; the first per-state OBIM child is
   `IM01`.
2. **Reading CDHD's position as pixels instead of 8-pixel units** —
   produces objects positioned 1/8 of where they should be. Same trap
   in reverse for `SO_AT`: its operands are strips, not pixels (§7).
3. **Reading `walkX/walkY` unsigned** — an edge exit's walk-to point
   can be negative; unsigned it sends the actor marching off-room (§2).
4. **Trusting RMHD.numObjects** — that count includes objects with
   only OBCD (no image) and orphans a loader would drop. Trust the
   size of the parsed object map.
5. **Drawing a queued object whose state is 0** — by spec, state 0
   means hidden. Scripts often explicitly set an object's state to
   0 immediately before a cutscene to remove a piece of scenery
   that's about to be replaced by a sprite.
6. **Trimming the `@` padding out of OBNA** — skip it at render time
   instead; `setObjectName` needs the slack and the sentence line
   needs the stored bytes (§5).
7. **Skipping the same-box eviction (or its state revert)** — animated
   fixtures freeze after one cycle, and same-box pickers spin the VM
   into the step guard (§7).
8. **Defaulting object owner to 0** — a room object's default owner is
   15 (`OF_OWNER_ROOM`); the sentence script's approach gate reads it
   (§7a).
9. **Ignoring the Untouchable class in hit-tests** — taken items stay
   clickable as ghosts, and ~510 not-yet-active MI1 objects become
   hoverable too early (§7a).
10. **Measuring object distance to the image instead of the walk-to
    point** — the ego arrives and still reads "too far"; held items
    measure to their holder (§7a).
11. **Reading CDHD flags 0x80 as "untouchable", or `parent` as an
    object id** — 0x80 is the *required parent state* and `parent` a
    1-based source-order index; misread them and the cabin's chest is
    permanently dead and the safe's handle never resolves (§2, §7a).
12. **Letting draw order drive the object hit-test** — a drawn
    container shadows the un-drawn hotspot nested inside it (the safe
    over its handle); selection is source order + the parent chain,
    draw-agnostic (§7a).
