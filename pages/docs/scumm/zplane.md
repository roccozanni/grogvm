# SCUMM v5 ZP## — Z-Plane Masks

The `ZP##` blocks hold the room's foreground occlusion masks: 1-bit-
per-pixel bitmaps that tell the compositor when an actor pixel should
be hidden behind room geometry. A room has zero or more z-planes,
named `ZP01`, `ZP02`, `ZP03`, … in source order, and they're stored
alongside the room's background image under `RMIM > IM00`.

The encoding is close cousin to SMAP — same strip decomposition, same
header-inclusive offset convention — but the per-strip compression is
much simpler: a single byte-level packbits-style RLE instead of SMAP's
two-flavor palette-walk bit grammar.

This is a self-contained reference derived from reverse-engineering
real MI1 data, cross-checked against the format spec. Where it
disagrees with what real game data actually decodes to, the data is
the source of truth and we document the correction.

## Sources

- ScummVM Technical Reference — Image resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Image_resources>.
  Same wiki page that documents SMAP; the z-plane section describes
  the packbits-RLE shape, the per-strip offset table, and the
  "any plane above actorZ hides" composite rule.

---

## 1. Where Z-planes live

Inside a SCUMM v5 resource file (`MONKEY.001` / `MONKEY2.001`):

```
LECF                top-level container
└── LFLF            one bundle per "disk"
    └── ROOM        room data
        └── RMIM    room image container
            ├── RMIH    z-plane count (2 bytes)
            └── IM00    primary image group
                ├── SMAP    background bitmap
                ├── ZP01    ← THIS DOCUMENT (one of these per active z-plane)
                ├── ZP02
                └── …
```

The naming convention starts at `ZP01`, not `ZP00`. `ZP00` is not used
in any v5 room we've looked at; the background bitmap occupies that
"slot" conceptually (the room's depth-band-0 surface).

---

## 2. RMIH — the plane count

`RMIH` is a fixed 2-byte block. Its only field is a u16 little-endian
that gives the number of z-planes the engine should expect for this
room. A room with `RMIH = 01 00` has one z-plane (`ZP01`); `RMIH = 02
00` declares two (`ZP01` + `ZP02`); `RMIH = 00 00` declares none and
the `IM00` will contain just the `SMAP`.

### ⚠️ Declared count vs. populated planes

The RMIH count is what the engine *allocates* for, not necessarily
what carries real data. A room can declare two planes but ship a
`ZP02` whose strips are all empty (see §6 for what "empty" looks like
on the wire). The decoder surfaces both numbers — the declared count
and the actual number of populated planes; a quick check against MI1
data confirms they sometimes diverge — for example MI1
LFLF #6 declares 2 planes but every strip of its `ZP02` is the
all-zero sentinel encoding, so the plane occludes nothing.

---

## 3. ZP## payload layout

```
┌──────────────────────────────────┬───────────────┐
│ stripCount × uint16 LE offsets   │ strip bodies  │
└──────────────────────────────────┴───────────────┘

stripCount = roomWidth / 8
```

Same vertical-strip decomposition as SMAP: a 320-wide room has 40
strips, each 8 pixels across and `roomHeight` pixels tall. Strips are
independent — they can be decoded in any order.

### ⚠️ The offset gotcha (same as SMAP)

Each `uint16` in the offset table is stored **relative to the start of
the ZP## block including its 8-byte block header**, not relative to
the payload. To turn an offset into a payload-relative position,
subtract 8.

```
encoder writes:    offset = 8 + tableSize + sumOfPreviousStripSizes
decoder seeking
into payload:      seek_pos = offset - 8
```

The first non-sentinel strip's offset is therefore `8 + 2 ×
stripCount` (= 88 for a 320-wide room with 40 strips).

**Symptom of getting this wrong**: every strip body looks like it
starts mid-stream — the first few bytes decode as nonsense run/
literal ops and the byte count never matches `roomHeight`.

### ⚠️ Offset 0 is a sentinel for an implicit all-zero strip

A strip-offset value of literally `0` does **not** mean "starts at
byte 0 of the block" — it means "this strip is entirely zero and has
no body written anywhere". The decoder must skip it: leave the
corresponding 8-column region of the mask zeroed and don't consume any
RLE bytes. The original engine reportedly handles these specially too;
for our purposes, "all-pass-through" is the correct semantics.

This convention lets a plane that's mostly empty (e.g. one that masks
only a single object in the corner of the room) ship with most of its
strips as 2 bytes of offset table and no body at all, instead of
paying for 40 strip bodies of "144 zero bytes" runs.

The decoder builds a parallel list of strip starts where a sentinel
marks an empty (skipped) strip. Body lengths come from looking ahead to
the next real entry, falling back to the payload end for the last one.

---

## 4. Strip body — the RLE

Each non-sentinel strip body decodes to exactly `roomHeight` bytes.
One byte per row of the 8-pixel-wide strip, **MSB-first within the
byte** — bit 7 is the leftmost pixel of the strip, bit 0 the
rightmost.

The RLE is byte-level packbits:

```
read byte op:
  op & 0x80 set   →  run:     read 1 more byte data;
                              emit (op & 0x7F) copies of data
  op & 0x80 clr   →  literal: read (op) more bytes;
                              emit them as-is
```

Both branches consume bytes until the strip has produced `roomHeight`
bytes; then decoding for that strip stops. (Real strips end exactly
on a row boundary — there's no "decode beyond `roomHeight`" case.)

### Worked example

The first strip body of `ZP01` in MI1 room 1 (200 rows tall) is the
following 39 bytes:

```
85 00 0f 01 0d 03 0d 00 40 20 04 48 84 60 80 40
04 02 83 00 02 02 05 8f 00 01 04 85 00 05 01 20
11 02 01 ff 00 96 00
```

Decoding it byte by byte:

| Op | Effect                          | Rows emitted |
|----|---------------------------------|--------------|
| `85` `00` | run of 5 × `0x00`        | 5            |
| `0f` …    | literal of 15 bytes       | 15           |
| `83` `00` | run of 3 × `0x00`        | 3            |
| `02` …    | literal of 2 bytes        | 2            |
| `8f` `00` | run of 15 × `0x00`       | 15           |
| `01` `04` | literal of 1 byte         | 1            |
| `85` `00` | run of 5 × `0x00`        | 5            |
| `05` …    | literal of 5 bytes        | 5            |
| `ff` `00` | run of 127 × `0x00`      | 127          |
| `96` `00` | run of 22 × `0x00`       | 22           |

Total: 200 rows. ✓ Byte count consumed: exactly the strip's 39 bytes,
nothing left over.

The pattern is typical: a few clusters of literal bytes in the upper
portion of the strip (where the foreground geometry sits) followed by
one or two big runs of zeros to fill the rest of the column (the
walkable floor area below).

### Why packbits and not something fancier?

Z-plane bits are dense in narrow vertical bands and very sparse
everywhere else. A door-frame outline produces ~30 non-zero rows in
the upper third of a column followed by ~170 zero rows below it.
Packbits compresses that to "a handful of literal/short-run bytes for
the detail, then one long run of zeros". SMAP needs a richer scheme
because background pixels are nuanced (gradients, dithering, palette
walks); z-planes only need 1 bit per pixel, and most pixels of a
foreground mask are either "all the same" or "raw detail" — the two
cases packbits excels at.

---

## 5. Bit layout within an emitted byte

Each decoded byte covers the 8 pixels of one row of the strip. The
convention is **MSB-first**:

```
emitted byte:        bit 7  bit 6  bit 5  bit 4  bit 3  bit 2  bit 1  bit 0
strip pixel column:    0      1      2      3      4      5      6      7
```

So byte `0x80` (`0b1000_0000`) marks the leftmost pixel of the strip
only; `0x01` marks the rightmost; `0xFF` marks all eight; `0x42` marks
columns 1 and 6 of the strip.

**Verification**: overlay the decoded plane on the room background in
the player UI. If the bit order is inverted you'll see the overlay
mirrored within each 8-pixel column band — door-frame edges appear as
jagged stair-step patterns at strip boundaries instead of clean
silhouettes. MI1 rooms have plenty of vertical foreground geometry
(palm trunks, door frames, masthead beams) that make this an obvious
sanity check.

---

## 6. Compositor semantics — the single-plane rule

A room with `N` z-planes exposes `N` foreground masks `ZP01`…`ZP0N`.
Each actor carries a 1-based **clip level** (SCUMM's `_zbuf`); the
default is `0` ("in front of everything").

### The drawing rule

When the compositor writes an actor pixel at room position (x, y):

> The pixel is hidden iff the actor's **own clip-level plane** —
> `ZP0k` for clip level `k` — has its bit set at (x, y). No other
> plane is consulted.

Equivalently:

- Actor at clip level `0` is never occluded (in front of every plane).
- Actor at clip level `1` is masked by `ZP01` **alone**.
- Actor at clip level `2` is masked by `ZP02` **alone**. Etc.

This mirrors SCUMM exactly: the costume renderer masks an actor
against the *single* mask buffer selected by `_zbuf` — it is **not** a
cumulative "any plane above" stack. The earlier cumulative reading
happened to agree on every MI1 room we'd seen because those rooms
either had one real plane or an empty `ZP02` (§"empty planes"). MI1
**room 30** broke it: there `ZP02 ⊇ ZP01` (`ZP01` is just the
foreground barrels; `ZP02` adds the loft railing + stairs). A floor
actor sits at clip level 1, so under the single-plane rule it is
masked by `ZP01` only and walks *in front* of the stairs — exactly
right. The cumulative rule masked it by `ZP01 ∪ ZP02` and drew
Guybrush behind the staircase banister.

### How an actor gets its clip level

`clipLevel = forceClip > 0 ? forceClip : (NeverClip class ? 0 :
walkBoxMask)`. `alwaysZclip k` sets `forceClip = k`; `neverZclip`
(and `followBoxes` / `ignoreBoxes`) clear it to 0 (an *unset* sentinel,
**not** "in front" — it falls through to the box mask); the actor's
assigned walk box (`_walkbox`) supplies the default (`mask 0` = in front,
`mask k` = `ZP0k`).

### Why some pixels are marked in multiple planes

Because masking is single-plane, a feature that must occlude actors at
*several* clip levels has to appear in *each* of those planes — so the
data marks the same pixel in `ZP01` and `ZP02` deliberately (and a
"deeper" plane is typically a superset of the shallower ones, as in
room 30). This is the artist's depth-stack ledger: each plane fully
describes the foreground for actors at that one level. The compositor
needs no special handling — it only ever reads the actor's own plane.

### Why some planes are entirely empty

`ZP02` in MI1 LFLF #6 declares itself in RMIH (`02 00`) but every
strip in the block is the offset-0 sentinel or a tiny "run of
height-many zeros". No bit anywhere is set. Toggling it in the player
UI tints nothing.

This is the artist's prerogative: `RMIH = 02` may reflect "scripts in
this scene position actors at z=0 and z=1" without there being any
foreground geometry that specifically needs to mask the z=1 actors.
The empty plane is harmless — the compositor walks it, finds nothing
set, and moves on. We surface both `declaredCount` and
`planes.length` in the decoded output so the divergence is visible.

---

## 7. Pitfalls cheat-sheet

In rough order of "what hits you first":

1. **Strip offsets look way too big / way too small** → header-
   inclusive convention. Subtract 8 from every raw u16 in the offset
   table to get a payload-relative position.
2. **Decoder crashes on a strip with offset = 0** → `0` is the
   "implicit all-zero strip" sentinel. Skip it; that 8-column region
   of the mask stays zeroed. The body for that strip doesn't exist
   anywhere in the payload.
3. **Strip body decoded byte count ≠ roomHeight** → either the offset
   handling is wrong (#1) or the RLE dispatch is reversed (high bit =
   literal instead of run, or vice versa). High bit set = run.
4. **Overlay is mirrored within each 8-pixel column** → bit order
   inside the emitted byte is wrong. MSB (bit 7) = leftmost pixel of
   the strip.
5. **Overlay is shifted vertically** → strip body packing is wrong.
   Each emitted byte is one *row* of the strip; the byte's 8 bits are
   the 8 *columns* within that row. Not the other way around.
6. **A declared plane shows up empty in the overlay** → that's
   correct. Real MI1 rooms have it. The RMIH count is what the engine
   allocates for, not a guarantee that every plane carries pixels.
7. **The same pixel is marked in multiple planes** → also correct.
   Masking is single-plane, so a feature occluding actors at several
   clip levels is marked in each of those planes (deeper planes are
   often supersets). The compositor only reads the actor's own plane.
8. **The compositor draws the actor over geometry it should hide
   behind (or behind geometry it should be in front of)** → wrong
   clip level, or the cumulative "any plane above" rule crept back in.
   The rule is single-plane: an actor at clip level `k` is masked by
   `ZP0k` **alone** — never by `ZP0(k+1)` and up. A floor actor at
   level 1 in a room where `ZP02 ⊇ ZP01` must stay in front of the
   `ZP02`-only geometry (MI1 room 30 stairs).
9. **A drawn object occludes the actor in the wrong place** → its
   z-plane was applied at the object's design `imhd.x/y` instead of its
   current (SO_AT) position. Object z-planes move with the object (see
   "Per-object z-planes").
10. **A drawn object buries the actor everywhere it overlaps** → the
    object's z-plane is fully set (a solid-fill mask, not a silhouette)
    and wasn't dropped. The loader drops all-1s **object** z-planes; only
    shaped masks occlude. Room 58's path trunks are the case.
11. **A drawn object hides a floor (clip-1) actor it shouldn't** → the
    object's mask lives in `ZP02` (plane 2) but was OR'd into plane 1 (the
    old single-plane collapse). An object `ZP0k` targets plane `k` alone, so
    only a clip-`k` actor is masked by it. The general-store wall items
    (room 30) are the case — `ZP01` empty, mask in `ZP02`. See "Each ZP##
    targets its own plane".

---

## 8. Actor z-depth — `forceClip` (actorOps neverZclip / alwaysZclip)

The compositor's rule is "any plane whose 1-based index > `actorZ` hides
the pixel." The per-actor `actorZ` comes from the actor's **`forceClip`**
combined with the **NeverClip class** and the **walk-box mask**. SCUMM's
resolution order is:

```
zbuf = _forceClip != 0 ? _forceClip
     : neverClipClass  ? front           // NeverClip object class (20)
     :                   maskFromBox(_walkbox)
```

| condition                              | `actorZ`         | effect                              |
|----------------------------------------|------------------|-------------------------------------|
| `alwaysZclip k` (0x13) → `forceClip k` | `k − 1`          | behind plane `k` and above          |
| NeverClip class, `forceClip ≤ 0`       | `planeCount`     | always in front (no plane occludes) |
| else (`forceClip ≤ 0`)                 | box-mask derived | see "Box-mask" below                |

> ⚠️ **`forceClip == 0` is NOT "always in front".** The `neverZclip`
> (0x12) opcode sets `forceClip = 0`, which is SCUMM's *not-forced*
> sentinel — it merely **clears** a previously-forced clip. A
> `forceClip == 0` actor behaves identically to the never-set `-1`
> default: its depth falls through to the NeverClip class or the walk-box
> mask. We previously read `0` as a front flag, which wrongly kept the ego
> drawn over every building (the ego is left `forceClip == 0` in every
> room). What actually keeps a decorative actor unconditionally in front
> is the **NeverClip class**, not `forceClip`.

> ⚠️ **`initActor` (actorOps SO_DEFAULT, 0x08) must clear `forceClip`.**
> SCUMM's `initActor` resets the forced clip, so an actor reusing a slot that an
> earlier scene left at `alwaysZclip k` comes back to box-derived depth on a
> plain `init`. Room 51 inits the Fettucini brothers (costume 27) with no zclip
> op; without the reset they inherited `forceClip = 1` from a prior occupant and
> the left brother drew **behind the haystack crate** in ZP01. We set
> `forceClip = 0` on init (the not-forced sentinel, ≡ the `-1` default for
> depth). Verified by rendering room 51. (`initActor` likewise resets
> `ignoreBoxes = false`, scale to `0xFF`, and the actor's `_walkbox` to the
> unassigned `-1` — the same "clear stale per-actor flags" rule; a stuck
> `ignoreBoxes` otherwise froze perspective scaling across rooms, see
> [WALK-BOXES](walk-boxes.md). The `_walkbox` reset matters for the room-51
> cannon actor — init'd then immediately `ignoreBoxes`, it must not fly with a
> prior scene's box; see "Box-mask" below.)

> ⚠️ **`followBoxes` / `ignoreBoxes` (actorOps 0x15 / 0x14) also reset
> `forceClip = 0`.** Both opcodes return the actor to box-driven *everything*,
> depth included — not just box-following. The **room-28 cook** (actor 6) is the
> case: its patrol (local #216) restores it with `{followBoxes}` and *never*
> issues `neverZclip`, but ENCD had left it at `alwaysZclip = 1`. Without the
> reset, `forceClip` stayed pinned at 1 and the cook was masked by ZP01 (the
> bar table) for its whole wander — drawn *behind* the table. With the reset it
> runs `forceClip = 0` (box-driven) across the wander, snapping back to 1 only
> at the kitchen-doorway entry/exit where the script explicitly sets
> `{ignoreBoxes; alwaysZclip = 1}`. Every MI1 `ignoreBoxes` pairs with a
> trailing explicit clip op in the same call (which wins), so the reset is
> observable only on a bare `{ignoreBoxes}` / `{followBoxes}`. User-confirmed
> in-browser.

`alwaysZclip k` → `actorZ = k − 1` so that "plane index > actorZ" makes
plane `k` (and higher) occlude the actor while planes below `k` don't.
The **Mêlée-island clouds** (room 10, costume 59) set `alwaysZclip 1`
(explicit, `forceClip = 1`), so `actorZ = 0` and the single mountain
z-plane (ZP01) draws over them — the clouds pass *behind* the mountain.
The LucasArts sparkles stay in front via the NeverClip **class** (their
`neverZclip` opcode only clears the clip). Verified headlessly: a cloud
parked over the mountain peak draws 0 pixels where ZP01's mask is set.

### Box-mask — the position-derived default clip

An actor that is **not forced** (`forceClip ≤ 0`: the never-set `-1`
default *or* `forceClip == 0` from `neverZclip`) and is **not in the
NeverClip class** derives its clip band from the **`mask` byte of its
assigned walk box** (`_walkbox`, see below):

| box `mask` | `actorZ`         | effect                              |
|------------|------------------|-------------------------------------|
| `0`        | `planeCount`     | in front of every plane             |
| `N` (>0)   | `N − 1`          | behind plane `N` and above          |

i.e. the *same* mapping as `alwaysZclip k`. An explicit `alwaysZclip`
(`forceClip > 0`) always wins. Verified empirically: room 38's behind-wall
sentries set `alwaysZclip 1` *explicitly* even though they stand in a
mask-0 box — so the engine's precedence (script flag over box default)
is real. The **ego** is the box-default case in practice: it carries
`forceClip == 0` everywhere, so its occlusion is entirely box-driven —
mask-1 dock boxes in **room 33** put it behind the houses, while its
mask-0 box in **room 38** keeps it in front of the wall. Box masks seen
in MI1: `0`/`1`/`2` (rooms 10/38/33).

**`_walkbox` is walk state, not a draw-time lookup.** Like SCUMM, the
actor stores the box it is *assigned to* (`actor.walkBox`) and maintains
it as it moves; the compositor reads that stored box and maps its `mask`
→ `actorZ`. The box is **assigned** (not at draw time) in the one place
that resolves a box from position — the movement/placement seam
(`rescaleActorForPosition`, shared with the scale system, so scale and
z-clip always agree) — using a **nearest-box** lookup, not a strict
point-in-box test: MI1's room-33 dock is built from thin *diagonal line*
boxes (e.g. box 4, UL==UR and LR==LL) that strictly contain no interior
point, so a strict lookup returned `null` → front (the old occlusion gap).
The nearest-box fallback yields the box the actor walks on.

An `ignoreBoxes` actor is **not** re-assigned as it moves, so it keeps its
last box — and `initActor` clears `_walkbox` to `-1` (unassigned → front).
**Room 51's cannon launch** is the case that pins this down: the airborne
actor (actor 11, costume 40) is init'd then set `ignoreBoxes; neverZclip`
*before* any placement, and flies/falls over the tent pole at y≈48. Because
init left its `_walkbox` at `-1` and `ignoreBoxes` freezes it there, it
resolves to front and arcs over the pole correctly — without the
draw-time box lookup that used to snap it to box 7 (mask 1) and let ZP01
(the pole) mask it, making Guybrush *vanish*. An explicit `alwaysZclip`
still wins above. (This replaced an `if (ignoreBoxes) return front` escape
hatch in the clip resolver: the `-1`-on-init sentinel makes it unnecessary,
and a non-`ignoreBoxes` actor standing off all boxes no longer mis-resolves
either — it keeps whatever box it was last assigned.)

Validated headlessly: a `forceClip`-cleared actor parked in any mask-1 box
of room 38 draws **0 pixels over the wall mask (ZP01)** — occluded behind
the wall — while a mask-0 box leaves it in front.

**Point-in-box and the two degenerate-box traps.** Walk boxes are
convex quads (corners UL→UR→LR→LL), so a point is inside when every
edge cross-product shares a sign. Two MI1 realities break a naive test:

- **SCUMM's invalid box 0.** MI1 ships box 0 with all four corners at
  `(-32000, -32000)` — a reserved "no box" sentinel. Every cross-product
  reads 0, so a naive sign test claims *every* point and a naive lookup
  would always resolve box 0. Detecting the all-collinear case and falling
  back to a corners' bounding-box test, which the `(-32000)` point fails
  for any real room coordinate.
- **Zero-area line boxes.** Room 38's box 1 is a *horizontal segment*
  (`UL==LL`, `UR==LR`, y=106); room 33's staircase boxes are diagonal
  lines. The same bounding-box fallback keeps on-segment points inside
  while rejecting off-line points (mixed cross-product signs).

**Known limitation — thin connector boxes + the line-following walker.**
Tracking `_walkbox` as walk state (above) removed the *draw-time* re-derivation,
but the box is still **assigned** from pixel position at each movement step
(`findBoxAtOrNearest`, a nearest-box fallback mirroring SCUMM's
`adjustXYToBeInBox`). On thin diagonal *connector* boxes the actor can step a
pixel or two off the box line and be assigned the wrong box — the same gap that
makes the room-52 bridge crossing fragile (see
[PATHFINDING §9](../engine/pathfinding.md)). The remaining faithful fix is the
**line-following walker** (`stepWalk` steps X/Y independently; SCUMM moves along
the line), which keeps the actor on the box line so the assignment is right;
deferred.

## Per-object z-planes — drawn objects occlude actors

Objects carry their own z-planes too: ~half of MI1's `OBIM` blocks
contain a `ZP##` inside their `IMxx` image. When a script `drawObject`s
such an object, that z-plane can make the object a **foreground** that
occludes z-clipped actors — exactly how the **MI1 title logo** (room 10,
object #109, a 224×120 image with an 8739-bit z-plane, ~33% set) sits in *front*
of the drifting cloud actors (room 10's costume-59 clouds at
`forceClip = 1` → `actorZ = 0`, hidden where the logo's mask is set).

- The object loader decodes **each** `ZP0k` chunk of an `IMxx` into its own
  plane, indexed by ordinal (`ZP01` → plane 1, `ZP02` → plane 2, …) — the
  same `ZP0k → plane k` mapping the room planes use (sized to the object's
  `imhd.width × height`; width must be a multiple of 8, else skipped). It
  does **not** OR the chunks into one mask — see "Each ZP## targets its own
  plane" below for why that was wrong.
- The compositor ORs each **drawn** object's `ZP0k` into room plane `k` at
  the object's runtime position, then applies the single-plane rule: a
  clip-`k` actor is masked by plane `k` alone. So a `forceClip = 1` /
  box-mask-1 actor is hidden behind an object's `ZP01` but **not** its
  `ZP02`; an in-front actor (`neverZclip` class / `actorZ = effective plane
  count`) by neither. If an object targets a plane the room itself lacks,
  the merged stack is extended so a clip-`k` actor still has a plane `k` to
  test.
- The z-plane — not the object's image opacity — is the occlusion
  authority (faithful to SCUMM), so a few title *edge* pixels the
  authored mask doesn't cover can still show a cloud; that matches the
  original's masking.

### Each ZP## targets its own plane — not a single merged foreground

A multi-`ZP##` object is a depth ledger just like a multi-plane room: its
`ZP0k` describes the foreground for actors at clip level `k` *alone*.
**MI1's general store (room 30)** is the case that forces this. The wall
items — the sword (#388), shovel (#396), safe (#389), handle (#390) — carry
their occlusion mask **only in `ZP02`** (their `ZP01` is empty). The clip-2
shopkeeper passes behind them; the clip-1 ego, who walks to the shelf to buy
them, must pass *in front*. Merging every object chunk into plane 1 (the old
behaviour) clipped 125 px of ego's upper body behind the sword and never
occluded the clip-2 shopkeeper it should have. Targeting `ZP0k → plane k`
fixes both directions. (Most MI1 objects carry a single `ZP01`, so this only
changes the ~80 multi-`ZP##` objects in rooms 7, 8, 30, 59, 69, 70.)

### At the object's *current* position, not its design x/y

The mask is applied at the object's **runtime** position. `drawObject …
at x,y` (SO_AT) moves an object — both operands are in **strips**, so the
position is `(x·8, y·8)` — and the image, *its z-plane*, the hit-box, and
the walk-to point all move with it (see [OBJECTS §7](objects.md)). MI1's
forest maze (room 58) is the case that forces this: each "screen" is
composed by repositioning a shared set of tile objects, so an object's
z-plane must occlude where the object actually draws, not at its design
`imhd.x/y`.

### A fully-set object mask is dropped (⚠️ tentative heuristic)

Genuine foreground occluders are *shaped* masks (the title logo ~33% set;
the forest foliage ~40–53%) — transparency around the silhouette. An object
z-plane that is **fully set** (every bit 1 over the whole bounding box) is
**dropped** by the loader (decodes to no plane) so it never occludes actors.
Room 58's "il sentiero" path trunks (objs 685/686/687) carry such all-1s
masks: ego walks *in front* of them, while the shaped foliage masks (671/673)
still occlude. Without the drop, every path trunk buried ego wherever it
overlapped.

> ⚠️ **This drop is a heuristic, not a confirmed engine rule.** It keys on the
> only signal that separates occluders from non-occluders in MI1 — object masks
> are cleanly bimodal (shaped <95% vs solid 100%, nothing between; the 36 solid
> ones are all non-occluders: the forest path, the store door, levers, the
> vase). But *why* the original engine ignores a fully-solid object z-plane is
> unknown — the answer is in its object-mask write path. Ruled out as the cause
> (object class, the `ZP0k → plane k` index, image transparency — the trunks are
> opaque color-0, not transparent — and the actor's walk-box clip plane), so a
> future object-occlusion oddity should suspect *this drop* before those.

> The drop applies to **object** z-planes only. Room z-planes (`ZP01`…) are the
> room's authored foreground and are never dropped — a room plane can
> legitimately be dense.
