# SCUMM v5 SMAP — Background Bitmap Format

The `SMAP` block holds the room background bitmap in SCUMM v5 games
(Monkey Island 1 CD VGA, Monkey Island 2, Indy 4, Day of the Tentacle,
…). It's the gnarliest single block format in v5: a vertical-strip
decomposition wrapped around two flavors of palette-walk RLE.

## At a glance

```
  the background = vertical strips, 8 px wide, decoded independently

  SMAP: ┌──────────────────────────────┬───────────────────────┐
        │ stripCount × u32 LE offsets  │ strip bodies …        │
        │ (header-inclusive: −8 to     │                       │
        │  get a payload position)     │                       │
        └──────────────────────────────┴───────────────────────┘

  each strip body:  [ code byte ][ initial color ][ bit stream ]
                         │
                         └─▶ picks the method:  uncompressed ·
                             Method 1 (palette walk) ·
                             Method 2 (richer deltas + RLE)
                             …plus direction, transparency, and
                             how many bits a palette index takes
```

This is a self-contained reference derived from reverse-engineering MI1
and MI2 data, cross-checked against the two main public sources for
the format. Where those sources disagree with what real game data
actually decodes to, the data is the source of truth and we document
the correction.

## Sources

- Aaron Giles, *"How to make a SCUMM image,"* originally hosted at
  scumm.mixnmojo.com — archived at
  <https://web.archive.org/web/20071011023943/http://scumm.mixnmojo.com/?page=articles/article1>.
  The single most useful primer on the strip-based bitmap layout
  and the compression dispatch table.
- ScummVM Technical Reference — Image resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Image_resources>.
  Authoritative on block-tree placement (SMAP under `RMIM > IM00`)
  and the v5/v6 differences.

Both sources predate the corrections in §6 and §7 below — they
describe an inverted Method 2 delta sign and a wrong `paletteBits`
constant for codes 0x54..0x58. Real game data disagrees with the
docs; we follow the data.

---

## 1. Where SMAP lives

Inside a SCUMM v5 resource file (`MONKEY.001` / `MONKEY2.001`):

```
LECF                 top-level container
└── LFLF             one bundle per room
    └── ROOM         room data
        ├── RMHD     header: width, height, num objects
        ├── CLUT     256-entry RGB palette
        ├── RMIM     room image container
        │   ├── RMIH image header
        │   └── IM00 primary image container
        │       ├── SMAP    ← THIS DOCUMENT
        │       └── ZP01…   z-plane masks (one or more)
        ├── OBIM…    object images
        └── OBCD…    object code + names
```

---

## 2. Strip decomposition

The background is split into **vertical strips, 8 pixels wide**. A
320-wide room has 40 strips. Each strip is `roomHeight` pixels tall
(typically 144 for full-screen). Strips are **independent** — each has
its own compression code, initial color, and bit stream. The decoder can
process them in any order.

---

## 3. SMAP payload layout

```
┌────────────────────────────────┬───────────────┐
│ stripCount × uint32 LE offset  │ strip bodies  │
└────────────────────────────────┴───────────────┘

stripCount = roomWidth / 8
```

### ⚠️ The offset gotcha

Each `uint32` in the offset table is stored **relative to the start of
the SMAP block including its 8-byte block header**, not relative to the
payload.

```
encoder writes:    offset = 8 + tableSize + sumOfPreviousStripSizes
decoder seeking
into payload:      seek_pos = offset - 8
```

The first strip's offset is therefore `8 + 4 × stripCount`. Anything
less than 8 is malformed.

**Symptom of getting this wrong**: the per-strip "compression code" you
read looks like random bytes (255, 12, 247, 0, …) instead of falling in
the narrow expected bands (0x0E–0x12, 0x18–0x1C, 0x40–0x44, …).

---

## 4. Strip body layout

```
┌─────┬───────────────────┬─────────────────┐
│ ID  │ initial color     │ bit stream      │
│ 1 B │ 1 B               │ remainder       │
└─────┴───────────────────┴─────────────────┘
```

| Field          | Meaning                                                    |
|----------------|------------------------------------------------------------|
| ID             | Compression code; selects the algorithm and parameters.    |
| Initial color  | Palette index of pixel 0; also the starting `color`/`sub`. |
| Bit stream     | Variable length; encoded LSB-first within each byte.       |

---

## 5. Bit stream conventions

### Bit order within a byte

Bit 0 (LSB) is read first, then bit 1, …, then bit 7. So byte
`0b00000111` (= 7) yields the bit sequence `1, 1, 1, 0, 0, 0, 0, 0`.

### Multi-bit integers

When `n` bits are read in order `b0, b1, …, b(n-1)`, the resulting
integer is `b0 + 2·b1 + 4·b2 + …` (i.e. **LSB-first** into the
integer). For example, reading 7 bits in order `0, 1, 1, 1, 1, 1, 1`
yields integer 126 (= 0x7E).

---

## 6. Compression methods dispatch

| ID range       | Method | Direction  | Transparent | paletteBits   |
|----------------|--------|------------|-------------|---------------|
| `0x01`         | uncompressed | horizontal | no    | n/a (raw 8b)  |
| `0x0E .. 0x12` | 1st    | vertical   | no          | code − `0x0A` |
| `0x18 .. 0x1C` | 1st    | horizontal | no          | code − `0x14` |
| `0x22 .. 0x26` | 1st    | vertical   | yes         | code − `0x1E` |
| `0x2C .. 0x30` | 1st    | horizontal | yes         | code − `0x28` |
| `0x40 .. 0x44` | 2nd    | horizontal | no          | code − `0x3C` |
| `0x54 .. 0x58` | 2nd    | horizontal | yes         | code − `0x50` ⚠️ |
| `0x68 .. 0x6C` | 2nd    | horizontal | yes (alias) | code − `0x64` |
| `0x7C .. 0x80` | 2nd    | horizontal | no  (alias) | code − `0x78` |

### Direction

- **Horizontal**: pixels emit row-by-row inside the 8-wide strip. Pixel
  index `i` maps to `(row = i / 8, col = i % 8)`.
- **Vertical**: pixels emit column-by-column. Pixel index `i` maps to
  `(col = i / H, row = i % H)`.

Method 2 only exists in the horizontal direction.

### Transparency

For background bitmaps the "transparent" variants decode pixel values
identically to opaque variants — transparency only matters when
compositing actors/objects over the room later.

### paletteBits

The width (4..8 bits) used when reading a *new* palette index from the
bit stream. The initial-color byte at strip start is always a full 8
bits regardless of `paletteBits`.

### ⚠️ Direction-label inconsistency in circulating notes

Some reverse-engineering notes summarise the methods in a table that
correctly lists `0x0E..0x12` as **vertical**, but the same notes
include a worked example calling `0x11` "horizontal". The table is
correct.

### ⚠️ paletteBits typo for `0x54..0x58`

Circulating notes list the "Param Subtraction" for the `0x54..0x58`
range as `0x51`, which yields `paletteBits = 3..7` — inconsistent with
every other Method 2 range (paletteBits is always between 4 and 8).
The correct subtract is `0x50`, yielding 4..8 like the other ranges.
The pattern of Method 2 subtracts is a clean `+20` step:
`0x3C, 0x50, 0x64, 0x78`.

Symptom of getting this wrong: narrow strips of localized garbage on
codes 87/88 specifically (those happen to be the most common values in
that range, with paletteBits 7 and 8 respectively).

---

## 7. Uncompressed (`0x01`)

The uncompressed method is what it sounds like: after the 1-byte
compression ID and the 1-byte initial color, the next `8 × roomHeight`
bytes are raw palette indices, written row-by-row inside the 8-wide
strip.

```
strip layout:  [0x01] [initial_color] [pixel0] [pixel1] … [pixelN]
```

It exists as a clean fallback in case a strip happens to be such a
mess of unrelated palette indices that none of the compressed methods
beat one-byte-per-pixel. In practice that is almost never true for
hand-painted background art — the SCUMM palette is deliberately laid
out so that similar colors sit next to each other in the index space,
which is what makes the palette-walk methods (8 and 9 below) so
effective. As a result, code `0x01` shows up in maybe a handful of
strips across a whole game's worth of rooms, if at all.

A minor curiosity: the "initial color" byte is technically redundant
for the uncompressed method (the first pixel byte already serves the
same role), but it's there to keep the strip-header layout uniform
across every compression code.

---

## 8. Method 1 — palette walks with a direction memory

Method 1 is the encoder's bread-and-butter scheme for backgrounds with
gentle gradients and slowly-shifting detail: skies, shaded surfaces,
soft transitions. The whole grammar is built around making the most
common case as cheap as possible — namely, "this pixel is the same as
the last one".

### Bit grammar

```
0      keep current color and emit a pixel
10     read paletteBits → new color; reset `sub` to 1
110    color -= sub
111    sub = -sub; color -= sub
```

### What it's actually doing

The decoder carries two pieces of state across the whole strip:

- `color` — the running palette index. Starts at the strip's
  initial-color byte and is the only thing ever written to the output
  framebuffer.
- `sub` — a small signed step (always ±1) that records which way the
  most recent palette walk was heading. Starts at `1` for every strip.

Each operation reads bits one at a time until it has matched one of
the four prefixes, then emits exactly one pixel of `color` (which the
operation may or may not have modified):

- A single `0` bit — by far the cheapest branch — means "keep the
  current color and move on". Solid regions of the strip cost one bit
  per pixel.
- The prefix `10` says "I'm jumping to a brand-new color that isn't
  closely related to where I am now". The decoder reads
  `paletteBits` bits, treats them as an unsigned little-endian
  integer, and that's the new palette index. This branch shows up at
  the boundaries between unrelated regions of the strip — sky meeting
  treetop, say — and it also resets `sub` to `1` because we've just
  teleported, so the previous direction of travel is no longer
  meaningful.
- The prefix `110` says "walk one step from where you are, in the
  direction we've been heading". The decoder does `color -= sub`. With
  `sub = 1` this decrements the palette index by 1; once `sub` has been
  flipped to `-1` (see below) the same op increments by 1 instead.
- The prefix `111` says "we're turning around — flip the direction and
  then walk one step the new way". The decoder negates `sub` first,
  then does `color -= sub`. This is what lets the encoder express a
  gradient that reaches its lightest or darkest point and starts
  curving back the other way without paying for a fresh absolute color
  load.

### Why this is efficient

The cleverness lives in `sub` and the SCUMM palette layout. Every
room's palette is laid out so that consecutive indices are visually
close, and adjacent shades of the same color sit next to each other.
That means a smooth gradient — a sky going from light blue at the top
to dark blue at the horizon — is naturally a sequence of palette
indices walking in one direction one step at a time. Method 1 encodes
that as one `10` to establish the starting shade, then a run of `110`
ops (three bits each) all the way down the strip. No need to re-load
the palette index every pixel; no need to even tell the decoder which
direction we're walking after the first turn.

Note that **Method 1 has no run-length encoding**. A long solid run is
already pretty compact at one bit per pixel, but for *very* long runs
(big skies, large painted surfaces) the encoder will switch to Method
2 specifically because it can pack 256 same-color pixels into 13 bits.

### When the encoder picks Method 1

Mostly strips with moderate variation: per-pixel changes are small,
runs are short to medium, and the palette walks stay within a narrow
band of nearby indices. Hills, terrain, character clothing, anything
that looks "smoothly shaded".

---

## 9. Method 2 — richer deltas, plus run-length encoding

Method 2 is the encoder's choice when Method 1's `±1` step isn't
expressive enough, or when the strip has very long uniform runs that
even one-bit-per-pixel won't squeeze tightly enough. It's strictly
more capable than Method 1 (at the cost of slightly more expensive
change operations) and shows up dominantly in strips with stippled
textures, painted detail, and large flat areas.

### Bit grammar

```
0      keep current color and emit a pixel
10     read paletteBits → new color
11     read 3 more bits as LSB-first unsigned d (0..7):
       ┌─────────────────────────────────────────────┐
       │ d == 4  → RLE: read 8 bits as `reps`        │
       │           emit `reps` additional pixels     │
       │ d != 4  → color -= (4 - d)                  │
       └─────────────────────────────────────────────┘
```

### What it's actually doing

The first two branches — `0` and `10` — are identical to Method 1's
keep and "load new absolute color". The third branch is where the
methods diverge.

Where Method 1 commits to a single `±1` step in a remembered direction,
Method 2 reads a 3-bit value `d` and uses it as either a signed delta
or as an escape into run-length encoding. The deltas are explicit
amounts:

| d | Action          |
|---|-----------------|
| 0 | `color -= 4`    |
| 1 | `color -= 3`    |
| 2 | `color -= 2`    |
| 3 | `color -= 1`    |
| 4 | (escape: RLE)   |
| 5 | `color += 1`    |
| 6 | `color += 2`    |
| 7 | `color += 3`    |

So in a single 5-bit change op, the decoder can move up to four palette
indices in either direction. That's strictly more expressive than
Method 1's `±1` step and matters for content where consecutive pixels
differ by more than one index — fabric weave, foliage stippling, the
small dithering patterns common in 256-color art.

There's no `sub` direction-memory in Method 2: every delta op stands
on its own. The encoder pays for that flexibility with 5 bits per
delta op (one more than Method 1's 3-bit `110` / `111`), but in
exchange it can jump up to four steps in one op instead of requiring
four ops.

The "RLE escape" — `d == 4` — is what makes Method 2 dominate on
strips with long uniform runs. When the decoder sees this code, it
reads eight more bits as an unsigned count `reps`, then emits that
many *additional* pixels of the current color on top of the one the
operation already produces. So a single `11 100 N₈` instruction
contributes `1 + N` pixels in just 13 bits total — up to 256 pixels of
the same color for a 13-bit cost. That's roughly a 20× saving over
Method 1's "one bit per pixel" for long runs, which is why sky bands,
large flat seas, dark cave backdrops, and painted walls all live in
Method 2 strips.

### ⚠️ The sign of the delta is inverted from many circulating notes

Long-circulating reverse-engineering notes for this format
label `d = 0` as "Increase current palette index by 4" and `d = 7` as
"Decrease by 3". **Those signs are inverted relative to what the
encoder actually writes** in MI1 / MI2 (and almost certainly the other
v5 games — they all use the same compressor). The mapping in the table
above is what real game data decodes to.

The check is easy: apply the documented "increase" signs and look at a
gradient region of a real game's first room. Wrong direction shows up
unmistakably as rapid color cycling through unrelated palette entries
(yellow/pink/white stripes at the top of a sky strip in MI1's Mêlée
Island beach, for example). Flipping the sign cleans every such
artifact and the gradient becomes smooth.

Programmatically, the working dispatch is `color += (d - 4)` for
`d != 4`, equivalently `color -= (4 - d)`.

### ⚠️ RLE pixel counting

The `d == 4` branch emits `reps` **additional** pixels of the current
color, on top of the one pixel that the iteration's natural
`emit(color)` produces. So one `11 100 N₈` operation contributes
`1 + N` pixels in total.

### When the encoder picks Method 2

Long uniform runs (skies, large flat areas of color), stippled or
dithered patterns where consecutive pixels jump by more than one
index, and generally any strip where Method 1 would need a lot of
short-range jumps to keep up. Many MI1 / MI2 rooms have most of their
strips in Method 2.

---

## 10. Pitfalls cheat-sheet

A condensed list of things that took us a while to get right, in rough
order of "the symptom you'll see first":

1. **Wildly varying compression codes** (255, 12, 247, 0, …) →
   strip offsets aren't header-inclusive. Subtract 8.
2. **Bit-stream underrun on most strips** → either the offset issue
   above, or Method 1/2 dispatch missing the RLE branch (Method 1 has
   none; Method 2 has it at `d == 4` only).
3. **Mostly-correct image with rapid color-cycling artifacts in
   uniform regions** → Method 2 delta signs need flipping. Use
   `color -= (4 - d)`.
4. **Vertical bars of "stuck" color stretching through a strip** →
   delta sign issue manifesting as "walk fails to reach the right
   index"; same fix as above.
5. **Whole strips of solid color where there should be detail** →
   the dispatch is treating something as RLE that shouldn't be (often
   MSB-first interpretation of Method 2's 3-bit selector). Use
   LSB-first.
6. **Strip transposed (looks like a 90° rotation)** → wrong scan
   direction for the strip's compression code. Check the table in §6.
7. **Adjacent strips look totally different from each other** → that's
   normal. The encoder picks a per-strip method based on which is most
   efficient for that strip's data. MI1 rooms commonly mix Method 1 V,
   Method 1 H, and Method 2 H within the same image.

