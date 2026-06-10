# SCUMM v5 ZP## — Z-Plane Masks

The `ZP##` blocks hold the room's foreground occlusion masks: 1-bit-
per-pixel bitmaps that tell the compositor when an actor pixel should
be hidden behind room geometry.

## At a glance

```
     ZP01         ZP02         ZP03 …       one 1-bit mask per plane,
   ┌────────┐   ┌────────┐                  stored like SMAP: vertical
   │ ▒▒     │   │ ▒▒▒▒   │                  8-px strips, simple RLE
   └────────┘   └────────┘

   an actor carries ONE clip level k, and is masked by ZP0k ALONE:

      clip 0 → in front of every plane
      clip 1 → hidden where ZP01 is set — ZP02 is never consulted
      clip 2 → hidden where ZP02 is set — ZP01 is never consulted

   it is NOT a cumulative "every plane above me hides me" stack (§6)
```

A room has zero or more z-planes, named `ZP01`, `ZP02`, `ZP03`, … in
source order, stored alongside the room's background image under
`RMIM > IM00`. The encoding is close cousin to SMAP — same strip
decomposition, same header-inclusive offset convention — but the
per-strip compression is much simpler: a single byte-level
packbits-style RLE instead of SMAP's two-flavor palette-walk bit
grammar.

This is a self-contained reference derived from reverse-engineering
real MI1 data, cross-checked against the format spec. Where it
disagrees with what real game data actually decodes to, the data is
the source of truth and we document the correction.

## Sources

- ScummVM Technical Reference — Image resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Image_resources>.
  Same wiki page that documents SMAP; the z-plane section describes
  the packbits-RLE shape, the per-strip offset table, and the
  composite rule.

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
on the wire). The two numbers genuinely diverge in MI1 data — for
example MI1 LFLF #6 declares 2 planes but every strip of its `ZP02` is
the all-zero sentinel encoding, so the plane occludes nothing.

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
RLE bytes. The original engine handles these specially too; the
correct semantics is "all-pass-through".

This convention lets a plane that's mostly empty (e.g. one that masks
only a single object in the corner of the room) ship with most of its
strips as 2 bytes of offset table and no body at all, instead of
paying for 40 strip bodies of "144 zero bytes" runs.

Strip body lengths are not stored anywhere: a body runs from its
offset to the next non-sentinel offset in the table, and the last one
runs to the end of the payload.

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

**Verification**: overlay the decoded plane on the room background.
If the bit order is inverted you'll see the overlay
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
cumulative "any plane above" stack. A cumulative reading agrees by
accident in most rooms (one real plane, or an empty `ZP02` —
§"empty planes"), which is what makes it a tempting wrong turn. MI1
**room 30** settles it: there `ZP02 ⊇ ZP01` (`ZP01` is just the
foreground barrels; `ZP02` adds the loft railing + stairs). A floor
actor sits at clip level 1, so under the single-plane rule it is
masked by `ZP01` only and walks *in front* of the stairs — exactly
right. The cumulative rule masks it by `ZP01 ∪ ZP02` and draws
Guybrush behind the staircase banister.

### Actor over actor — paint order, not planes

Z-planes settle actor-vs-*room* depth only. Actor-vs-actor depth is
paint order: actors draw back-to-front by room `y` — greater `y` is
nearer the camera and paints last — with actor id breaking ties at
equal `y`. This is what draws Guybrush over the seated SCUMM-Bar
pirates: standing in front of their table, his feet are lower in the
room, so he sorts later and paints on top.

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
height-many zeros". No bit anywhere is set.

This is the artist's prerogative: `RMIH = 02` may reflect "scripts in
this scene position actors at z=0 and z=1" without there being any
foreground geometry that specifically needs to mask the z=1 actors.
The empty plane is harmless — the compositor walks it, finds nothing
set, and moves on.

---

## 7. Actor z-depth — `forceClip` (actorOps neverZclip / alwaysZclip)

The per-actor clip level the single-plane rule (§6) reads comes from
the actor's **`forceClip`** combined with the **NeverClip class** and
the **walk-box mask**. SCUMM's resolution order is:

```
zbuf = _forceClip != 0 ? _forceClip
     : neverClipClass  ? front           // NeverClip object class (20)
     :                   maskFromBox(_walkbox)
```

| condition                              | clip level       | effect                              |
|----------------------------------------|------------------|-------------------------------------|
| `alwaysZclip k` (0x13) → `forceClip k` | `k`              | masked by `ZP0k` alone              |
| NeverClip class, `forceClip ≤ 0`       | front            | always in front (no plane occludes) |
| else (`forceClip ≤ 0`)                 | box-mask derived | see "Box-mask" below                |

The **Mêlée-island clouds** (room 10, costume 59) set `alwaysZclip 1`
(explicit, `forceClip = 1`), so the single mountain z-plane (ZP01)
draws over them — the clouds pass *behind* the mountain. The
LucasArts sparkles stay in front via the NeverClip **class** (their
`neverZclip` opcode only clears the clip).

> ⚠️ **`forceClip == 0` is NOT "always in front".** The `neverZclip`
> (0x12) opcode sets `forceClip = 0`, which is SCUMM's *not-forced*
> sentinel — it merely **clears** a previously-forced clip. A
> `forceClip == 0` actor behaves identically to the never-set `-1`
> default: its depth falls through to the NeverClip class or the walk-box
> mask. Reading `0` as a front flag keeps the ego drawn over every
> building — the ego carries `forceClip == 0` in every room. What
> actually keeps a decorative actor unconditionally in front is the
> **NeverClip class**, not `forceClip`.

**Fine print — two more opcodes reset `forceClip`:**

- **`initActor` (actorOps SO_DEFAULT, 0x08) clears `forceClip`.**
  SCUMM's `initActor` resets the forced clip, so an actor reusing a slot
  that an earlier scene left at `alwaysZclip k` comes back to box-derived
  depth on a plain `init`. Room 51 pins it: the Fettucini brothers
  (costume 27) are init'd with no zclip op — without the reset they
  inherit `forceClip = 1` from a prior occupant and the left brother
  draws **behind the haystack crate** in ZP01. (`initActor` likewise
  resets `ignoreBoxes = false`, scale to `0xFF`, and the actor's
  `_walkbox` to the unassigned `-1` — the same "clear stale per-actor
  flags" rule; a stuck `ignoreBoxes` freezes perspective scaling across
  rooms, see [WALK-BOXES](walk-boxes.md). The `_walkbox` reset matters
  for the room-51 cannon actor — init'd then immediately `ignoreBoxes`,
  it must not fly with a prior scene's box; see "Box-mask" below.)
- **`followBoxes` / `ignoreBoxes` (actorOps 0x15 / 0x14) also reset
  `forceClip = 0`.** Both opcodes return the actor to box-driven
  *everything*, depth included — not just box-following. The **room-28
  cook** (actor 6) is the case: its patrol (local #216) restores it with
  `{followBoxes}` and *never* issues `neverZclip`, but ENCD had left it
  at `alwaysZclip = 1`. Without the reset, `forceClip` stays pinned at 1
  and the cook is masked by ZP01 (the bar table) for its whole wander —
  drawn *behind* the table. With the reset it runs `forceClip = 0`
  (box-driven) across the wander, snapping back to 1 only at the
  kitchen-doorway entry/exit where the script explicitly sets
  `{ignoreBoxes; alwaysZclip = 1}`. Every MI1 `ignoreBoxes` pairs with a
  trailing explicit clip op in the same call (which wins), so the reset
  is observable only on a bare `{ignoreBoxes}` / `{followBoxes}`.

### Box-mask — the position-derived default clip

An actor that is **not forced** (`forceClip ≤ 0`: the never-set `-1`
default *or* `forceClip == 0` from `neverZclip`) and is **not in the
NeverClip class** derives its clip band from the **`mask` byte of its
assigned walk box** (`_walkbox`, see below):

| box `mask` | clip level | effect                              |
|------------|------------|-------------------------------------|
| `0`        | front      | in front of every plane             |
| `N` (>0)   | `N`        | masked by `ZP0N` alone              |

i.e. the *same* mapping as `alwaysZclip k`. An explicit `alwaysZclip`
(`forceClip > 0`) always wins — room 38's behind-wall sentries pin the
precedence: they set `alwaysZclip 1` *explicitly* even though they stand
in a mask-0 box, so the script flag must beat the box default. The
**ego** is the box-default case in practice: it carries
`forceClip == 0` everywhere, so its occlusion is entirely box-driven —
mask-1 dock boxes in **room 33** put it behind the houses, while its
mask-0 box in **room 38** keeps it in front of the wall. Box masks seen
in MI1: `0`/`1`/`2` (rooms 10/38/33).

**`_walkbox` is walk state, not a draw-time lookup.** The actor stores
the box it is *assigned to* and maintains it as it moves; the compositor
reads that stored box and maps its `mask` → clip level. The assignment
happens at movement/placement (SCUMM's `adjustXYToBeInBox` snaps to the
**nearest** box, not a strict point-in-box hit), and it is the same
assignment perspective scale reads — scale and z-clip always agree. A
strict containment test can't even resolve a box on MI1's room-33 dock,
which is built from thin *diagonal line* boxes (e.g. box 4, UL==UR and
LR==LL) that strictly contain no interior point; the nearest-box snap
yields the box the actor walks on. The box geometry traps (the
`(-32000, -32000)` box-0 sentinel, zero-area line boxes) are covered in
[WALK-BOXES](walk-boxes.md); how GrogVM assigns and routes over boxes in
[PATHFINDING](../engine/pathfinding.md).

An `ignoreBoxes` actor is **not** re-assigned as it moves, so it keeps its
last box — and `initActor` clears `_walkbox` to `-1` (unassigned → front).
**Room 51's cannon launch** is the case that pins this down: the airborne
actor (actor 11, costume 40) is init'd then set `ignoreBoxes; neverZclip`
*before* any placement, and flies/falls over the tent pole at y≈48. Because
init leaves its `_walkbox` at `-1` and `ignoreBoxes` freezes it there, it
resolves to front and arcs over the pole correctly — a draw-time box lookup
would snap it to box 7 (mask 1) and let ZP01 (the pole) mask it, making
Guybrush *vanish* mid-flight. An explicit `alwaysZclip` still wins above.

## 8. Per-object z-planes — drawn objects occlude actors

Objects carry their own z-planes too: ~half of MI1's `OBIM` blocks
contain a `ZP##` inside their `IMxx` image. When a script `drawObject`s
such an object, that z-plane can make the object a **foreground** that
occludes z-clipped actors — exactly how the **MI1 title logo** (room 10,
object #109, a 224×120 image with an 8739-bit z-plane, ~33% set) sits in *front*
of the drifting cloud actors (room 10's costume-59 clouds at
`forceClip = 1`, hidden where the logo's mask is set).

- An object's `IMxx` can carry several `ZP0k` chunks; each is its own
  plane, indexed by ordinal (`ZP01` → plane 1, `ZP02` → plane 2, …) — the
  same `ZP0k → plane k` mapping the room planes use, sized to the object's
  `imhd.width × height`. The chunks are **not** one mask to merge — see
  "Each ZP## targets its own plane" below.
- Each **drawn** object's `ZP0k` is stamped into room plane `k` at the
  object's runtime position — in **draw order, rewriting what was there**
  (see "The mask surface is written in draw order" below) — then the
  single-plane rule applies: a clip-`k` actor is masked by plane `k` alone.
  So a `forceClip = 1` / box-mask-1 actor is hidden behind an object's
  `ZP01` but **not** its `ZP02`; an in-front actor (`neverZclip` class /
  front clip level) by neither. (GrogVM extends the merged
  stack when an object targets a plane the room lacks, so a clip-`k` actor
  always has a plane `k` to test — an engine choice; no MI1 room has
  forced the question.)
- The z-plane — not the object's image opacity — decides which actor
  *pixels* are hidden, so a few title *edge* pixels the authored mask
  doesn't cover can still show a cloud; that matches the original's
  masking. Opacity matters at mask-*write* time instead: it selects
  whether a strip replaces or ORs (below).

### Each ZP## targets its own plane — not a single merged foreground

A multi-`ZP##` object is a depth ledger just like a multi-plane room: its
`ZP0k` describes the foreground for actors at clip level `k` *alone*.
**MI1's general store (room 30)** is the case that forces this. The wall
items — the sword (#388), shovel (#396), safe (#389), handle (#390) — carry
their occlusion mask **only in `ZP02`** (their `ZP01` is empty). The clip-2
shopkeeper passes behind them; the clip-1 ego, who walks to the shelf to buy
them, must pass *in front*. Collapsing every object chunk into plane 1 clips
the ego's upper body behind the sword and never occludes the clip-2
shopkeeper it should; targeting `ZP0k → plane k` gets both directions right.
(Most MI1 objects carry a single `ZP01`; the ~80 multi-`ZP##` ones cluster
in rooms 7, 8, 30, 59, 69, 70.)

### At the object's *current* position, not its design x/y

The mask is applied at the object's **runtime** position. `drawObject …
at x,y` (SO_AT) moves an object — both operands are in **strips**, so the
position is `(x·8, y·8)` — and the image, *its z-plane*, the hit-box, and
the walk-to point all move with it (see [OBJECTS §7](objects.md)). MI1's
forest maze (room 58) is the case that forces this: each "screen" is
composed by repositioning a shared set of tile objects, so an object's
z-plane must occlude where the object actually draws, not at its design
`imhd.x/y`.

### The mask surface is written in draw order — later draws erase earlier masks

The mask planes are a **stateful surface**, exactly like the background
virtual screen the images draw into: an object draw doesn't *overlay* its
z-plane onto a merged stack, it **rewrites the surface in its footprint**,
strip by strip, in draw order. Per 8-px strip:

- A strip with **no transparent image pixel replaces** the mask rows it
  covers — the object's `ZP0k` bits where it has them, **zeros where it has
  no data for plane `k`** (no chunk, or that strip is the offset-0 sentinel).
- A strip **with transparency ORs** its bits in, and leaves planes it has no
  data for untouched.

The room's own planes are just the seed — what the background draw stamps —
and every object drawn after rewrites from there. Two consequences that look
wrong until you know the rule:

- **An object's mask can be erased by a later draw.** A mask only occludes
  while it is the *most recent* opaque draw over its strips.
- **A solid all-1s object mask is real, meaningful data, not an anomaly.**
  MI1's object masks are bimodal (shaped silhouettes vs fully-set), and every
  solid one is a non-occluder *in practice* — not because the engine drops
  solid masks (it doesn't; a solid mask nothing covers occludes just fine)
  but because each one is authored to be drawn under later opaque draws that
  erase it.

**MI1's forest maze (room 58) is the forcing case.** Every walk box there is
`mask = 1` — ego is clip-1 on the whole floor, so box masks can't make one
tile occlude and another not. Every object is fully opaque. The "il sentiero"
exit tiles (#685–688) carry **solid 100% `ZP01` masks**, and each screen's
entry script draws the exits *first*, then six opaque dressing tiles covering
the whole 3×2 tile grid, then the props. The dressing draws erase the exits'
masks — ego walks freely into the path openings — while the shaped rock-band
tiles drawn last keep their bits and occlude ego behind the rock. **Mask
shape was never the occluder/non-occluder rule; draw order plus strip opacity
is.** (One authored sliver survives: the right exit #687 is 24 px wide and
the dressing grid covers only its first two strips, so its solid mask stands
in the rightmost strip, x 312–319 — in the original too.)

The same rule is why the one tile the forest's park-all loop never parks
(#673, dressed on only 6 of the 20 screens) is harmless: on screens that
don't dress it, its persisted nonzero state re-draws it at its design
position, where that screen's dressing tiles — drawn after it — erase its
pixels *and* its mask. The scripters never needed to park it.

Two related non-bugs, same room: the hard vertical seams at the tile
boundaries (x = 104/208) are the authored art, present in the original; and
the room's nearly-empty `ZP01` (2.5%) is fine — the dressing tiles rewrite
virtually the whole surface every screen anyway.

---

## 9. Pitfalls cheat-sheet

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
   current (SO_AT) position. Object z-planes move with the object (§8).
10. **A drawn object buries the actor everywhere it overlaps** → a solid
    (all-1s) object mask survived that a later opaque draw should have
    erased. Masks are written in draw order — an opaque strip *replaces*
    the surface, zeros included — so check stamp order and the per-strip
    opacity test. Room 58's path tiles, parked under the dressing tiles,
    are the case (§8).
11. **A drawn object hides a floor (clip-1) actor it shouldn't** → the
    object's mask lives in `ZP02` (plane 2) but was OR'd into plane 1 (the
    old single-plane collapse). An object `ZP0k` targets plane `k` alone, so
    only a clip-`k` actor is masked by it. The general-store wall items
    (room 30) are the case — `ZP01` empty, mask in `ZP02` (§8).
