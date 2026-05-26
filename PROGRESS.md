# webscumm — Progress

Working tracker of what's done and what's next. The **active phase** is
broken into concrete tasks. **Future phases stay one-liners** until we
actually start them — speculative breakdowns rot.

When a phase is complete, summarize what was built under "Done" and
detail the next phase here.

---

## Status

**Phase 2 complete.** Ready to kick off Phase 3 (Costumes) when you are.

---

## Future phases

Kept intentionally undetailed. We'll break each into tasks when we start
it. Order and scope may shift as we learn the territory — see
ARCHITECTURE.md §9 for the original outline.

- **Phase 3 — Costumes.** Decode and draw an actor frame, with Z-plane masking.
- **Phase 4 — Text.** Decode `CHAR` glyphs, render dialog.
- **Phase 5 — VM skeleton.** Script slots, variables, opcode dispatch, boot script.
- **Phase 6 — Enough opcodes to walk.** Reach the SCUMM Bar.
- **Phase 7 — Verb UI + input.** Click-to-walk, look-at, pick-up.
- **Phase 8 — Save states.**
- **Phase 9 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 10 — MI2 + polish.**

---

## Done

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
