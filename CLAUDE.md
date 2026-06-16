# CLAUDE.md: GrogVM operational index for AI assistants

You are joining a side project where the user is building a TypeScript
SCUMM v5 reimplementation from scratch, for fun and learning. This file is
the **operational index**: the repo map, the module/CLI APIs you'll import,
and the dev-environment gotchas — the fragile, code-pointer-heavy detail the
public docs leave out by their no-fragile-pointers convention. Everything
conceptual — how we work, where knowledge lives, how claims get verified,
how the engine is built — is public in `pages/docs/` and linked below.

## Read these first, in order

1. **[pages/docs/agent/collaboration.md](pages/docs/agent/collaboration.md)**
   — the working contract: plan-first, engine-faithful no-shortcuts, the
   durable preferences, the shape of a work session.
2. **[pages/docs/agent/knowledge.md](pages/docs/agent/knowledge.md)**
   — the lab-notebook → docs pipeline (incl. the wrap flow), the
   code-comments policy, the doc-authoring conventions.
3. **[pages/docs/agent/verification.md](pages/docs/agent/verification.md)**
   — verify behaviour, not bookkeeping: the instruments (disassembler,
   harness, oracle), the divergence tiers, the hang watchdog, probes.
4. **[pages/docs/engine/architecture.md](pages/docs/engine/architecture.md)**
   — the as-built architecture: layers, seams, load-bearing principles.
5. **[PROGRESS.md](PROGRESS.md)** — current state: what's in flight, done,
   and next. The status line at the top says where we are.

## Project structure

```
PROGRESS.md               lab notebook + tracker: current state, what's next
README.md                 human-facing intro
pages/                    THE page source — markdown; file path = route
  index.md                → /         home (content page)
  library.md explore.md play.md
                          → app pages: an island declared via frontmatter
                          `script:` is hydrated into the rendered page
  docs/                   public documentation; conventions →
                          pages/docs/agent/knowledge.md
    scumm/                SCUMM v5 reference — file formats + original behaviour
    engine/               how GrogVM itself is built
    agent/                how the work is done — normative for assistants
    index.md              docs landing page
src/
  build/                  md→HTML generator + Vite plugin (offline tooling;
                          nothing imports it)
  site/                   shared page shell — layout + site.css; no engine
                          or platform imports
  styles/                 per-island stylesheets (explorer.css, player.css)
  platform/               browser adapters, no UI — routing/, storage/
                          (IndexedDB, FS-Access permission, game files),
                          render/ (Canvas2D implementation of the engine's
                          Renderer seam), detect.ts (game classification),
                          browser-support.ts (capability gate)
  app/                    the interactive islands — each exports mount(el):
    library/              installed-games list + flash messages
    install/              directory picker flow
    explorer/             session-free static resource browser
    player/               hosts one EngineSession: play/ (game canvas +
                          overlay) + debug/ (live VM inspector) +
                          play-area (crosshair / debug overlays / click
                          routing — game pixels are engine-composed) + input
    reactive/             tiny owned signal/effect core (DOM-only leaf)
  engine/                 (no DOM, no node:fs — portable core)
    resources/            .000/.001 parsing — XOR, blocks, tree nav,
                          per-tag description catalog
    vm/                   the VM + world state — variables, slots, params,
                          boot, savestate, vars.ts (name→index map);
                          opcodes/index.ts defines every opcode ONCE
                          (decode + exec + disasm text) in the registry
                          both the dispatcher and disasm.ts read (below)
    graphics/             decoders: smap, costume, charset, zplane, text,
                          palette, actor compositing
    render/               Renderer seam + Memory recorder + frame
                          compositor (room scene) + screen composer
                          (verb band + dialog + verb hit-test; emits the
                          full 320×200) + indexed-to-rgba pure helper;
                          the Canvas2D implementation is platform/render/
    room/                 room loader + extract.ts: graceful
                          listRooms/extractRoom static-inspection layer
    object/               OBCD/OBIM loader + verb-script lookup
    actor/                actor table + walk stepping
    pathfinding/          walk boxes + box-graph routing
    sound/                AudioBackend timing seam + SOUN resource parsing
    session/              EngineSession factory: vm + compositors + loop +
                          renderer; the clock is injected
  testkit/                dev/test harness — sibling of engine, NOT inside it.
                          drive.ts = game-agnostic VM drivers (pure,
                          synthetic-testable); scummv5.ts = load/boot/save
                          by game dir (Node-only, node:fs)
integration/              root-level playthroughs — drive the REAL game files
  mi1/                    & saves, run via `npm run test:integration`. game.ts
                          = data dir + ids; walkthrough.test.ts = regression net
tools/                    committed CLIs — thin arg-parsers over tested src/
                          modules, run via npm
```

## Disassembler & opcodes (`vm/disasm.ts`, `vm/opcodes/`)

The concept and why it's trustworthy → [verification.md](pages/docs/agent/verification.md).
Operational handles:

- `disassemble(bytecode: Uint8Array): DisasmInstruction[]`
  (`{offset, opcode, text, aligned}`) — executes nothing, reentrant,
  loop-bounded (safe on garbage bytes). A run ending `aligned: false` hit a
  byte it couldn't decode and stopped; treat everything after as unknown.
- CLI front-end (`tools/disgrogate.ts`): see the **disgrogate skill** for the
  invocation, the forms, and the required `--game=<dir>`. `SCAN` sweeps
  **global** scripts only; room-local ids (≥ 200) are queried as `L<id> <room>`
  (see [room.md §7](pages/docs/scumm/room.md)).
- **`override BEGIN (then jump N)` prints the RAW jump delta** — the engine
  lands at `pc + N`. Don't resolve N against script start; that sends you
  mid-instruction into garbage (bit the title-music trace).
- **One operand layout per opcode, by construction.** Each family is a single
  `defineOp` in `opcodes/index.ts` (the registry both the dispatcher and the
  disassembler read, so they can't disagree on sizes). To add or fix an
  opcode, touch only its `defineOp`. Lone exception: `expression` is a
  `defineRawOp` (nested opcodes execute mid-decode). The corpus net
  (`integration/mi1/disasm.test.ts`) pins zero misalignments — run it after
  any decode change.
- **The executing table is not axiomatic.** When the disassembler and the
  executing handler disagree on an operand size, the tie-breaker is the **real
  game bytecode**, never the engine — a cold path can carry the same bug as
  either side (`stringOps loadString` once read raw-scan-to-NUL @443 when the
  escape-aware `cstr` @445 was right; the next `loadString`s are the wheel
  locations, which settled it). Read the bytes two ways: (1) **downstream
  alignment** — the correctly-sized opcode lands the linear sweep on the next
  obviously-real instruction (a clean `loadString "Jamaica"`, a closing
  `stopObjectCode`); a wrong size garbles everything after. (2) **operand
  plausibility** — `drawBox color=117 coords 9984` or `putActor a=114 x=L354`
  (local #354 when locals are 0–24) means you're decoding misaligned data, not
  code. Concept → [verification.md](pages/docs/agent/verification.md).

## Harness & playthroughs (`src/testkit/`, `integration/`)

The concept (two layers, the faithful input path, the regression net,
ids-not-strings, where a fixed bug's guard belongs) →
[harness.md](pages/docs/engine/harness.md). Reach for the harness instead of
re-deriving boot boilerplate, and for these committed building blocks instead
of copy-pasting a resource preamble or decoder chain. **What to import:**

- **Drive a real VM** — `bootScummV5(dir[, gameId, random])` → `Vm` (plus
  `hasData(dir)`, `loadScummV5(dir)`, `restoreSave(vm, name)` →
  `saves/<name>.websave.json`); then `drive.ts`
  (`driveTicks(vm, n)` · `driveUntil(vm, pred, {maxTicks})` · `driveToRoom` ·
  `setMouse`/`hover`) and the faithful action vocab `actions.ts`
  (`walkTo`/`use`/`useWith`/`give`/`pickAnswer`/`pickDialogAnswer`/`waitIdle`,
  plus `objectPoint`/`actorPoint`). `scummv5.ts` re-exports the lot.
- **Render a VM to PNG** — `writeScreenshot(vm, path, {scale=3})` /
  `screenshot(vm)` (full screen through the real compose pipeline), or the
  `tools/mugshot.ts` CLI (see the **mugshot skill** for its invocation).
- **Inspect a room statically (no boot)** — `listRooms(file, loff)` +
  `extractRoom(file, ref)` (`room/extract.ts`): a graceful dossier
  (bg / objects / scripts / boxes / box matrix / scale / z-planes, each
  isolated so one bad section never sinks the rest) + `referencedGlobalScripts`.
  Same primitives the Explorer renders.
- **Trace what actually runs** — `traceTicks(vm, n, {scripts?, keepIdle?})`
  (`testkit/trace.ts`) drives `n` jiffies and returns the per-frame opcodes,
  grouped by the script that ran them, off the VM's built-in trace ring (no
  engine hooks); `formatFrames`/`groupFrame` are the pure renderers. Its CLI
  front-end is `tools/spyglass.ts` (see the **spyglass skill** for the
  invocation). The dynamic counterpart to disgrogate: it shows what *executed*,
  not what a script *could* run. A killed script's terminating `stopObjectCode`
  surfaces under a trailing `#0` run (the slot id is cleared before the trace
  push) — expected.
- **Reproducibility** — `makeSeededRandom(seed)` (mulberry32) feeds
  `VmInit.random`; not part of the save snapshot.

**Code traps:**

- `setMouse` writes ROOM coords (VARs 44/45); the browser input layer writes
  script-SCREEN coords (verb band remapped to y ≥ 144). So headless hover
  never lands in the verb band — a test wanting the hover highlight must write
  script-screen coords itself.
- Carried-item actions click the inventory panel's **visible window** (scan the
  live slot table g133+, click arrows 208/209 until the item shows). Never
  compute a slot as `200 + inventoryIndex` — past the window that's a different
  verb (208 IS the up arrow). See [input.md §8](pages/docs/scumm/input.md).

**Probes:** throwaway investigation scripts (render dumps, one-off decoders)
go in `scratch/` — gitignored, NEVER `integration/` or any `*.test.ts` (that
dir is the regression net). Run with `npx vite-node scratch/<name>.ts`, and
build on the testkit (`bootScummV5` / `restoreSave` from `src/testkit/`)
rather than a hand-rolled resource preamble (`writeScreenshot` / `testkit/png.ts`
cover PNG output). A probe that proves reusable graduates to a committed
`tools/` CLI.

**Run the playthroughs separately** (own vitest config, NOT the default `npm
test`, which stays fast/synthetic/data-free): see the **walkthrough skill** for
the commands, the `GROG_GAME_DIR` data override, and the opt-in per-beat
checkpoint saves. Data-gated: self-skips with no game data, so a fresh checkout
/ CI stays green; never commit the copyrighted bytes.

## Dev-environment gotchas (fragile, operational — not doc material)

- **TypeScript 6 narrows typed-array buffer generics.** `Uint8ClampedArray`
  defaults to `<ArrayBufferLike>` but `ImageData` wants `<ArrayBuffer>`. On
  `Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'`, add the
  explicit `<ArrayBuffer>` type argument to the return type of whichever
  function built the buffer (see `render/indexed-to-rgba.ts`).
- **Brave** disables the File System Access API even with Shields off for the
  site — the per-site toggle doesn't cover it. Users need
  `brave://flags/#file-system-access-api` enabled, then a relaunch (the
  unsupported-browser screen hints this; `platform/browser-support.ts`).
- **Canvas2DRenderer clears before each `present()`.** The session presents
  opaque, but the explorer and any direct renderer user can present with a
  transparent index — the clear keeps those pixels exposing the canvas
  background (the CSS checkerboard) rather than compositing the previous frame.
- **`src/site/og.png` is a generated raster of `src/site/grogvm.svg`** (the
  1200×630 social card, checked in) — editing the SVG without regenerating
  silently desyncs the card. No rasterizer deps on this machine (no
  rsvg/magick/inkscape; PIL absent); recipe: wrap the SVG in a 1200×1200 canvas
  with the content translated down 285px (`<g transform="translate(0,285)">`,
  extend the bg rect to match), `qlmanage -t -s 1200 -o /tmp wrapper.svg`, then
  `sips --cropToHeightWidth 630 1200` (sips ignores the crop offset and
  center-crops — the 285px translate makes it exact). Verify by Reading the PNG.

## Site look & feel

The site's visual direction is **retrogaming / terminal**: a dark theme +
monospace, applied across both the markdown content pages and the app screens
(library/explore/play). Monospace is deliberate everywhere — chosen over a
proportional sans even for long-form prose, for aesthetic consistency; prose
stays full-width (~100ch) with generous line-height (~1.75) rather than a
capped reading measure. Shared theme + chrome live in `src/site/site.css`
(served as `/site.css` on every page); typography is scoped to `.prose` so it
doesn't leak onto the app screens. Prefer styling choices that reinforce the
retro look.

## Quick health checks

```bash
npm run typecheck     # 0 errors expected
npm test              # full synthetic suite should pass
npm run build         # must be green; the engine lands only in the
                      # play/explore chunks — library + content pages
                      # stay engine-free (a few KB of JS each)
```
