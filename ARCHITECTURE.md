# webscumm — Architecture

A from-scratch TypeScript reimplementation of a small slice of [SCUMM]
running natively in the browser. The goal is **learning by building**, not
shipping a ScummVM alternative.

[SCUMM]: https://en.wikipedia.org/wiki/SCUMM

---

## 1. Goal & scope

Build a web-native interpreter capable of running:

- **The Secret of Monkey Island** — CD DOS, VGA, 256-color (SCUMM v5)
- **Monkey Island 2: LeChuck's Revenge** — DOS, VGA, 256-color (SCUMM v5)

Both titles share the same engine version, container layout, and graphics
pipeline, so almost all engine code is reused across the two.

### Non-goals

- Compatibility with other SCUMM versions (v4, v6+).
- Compatibility with non-SCUMM LucasArts titles.
- Bit-exact reproduction of original timing, audio mixing, or quirks. We aim
  for "plays correctly enough to finish the game", not preservation.
- Reusing any ScummVM source. The project is a clean-room rewrite based on
  publicly documented file formats and bytecode references.
- Mobile / touch input as a first-class target. Desktop browsers only.
- A general-purpose plugin system, mod support, or scripting hooks.

---

## 2. Guiding principles

These shape every decision below.

1. **Learning first.** Code clarity beats performance. Prefer the
   straightforward implementation over the clever one, even when the clever
   one would be faster. If a 50-line decoder is easier to follow than a
   10-line one full of bit tricks, the 50-line version wins.
2. **Small, runnable steps.** Each phase ends with something we can see,
   run, or assert against. We do not build three subsystems in parallel
   hoping they meet in the middle.
3. **Test-first feedback loop.** Automated tests exist from phase 0
   (see §6). The browser is for integration and rendering bugs only — not
   for verifying decoder correctness or VM behavior.
4. **No premature abstraction.** Build the one concrete thing first, then
   extract an interface only when a second implementation actually arrives.
   The two interfaces called out below (`Renderer`, `AudioBackend`) are the
   exceptions because they directly enable testing without a DOM.
5. **Reverse engineering, not reuse.** We learn from public format docs
   and write our own code. No copying from ScummVM.

---

## 3. Target file layout

The user "installs" each game by pointing the host shell at a directory on
disk containing the original game files. Expected contents:

```
SecretOfMonkeyIsland/
  MONKEY.000        # index: directories, room offsets, palette/script counts
  MONKEY.001        # LECF container: all room/script/costume/sound resources
  track02.fla ...   # redbook CD audio (deferred — audio phase)

MonkeyIsland2/
  MONKEY2.000
  MONKEY2.001
```

Detection rule: a directory is identified as MI1 if it contains
`MONKEY.000` + `MONKEY.001`, MI2 if it contains `MONKEY2.000` + `MONKEY2.001`.
No other heuristics — if the user points at the wrong folder, we say so.

Both `.000` and `.001` are **XOR-encrypted byte-wise with `0x69`** in these
releases. The resource layer decrypts on read.

---

## 4. High-level layers

```
┌────────────────────────────────────────────────────┐
│  Host shell  (src/shell)                           │
│  - Game library UI, install flow, settings         │
│  - File System Access API, IndexedDB persistence   │
│  - Hosts the engine in a <canvas>                  │
└────────────────────────────────────────────────────┘
                       │   boots with a GameHandle
                       ▼
┌────────────────────────────────────────────────────┐
│  Engine  (src/engine)                              │
│                                                    │
│   ┌──────────┐   ┌──────────┐   ┌──────────────┐   │
│   │ Resources│──▶│   VM     │──▶│   Graphics   │   │
│   │  (.000/  │   │ (bytecode│   │ (rooms,      │   │
│   │   .001)  │   │  interp) │   │  costumes,   │   │
│   └──────────┘   └────┬─────┘   │  charset)    │   │
│                       │         └──────┬───────┘   │
│                       ▼                ▼           │
│                  ┌─────────┐    ┌──────────────┐   │
│                  │  Input  │    │   Renderer   │   │
│                  │  Audio  │    │  (interface) │   │
│                  │  Save   │    └──────┬───────┘   │
│                  └─────────┘           ▼           │
│                                  ┌──────────────┐  │
│                                  │  Canvas2D    │  │
│                                  │  impl        │  │
│                                  └──────────────┘  │
└────────────────────────────────────────────────────┘
```

The **host shell** and the **engine** are independent. The shell knows how to
locate game files and persist user state; the engine knows how to take an
opened set of game files and produce frames + audio + accept input. They
communicate through a small `EngineSession` boundary, never through globals.

---

## 5. Module breakdown

### 5.1 Resources — `src/engine/resources/`

Owns the on-disk format. Nothing above this layer should know about LECF
blocks, XOR, or byte offsets.

- **`XorStream`** — random-access reader over a `File`/`Blob`, transparently
  decrypts with `0x69`.
- **`Block`** — SCUMM v5 block format: 4-byte big-endian size + 4-char tag +
  payload. Recursive containers (`LECF` → `LFLF` → `ROOM` etc.).
- **`Index`** — parses `MONKEY.000`: `RNAM` (room names), `MAXS` (counts),
  `DROO`/`DSCR`/`DSOU`/`DCOS`/`DCHR`/`DOBJ` (resource directories), `DLFL`
  (per-room offset table into `.001`).
- **`ResourceManager`** — read-through cache, keyed by `(type, id)`. Lazy:
  resources are decoded on first access, not at load time. LRU eviction
  for big things (rooms, costumes); permanent for small things (scripts).

This layer returns raw decoded buffers; format-specific decoders
(smap, costume frames, charset glyphs) live in `graphics/`.

### 5.2 VM — `src/engine/vm/`

A bytecode interpreter for the SCUMM v5 opcode set (~160 opcodes with
parameter-mode bit flags).

- **`ScriptSlot`** — one of N concurrent running scripts, tracks PC,
  status (running/paused/frozen/dead), local variables, owning room.
- **`Vm`** — owns script slots, the global variable bank (vars 0–799, bit
  vars 0–4095), and an opcode dispatch table. Steps one slot at a time
  until it yields (breakHere, delay, jump, etc.).
- **`Objects`** — object state table: position, state flags, owner, name.
- **`Sentence`** — verb + object1 + object2, fed by the input layer and
  consumed by scripts via the `do-sentence` opcode.

The VM never touches the renderer or audio directly. It mutates engine
state (palette dirty flags, actor positions, room load requests) and the
main loop pushes that state into the appropriate subsystem each frame.

### 5.3 Graphics — `src/engine/graphics/`

Pure decoders + a 320×200 indexed-color framebuffer. No platform code here.

- **`Palette`** — 256 RGB entries, dirty flag, supports cycling and
  fade-to/from operations driven by VM opcodes.
- **`Room`** — background decoder for `SMAP` (strip-based; each strip is
  one of several compression methods identified by a leading code byte),
  plus Z-planes (`ZP00`..`ZP03`) used for actor occlusion.
- **`Costume`** — actor animation decoder. v5 costumes are a graph of
  limbs × frames × commands; this is the gnarliest decoder in the project.
- **`Charset`** — bitmap fonts used for verb UI and dialog text.
- **`Framebuffer`** — `Uint8Array(320 * 200)` of palette indices, plus the
  "main", "text", and "verb" virtual surfaces SCUMM tracks separately.

### 5.4 Renderer — `src/engine/render/`

The swappable seam. Engine code only talks to the `Renderer` interface:

```ts
interface Renderer {
  setPalette(rgb: Uint8Array /* 768 bytes */): void;
  present(indexed: Uint8Array /* 320*200 */): void;
  dispose(): void;
}
```

- **`Canvas2DRenderer`** — default. Converts the indexed framebuffer to
  RGBA via the palette into an `ImageData` and `putImageData`s it.
- **`MemoryRenderer`** — used by tests. Records calls (latest palette,
  latest framebuffer) so engine behavior can be asserted without a DOM.
- A future `WebGLRenderer` would implement the same interface and could
  do palette lookup in a shader (palette as a 256×1 texture, indexed
  framebuffer as a `LUMINANCE` texture). Out of scope for now.

Crucially, **all visual work above this line is on indexed pixels**. We do
not pre-multiply the palette into RGBA in any decoder. This keeps palette
cycling and fades cheap and makes the WebGL swap trivial later.

#### Scaling and display size

The engine always works in **native 320×200 indexed pixels**. Nothing in
the engine knows or cares what size the canvas appears on screen — this
keeps coordinate math (mouse clicks, actor positions, room geometry) in
the same units the original game uses.

Scaling is the **host shell's** job, done entirely with CSS:

- The `<canvas>` element has `width="320" height="200"` (its internal
  bitmap stays native resolution).
- CSS sizes the canvas to the largest **integer multiple** of 320×200
  that fits the available viewport (so 640×400, 960×600, 1280×800, …),
  letterboxed on whichever axis runs out of room first.
- `image-rendering: pixelated` keeps the upscale crisp instead of blurry.
- The shell re-computes the chosen scale on resize.

Integer scaling only — no fractional scaling, no smoothing. It's both
simpler and looks better for pixel art.

### 5.5 Input — `src/engine/input/`

Mouse position (clipped to the 320×200 game space, accounting for canvas
scale), button edges, a small keyboard event queue. Translates clicks into
verb/object selections by querying the current verb UI state.

### 5.6 Audio — `src/engine/audio/` *(deferred)*

A no-op `AudioBackend` interface exists from day one so VM opcodes that
request sounds have somewhere to call. Real implementation — iMUSE plus
AdLib (OPL) and/or MT-32 emulation, plus CD redbook (FLA) playback —
lands in its own phase. Documented here so the seam is not skipped.

```ts
interface AudioBackend {
  playSound(id: number): void;
  stopSound(id: number): void;
  stopAll(): void;
}
```

### 5.7 Save states — `src/engine/save/`

Snapshot the VM state (variables, script slots, object state, current
room id, actor state, palette) to a versioned binary blob. Stored in
IndexedDB by the host shell, keyed by game + slot. Format is ours; not
compatible with original SCUMM save files (a non-goal).

### 5.8 Game loop — `src/engine/loop.ts`

`requestAnimationFrame`-driven, with a fixed-step "engine tick" running at
the rate scripts expect (SCUMM v5 paces internal time at roughly 60Hz, with
some subsystems updating at lower divisors). One tick:

1. Drain input events into VM-visible state.
2. Run script slots until all yield.
3. Walk actors (pathfinding step).
4. Update palette cycling / fades.
5. Compose framebuffer: room background → Z-masked actors → objects →
   verb UI → text.
6. Hand the framebuffer + palette to the renderer.

---

## 6. Testing

Automated tests exist from phase 0 and are part of every phase's
definition of done. The browser is reserved for integration and rendering
issues — never for verifying decoder correctness or VM behavior.

### Tooling

- **[Vitest][vitest]** as the test runner. Native ESM, Vite-aligned (so
  it picks up `tsconfig.json` and aliases for free), Jest-compatible API,
  fast watch mode.
- Tests run in **Node** by default (`environment: 'node'`), not jsdom.
  Engine code must work without a DOM; that constraint is enforced by the
  test environment itself.
- A single `pnpm test` (or `npm test`) command runs the whole suite in
  watch mode locally; CI runs it once and fails on red.

[vitest]: https://vitest.dev/

### What gets tested where

| Layer | How it's tested |
|-------|-----------------|
| Resources (block parser, XOR, index) | Pure unit tests with handcrafted byte fixtures. No real game files. |
| Graphics decoders (SMAP strips, costumes, charset) | Feed a known compressed input, assert the decoded indexed bytes. Tiny synthetic fixtures, plus optional larger golden buffers checked into the repo. |
| VM (opcode handlers, script slots, variables) | Drive each opcode through a minimal `Vm` instance, assert state changes. Compose small "scripts" in code to test control flow (jumps, breakHere, do-sentence). |
| Renderer | `MemoryRenderer` is the test double; the `Canvas2DRenderer` is exercised in the browser only. |
| Save states | Round-trip serialize → deserialize → equality. |
| Game loop | Step the loop N ticks with a `MemoryRenderer` and a scripted input source; assert observable state. |
| Host shell | Lightly tested. Storage wrappers and the game-detection function get unit tests; UI is exercised by hand. |

### Fixtures and game data

- **Committed test data is synthetic only.** We construct fake `.000` /
  `.001` payloads in code (or as small binary files in `test/fixtures/`)
  to exercise the parsers. We do not commit any LucasArts assets.
- A separate, opt-in **integration test tier** can read real game files
  from a path the developer configures locally (e.g. an env var pointing
  at `~/games/MonkeyIsland1/`). These tests are skipped if the path is
  not set, so the default suite stays green for anyone.

### Discipline

- **Test the contract, not the implementation.** Assert on decoded
  outputs, observable VM state, framebuffer contents — not on private
  helpers. Refactors should rarely break tests.
- **Red-green-refactor for decoders.** Write the test against the
  documented format first, then the implementation until it passes.
- **No "smoke tests" that pass by not throwing.** Every test asserts
  something specific.

---

## 7. Host shell — `src/shell/`

Vanilla TypeScript + Vite, no framework. The shell has three screens:

1. **Library** — list of installed games, "Play" buttons, "Install game"
   button.
2. **Install** — opens the directory picker via the File System Access
   API, detects which game (MI1/MI2) the directory holds, stores the
   `FileSystemDirectoryHandle` in IndexedDB so it persists across reloads.
3. **Player** — full-screen canvas hosting the engine, plus a minimal
   overlay for save/load and exit.

### Persistence

- **IndexedDB** — `games` store (per-game metadata + the persisted
  `FileSystemDirectoryHandle`), `saves` store (save-state blobs).
- Permission to the stored directory handle is requested again on each
  session (browser security requirement). The shell handles the re-grant
  flow before booting the engine.

### Browser API requirements

- File System Access API (Chromium-based browsers only at time of writing).
  Firefox/Safari fallback is a non-goal for now; the library screen tells
  the user the browser is unsupported.

---

## 8. Directory layout

```
webscumm/
├── ARCHITECTURE.md
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── public/
├── test/
│   └── fixtures/                # synthetic binary fixtures for tests
└── src/
    ├── main.ts                  # entry: mounts the shell
    ├── shell/
    │   ├── library/             # library screen
    │   ├── install/             # install flow + game detection
    │   ├── player/              # full-screen canvas + overlay
    │   └── storage/             # IndexedDB wrappers
    └── engine/
        ├── resources/           # .000/.001 parsing, blocks, XOR
        ├── vm/                  # opcode dispatch, script slots, vars
        ├── graphics/            # room/costume/charset decoders, palette
        ├── render/              # Renderer interface, Canvas2D + Memory impls
        ├── input/
        ├── audio/               # interface + silent default
        ├── save/
        └── loop.ts
```

Tests live next to the code they cover as `*.test.ts` files (Vitest
default). The top-level `test/fixtures/` directory holds shared binary
fixtures when handcrafting them inline would be unwieldy.

The engine has zero imports from `shell/`. The shell imports the engine
through a single `EngineSession` factory.

---

## 9. Phased roadmap

The architecture above is the destination. We build to it in small,
runnable steps. Each phase ends with something we can see/poke at.

| Phase | Outcome |
|-------|---------|
| **0. Scaffold** | Vite + TS project, **Vitest set up with one trivial passing test**, library screen, install flow, IndexedDB persistence of directory handles. No engine yet. |
| **1. Resource catalog** | Open `MONKEY.000`, dump every block tag/offset to the console. Prove XOR + block parsing. |
| **2. First pixels** | Decode the palette + room 1 background (`SMAP`). Push it to Canvas2D. One static frame on screen. |
| **3. Costumes** | Decode and draw Guybrush idle frame in the room. Z-plane masking. |
| **4. Text** | Decode `CHAR` glyphs, render a hardcoded line of dialog. |
| **5. VM skeleton** | Script slots, variable bank, opcode dispatch table with a handful of opcodes. Run the boot script far enough to fail loudly. |
| **6. Enough opcodes to walk** | Implement opcodes needed to reach the SCUMM Bar — actor walking, room transitions, simple object interactions. |
| **7. Verb UI + input** | Verbs, sentence line, click-to-walk, look-at/pick-up actually working. |
| **8. Save states** | Snapshot + restore VM state, IndexedDB slots, overlay UI. |
| **9. Audio** | iMUSE driver, AdLib (OPL3) synth, then MT-32 if appetite remains. CD redbook later still. |
| **10. MI2 + polish** | Verify MI2 boots on the same engine; fix the inevitable v5-but-slightly-different edge cases. |

Phases are not commitments — they're the current best guess at a learning
order. Reorder freely as we discover the territory.

---

## 10. References (read-only, no code reuse)

- [SCUMM technical reference (ScummVM wiki)][scumm-wiki] — block formats,
  opcode tables, costume layout.
- [`descumm`][descumm] documentation — bytecode disassembly conventions.
- Aric Wilmunder's original SCUMM design notes (publicly posted).
- Ron Gilbert's blog posts on SCUMM history (background, not technical).

[scumm-wiki]: https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference
[descumm]: https://wiki.scummvm.org/index.php?title=SCUMM/Tools/descumm

---

## 11. Open questions

A running log of every uncertainty we've surfaced. Items are classified:

- **Decided** — drove or confirmed an architectural choice already in this
  doc. Kept here so future-us can see *why* the choice was made.
- **Deferred** — does not change the architecture. Will be revisited when
  the relevant phase begins.

New questions get appended as they come up; nothing is dropped.

---

**Q1. Pathfinding: box-based (SCUMM-native) vs simpler grid stand-in?**
SCUMM walks actors over a graph of polygonal "walk boxes" with explicit
connections between adjacent boxes. A grid-based A* would be much simpler
to implement until v5 box semantics are well understood. Both algorithms
sit behind the same `actor.walkTo(x, y)` call — module layout doesn't
change either way.
**Status: Deferred.** Revisit at the start of Phase 6 (enough opcodes to
walk). Likely answer: grid stand-in first to get walking on screen, then
swap to native box-based pathfinding.

---

**Q2. Aspect correction: square pixels or vertical stretch to 4:3?**
The original 320×200 was displayed on 4:3 CRTs at a ~1.2:1 pixel aspect.
Rendering with square pixels looks slightly squashed; the period-accurate
look stretches vertically to 320×240 equivalent.
**Status: Decided.** The engine framebuffer is always 320×200 in logical,
square pixels — see §5.4. Any aspect correction is a *presentation-layer*
concern handled by the shell via CSS height stretch, off by default. A
toggle can be added later without engine changes.

---

**Q3. Frame pacing: re-derive SCUMM's exact tick model, or fixed-rate?**
SCUMM's internal scheduler runs subsystems at different divisors of a
base rate, with some game-specific tuning. Reproducing this exactly is a
research project on its own.
**Status: Decided (in part).** Fixed-step engine ticks driven by
`requestAnimationFrame` — see §5.8. The *exact* tick rate (60Hz is our
initial guess) is a tuning parameter, not an architectural choice;
**deferred** until scripts visibly misbehave.

---

**Q4. Costume decoder strategy: follow public RE notes closely on first
pass, or improvise?**
The costume format (limbs × frames × command streams) is the gnarliest
decoder in the project. The ScummVM wiki documents it thoroughly.
**Status: Deferred.** Decide at the start of Phase 3 (Costumes). Likely
answer: follow the wiki closely first, refactor for clarity after the
output is verified pixel-correct against a known frame.

---

**Q5. Engine threading: main thread or Web Worker with OffscreenCanvas?**
Putting the engine in a Worker isolates it from UI jank in the shell and
is the "correct" production pattern. It also forces all engine ↔ shell
communication through `postMessage`.
**Status: Decided.** Main thread for now. The `EngineSession` boundary
(see §4) is intentionally small and message-shaped (open files in, frames
+ audio + input events across), so moving the engine to a Worker later is
feasible without rewriting consumers. Adds complexity now for no learning
benefit.

---

**Q6. Per-game variations within SCUMM v5: forked engine paths or a
single engine with a game-id switch?**
SCUMM v5 isn't perfectly uniform — MI1 CD, MI2, FOA, and Indy 4 differ in
specific opcode behaviors, default variable layouts, and small resource
quirks.
**Status: Decided.** Single engine. `EngineSession` carries a `GameId`
enum (`MI1_CD`, `MI2`), and engine code branches on it at the small
number of known difference points (kept isolated, not sprinkled). We do
not fork the codebase per game.
