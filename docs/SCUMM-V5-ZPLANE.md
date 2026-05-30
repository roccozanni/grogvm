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
on the wire). `webscumm`'s decoder surfaces both numbers
(`declaredCount` and the actual `planes.length`); a quick check
against MI1 data confirms they sometimes diverge — for example MI1
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

`webscumm`'s decoder builds a parallel `(number | null)[]` of strip
starts: `null` is the sentinel and we just skip those entries when
walking. Body lengths are computed by looking ahead for the next
non-null entry, falling back to `payload.length` for the last one.

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

## 6. Compositor semantics — the depth-band rule

A room with `N` z-planes defines `N + 1` depth bands. Band 0 is the
background; band 1 is everything in `ZP01`; band 2 is everything in
`ZP02`; etc. Actors carry a small integer **z-level** that places them
into one of these bands; the default is `actorZ = 0` (back-most).

### The drawing rule

When the compositor writes an actor pixel at room position (x, y):

> The pixel is drawn iff **no z-plane whose 1-based index is greater
> than `actorZ` has its bit set at (x, y)**.

Equivalently:

- Actor at `z = 0` is hidden by *any* plane with a bit set at the
  pixel (`ZP01`, `ZP02`, `ZP03`, …).
- Actor at `z = 1` is hidden only by `ZP02` and higher.
- Actor at `z = 2` is hidden only by `ZP03` and higher.

So bumping the actor's z-level "pulls them forward" past planes one
at a time. `actorZ = N` (where `N` equals the plane count) places the
actor in front of every plane and they're never occluded.

### Why some pixels are marked in multiple planes

Inspecting MI1 data you'll see foreground features (the trunk of a
palm tree, an interior column, a tall rock) where the same pixel is
set in both `ZP01` and `ZP02`. Under the rule above the overlap is
redundant — the higher-indexed plane alone is enough to occlude every
actor z-level it should — but the game's tools mark every applicable
band explicitly. Two compatible readings:

- **As a depth-stack ledger.** Each plane "claims" the depth band it
  belongs to. A tall column that's in front of *both* back-walking
  and middle-walking actors gets a claim in band 1 and a claim in
  band 2. Cumulative marking makes the artist's intent obvious from
  the data alone, without inferring it from the inheritance rule.
- **As tool / engine insurance.** Different parts of the engine pipe
  the planes through different paths (the `webscumm` compositor walks
  all planes; a hypothetical "is this pixel foreground at depth N?"
  query might check just one plane). Explicit marking keeps both
  consumers happy.

Either way: the compositor doesn't need to do anything special for
overlapping bits — the "any plane > actorZ" rule handles them
correctly.

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
   Foreground features that occlude actors at multiple depth bands
   claim every band they belong to. The compositor's "any plane >
   actorZ" rule handles overlapping marks without special-casing.
8. **The compositor draws the actor over geometry it should hide
   behind** → either the wrong z-plane is being checked or `actorZ`
   is too high. Remember the rule is *strictly greater than* — a
   plane at index `actorZ` does **not** occlude.

---

## 8. Reference implementation

The accompanying TypeScript implementation lives at
[`src/engine/graphics/zplane.ts`](../src/engine/graphics/zplane.ts).
Public surface:

- `decodeZPlanes(file, roomBlock, width, height) → DecodedZPlanes` —
  walk `RMIM > IM00` for `ZP##` blocks, decode each, return them in
  source order alongside the RMIH-declared count.
- `decodeZPlane(payload, width, height) → DecodedZPlane` — decode one
  block payload to a `width × height` byte mask (1 byte per pixel,
  `0` = pass-through, `1` = occlude). Exposed publicly so synthetic-
  fixture tests can call it directly.
- `parseRmihPlaneCount(payload) → number` — the u16 LE field read from
  the 2-byte `RMIH` block.
- `zplaneBit(plane, x, y) → 0 | 1` — O(1) lookup. Out-of-bounds reads
  return 0 (pass-through).

The actor compositor lives in
[`src/engine/graphics/composite.ts`](../src/engine/graphics/composite.ts)
and consumes `DecodedZPlane[]` directly — see that file for the
"any plane > actorZ" rule in code.

Unit tests in
[`src/engine/graphics/zplane.test.ts`](../src/engine/graphics/zplane.test.ts)
cover MSB-first bit layout, literal + run ops in sequence, multi-strip
side-by-side placement, the offset-0 sentinel, the RMIH parser, the
bit accessor (including out-of-bounds), and the relevant error paths.
Real-game correctness is verified through the player UI's per-plane
overlay toggle.

## Actor z-depth — `forceClip` (actorOps neverZclip / alwaysZclip)

`compositeActor`'s rule is "any plane whose 1-based index > `actorZ` hides
the pixel." The per-actor `actorZ` comes from the actor's **`forceClip`**,
which SCUMM scripts set via `actorOps`:

| actorOps sub-op        | `actor.forceClip` | `actorZ`            | effect                              |
|------------------------|-------------------|---------------------|-------------------------------------|
| `neverZclip` (0x12)    | `0`               | `zPlanes.length`    | always in front (no plane occludes) |
| `alwaysZclip k` (0x13) | `k` (>0)          | `k − 1`             | behind plane `k` and above          |
| *(unset)*              | `-1`              | `zPlanes.length`    | in front (compositor default)       |

`alwaysZclip k` → `actorZ = k − 1` so that "plane index > actorZ" makes
plane `k` (and higher) occlude the actor while planes below `k` don't.
The **Mêlée-island clouds** (room 10, costume 59) set `alwaysZclip 1`, so
`actorZ = 0` and the single mountain z-plane (ZP01) draws over them — the
clouds pass *behind* the mountain. The LucasArts sparkles set
`neverZclip` and stay in front. Verified headlessly
(`scratch/occlusion-check.ts`): a cloud parked over the mountain peak
draws 0 pixels where ZP01's mask is set.

**Still open — the position/box-derived default clip.** Plain actors
(no `forceClip`) still composite in front of every plane (`actorZ =
zPlanes.length`). SCUMM derives a default clip band from the actor's
walk-box / Y position, so e.g. the lookout fire (room 38) that should sit
behind the wall still draws over it. That general default lands with the
walk-box-Z sub-phase; only the explicit `forceClip` flags are honored so
far.

## Per-object z-planes — drawn objects occlude actors

Objects carry their own z-planes too: ~half of MI1's `OBIM` blocks
contain a `ZP##` inside their `IMxx` image. When a script `drawObject`s
such an object, that z-plane makes the object a **foreground** that
occludes z-clipped actors — exactly how the **MI1 title logo** (room 10,
object #109, a 224×120 image with an 8739-bit z-plane) sits in *front* of
the drifting cloud actors.

- The object loader decodes the OR of an `IMxx`'s `ZP##` blocks into
  `ObjectImage.zPlane` (sized to the object's `imhd.width × height`;
  width must be a multiple of 8, else skipped).
- The compositor (`mergeForeground`) ORs each **drawn** object's z-plane
  into the frontmost plane (index 1) at the object's `imhd.x / y`, then
  composites actors against that merged set. So a z-clipped actor
  (`forceClip > 0`, `actorZ = 0`) is hidden behind the title; an
  in-front actor (`neverZclip` / default, `actorZ = effective plane
  count`) is not.
- The z-plane — not the object's image opacity — is the occlusion
  authority (faithful to SCUMM), so a few title *edge* pixels the
  authored mask doesn't cover can still show a cloud; that matches the
  original's masking.
