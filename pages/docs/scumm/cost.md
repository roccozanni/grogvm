# SCUMM v5 COST — Costume Format

The `COST` block holds one actor costume in SCUMM v5 games — every
character sprite Guybrush bumps into, every animated object that moves
of its own accord, and Guybrush himself. Despite being a single block,
it packs a small filesystem worth of state: a sub-palette, a frame
library that's organised by body part, a tiny bytecode for sequencing
animations, and a per-frame run-length-encoded bitmap with its own
displacement metadata.

This is a self-contained reference derived from reverse-engineering
real MI1 and MI2 data, cross-checked against two public sources for
the format. Where those sources disagree with what real game data
actually decodes to, the data is the source of truth and we document
the correction.

## Sources

- *"Costume spec"* (anonymous compilation, originally hosted at
  scumm.mixnmojo.com — archived at
  <https://web.archive.org/web/20070803050102/http://scumm.mixnmojo.com/?page=specs&file=costumespec.txt>).
  Concise narrative on slots, animations, and the per-slot frame
  cmd array; the source of the picture-header layout we rely on.
- ScummVM Technical Reference — Costume resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Costume_resources>.
  Authoritative on block tree placement, the `format` byte (palette
  size + alignment bit), and the cmd-byte magic values (`0x71-0x7C`
  for sound/stop/start/hide/skip).

The animation playback engine — anim record layout, per-slot
`SlotModifier`, the cmd byte stream, and the things the wiki gets
right and wrong — lives in a separate doc,
[`costume-anim.md`](costume-anim.md). This document
focuses on the **static** parts of the format: header, palette,
limb-image tables, picture headers, and the pixel RLE.

---

## 1. Where COST lives

Inside a SCUMM v5 resource file (`MONKEY.001` / `MONKEY2.001`):

```
LECF                 top-level container
└── LFLF             one bundle per "disk" (room + its scripts/sounds/costumes/…)
    ├── ROOM         (described elsewhere)
    ├── COST         ← THIS DOCUMENT (zero or more per LFLF)
    ├── COST
    ├── SCRP         …
    ├── SOUN         …
    └── CHAR         …
```

A single LFLF can contain multiple `COST` blocks; LFLFs that don't ship
any costumes have none. The index file (`MONKEY.000`) carries a `DCOS`
directory that maps **costume id → (disk file, byte offset)** so the
engine can grab any costume by id at runtime.

---

## 2. The mental model: slots, animations, and images

Before any bit-level details, the conceptual structure is worth holding
in your head, because the file layout mirrors it almost exactly.

A costume is **up to sixteen "slots" running in parallel**. Each slot
holds the index of the current image to display, plus a small amount of
animation state (current frame within an animation, whether the slot
is paused, whether to loop). The slots draw on top of each other in
slot-index order, which is why head and torso of one character can be
separately animated — they're different slots, the head sits in front
of the torso because its slot number is higher, and a "talking" anim
only changes the head slot while the torso slot stays put.

A slot is also what other parts of the SCUMM literature call a "limb",
and this document uses both terms — `slot` is more correct given that
slots routinely hold non-anatomical things (a hat or a sword or a
particle), but `limb` is the more common word in SCUMM references. The
two are interchangeable.

The actor isn't an array of *frames*; it's an array of (slot ←
image-table-index) pointers that the **animation runtime** ticks
forward each frame. An "animation" is therefore a tiny program that
says "while I'm running: slot 0 plays images at frame-table indices
0..6, slot 4 plays images at frame-table indices 10..15, slot 7 is
disabled". Multiple animations can be started in sequence and the
runtime mixes them — starting "talk" while "walk south" is already
running just overrides the slots that "talk" cares about and leaves
the rest alone. That mixing is what gives v5 actors their walking-
while-talking-while-pointing behaviour without needing a Cartesian
product of pre-composited frames.

There are three indirections inside a `COST` block, and they line up
1:1 with the three concepts:

1. **animation index → animation record**. Maps a high-level animation
   id (0..numAnim) to a small variable-length record that describes
   which limbs participate and what their per-slot frame ranges are.
2. **limb + frame-within-anim → frame-table index**. The animation
   record pulls a u8 frame-table index out of a shared "frame block".
3. **limb + frame-table index → image picture**. Each limb has its own
   table of image pointers, and the picture being drawn is the one at
   the frame-table index for that limb's table.

Decoders that try to skip a level — say, mapping animations directly
to image pointers — work for very simple costumes and then explode on
anything that mixes limbs.

---

## 3. Block payload layout

After the standard 8-byte block header (`'COST'` + big-endian size),
the COST payload begins with a tight fixed-size header. Everything in
this section is at known offsets relative to the start of the payload;
the variable-size parts (image tables, animation records, image
pictures themselves) are reached through offsets in this header.

```
                ┌──────────────────────────────────────────────────────┐
0x00  uint8     │ numAnim − 1   (highest valid animation index)        │
0x01  uint8     │ format        (encoding flags — see §3.1)            │
0x02  bytes     │ palette[16 or 32]  (sub-palette into the room CLUT)  │
                ├──────────────────────────────────────────────────────┤
                │ uint16 LE  frameOffs                                 │
                │ uint16 LE  imageTableOffs[16]   (per-limb)           │
                │ uint16 LE  animOffs[numAnim+1]  (per animation)      │
                ├──────────────────────────────────────────────────────┤
                │ … variable-length tail: frame block, image tables,   │
                │   animation records, and image pictures …            │
                └──────────────────────────────────────────────────────┘
```

All offsets in this block — `frameOffs`, every `imageTableOffs[i]`,
every `animOffs[a]`, and every entry inside an image table — are
**unsigned 16-bit little-endian, measured from the start of the COST
payload** (i.e. from byte 0 of the figure above, which is byte 8 of the
COST block as it sits in the resource file).

### 3.1 The format byte

```
┌─────┬─────────────────────────────┬─────┐
│ bit │ meaning                     │ MI1 │
├─────┼─────────────────────────────┼─────┤
│  7  │ mirror flag                 │  0  │
│ 6:1 │ unused / reserved           │  -  │
│  0  │ palette size                │  0  │
└─────┴─────────────────────────────┴─────┘

format & 0x7F == 0x58  →  16-color costume (palette has 16 entries)
format & 0x7F == 0x59  →  32-color costume (palette has 32 entries)
format & 0x80          →  "different alignment" (semantics TBD)
```

Most MI1/MI2 costumes are `format == 0x58` (16-color), but **not all**:
MI1 costume 24 — the three important-looking pirates in the SCUMM Bar
(room 28, actor 3) — is `format == 0x59`, 32-color. Decoding it with the
16-color RLE split renders vertical-streak garbage where the pirates
should be (the run byte's colour/length boundary is off by one bit; see
§5). A decoder must take the palette size (16 or 32) from the header so the
run-byte split matches. The mirror flag's effect on rendering
isn't yet pinned down empirically; long-circulating notes describe it
as a "different alignment" rule, possibly affecting whether frames are
auto-mirrored along the actor's facing axis. Implementations should
read the bit but not yet act on it; first verify in a real costume
that has it set.

### 3.2 The sub-palette

The next 16 (or 32) bytes are the costume's *local* palette. Each byte
is an index into the room's 256-entry CLUT — so the costume doesn't
have its own RGB colors, it has a small remapping table that says
"costume color 1 = CLUT index 0xD4". This is what lets the same
costume look correct in any room: it always pulls colors out of
whichever CLUT is currently active.

**Costume color 0 is the transparent slot**: a pixel emitted as
costume index 0 must not be drawn, regardless of what the palette byte
at position 0 says. The byte at `palette[0]` is therefore essentially
unused — encoders typically write some arbitrary CLUT index there and
the engine ignores it. Two costumes in different rooms can have
totally different `palette[0]` bytes; both still treat color 0 as "do
not draw".

### 3.3 numAnim

The byte at offset 0 is **the highest valid animation index**, not the
count. So `numAnim = N` means animation ids `0..N` are valid, and the
`animOffs` table that follows has `N + 1` entries. Most decoders
either off-by-one this or paper over it by always adding 1; the safe
approach is to add 1 and store the count.

### 3.4 frameOffs

The `frameOffs` field points to a **flat array of u8 frame-table
indices**. The animation records use it as a backing store: each
animation, for each limb that participates, says "play indices
`frameOffs[start..start+length]` from this limb's image table". So
walking a multi-step animation reads frame-table indices out of this
array sequentially.

Some entries in `frameOffs` have magic meanings the runtime intercepts
before doing a table lookup:

| Index byte | Meaning                                              |
|-----------:|------------------------------------------------------|
|     `0x79` | pause this slot                                      |
|     `0x7A` | resume this slot                                     |
|     `0x7B` | don't draw an image this tick (but advance the slot) |
|     `0x78` | increment animation counter 1                        |
|     `0x7C` | increment animation counter 2                        |

The animation counters are 8-bit values exposed to script via global
variables; scripts use them to synchronise behaviour with a slot's
animation progress ("when his foot is at its lowest point, play the
footstep sound"). They matter only while the animation runtime is
ticking; a static single-frame decode never touches them.

The frame-table indices in `frameOffs` are only 7 bits of "real"
index; the top bit is reserved (purpose not yet established
empirically — long-circulating notes hand-wave it as "unknown"). Mask
with `0x7F` before using the value to index into a limb's image
table.

### 3.5 imageTableOffs[16]

Sixteen u16 offsets, one per limb (in limb order — entry 0 is limb 0).
Each points to the start of that limb's **image table**: a packed
array of u16 image-picture pointers. The table length isn't stored:
the encoder relies on the convention that the next limb's table
starts where this one ends, so the table for limb `i` spans
`imageTableOffs[i] .. imageTableOffs[next-non-equal-i]`, and the last
group's table runs to the start of the first image picture.

Most v5 costumes use only two or three limbs out of the available
sixteen. **Unused limbs all share the same sentinel offset** — almost
always the offset of the first image picture. Decoders that naively
read u16 pairs at that sentinel offset get back bytes of pixel data,
not real frame pointers; this is the source of every "why am I seeing
hundreds of garbage frames for limb 7?" debugging headache.

### 3.6 animOffs[numAnim + 1]

One u16 per animation, pointing into the **animation records**. Each
record is variable-length: it starts with a 16-bit mask of which limbs
participate (MSB = limb 0, LSB = limb 15), followed by one 3-byte
`SlotModifier` per set bit, in MSB-first order. A `SlotModifier`
encodes:

```
uint16 LE  frameIndex   ; starting index into frameOffs for this slot
uint8      frameLen     ; low 7 bits = number of frames to play
                        ; high bit  = loop flag (1 → restart at end)
```

`frameIndex == 0xFFFF` is a sentinel meaning "this slot is disabled
during this animation". The animation runtime walks the participating
slots tick-by-tick, advancing each one through its slice of `frameOffs`
at the rate the engine drives.

The animation runtime walks these records: it parses an anim record into
per-slot playback state, advances each slot's cursor every engine tick, and
reads the command byte at the slot's current cursor to pick the picture index.
See [`costume-anim.md`](costume-anim.md) for the record format, the chore model,
and the command-byte semantics.

---

## 4. The image table → image picture

`imageTableOffs[limb]` points to a packed array of u16 LE values, each
of which is a payload-relative offset of one image picture (a single
drawn pose for that limb). The image table for limb `i` typically
holds anywhere from one to a few dozen entries.

### ⚠️ The pointer-into-the-middle convention

This is the single biggest gotcha in the COST format, and it cost us
the most time to figure out.

**An image-table entry doesn't point to the start of the image
picture's header.** It points **6 bytes into the header**, landing on
the `y` field of the image's displacement struct. To read the picture,
you reach *backwards* from the pointer by 6 bytes to find the start of
the 12-byte header, then forwards by 6 bytes to find the start of the
RLE pixel data:

```
              ┌─────────────────────────────────────────────────────┐
ptr − 6       │ width (u8)    + unknown (u8)                        │
ptr − 4       │ height (u8)   + unknown (u8)                        │
ptr − 2       │ x      (i16 LE)                                     │
ptr           │ y      (i16 LE)              ◀── image-table entry  │
ptr + 2       │ xinc   (i16 LE)                                     │
ptr + 4       │ yinc   (i16 LE)                                     │
              ├─────────────────────────────────────────────────────┤
ptr + 6       │ rawImage … RLE bytes …                              │
              └─────────────────────────────────────────────────────┘
```

The convention almost certainly exists because the original engine
keeps a "relative position" register and the most frequent operation
it does with an image is "add `x, y` to relPos and clamp to the
screen". Pointing at the `y` field means the engine can do one `LDS`-
style load to fetch both `x` and `y` as a single dword without an
additional address calc; width and height are only consulted once per
draw, so paying an extra subtraction for them is fine. (This is
guesswork — the original sources are closed — but the layout makes
sense under those assumptions and no other rationale is obvious.)

### Why the gotcha bites

The natural assumption is "the offset in a table points to the start
of the thing". With that assumption you read width and height from
bytes 0..3 of the supposed header, get values like `0xFFFC` and
`0xFFD2` (which are the high and low bytes of the `y` field
interpreted as a u16 width), conclude "65532-pixel-wide frame ≈
broken", and start questioning whether the format is even what you
think it is.

The clean diagnostic is to test three layouts against a known frame:
"pointer is at start of header", "header begins ptr − 4", "header
begins ptr − 6". Only one of them produces a small positive width and
height. Layout `ptr − 6` is correct on every MI1/MI2 frame we've
checked.

### 4.1 The image header fields

```
width  (u8)   image width in pixels (1..255)
height (u8)   image height in pixels (1..255)
x      (i16)  signed X offset applied at composite time
y      (i16)  signed Y offset applied at composite time
xinc   (i16)  post-draw increment to actor.relPos.x
yinc   (i16)  post-draw decrement to actor.relPos.y  (relPos.y -= yinc)
```

The `width` and `height` are followed by an extra "unknown" byte each,
giving 4 bytes total before `x`. Long-circulating notes speculate
these are width/height high-byte extensions for later games (v6+) and
are zero in v5. In MI1/MI2 every value is comfortably under 256 so
treating them as u8 is correct; treating them as u16 LE works by
accident because the high byte is zero, but the right thing is to
read them as u8 and ignore the trailing byte.

`x` and `y` give the position of the image relative to the actor's
current `relPos` (relative position register) at the moment the image
is drawn. The engine *clears* `relPos` before starting to draw each
animation tick, then accumulates `xinc, yinc` from each drawn image
into it as a side effect. That's how a walk-cycle composes
displacement — each image in the sequence carries the delta from the
previous image's anchor, and the engine sums them.

`xinc` and `yinc` are inert for a static single-image decode (nothing
iterates); they matter only to the animation runtime, which sums them
across a sequence.

### 4.2 The actor anchor convention

A consequence of the `x`/`y` fields being negative on every "main
character" frame we've inspected: the actor's `(x, y)` position in
*room* coordinates lands on the **feet of the sprite**, not its
top-left or its center. Worked example for Guybrush's idle frame in
MI1 (`width=21`, `height=47`, `redirX=-11`, `redirY=-46`) drawn with
`actorX=160`, `actorY=170`:

```
frame top-left in room  = (actorX + redirX, actorY + redirY)
                        = (160 - 11, 170 - 46)
                        = (149, 124)

frame bottom-right      = (149 + 21, 124 + 47)
                        = (170, 171)

actor anchor (160, 170) lands inside the frame at:
   col = 160 - 149 = 11   (of 21 columns → horizontally centered)
   row = 170 - 124 = 46   (of 47 rows    → second-to-last row)
```

Col 11 of 21 is the middle column; row 46 of 47 is one pixel above
the bottom. So the anchor sits at **bottom-center, on the feet**.
That's universal in SCUMM v5: a script that says "Guybrush is at
(160, 170)" means his feet are at (160, 170), not the top-left of his
sprite. Different frames in a walk cycle have slightly different
`redirX/redirY` values, which is how the head bobs and the body sways
relative to a moving foot anchor without the engine doing per-frame
shape math — the art carries the offset directly.

---

## 5. RLE encoding of the pixel data

After the 12-byte image header, the rest of the image picture is a
single stream of run-length-encoded bytes. The bit packing inside each
byte differs by palette size:

```
16-color (format & 0x7F == 0x58):
   ┌─────────┬─────────┐
   │  color  │ length  │
   │ 4 bits  │ 4 bits  │
   └─────────┴─────────┘
   = (color << 4) | length

32-color (format & 0x7F == 0x59):
   ┌─────────┬─────────┐
   │  color  │ length  │
   │ 5 bits  │ 3 bits  │
   └─────────┴─────────┘
   = (color << 3) | length
```

In both modes, `color` is an index into the costume's local palette
and `length` is the number of consecutive pixels of that color.

### ⚠️ The length-zero escape

If `length == 0` in either mode, **the byte does not mean "run of 16"
or "run of 8" — it means "the next byte is the actual length", read
as an unsigned u8 (so 1..255)**.

This is the most consequential correction over the most-natural
guess. A "length 0 = max-of-nibble" interpretation produces output
that is *almost* right: the image looks roughly correct because most
runs are short enough that the escape doesn't trigger, but every time
the encoder needed a run longer than 15 (in 16-color mode) it issued a
length-0-followed-by-extension, and a wrong-interpretation decoder
quietly miscounts. The miscount accumulates over the image and
manifests as garbage pixels at the *trailing* edge of the column-
major emit — the rightmost columns and the bottom of the last column.
With a contrasting preview palette that garbage looks like alarming
vertical stripes on the edges of an otherwise-recognisable character.

The clean diagnostic is to check the exact byte count: if you know
where the next image picture starts (from the next entry in the same
limb's image table), the RLE region for this picture has a precisely
known length. With the wrong rule, your decoder will consume more
bytes than the region holds. With the correct rule, the byte count
lands exactly on the next picture's header.

### 5.1 Pixels are emitted column-major

The RLE stream describes pixels in **column-major order**: the first
pixel emitted is `(col=0, row=0)`, the second is `(col=0, row=1)`, …,
the `height`-th is `(col=0, row=height-1)`, and only then does the
emission move on to `(col=1, row=0)`. Runs may straddle column
boundaries; a run of length 30 in a 4-pixel-wide image fills all of
column 0 (4 pixels), all of column 1, all of column 2, and the first
18 pixels of column 3, without any extra signalling.

Why columns and not rows? The likely reason is the same one that
drives SMAP's column-strip decomposition: actors are tall and narrow.
Hand-drawn 256-color characters tend to have long vertical color
streaks (the outline of an arm, the shaft of a torch, the strap of a
satchel) and short horizontal ones. Column-major emit makes those
long vertical streaks RLE-friendly — a 30-pixel-tall arm outline
encodes as a few bytes if the color stays constant along the column,
where row-major emit would chop the same outline into 30 single-pixel
runs.

### 5.2 Index 0 is transparent

When the decoder emits a pixel of costume index 0, the compositor
must skip it — the underlying framebuffer pixel (the room background,
or another already-drawn actor pixel) is preserved. A common technique
is to emit a sentinel value (e.g. `0xFF`) for index-0 pixels so the
compositor has a single value to check; costume indices only range
0..31, so such a sentinel is unambiguous.

This is what gives costumes their irregular silhouettes — the
rectangular `width × height` image has transparent runs encoded just
like any other color (a run of `(0, N)` for N transparent pixels), but
those pixels never make it to the screen.

---

## 6. The MI2 two-byte offset shift

A historical artifact: between MI1 (CD VGA) and MI2, LucasArts
changed the resource block header from a 2-byte block ID + 4-byte size
to a 4-byte tag + 4-byte size — the format every other v5 game uses
and that our block parser handles. They did **not** update the
costume format to match. Every payload-relative offset inside a `COST`
block in MI2 is therefore 2 bytes too small relative to the post-
header payload that our parser hands the costume decoder.

The clean fix, recommended by the long-circulating notes and confirmed
by testing against real data, is to **skip the first 2 bytes of an MI2
costume payload** before parsing, treating those two bytes as part of
the implicit pre-header. All offsets then resolve correctly against
the shifted payload.

---

## 7. Putting it together — a single static frame

The above is a lot of pieces. Here's the path the decoder takes to go
from "I want costume `c`, limb `l`, image `i`, rendered in room `r`"
to actual RGBA pixels:

1. **Get the COST payload.** Walk the LECF/LFLF tree, pick the `c`-th
   `COST`, slice its payload out of the resource file's decrypted
   bytes. (MI2: drop the first two bytes.)
2. **Parse the fixed header.** Read `numAnim`, `format`, the
   sub-palette, `frameOffs`, `imageTableOffs[16]`, `animOffs[…]`.
3. **Find the limb's image table.** Bound it above by the next
   distinct value in `imageTableOffs`. Read `entries.length` u16 LE
   pointers from the table. If the limb shares its offset with many
   other limbs (the "unused" sentinel pattern), there's no real table
   here — abort with a clear error.
4. **Pick image-pointer `i`.** Validate it falls inside the payload.
5. **Read the image header backwards.** From the pointer, read width
   (u8) at `ptr − 6`, height at `ptr − 4`, `x` (i16) at `ptr − 2`, `y`
   at `ptr`, `xinc` at `ptr + 2`, `yinc` at `ptr + 4`.
6. **Decode the RLE.** Read bytes starting at `ptr + 6`. Each byte is
   `(color << 4) | length` (or `(color << 3) | length` in 32-color
   mode). If `length == 0`, read one more byte for the real length.
   Emit `length` pixels of `color` in column-major order.
7. **Map costume colors to RGB.** Resolve costume index 0 to
   transparent. For each non-zero index `k`, look up
   `costPalette[k]` → CLUT index, then `roomCLUT[clutIdx]` → RGB
   triple.
8. **Composite onto the room framebuffer** at `(actorX + x,
   actorY + y)`, skipping transparent pixels and respecting any
   z-plane mask the room provides.

---

## 8. Pitfalls cheat-sheet

A condensed list of things that took us a while to get right, in
roughly the order you'll hit them if you implement a costume decoder
from scratch:

1. **"Garbage" frame headers reading 65532 as width** → the image-
   table pointer lands 6 bytes into the header, not at the start.
   Read width/height/x at negative offsets relative to the pointer.
2. **Per-limb image tables seem absurdly long** → most of the
   "entries" past the real ones are pixel bytes of image pictures
   that happen to live right after the table. Bound the table by the
   next distinct value in `imageTableOffs`, and trust only entries
   that point forward into the payload.
3. **Unused limbs all return identical, useless frame lists** → many
   limbs share a sentinel offset that points into the image-picture
   region rather than to a real image table. Detect by grouping
   `imageTableOffs` values; groups shared by four or more limbs are
   the sentinel.
4. **`length = 0` does NOT mean "run of nibble-max"** — it means
   "next byte is the real length". Easiest verification: compute the
   exact RLE byte budget from "this image-pointer entry" and "the
   next image-pointer entry" minus the next header start; the
   decoder's consumed-byte count must match exactly.
5. **Image looks scrambled with horizontal striping** → pixel emit is
   column-major, not row-major. The error scales with image height;
   small images can look approximately correct under either ordering
   and mislead a small test.
6. **Image looks recognisable but has alarming colored stripes on the
   left/right edges** → the RLE length-zero rule is wrong (see #4)
   and the decoder is over-consuming bytes. The "extra" pixels
   emitted come from the next image's header and land in the
   rightmost columns under column-major emit.
7. **Costume color 0 renders as some bright nonsense color** → index
   0 is *transparent* regardless of what `palette[0]` contains. Emit
   a sentinel and let the compositor skip it.
8. **All MI2 costumes look broken in the same systematic way** →
   the 2-byte offset shift (§6). Slice off the first two bytes of an
   MI2 COST payload before parsing.
9. **`numAnim` byte gives unexpectedly large counts (100+ for a
   minor NPC)** → the byte is the *highest valid index*, not the
   count; the count is byte + 1, and the index space is often
   sparsely populated (only a few animation slots actually defined).
   That's normal — the encoder uses fixed slot numbers per
   conventional action (walk-south, walk-east, talk, etc.) so an
   actor that doesn't talk can still have `numAnim` reflect "anim
   slot for talking" being a valid index.
10. **The frame-table index `0x79` makes nothing visible draw** → it's
    a magic value the runtime intercepts ("pause this slot"). Same
    family includes `0x7A` (resume), `0x7B` (skip this tick),
    `0x78` and `0x7C` (animation counters). Mask `& 0x7F` before
    indexing into a limb's image table, but only after handling the
    magic values.
