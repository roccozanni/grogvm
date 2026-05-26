# webscumm — Progress

Working tracker of what's done and what's next. The **active phase** is
broken into concrete tasks. **Future phases stay one-liners** until we
actually start them — speculative breakdowns rot.

When a phase is complete, summarize what was built under "Done" and
detail the next phase here.

---

## Status

**Phase 4 complete.** Phase 5 (VM skeleton) is up next.

---

## Future phases

Kept intentionally undetailed. We'll break each into tasks when we start
it. Order and scope may shift as we learn the territory — see
ARCHITECTURE.md §9 for the original outline.

- **Phase 5 — VM skeleton.** Script slots, variables, opcode dispatch, boot script.
- **Phase 6 — Enough opcodes to walk.** Reach the SCUMM Bar.
- **Phase 7 — Verb UI + input.** Click-to-walk, look-at, pick-up.
- **Phase 8 — Save states.**
- **Phase 9 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 10 — MI2 + polish.**

---

## Done

### Phase 4 — Text *(2026-05-26)*

Decodes SCUMM v5 `CHAR` (bitmap font) blocks at both 1 and 2 bits per
pixel and renders arbitrary strings to indexed pixel buffers. The
player UI gains an LFLF-scoped charset inspector with header
diagnostics, a CLUT-tinted color-map view, a clickable glyph grid,
and a live text-rendering field (string input + ink-color picker)
that uses the currently-selected room's CLUT. 191 tests across 20
files; new `docs/SCUMM-V5-CHAR.md` format reference.

#### Original task checklist (all complete)

**Charset decoder — `src/engine/graphics/charset.ts`**

- [x] `walkCharsets(file)` — iterate `LECF > LFLF > CHAR` blocks in source order
- [x] `parseCharHeader(payload)` — size, magic, 15-byte color map, bpp (1 or 2), fontHeight, numChars, glyph offset table
- [x] `glyphPayloadOffset(header, charCode)` — resolves the **+21 anchor** convention (offsets are payload-relative to byte 21, not byte 0; value 0 is "no glyph" sentinel)
- [x] `decodeGlyph(payload, absOffset, bpp)` — 4-byte per-glyph header (width u8, height u8, xOffset i8, yOffset i8) + bit-packed pixel stream (row-major, MSB-first within each byte, **no per-row padding**)

**Text renderer — `src/engine/graphics/text.ts`**

- [x] `measureText` — bounding box for a string, honoring per-glyph advance + xOffset extension
- [x] `renderText(payload, header, text, colorMap)` — column-major emit of glyph stamps; `\n` newline support; zero-value pixels stay `CHARSET_TRANSPARENT`; non-zero glyph values route through caller-provided color map to CLUT indices

**Format reference — `docs/SCUMM-V5-CHAR.md`**

- [x] Block tree position, mental model (color map as palette routing for actor talk colors), payload layout field-by-field, ⚠️ +21 anchor convention with the "anchor probe" verification trick, 1-bpp and 2-bpp packing rules with a worked example, 15-byte color-map slot semantics (slot 0 always transparent, slots 1..2^bpp − 1 active), text layout semantics, 8-step "decode-to-pixels" walkthrough, 8-entry pitfalls cheat sheet

**Player UI — charset inspector — `src/shell/player/player.ts`**

- [x] LFLF-scoped charsets section, slotted in below costumes; same prev/next nav-per-LFLF pattern
- [x] Header summary: `N bpp · fontHeight=H · K populated / M slots · magic=0x0363 · payload N B`
- [x] Color map swatch grid: 15 cells with CLUT indices, tinted with the real game color from the current room's CLUT; "active" slots (1..2^bpp − 1) get an accent border
- [x] Glyph grid: every populated glyph rendered at 3× scale through the charset's color map, with the printable char or `\xNN` as a label, click to expand
- [x] Glyph detail panel: hex peek of the per-glyph header (4 bytes highlighted) + bitmap body, 6× preview, advance/offset metadata
- [x] Text-rendering widget: free-form text input (defaults to `GUYBRUSH THREEPWOOD`), ink-color number input that overrides color-map slot 1 live, 2× rendered canvas updating on every keystroke

**Tests**

- [x] `charset.test.ts` (16) — `walkCharsets`, `parseCharHeader` (1-bpp, 2-bpp, malformed headers, oversized numChars), `glyphPayloadOffset` (+21 anchor, sentinel, out-of-range), `decodeGlyph` (MSB-first row-major, signed offsets, 2-bpp straddle, zero-dim glyphs, bitstream truncation)
- [x] `text.test.ts` (12) — `measureText` (empty / single / multi-char / newline / missing glyph), `renderText` (ink color, transparency, side-by-side layout, per-glyph xOffset, newline stacking, 2-bpp color routing, colorMap-too-short error)

#### Bonuses

- **Anchor-probe scratch script** — `scratch/inspect-charsets.ts` automatically probes five plausible offset anchors (absolute, +21, +23, +25, +29) for the first non-zero glyph-offset entry and reports which one decodes as a sensible glyph header. The +21 finding came from this in a single pass.
- **CLUT-tinted color-map swatches** — instead of showing raw CLUT indices as numbers, each cell of the color map renders with the actual game color from the currently-selected room's CLUT. The font's "intent" reads at a glance — slot 1 is whatever shade Guybrush's talk color picks, slot 2/3 the outline/fill ramp for 2-bpp fonts.
- **ASCII-print scratch** — `scratch/print-glyphs.ts` decodes a range of characters via the engine's own decoder and prints them as terminal-readable ASCII glyphs. Used to verify all 5 MI1 charsets + the MI2 charsets at 1- and 2-bpp before claiming the decoder correct.
- **`yOffset` honored throughout** — MI1 charset #4 (2-bpp, big credits font) uses `yOff = 1` on every glyph to drop them below the cursor's baseline. Our renderer honors this without special-casing.

#### Notable design choices made during implementation

- **+21 anchor for glyph offsets** — the long-circulating-notes-style "offset is from start of payload" reading produces glyph offsets pointing into the offset table itself. Adding 21 (the byte position of the `bpp` field, which is also the start of the "logical charset metadata" block) lands every offset at a valid glyph header. Verified empirically via the anchor-probe scratch on all 5 MI1 charsets.
- **MSB-first row-major, no per-row padding** — bits flow continuously across row boundaries within a glyph. A 7×7 1-bpp glyph fits in 49 bits = 7 bytes minus 7 trailing bits, NOT 7 bytes per row × 7 rows. Our `decodeGlyph` reads bit-by-bit so the bpp=2 straddle case is handled naturally.
- **Slot 0 is always transparent** in the color map, regardless of what `colorMap[0]` contains. Mirrors the COST convention; lets the same charset render in any color without re-encoding.
- **Same decoder works for MI1 and MI2.** The 2-byte offset shift that MI2 COST blocks need does NOT apply to MI2 CHAR blocks — both games parse identically. Verified visually.
- **Color map filler is real** — slots 4..15 for both 1-bpp and 2-bpp charsets contain a sequential `0x04, 0x05, … 0x0f` filler pattern across every charset we inspected. Almost certainly the encoder's default fill; the UI marks them as inactive (muted) so they're visibly distinct from the slots actually used.
- **Newline = `fontHeight` advance, no inter-line gap.** Simplest possible vertical layout; word-wrap and text-box geometry are downstream concerns deferred to dialog UI.
- **Diagnostic UI is permanent.** Glyph grid + color-map view + text input stay in the player even when scripts eventually drive the renderer.

#### Open issues / known limitations

- **No dialog escape codes.** Strings containing `0xFF`-prefixed sequences (wait, sound, variable substitution, runtime color change) attempt to look up character `0xFF` in the glyph table rather than treating them as control codes. VM concern; lands alongside the bytecode interpreter.
- **No word wrap / text-box layout.** The renderer draws a single-line stream split on `\n` only. Speech-bubble positioning above an actor's head, multi-line wrapping, and alignment are downstream.
- **No actor-bound talk colors.** Color comes from the player UI's ink input. A real script picks a color per actor and the engine passes it to the renderer.
- **Empty `numChars = 0` charsets rejected.** Defensive — we throw rather than silently producing an empty inspector. Hasn't surfaced in real data.
- **Magic `0x0363` not validated.** Every MI1/MI2 charset has it; we parse and surface it but don't reject unknown magic values.

---

### Phase 3 — Costumes *(2026-05-26)*

Decodes SCUMM v5 costumes end-to-end — sub-palette, image tables,
RLE-encoded frame pictures — plus the z-plane occlusion masks that
back actor compositing. The player UI gains a hierarchical resource
browser (rooms with LFLF-scoped costumes nested below), a
comprehensive costume inspector (header diagnostics, palette
swatches, color-keyed hex dump, limb-table chip grid, per-frame
preview canvas through the active room's CLUT), per-z-plane overlay
toggles, and a live actor compositor with click + drag positioning.
163 tests across 18 files. Two new format references in `docs/`.

#### Original task checklist (all complete)

**Costume decoders — `src/engine/graphics/costume.ts`**

- [x] `walkCostumes(file)` — iterates `LECF > LFLF > COST` in source order, indexed by LFLF position
- [x] `parseCostumeHeader(payload)` — `numAnim`, format byte (mirror + 16/32-color), sub-palette, `animCmdOffset` (= `frameOffs`), 16 `limbOffsets` (= `imageTableOffs`), `animOffsets`
- [x] `decodeLimbTables(payload, header)` — group limbs by shared offset, decode u16 LE pointer arrays, flag suspicious entries

**Frame decoder — `src/engine/graphics/costume-frame.ts`**

- [x] 12-byte image header parse: `width u8`, unknown u8, `height u8`, unknown u8, `x i16`, `y i16` ◀ frame pointer lands here, `xinc i16`, `yinc i16`
- [x] `decodeCostumeFrame(payload, framePtr)` — column-major emit; 16-color RLE with `length == 0 → next byte is the real length` extended-length escape
- [x] Costume palette index 0 → `COSTUME_FRAME_TRANSPARENT` (`0xFF`) sentinel

**Z-plane decoder — `src/engine/graphics/zplane.ts`**

- [x] `parseRmihPlaneCount(payload)` — u16 LE plane count from RMIH
- [x] `decodeZPlanes(file, roomBlock, w, h)` — walks `RMIM > IM00` for ZP## blocks
- [x] `decodeZPlane(payload, w, h)` — packbits-style RLE (high bit = run, clear = literal), MSB-first bit layout within emitted byte, offset-0 sentinel for implicit all-zero strips
- [x] `zplaneBit(plane, x, y)` — O(1) accessor with out-of-bounds = 0

**Actor compositor — `src/engine/graphics/composite.ts`**

- [x] `compositeActor({ framebuffer, fbW, fbH, frame, costPalette, actorX, actorY, actorZ, zPlanes })` — maps costume indices through CLUT, edge-clips, applies the "any plane index > actorZ hides" occlusion rule

**Player UI — `src/shell/player/`**

- [x] Hierarchical resource browsing: room nav drives the costume list (LFLF-scoped); navigating rooms updates the costumes underneath
- [x] Costume header diagnostics — format, palette, offsets, payload size
- [x] Color-keyed payload hex dump (`numAnim` / `format` / `palette` / `animCmdOffset` / `limbOffsets` / `animOffsets` each in a distinct tint)
- [x] Limb-table chip grid; trailing junk + "unused sentinel" groups handled cleanly
- [x] Frame chip click → hex peek + 3-candidate header-layout viewer + decoded preview canvas (real CLUT) + "Place on current room" button
- [x] Z-plane overlay canvas stacked over the room canvas with per-plane toggle buttons
- [x] Actor placement: defaults adapt to current room dimensions (200-tall vs 144-tall); x / y / z number inputs
- [x] Click + drag the room canvas to reposition the actor; smooth re-composite without DOM rebuild

**Format references — `docs/`**

- [x] `SCUMM-V5-COST.md` — block layout, mental model (slots/limbs/anims, three indirections), the +6 pointer convention, 16- and 32-color RLE with the length-zero escape, column-major emit, the feet-anchor convention with worked Guybrush example, MI2's 2-byte offset shift, end-to-end decode walkthrough, 10-entry pitfalls cheat sheet
- [x] `SCUMM-V5-ZPLANE.md` — RMIH, header-inclusive offsets, the offset-0 sentinel, packbits RLE with a worked strip decode, MSB-first bit order, the "any plane > actorZ" rule, explanation of overlapping pixels across planes and why a declared plane can be entirely empty (MI1 LFLF #6 ZP02), 8-entry pitfalls cheat sheet

**Tests**

- [x] `costume.test.ts` (13) — `walkCostumes`, header (16/32-color, mirror, truncation), `decodeLimbTables` (grouping, suspicious flagging, empty)
- [x] `costume-frame.test.ts` (10) — flat fills, signed displacements, column-major straddling, transparency, extended-length escape (including > 16), `xinc/yinc`, zero-dim and truncated-RLE errors
- [x] `zplane.test.ts` (13) — RMIH parse, MSB-first bit layout, literal + run sequencing, multi-strip, offset-0 sentinel, error paths, bit accessor
- [x] `composite.test.ts` (10) — opaque pass-through, transparency, redirX/Y, edge clipping (all 4 sides), multi-plane occlusion, dimension errors

#### Bonuses

- **LFLF-scoped resource browsing.** Realized mid-phase that "browse 119 flat costumes" doesn't match how the file is organised. Costumes (and any later resource types — scripts, charsets, sounds) now nest under the current room's LFLF.
- **Click + drag actor placement.** Initially just number-input fields; the user pointed out "drag" was implied so I wired up pointer events with a light-refresh path that re-composites onto the existing canvas without rebuilding any DOM.
- **Real-CLUT frame previews.** Before this, frames previewed with a rainbow palette that made every sprite look like Christmas. Routing through the active room's CLUT shows actual game colors at a glance.
- **3-candidate header-layout viewer.** For any candidate frame pointer, shows what width/height/redir would read as under three offset-into-header conventions. Made the +6 discovery a single-look exercise.
- **Smart "Place on current room" defaults.** Adapts `(x, y)` to the current room's dimensions so the default lands on-screen for both 200-tall outdoor and 144-tall interior rooms.
- **`scratch/` debug scripts** (gitignored) — five small scripts for inspecting real game data through the engine's own decoders. The workflow was: write a hypothesis, dump real bytes against it, iterate. Kept around for the next phase.

#### Notable design choices made during implementation

- **Anim-record decoding deferred to the VM phase.** The variable-length anim command stream is what the runtime uses to play animations frame-by-frame; for "render one static frame" we pick limb + frame directly.
- **Frame pointer at +6 into the image header.** The natural "pointer at struct start" reading produces `width = 0xFFFC`. The format keeps the pointer at the `y` field, likely a side effect of the original engine doing a single dword load on `(x, y)`.
- **RLE `length == 0` is an extended-length escape, not "run of 16".** With "run of 16", consumed byte count exceeded the available region by 8 bytes on Guybrush's idle frame, spilling garbage into the rightmost columns. With the escape rule, the count lands exactly on the next frame's header.
- **Costume color 0 = transparent** regardless of `palette[0]`'s value. Sentinel emit lets the compositor skip cleanly.
- **Z-plane offset-0 sentinel for all-zero strips.** Saves bytes for sparse masks; would crash a naive "subtract 8 → negative offset" decode.
- **Z-plane MSB-first within each emitted byte.** Visually verified by overlaying decoded masks on real MI1 room geometry.
- **Z-plane rule: "any plane index > actorZ hides".** Plane indices run 1..N. `actorZ = 0` (default) is occluded by everything; raising `actorZ` pulls the actor forward past planes one at a time.
- **Compositor reads `costPalette[idx]` → `roomCLUT[clutIdx]` inline.** Keeps frame data palette-agnostic; the same costume renders correctly in any room's CLUT.
- **LFLF index, not DROO id.** Rooms and costumes are indexed by their position in the LECF tree; the UI shows both "Room N of M" and "LFLF #X".
- **Drag uses a light-refresh path.** Re-composites onto the existing canvas (no DOM rebuild) so the canvas element stays alive through the drag and pointer events route to the same captured target. Full refresh (which rebuilds the section, in turn syncing x/y/z input field values) fires once on pointerup.

#### Open issues / known limitations

- **MI2's 2-byte offset shift not yet patched.** Documented in `docs/SCUMM-V5-COST.md` §6; MI2 costumes will decode garbage until applied.
- **32-color mode (format byte 0x59) not implemented.** Every MI1/MI2 costume in our sample is 16-color. Format documented but no decoder path.
- **Mirror flag (format bit 7) parsed but not acted on.** No costume in our sample has it set.
- **Anim record stream not decoded.** VM concern. Picking limb + frame happens directly in the UI; no animation playback exists.
- **No DROO interpretation.** Script-driven `setRoom` / `setCostume` calls would need DROO resolution.
- **No actor scaling.** The SCAL block (per-y scaling that shrinks actors walking "away" from the camera) is not consulted; actors render at native resolution at all room positions.

---

### Phase 2 — First pixels *(2026-05-26)*

Decodes the palette and background bitmap of any selectable room in
MI1 / MI2 and renders it on a Canvas2D at native resolution with
TRNS-aware transparency (transparent regions show through to a CSS
checkerboard so object placeholders are visually obvious). The block
tree from Phase 1 stays visible below; a new per-strip method bar +
histogram chip list expose SMAP decoder behavior at a glance. 116 tests
across 14 files.

#### Original task checklist (all complete)

**Block payload access — `src/engine/resources/tree.ts`**

- [x] `ResourceFile = { bytes, tree }` — single value carried by every Phase 2 decoder
- [x] `payloadOf(file, block)` — `subarray` of the block's body
- [x] `findChild` / `findChildren` / `findDescendant` — navigate by tag
- [x] `parseResourceFile` now returns `ResourceFile`

**Room navigation — `src/engine/graphics/room.ts`**

- [x] `walkRooms(file)` iterates `LECF > LFLF > ROOM` in source order, indexed by LFLF position
- [x] `decodeRoom(file, roomBlock)` composes RMHD + CLUT + SMAP + TRNS into a `DecodedRoom`

**Leaf decoders — `src/engine/graphics/`**

- [x] `rmhd.ts` — three 16-bit LE fields (`width`, `height`, `numObjects`)
- [x] `clut.ts` — 768-byte RGB palette in 0..255 (no bit-scaling needed; values are stored DAC-shifted)
- [x] `smap.ts` — full dispatcher across `0x01`, `0x0E..0x12`, `0x18..0x1C`, `0x22..0x26`, `0x2C..0x30`, `0x40..0x44`, `0x54..0x58`, `0x68..0x6C`, `0x7C..0x80`; uncompressed + Method 1 (V/H, opaque + transparent) + Method 2 (H, opaque + transparent + aliases)
- [x] `trns.ts` — 16-bit LE transparent palette index *(bonus — see below)*

**Renderer — `src/engine/render/`**

- [x] `Renderer` interface: `setPalette`, `setTransparentIndex`, `present`, `dispose`
- [x] `Canvas2DRenderer` — composes indexed + palette → `ImageData`, honours transparent index (alpha=0)
- [x] `MemoryRenderer` — records latest palette/framebuffer/transparent for tests; `rgbaSnapshot()` helper
- [x] `indexedToRgba` — pure helper, transparent index → alpha=0, rest opaque

**Player screen integration — `src/shell/player/`**

- [x] Room viewer section above the block tree
- [x] Prev / next room selector with `Room N of M · LFLF #X` label
- [x] Canvas at native room dimensions, CSS-scaled 2× with `image-rendering: pixelated`
- [x] CSS checkerboard background reveals transparent (TRNS) pixels
- [x] Per-strip method bar (color-coded by family) aligned with the canvas
- [x] Histogram chip list summarizing the codes used by this room
- [x] Loading + decode-error states inline

**Tests**

- [x] `tree.test.ts` — 11 tests on payloadOf / findChild / findChildren / findDescendant
- [x] `rmhd.test.ts` — 5 tests
- [x] `clut.test.ts` — 4 tests
- [x] `trns.test.ts` — 3 tests
- [x] `smap.test.ts` — 32 tests: dispatch, uncompressed, **full Method 1 grammar coverage**, **full Method 2 grammar coverage** (each delta, RLE + clamp, aliases, transparent variants), strip-method diagnostic helper
- [x] `indexed-to-rgba.test.ts` — 5 tests including transparency
- [x] `memory.test.ts` — 6 tests including transparency round-trip
- [x] `room.test.ts` — 4 tests on `walkRooms` (LFLF iteration, skipped LFLFs, missing LECF, etc.)

#### Bonuses

- **TRNS / transparency support** — added when room viewing surfaced
  "purple bars" that turned out to be object placeholders. Renderer
  interface grew `setTransparentIndex`, indexed-to-RGBA learned to emit
  RGBA(0,0,0,0) for the configured index, CSS checkerboard backdrop on
  the canvas exposes those regions visually.
- **Per-strip method diagnostic UI** — `getSmapStripMethods` helper
  plus a color-coded cell bar aligned with the canvas and a histogram
  chip list. Made every subsequent SMAP debugging round much faster.
- **`docs/SCUMM-V5-SMAP.md`** — a self-contained format reference
  covering layout, bit-stream conventions, full method dispatch, both
  compression algorithms with prose explanations, and the two specific
  corrections we needed to make over the long-circulating notes.

#### Notable design choices made during implementation

- **`ResourceFile` flows through everything.** Decoders take
  `(file, block)` and slice on demand; no copy, no re-decryption, and
  no "did you pass the right payload?" bug class.
- **Engine code stays DOM-free.** Only the shell touches
  `FileSystemDirectoryHandle` / `File`; engine layer consumes
  `Uint8Array` / `ResourceFile`.
- **SMAP offsets are header-inclusive.** The decoder gets the payload
  and subtracts 8 inside `readStripOffsets`. Symptom of getting this
  wrong is wildly varying compression codes (255, 0, 247…) and was
  the first debugging milestone.
- **Method 2 delta sign is inverted from the circulating notes.** The
  working dispatch is `color -= (4 - d)`. Verified empirically against
  MI1 / MI2 strips; opposite sign produces unmistakable color-cycling
  artifacts in gradient regions.
- **Method 2 paletteBits subtract for `0x54..0x58` is `0x50`, not
  `0x51`.** The notes' value yields pb=3..7 which conflicts with every
  other range. Symptom: localized garbage on codes 87 / 88 only.
- **Canvas2DRenderer clears before each present.** Transparent pixels
  in the new frame must expose the CSS checkerboard, not blend with
  the prior frame.
- **Room indexing by LFLF position, not game id.** DROO decoding is
  deferred until scripts actually call `setRoom`. The UI shows both
  "Room N of M" and "LFLF #X" so the cross-reference is explicit.

#### Open issues / known limitations

- **No actor / object compositing yet.** Areas marked transparent by
  TRNS show through to the checkerboard. They'll be filled by OBIM
  sprites in Phase 3+.
- **No DROO interpretation.** Rooms indexed by LFLF position; room IDs
  used inside scripts are not yet resolved.
- **No palette cycling / fades.** The CYCL block is not decoded.
- **MI2 cutscene rooms render as solid colors.** That's correct —
  rooms 103 (all black) and 108 (all purple) really do ship as 40
  identical-color strips for fade/transition effects.

---

### Phase 1 — Resource catalog *(2026-05-25)*

Parses `MONKEY.000` + `MONKEY.001` (and MI2 equivalents) end to end:
File System Access permission re-grant, slurp + byte-XOR-decrypt with
key `0x69`, recursive walk of the SCUMM v5 block tree, indented per-line
tree dump in the player screen with a tag-by-tag description from a
single-source-of-truth catalog. 46 tests across 6 files.

#### Original task checklist (all complete)

**Permission re-grant**

- [x] `src/shell/storage/permission.ts` — `ensureReadPermission(handle)` queries+requests `'read'` mode
- [x] Wired into the library's Play button (re-grant before navigating)
- [x] Denial path: navigate to `{ kind: 'library', flash: '…retry.' }` and render an inline flash banner

**XOR layer — `src/engine/resources/xor.ts`**

- [x] Pure `xorDecrypt(data, key)`, returns a new buffer
- [x] `SCUMM_V5_XOR_KEY = 0x69` constant with comment noting other v5 releases may differ
- [x] 6 tests: empty input, identity at key=0, round-trip, per-byte XOR, no mutation, key constant value

**Block parser — `src/engine/resources/block.ts`**

- [x] `Block { tag, offset, size, children? }` with `children` set iff the tag is a known container
- [x] `parseBlocks(data, baseOffset = 0)` — recursive walker
- [x] BE 32-bit size, size includes the 8-byte header
- [x] `isContainerTag(tag)` — closed set + `^IM[0-9A-F]{2}$` regex for image containers
- [x] `BlockParseError` with byte offset on zero-size, overshoot, truncated header
- [x] 15 tests: leaf, sequence, nested, deeply nested, unknown→leaf, empty container, error paths, `baseOffset`

**File adapter — `src/engine/resources/file.ts`**

- [x] `parseResourceFile(encrypted, xorKey)` — composes `xorDecrypt` + `parseBlocks`
- [x] No DOM types in the engine layer — shell does `FileSystemDirectoryHandle` → `File` → `Uint8Array`
- [x] No standalone tests; covered transitively by xor + block tests

**Player screen rewrite — `src/shell/player/player.ts`**

- [x] Back button + header (game name, gameId, source dir)
- [x] Loading state while files are read + parsed
- [x] Two sections (Index, Resources) with stats (block count, top-level count, file size)
- [x] Indented per-line tree, monospace, color-coded (tag accent, meta muted, description italic)
- [x] Case-insensitive filename match in `findFile` (handles uppercase/lowercase game files)
- [x] Error state with file/parse error message

**Tests**

- [x] Phase 1 added 27 tests (xor: 6, block: 15, catalog: 6). Total: 46 across 6 files.

#### Bonus: block-description catalog

Added during browser review when you flagged "would be SUPER NICE to know
what each block means". Single source of truth at
`src/engine/resources/catalog.ts`, used inline by the player UI.

- [x] `describeBlock(tag)` covers every block currently emitted by the parser, plus `IM[0-9A-F]{2}` and `ZP[0-9A-F]{2}` patterns
- [x] Test asserts every container tag in the parser has a catalog entry (parser/catalog stay in sync)

#### Notable design choices made during implementation

- **`children !== undefined` distinguishes containers from leaves**,
  even for empty containers (which get `children: []`). Cleaner than
  using a separate `isContainer` field that could drift from `children`.
- **Per-line `<div>`s, not `<pre>`** in the tree view, so the
  description can render in a distinct muted/italic style. With ~2-3k
  blocks in MI1's `.001` this is still well under 100 ms to paint.
- **Catalog as data, not docs.** Descriptions live in TS alongside the
  parser. The UI is the primary surface; if a separate Markdown
  reference is wanted later, we can generate it from the catalog.
- **`flash` state on the library Screen**, added so permission denial
  has somewhere to land that isn't an `alert()`.

---

### Phase 0 — Scaffold *(2026-05-25)*

Runnable empty app: Vite + TypeScript + Vitest scaffold, library /
install / player-placeholder screens with a state-machine shell, game
detection, IndexedDB persistence of directory handles, browser-support
gating, 15 passing tests across 3 files. `npm run dev` serves the
library; `npm test` watches.

#### Original task checklist (all complete)

**Project setup**

- [x] `npm init`, add `.gitignore`
- [x] Install dev deps: `vite`, `typescript`, `vitest`, `@types/node`, `fake-indexeddb`, `@types/wicg-file-system-access`
- [x] `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`)
- [x] `vite.config.ts`
- [x] `vitest.config.ts` (`environment: 'node'`)
- [x] `index.html` + `src/main.ts`
- [x] npm scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `test:run`
- [x] `npm run dev` boots and serves the library screen

**Test harness**

- [x] Trivial Vitest sanity test (`src/sanity.test.ts`)
- [x] `npm test` runs in watch mode, green

**Shell skeleton**

- [x] Screen state machine in `src/shell/app.ts` (`library` | `install` | `player`)
- [x] Directory structure per ARCHITECTURE.md §8

**Library screen — `src/shell/library/`**

- [x] Lists installed games from IndexedDB, with empty-state copy
- [x] "Install game…" button → install screen
- [x] Per-game row: name, gameId, Play button (navigates to player placeholder), Remove button
- [x] Remove deletes the IndexedDB record only — user's files are untouched

**Install flow — `src/shell/install/`**

- [x] Triggers `window.showDirectoryPicker({ mode: 'read' })` on button click
- [x] Game detection in `detect.ts` (pure, filename-based, case-insensitive)
- [x] On success: persist `{ id, displayName, gameId, directoryHandle, installedAt }` to IndexedDB, return to library
- [x] On unknown: error message with retry/cancel
- [x] User cancel (AbortError) is silent

**IndexedDB layer — `src/shell/storage/`**

- [x] `games` object store with CRUD wrappers (`listGames`, `addGame`, `removeGame`, `getGame`)
- [x] Each operation opens + closes its own DB connection (simple, no shared state)
- [x] *(Deferred to launch time)* Permission re-grant flow before passing the handle to the engine — left as a TODO comment for Phase 2 when there's actually something to launch

**Browser support**

- [x] `checkBrowserSupport()` detects missing `showDirectoryPicker` and `indexedDB`
- [x] Renders an "Unsupported browser" page instead of crashing

**Tests for Phase 0**

- [x] `detect.test.ts` — 8 tests: positive MI1, positive MI2, case-insensitive, missing file, empty, unrelated, extra files, MI1/MI2 disambiguation
- [x] `games.test.ts` — 6 tests: empty store, add+list, round-trip by id, remove, unknown id, multiple games independent. Uses `fake-indexeddb/auto`, resets the DB between tests.
- [x] `sanity.test.ts` — 1 test: arithmetic sanity check

#### Notable design choices made during implementation

- **Detection takes `string[]`, not a directory handle.** Pure function,
  trivially testable in Node. The directory-walking adapter lives in
  shell-only `install.ts`, which the test suite doesn't touch.
- **No shared DB connection.** Every storage call opens, transacts, and
  closes its own `IDBDatabase`. Simpler than connection pooling, fine for
  the access pattern (one user action at a time). Revisit if it ever
  matters.
- **Permission re-grant deferred.** Stored a TODO for when the player
  screen actually needs to open the files (Phase 2). Phase 0's player is
  a placeholder, so there's nothing to authorize yet.
- **`@types/wicg-file-system-access`** was needed — TypeScript's built-in
  `lib.dom.d.ts` covers `FileSystemDirectoryHandle` and `entries()`, but
  not `Window.showDirectoryPicker`.
