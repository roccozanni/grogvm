# SCUMM v5 CHAR — Character Set (Bitmap Font) Format

A `CHAR` block holds one bitmap font: a per-character glyph table, the
glyph bitmaps themselves, and a small palette mapping that lets the
runtime colourise text by remapping glyph bit-patterns to room CLUT
indices. SCUMM v5 games typically ship multiple charsets — different
fonts for verb UI, dialog, and intro credits — and `LFLF` blocks can
hold zero or more of them.

This is a self-contained reference derived from reverse-engineering
real MI1 data, cross-checked against the long-circulating notes for
this format. Where those notes disagree with what real game data
actually decodes to, the data is the source of truth and we document
the correction (notably the **+21 anchor convention** for glyph
offsets in §4, which the notes miss).

## Sources

- ScummVM Technical Reference — Charset resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Charset_resources>.
  Useful for the high-level block layout and the per-glyph header
  shape; the +21 anchor was empirically derived against MI1 data.

---

## 1. Where CHAR lives

Inside a SCUMM v5 resource file (`MONKEY.001` / `MONKEY2.001`):

```
LECF                  top-level container
└── LFLF              one bundle per "disk"
    ├── ROOM          (described elsewhere)
    ├── COST          (described in cost.md)
    ├── CHAR          ← THIS DOCUMENT — zero or more per LFLF
    ├── CHAR
    ├── SCRP          …
    └── SOUN          …
```

In MI1, every `CHAR` we've inspected lives in `LFLF9`. The index file
(`MONKEY.000`) carries a `DCHR` directory mapping charset id → (owning
room, byte offset). To merely *browse* the fonts you can walk
`LECF > LFLF > CHAR` in source order. MI1 ships **5 charsets** across
LFLF9; their roles correspond to dialog font / verb font / intro
credits font / etc.

### Resolving a charset *by id*

When a script selects a font with `initCharset N` (the `cursorCommand`
charset sub-op), **`N` must be resolved through the `DCHR` directory,
not by walk order.** The two disagree: the charset id space includes
built-in **null entries** (ids 0 and 5 in MI1) that occupy id slots but
have no `CHAR` block, so the id of a real font is offset from its
position in source order. Resolving `initCharset 2` by walk order
returns the *wrong* font (a thin 1-bpp body font instead of the bold
2-bpp talk font).

The correct path is `id → DCHR[id] {room, offset} → loff(room) + offset
→ CHAR block`. Walk order is only a safe fallback for the null ids,
which have no directory entry to resolve.

---

## 2. The mental model

A charset is **a glyph table + a small palette mapping**. The glyph
table gives one indexed bitmap per character code; the palette
mapping (the "color map" in our terminology) re-routes glyph bit
values to CLUT indices so the same charset can render as black-on-
white for verbs, brown-on-paper for dialog, or any other inked tone
the script picks.

Glyph bitmaps are packed at either **1 bit per pixel** (binary
"ink / no ink") or **2 bits per pixel** (a 4-level ramp suitable for
anti-aliased outlined fonts). The choice is per-charset, not per-
glyph. MI1's smaller fonts are 1-bpp; the larger title/credits font
is 2-bpp.

The format mirrors COST in one specific way: glyph bitmap "off"
pixels (bit pattern `0`) are universally transparent, regardless of
what `colorMap[0]` contains. So `colorMap[0]` is effectively unused
storage; only `colorMap[1..2^bpp - 1]` carries real CLUT indices.

---

## 3. Block payload layout

After the standard 8-byte block header (`'CHAR' + size BE`), the
payload begins:

```
off  size   field
 0    u32   size       — redundant; equals (block_size − 23). Informational.
 4    u16   magic      — observed 0x0363 across every MI1/MI2 charset.
 6    15B   colorMap   — bit-pattern → CLUT index table (see §5).
21    u8    bpp        — 1 or 2 bits per glyph pixel.
22    u8    fontHeight — declared font height in pixels.
23    u16   numChars   — number of entries in the offset table below.
25    u32×N glyphOffsets — N = numChars; per-char offset table.
```

The `size` field at bytes 0..3 always equals `block_size − 23`,
equivalently `payload_length − 15`. So it counts payload bytes from
byte 15 onwards. Why "15"? The size field's anchor doesn't line up
with any other meaningful field — best read as "redundant metadata
the original tools wrote out, the decoder doesn't need it".

### ⚠️ Glyph offsets are anchored at byte 21

Each `u32` in `glyphOffsets` is **not** a byte position from the
start of the payload. It's the byte position **relative to byte 21**
— the position of the `bpp` byte. Translation:

```
absolute_byte_in_payload = 21 + glyphOffsets[charCode]
```

An offset value of literally `0` is the "no glyph for this char code"
sentinel; most charsets have many sentinel entries because not every
ASCII code (let alone the full 0..255 range) is populated.

This is the same family of "offset has an unusual anchor" quirk
we've seen in SMAP (header-inclusive +8), ZP## (also +8), and COST
(image-table entries point 6 bytes into the image header). The
constant in CHAR is 21 — exactly the number of bytes before the
`bpp` field, so the natural reading is "offset relative to start of
the bpp/fontHeight/numChars/offsetTable section".

A useful verification: build the offset table with `tableEnd = 25 +
numChars × 4`. For the first non-sentinel `glyphOffsets[c]`, the
expression `21 + glyphOffsets[c]` should be ≥ `tableEnd` — i.e. the
glyph data lives *after* the offset table. If you tried the "absolute
from byte 0" reading it'd be `glyphOffsets[c]`, which lands *inside*
the offset table for MI1 charsets and signals the wrong anchor.

### Counting populated glyphs

`numChars` is the *table* length, not the count of usable glyphs.
MI1's 1-bpp dialog font declares `numChars = 256` but populates only
~96 entries (printable ASCII plus a handful of extras); the rest are
sentinel zeros. It's worth reporting both the populated count and the
slot count, since the divergence is large.

---

## 4. Per-glyph header + bitmap

At `21 + glyphOffsets[c]`, each non-sentinel glyph begins with a
4-byte header followed by its bitmap stream:

```
off  size  field
 0    u8   width
 1    u8   height
 2    i8   xOffset    (signed; applied to cursor before stamping)
 3    i8   yOffset    (signed; applied to cursor before stamping)
 4..  bits packed: width × height pixels at `bpp` bits each,
      row-major, MSB-first within each byte. No per-row padding.
```

The bitmap byte count is `ceil(width × height × bpp / 8)`. Bit
positions roll continuously across row boundaries — there is no
"each row starts on a byte boundary" rule. A 6×8×1 glyph fills
exactly 6 bytes; a 7×7×1 glyph straddles byte boundaries mid-row.

`xOffset` / `yOffset` are signed bytes the text-layout pass adds to
the cursor before stamping the glyph. They're nearly always 0 for
plain 1-bpp fonts; the 2-bpp outlined font in MI1 uses `xOffset = −1`
so each glyph overlaps the right edge of the previous one by 1
pixel, knitting outlines together cleanly.

### ⚠️ Some releases store the bitstream 180°-rotated

Some releases ship a charset whose glyph bitstream is stored rotated
180° — and **no header flag distinguishes it**: two charsets with
byte-identical 25-byte headers can differ this way (observed in the
Italian MI1 release, charset 2). Detection has to be empirical: in an
upright font the densest pixel row of glyphs like `L` and `J` is the
baseline stroke, so it must land in the lower half of the cell — if it
lands in the upper half, the stream is rotated. Decoding then mirrors
the pixel grid through its centre, equivalent to re-decoding the
reversed stream.

### Empty / zero-sized glyphs

Some character codes (typically ASCII control codes 0x01..0x1F) have
a valid offset pointing to a 4-byte header where `width = 0` or
`height = 0` — present but blank. A decoder should return an empty
pixel buffer for those rather than throwing, so a string containing a
stray control byte doesn't break rendering.

### Bit packing — worked example

A 4×2 glyph at 1-bpp encodes 8 pixels into 1 byte. With pixel row 0
as `1, 0, 1, 0` and row 1 as `0, 1, 0, 1`:

```
bit positions (MSB → LSB):  7 6 5 4 | 3 2 1 0
pixel values:               1 0 1 0   0 1 0 1
byte value:                 0xA5
```

So a single byte `0xA5` carries the whole glyph; rows do *not*
re-align to a byte boundary between them. Reading bit-by-bit (rather
than byte-aligned per row) handles the bpp=2 straddle case the same way
naturally.

---

## 5. The 15-byte color map

Bytes 6..20 of the payload are a 15-entry palette mapping table
indexed by glyph bit pattern. For a charset with `bpp = b`, the
meaningful entries are indices `1 .. 2^b − 1`:

- **1-bpp charset**: `colorMap[1]` is the single ink color. Indices
  2..15 are storage filler — observed values follow a sequential
  `0x03, 0x04, … 0x0f` pattern that's almost certainly the encoder's
  default fill, not significant data.
- **2-bpp charset**: `colorMap[1..3]` carry three CLUT indices
  representing the outline / mid / fill levels of a four-level
  glyph (level 0 = transparent, levels 1..3 from the map). Indices
  4..15 are filler.

The "ink color" the runtime uses is whatever the script writes into
`colorMap[1]` at runtime (actor talk colours, credit colours — see the
render-time note below).

Slot 0 is always transparent regardless of its value, mirroring the
COST convention.

### Render-time colours vs. the embedded map

The embedded `colorMap` entries above index 1 are **editor placeholders,
not render colours.** A real 2-bpp talk/credit font decodes to glyph
levels where value 1 is the inner **fill** and value 2 the outer
**outline**, but the map's slot-2/slot-3 values are arbitrary ramp
colours (teal/red in MI1) the engine does not use. The levels the engine
actually paints come from the **runtime colour map**, set by script via
the `cursorCommand` charset-colours sub-op: MI1's boot sets it to
`[0, 6, 2]`, mapping glyph fill to CLUT 6 and outline to CLUT 2 — which
is why the verb glyphs carry dark shadows. When an active text colour is
in play (the `SO_COLOR` the script set — actor talk colour, credit
colour, etc.) it overrides the fill; the outline keeps the dark map
entry, so talk and credit text reads as coloured fill with a black
shadow. Treating the embedded slot-2/3 values as render colours produces
the wrong (teal-edged) text.

An actor's talk colour must be read **live at render time**, not
captured when the line is printed: the SCUMM-Bar pirates set their talk
colour from a helper script started *after* the `print` — a frame later
— so a print-time capture inks the line wrongly.

---

## 6. Text layout semantics

The simplest plausible single-line layout is:

```
cursorX, cursorY = 0, 0
for each character ch in the string:
  if ch == '\n':
    cursorX = 0
    cursorY += fontHeight
    continue
  g = decode glyph for ch.charCodeAt(0)
  if g is non-empty:
    stamp g.pixels at (cursorX + g.xOffset, cursorY + g.yOffset)
  cursorX += g.width
```

So the **advance** per glyph is just `width`. The `xOffset` shifts
the *stamp position* — not the advance — which is how outlined fonts
get their overlap. Stamped pixels honor `xOffset` / `yOffset` as
signed displacements; the bounding box widens to fit any pixels
pushed beyond the bare-advance edges.

Newlines reset the cursor to column 0 and advance Y by the declared
`fontHeight`. There is no inter-line gap — adjacent lines touch.
Word wrap, alignment (centered / right-justified), and dialog text-
box geometry are downstream concerns.

### The message channels + the blast model

A `print` opcode targets a channel by its actor id, and the channels coexist
on screen:

- **Actor speech** (a real actor id) — transient, positioned above the
  speaker, auto-cleared when the talk timer drains.
- **Narrator text (id 255)** — screen-positioned rather than
  speaker-anchored, but otherwise **talk-flow**: it pages on `\xff\x03`,
  gates `wait forMessage`, and is auto-cleared at the same timer drain that
  releases the wait — unless it carries keepText. The MI1 data pins this
  split cleanly: every a=255 print that must outlive its delay carries
  `\xff\x02` (the credits `#152`, the "Nel frattempo" interludes
  `#120-122`, "Passano giorni" `#108`, the layered "Le tre prove!" title,
  copy protection `#154/155`), while the close-up conversation replies
  (`#93`…) carry none and rely on the drain erase — without it, a pirate's
  last reply lingers over the dialog choices.
- **Blast text (id 254: signs, part-titles, the dance steps)** — SCUMM
  *blasts* it onto the charset region outside the talk lifetime. Its
  lifetime is **`restoreCharsetBg`**: a *transient* (non-keepText) print
  draws over a region that is restored (erased) exactly **once per display
  cycle**, lazily, just before the first transient draw of that cycle. So
  transient prints **within one frame accumulate**, but the first transient
  print of a *new* frame erases the previous frame's transient text first.
  A print at an already-occupied anchor replaces it.
- **id 253 is a developer/debug channel** — in MI1's Italian build every
  `print a=253` is a leftover English dev string (mostly gated behind
  `bit#482`), so it is suppressed rather than drawn. Routing 253 to the
  screen leaks untranslated debug lines over real text.

keepText prints (`\xff\x02`) neither trigger nor suffer any of the erases —
they accumulate and persist until an explicit clear, overwrite, room change,
or reset.

**System-print state is sticky.** The position, centering, and colour
one system print establishes (`SO_AT`, `SO_CENTER`, `SO_COLOR`) carry
over to the next system print that doesn't restate them. MI1's credits
rely on this: each screen carries `SO_AT`/`SO_CENTER` only on its first
line, and the following lines inherit. Actor talk never reads the
sticky state — its placement follows the speaker.

Two real scenes pin down both halves of this rule:

- The **"Parte Due / Il Viaggio" chapter card** (`global #122`) issues
  *two* `print(254)` opcodes back-to-back **in one frame** at different y
  (`@165`, `@180`) and they coexist — same-frame transient prints stack.
  Once drawn they persist across the following wait frames (no new
  transient print arrives to fire the restore). (That card's hold is a
  separate matter — the duration of its sound, gated by an
  `isSoundRunning` wait loop, so it lands with audio.)
- The **map hover poller** (`global #24`, room 85) re-prints the
  hovered location's name **near the cursor every frame**, and a bare
  `print " " at 0,0` on hover-out. Because the cursor drifts a pixel or
  two per frame, a naïve "stack distinct positions" model smeared a trail
  of stale labels that never cleared (`bug-map-labels`). The per-cycle
  restore is what collapses each frame's label onto one and lets the
  hover-out space erase it — exactly the original's behaviour.

Concretely, a "restore pending" flag is armed at the top of each game
frame and consumed by that frame's first transient print, which drops the
prior frame's transient lines (keepText lines survive). The flag is
transient — not part of save state; it re-arms every frame. System text is
**not** auto-cleared by the talk timer at all (only actor speech is); it is
erased by the next transient print's restore, a **room change**, a
**cutscene end**, an empty print, or reset (see the timer section below).

### What's not in the renderer (deliberately)

The SCUMM dialog system reserves a small family of byte values
(`0xFF` followed by a sub-code) for *escape sequences* — "wait for
click", "play sound id N", "substitute variable N", "set color to
N". Those are interpreted by the VM as it streams dialog through
the text renderer; the renderer itself just sees an already-resolved
string. A renderer that receives an unresolved string containing `0xFF`
bytes will attempt to look up character `0xFF` in the glyph table and
render or skip per the result — these codes must be handled upstream.

**`0xFE` is a second escape introducer**, distinct from `0xFF`: in the
string decoder `FE 01` is a **newline**, while a bare `0x01` (not
preceded by `0xFE`) stays an ordinary glyph. The decoder must look at
the introducer before the sub-code byte — treating every `0x01` as a
line break, or ignoring `0xFE`, both mangle layout. MI1's verb-panel
scroll arrows (verbs 109/110) stack their 8×8 glyph tiles into a taller
arrow using `FE 01` as the row separator.

### `@` (0x40) is name padding, not a glyph

Object names live in fixed-size OBNA buffers padded with `@` (0x40) so a
later `setObjectName` can overwrite them in place with a longer string (obj
488's verb-91 rewrites `"@@@@@ pezzi da otto@@@@"` → `"500 pezzi da otto"`).
SCUMM's printer **skips `@` outright** — and must, because the sentence and
dialogue fonts (charset id 1 and 2) *do* carry a visible `@` glyph yet the
game never shows padding clutter. So text measurement and rendering must
skip code 0x40 unconditionally rather than leaning on a font that happens to
lack the glyph — otherwise the padding leaks through, e.g. "il pezzo di
carne@@@@…" in the sentence line.

### The talk timer vs. on-screen lifetime

When the talk timer (`VAR_HAVE_MSG`/`talkDelay`, paced by `VAR_CHARINC` ×
length, with a floor of ~30 jiffies — about half a second — so even a
one-character line lingers readably) drains, `VAR_HAVE_MSG` clears so a
`wait forMessage` releases, and the **talk-flow text** — actor speech *and*
narrator a=255 lines without keepText — is removed. A long message split with
`\xff\x03` is presented one sentence page at a time; each page runs its own
timer, and `VAR_HAVE_MSG` stays set until the last page is dismissed.
**Blast text (a=254) is not removed by the timer** — its on-screen lifetime
is SCUMM's `restoreCharsetBg` (a screen redraw), which we approximate with
three triggers: the next transient print's per-cycle restore, a **room
change** (`enterRoom`), and a **cutscene end** (`endCutscene`). An explicit
empty/space `print` and reset also clear it.

Two scenes pin the channel split — both are non-keepText system lines, and
the **actor id** is what tells their lifetimes apart:

- The room-28 **cook's** `print a=255 "Non puoi venire di qui!"` runs
  `print → wait forMessage → endCutScene`. The line erases at the drain —
  the same instant the wait releases, one opcode before the cutscene end, so
  the two triggers are visually indistinguishable here. The case that
  *requires* the drain erase is the close-up conversations (`#93`…): the
  reply's `wait forMessage` releases straight into the choice menu with no
  cutscene end or room change in sight.
- The **treasure-map close-up** (`global #123` → room 63) prints its
  dance-step lines as **a=254** blast text, then sits in a wait-for-**click**
  loop (no `wait forMessage`). The lines must persist until the click ends
  the cutscene — which they do, because 254 lives outside the talk lifetime
  entirely.

**keepText** (`\xff\x02`) is a stronger persistence: it survives even the
per-cycle restore, clearing only on an explicit empty/space `print` at the same
anchor, an overwrite, or a room change. Signs, credits, and the layered
"Le tre prove!" title use it: the credit script (`#152`) prints a credit with
`\xff\x02`, holds it with its own `delay`, then clears it with `print " "`. The
string decoder must surface the keepText flag.

---

## 7. End-to-end — rendering "GUYBRUSH"

What the decoder does to go from "raw payload" to "letters
on a canvas":

1. **Walk the resource tree** for a `CHAR` block; slice its payload.
2. **Parse the header** at bytes 0..(25 + 4×numChars − 1): pull
   `colorMap`, `bpp`, `fontHeight`, `numChars`, and the per-char
   `glyphOffsets[]`.
3. **For each character in the input string**: turn the char code
   into a glyph-table index, fetch `glyphOffsets[code]`, skip if
   it's the sentinel `0`.
4. **Resolve the byte position**: `glyphAbsByte = 21 +
   glyphOffsets[code]`.
5. **Read the glyph header** at that position: `width, height,
   xOffset, yOffset` (4 bytes).
6. **Decode the bitmap** starting at `glyphAbsByte + 4`, reading
   `width × height × bpp` bits MSB-first across byte boundaries.
7. **Pick a colour map**: typically the charset's own `colorMap`,
   possibly with slot 1 overridden by the actor's talk colour.
8. **Stamp the glyph** into the output bitmap at `(cursorX +
   xOffset, cursorY + yOffset)`, mapping each non-zero pixel value
   through `colorMap` to a CLUT index and leaving zero-valued
   pixels transparent.
9. **Advance the cursor** by `width` and move on to the next
   character.

For "GUYBRUSH" in MI1 charset #0 (1-bpp, 6-wide glyphs), the result
is a 48 × 8 pixel buffer in a single CLUT colour.

---

## 8. Pitfalls cheat-sheet

In rough order of "what hits you first":

1. **Glyph offsets look like they point into the offset table** →
   anchor convention. Add 21 to every non-zero `glyphOffsets[c]`
   value to get the payload-byte position.
2. **`numChars` declares 256 but most lookups return junk** → those
   entries are sentinel `0`s. `numChars` is the *table* length, not
   the *populated-glyph* count.
3. **Width and height look like garbage on the first glyph** →
   you've landed inside the offset table instead of at a real glyph
   header. Confirm the anchor convention (#1).
4. **Decoded glyphs look correct shape-wise but scrambled
   column-wise** → glyph pixels are row-major, MSB-first within
   byte, but bits flow continuously across row boundaries with
   *no* per-row padding. A bpp=1 row-aligned read of a 6×8 glyph
   wastes 2 bits per row and shifts subsequent rows.
5. **2-bpp glyphs render with the wrong tones** → `colorMap[1..3]`
   has slot 1 = outline, slot 2 = mid, slot 3 = fill (or whichever
   convention the artist used; verify visually). Indices 4..15 of
   `colorMap` are storage filler — don't use them.
6. **Empty glyphs (width=0 or height=0) crash the decoder** →
   ASCII control codes 0x01..0x1F are typically present but blank.
   Return an empty bitmap, don't throw.
7. **A char code that's invalid renders junk** → check for the
   sentinel offset `0` *before* dereferencing; a glyph-offset lookup
   should return nothing for sentinels and unknown codes.
8. **Text bounding box is too small on the right** → the cursor
   advances by `width`, but `xOffset` can extend the visible glyph
   past `cursor + width`. Text measurement tracks the max of `cursor +
   xOffset + width` and the bare-cursor advance to size the box.
9. **One release's charset decodes upside-down and mirrored** → the
   bitstream is stored 180°-rotated with no header flag (Italian MI1,
   charset 2). Detect empirically — the densest row of `L`/`J` glyphs
   must land in the lower half — and mirror the grid through its
   centre (§4).
