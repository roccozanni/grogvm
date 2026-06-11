# AGENTS.md — GrogVM briefing for AI assistants

You are joining a side project where the user is building a TypeScript
SCUMM v5 reimplementation from scratch, for fun and learning. This
file captures the user's collaboration style, the project's working
conventions, and the non-obvious knowledge that's easy to lose between
sessions.

## Read these first, in order

1. **[pages/docs/engine/architecture.md](pages/docs/engine/architecture.md)**
   — the as-built architecture: layers, seams, and the load-bearing
   principles.
2. **[PROGRESS.md](PROGRESS.md)** — current state: what's in flight,
   what's done, what's next. Status line at the top says where we are.

## Project intent

GrogVM targets MI1 (CD VGA) + MI2 (DOS). **Primary goal is
learning**, not shipping a ScummVM alternative. Clarity beats
performance. Built in small, runnable steps — each lands something
visible and tested. (The original numbered-phase plan is history; git
keeps it. PROGRESS.md tracks what's current and what's next.)

## How the user collaborates

- **Plan first, implement second.** When asked to start a significant
  piece of work, write the plan into PROGRESS.md (or propose it
  in chat) and let the user review before touching code.
- **Detail the active work, leave future items as one-liners.** The
  user explicitly does not want pre-planning beyond the work in
  flight — speculative breakdowns rot.
- **Engine-faithful, no shortcuts.** Every change is the final,
  SCUMM-faithful solution: confirm the real mechanism first
  (disassemble the original, drive the harness) before editing; when
  the faithful fix and a quick shell workaround disagree, faithful
  wins. Verify the actual outcome — render real pixels for visual
  bugs, reproduce the real flow for behaviour — never just the
  bookkeeping. Surface any deferral/approximation explicitly in
  PROGRESS.md; never bury a shortcut. If faithful needs a bigger
  refactor, raise the tradeoff instead of silently picking a path.
- **Be transparent about uncertainty.** Saying "my hypothesis is X,
  refresh and tell me what you see" is encouraged. The user is happy
  to iterate empirically when a problem is genuinely hard. They are
  *not* happy with confident-sounding guesses.
- **Surgical edits over rewrites.** Don't refactor working code "while
  you're there" unless the user asked. Use Edit with focused old/new
  strings.

## Durable preferences

Each of these has bitten us in the past — assume the user will react
if violated:

- **Debug / inspection UI is permanent, not scaffolding.** The
  block-tree dump, the per-strip method bar, the histogram chip list,
  any future inspection view — these all stay. GrogVM doubles as a
  learning tool, and removing inspection capability degrades that
  goal. Memory note:
  `~/.claude/projects/-Users-rocco-Developer-grogvm/memory/feedback-keep-debug-ui.md`.
- **No judgmental phrasing about other people's work.** Refer to
  reverse-engineering notes neutrally ("long-circulating notes"), not
  as "amateur" or "wrong".
- **No emojis in code or commits.** Documentation may use ⚠️ sparingly
  for warning callouts (see pages/docs/scumm/smap.md).
- **The user commits manually.** Never `git commit` without an
  explicit instruction. The user always says "commit" first.

## Code conventions

- **Engine code (`src/engine/**`) is DOM-free.** No `window`, no
  `document`, no browser globals. The platform layer
  (`src/platform/storage`) adapts `FileSystemDirectoryHandle` → `File`
  → `Uint8Array` and hands the bytes down to the engine.
- **Indexed pixels through the whole pipeline.** Decoders produce
  `Uint8Array` of palette indices. RGBA only ever appears inside the
  renderer (via `indexedToRgba`). Do not pre-multiply palette in
  decoders — it breaks the swappable-renderer story and palette
  cycling.
- **Test-first.** Vitest runs in a Node environment (no DOM). Add
  tests in the same edit as the feature; engine code is unit-testable
  with synthetic fixtures.
- **No backwards-compatibility shims, feature flags, or premature
  abstraction.** Three similar lines beat a misfit helper. Trust
  internal callers; validate only at the system boundary.
- **Comments are a last resort.** Default is none — see `## Code
  comments` for the policy and the few kinds worth keeping.

## Code comments

The knowledge home is `pages/docs/` — not comments. Docs are updated in
dedicated doc sessions (the wrap flow), **not** while writing code: when
coding surfaces a fact worth keeping, it goes into PROGRESS.md
**Current** as a lab note, never into a comment. LLM sessions
over-comment by default; the bar here is deliberately high.

**Default: no comment.** Before writing one, apply the test: *would a
competent reader, with the relevant doc open, plausibly break this code
without it?* If no, don't write it. If the urge is to explain the change
you just made or why it's correct — that's addressed to the reviewer,
not the next reader: commit-message content, never a comment.

**Module headers: 1–3 lines.** One sentence on what the module is, plus
a `pages/docs/...` link when a doc covers it. No design essays, no
model/lifecycle narration, no API tours — that's the doc's job. A module
whose filename already says it needs no header at all.

**The four kinds worth keeping** (1–2 lines each, rare):

1. **Traps** — code that looks wrong or arbitrary but is correct: a
   constant pinned to real game data, an order dependency, behaviour
   that deliberately mirrors an original-engine quirk. State the
   constraint, not the story of finding it.
2. **Corrections at point of use** — where the code deliberately
   diverges from long-circulating format notes: one line + doc link.
3. **Why-nots** — the obvious alternative is wrong for a reason the
   code can't show.
4. **One-line JSDoc on an export** only when the signature alone is
   ambiguous (units, coordinate space, jiffies vs. frames, ownership).

**Never:**

- Restating what the code or the name already says.
- Narrating history ("now also resets…", "fixed by…", "was
  previously…") — git keeps that.
- Design or architecture rationale — `pages/docs/engine/`.
- TODO / FIXME — open items live in PROGRESS.md.
- Section banners (`// ── input ──`) except as pure navigation in very
  long files — they carry no knowledge and earn no exception beyond
  that.

**Trimming an existing comment that carries a real, undocumented fact:**
don't destroy the fact — move it to PROGRESS.md Current (feed for the
next doc session), then trim the comment. `integration/<game>/game.ts`
is the one lenient zone: id labels and mechanic notes there ARE the
designated knowledge home for game-specific walkthrough facts (see
PROGRESS.md), so they stay.

## Documentation

`pages/docs/` is the durable knowledge base **and a public website**. Two
halves, kept separate:

- **`scumm/`** — reverse-engineered reference for the SCUMM v5 engine and its
  file formats. What the *original* does.
- **`engine/`** — how GrogVM itself is built (the session/game-loop, costume
  loading, pathfinding). What *we* do.

Because the docs are public and double as the project's memory, hold to these
rules when writing or editing them:

- **Prose for humans, compact.** The docs are read by people: prose-oriented,
  woven into the doc's existing sections — not bullet dumps or walls of text.
  A fact earns the words it needs and no more.
- **The pyramid template.** A doc over ~150 lines opens with an `## At a
  glance` block — one ASCII diagram plus a few lines of mental model, placed
  *before* Sources — and the long format/behaviour docs close with a
  `## Pitfalls cheat-sheet` (numbered, restating the traps with § pointers).
  Each section keeps a short narrative spine; MI1-specific or fine-grained
  detail demotes into a labeled `**Fine print:**` / `**Fine print (MI1):**`
  bullet block under it. `> ⚠️` blockquotes are reserved for genuine traps
  and corrections-to-circulating-notes, not emphasis. The ASCII-diagram idiom
  covers flows, state machines, and screen geometry, not just byte layouts.
- **New facts land at the right altitude.** Extend the spine or the relevant
  fine-print block of the section the fact belongs to — never append another
  bold paragraph at the end of a section in arrival order.
- **Facts, not theories or journals.** Settled conclusions only — root cause,
  format layout, the *why*. Never the failed hypotheses, dead ends, or
  blow-by-blow of getting there (git keeps that). No "BREAKTHROUGH/REVERTED"
  narration.
- **No phases or temporary state.** No "Phase 6", "deferred until", "not yet
  wired". The docs describe what *is*, timelessly.
- **No fragile code pointers.** No `src/...` paths, function/symbol names, line
  numbers, or `scratch/` scripts — they rot on the first refactor. SCUMM's own
  opcode/routine names (`adjustXYToBeInBox`, `o5_drawObject`) are fine as
  reference; a few coarse engine references are OK, but never point at specific
  code locations.
- **Verify "we do/defer X" against the code before writing it.** These claims
  go stale silently — this session found five already false (DOBJ, object verb
  dispatch, BOXM decoding, freezeScripts, DCOS). Recording a stale limitation
  is worse than omitting it.
- **Route findings by kind.** A SCUMM format/behaviour fact → `scumm/<doc>.md`;
  a durable engine-implementation fact → `engine/<doc>.md`; an **open
  limitation or bug → PROGRESS.md, never the docs.** Don't let a fact evaporate
  in the gap between the two doc folders.
- **Index titles** (`pages/docs/index.md`): descriptive Title-Case name with
  the on-disk resource in parens where one applies — `Background Bitmaps
  (`SMAP`)`, pairs joined ` + ` — and no tag for behaviour/subsystem docs that
  map to no single block.

## Project structure

```
PROGRESS.md               lab notebook + tracker: current state, what's next
README.md                 human-facing intro
pages/                    THE page source — markdown; file path = route
  index.md                → /         home (content page)
  library.md explore.md play.md
                          → app pages: an island declared via frontmatter
                          `script:` is hydrated into the rendered page
  docs/                   public documentation; see ## Documentation
    scumm/                SCUMM v5 reference — file formats + original-engine behaviour
    engine/               how GrogVM itself is built (architecture, session,
                          costumes, pathfinding, audio, harness)
    index.md              docs landing page
src/
  build/                  md→HTML generator + Vite plugin (offline tooling;
                          nothing imports it)
  site/                   shared page shell — layout + site.css; no engine
                          or platform imports
  styles/                 per-island stylesheets (explorer.css, player.css)
  platform/               browser adapters, no UI — routing/, storage/
                          (IndexedDB, FS-Access permission, game files),
                          detect.ts (game classification),
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
  engine/                 (no DOM imports, no node:fs — portable core)
    resources/            .000/.001 parsing — XOR, blocks, tree nav,
                          per-tag description catalog
    vm/                   the VM + world state — variables, slots, params,
                          boot, savestate, vars.ts (name→index map);
                          opcodes/index.ts defines every opcode ONCE
                          (decode + exec + disasm text) in the registry
                          both the dispatcher and disasm.ts read (below)
    graphics/             decoders: smap, costume, charset, zplane, text,
                          palette, actor compositing
    render/               Renderer seam + Canvas2D + Memory + frame
                          compositor (room scene) + screen composer
                          (verb band + dialog + verb hit-test; emits the
                          full 320×200) + indexed-to-rgba pure helper
    room/                 room loader + extract.ts: graceful
                          listRooms/extractRoom static-inspection layer
    object/               OBCD/OBIM loader + verb-script lookup
    actor/                actor table + walk stepping
    pathfinding/          walk boxes + box-graph routing
    sound/                AudioBackend timing seam + SOUN resource parsing
    session/              EngineSession factory: vm + compositors + loop +
                          renderer; the clock is injected
  testkit/                dev/test harness — sibling of engine, NOT inside
                          it (see below). drive.ts = game-agnostic VM
                          drivers (pure, synthetic-testable); scummv5.ts =
                          load/boot/save by game dir (Node-only, node:fs)
integration/              root-level playthroughs — drive the REAL game files
  mi1/                    & saves, run via `npm run test:integration` (NOT
                          default `npm test`). game.ts = data dir + ids;
                          walkthrough.test.ts = the continuous regression net
tools/                    committed first-class CLIs — thin arg-parsing +
                          file-loading front-ends over tested src/ modules,
                          run via npm (see `## Command-line tools`)
```

### The disassembler (`src/engine/vm/disasm.ts`)

A first-class, tested, read-only SCUMM v5 disassembler — the static
consumer of the opcode registry that also feeds the executing
dispatcher. Use it whenever you need to read what a script actually
does (reverse-engineering flow, confirming an opcode encoding, hunting
who sets a var).

- API: `disassemble(bytecode: Uint8Array): DisasmInstruction[]`
  (`{offset, opcode, text, aligned}`). It executes nothing and is
  reentrant (safe to call on arbitrary/garbage bytes — loops are
  bounded). A run that ends with `aligned: false` means it hit a byte
  it couldn't decode and stopped; treat everything after as unknown.
- CLI front-end: `npm run disgrogate -- <id>` (`L<id> <room>`,
  `ENCD/EXCD <room>`, or `SCAN grep=<term>` to sweep every script) —
  lives in `tools/disgrogate.ts` (see `## Command-line tools`). The CLI
  is just file-loading; the decode logic + tests live in the module.
- **One operand layout per opcode, by construction.** Each family is a
  single `defineOp` in `opcodes/index.ts` carrying opcode bytes,
  `decode` (the layout, written once against the `OperandReader` in
  `opcodes/operands.ts`), `exec`, and `format` — the dispatcher and the
  disassembler both read that registry (`opcodes/registry.ts`), so the
  two cannot disagree on operand sizes. When adding or fixing an
  opcode, touch only its `defineOp`. The one `defineRawOp` exception is
  `expression` (nested opcodes execute mid-decode). The corpus net
  (`integration/mi1/disasm.test.ts`) disassembles every script
  in the installed build and pins **zero misalignments** — run it after
  any decode change.

### The harness (`src/testkit/`) + integration playthroughs (`integration/`)

The *dynamic* companion to the disassembler: load → boot → drive → inspect
the real game on the VM. Reach for it whenever you need to reproduce a flow
or render real state (the working principle: verify behaviour, not
bookkeeping) instead of re-deriving the boot boilerplate. Two layers:

- **`testkit/` — the reusable harness.**
  - `drive.ts` — **game-agnostic** VM drivers: `setMouse`/`hover`,
    `driveTicks(vm, n)`, `driveUntil(vm, pred, {maxTicks})`,
    `driveToRoom(vm, room)`. Operate on a bare `Vm`, so MI2 (any v5 game)
    reuses them unchanged; unit-tested against a **synthetic VM**
    (`drive.test.ts`), runs everywhere incl. CI. Caveat: `setMouse` writes
    ROOM coords into VARs 44/45 (the browser input layer writes
    script-SCREEN coords, verb band remapped to y ≥ 144), so headless
    hover never lands in the verb band — a test wanting the engine's
    hover highlight must write script-screen coords itself.
  - `actions.ts` — **game-agnostic** faithful player-action vocabulary:
    `walkTo`/`use`/`pickAnswer`/`pickDialogAnswer`/`objectPoint`/`actorPoint`/
    `waitIdle`. Thin sugar over the real click flow (hover poller →
    active-object global → `doSentence`) — no sentence injection, so a
    playthrough built on it guards the genuine input path. Object targets
    derive their hover point from the CDHD hit-box center (`objectPoint`);
    **actor** targets (Talk-to / Give-to-actor) from the sprite-box center
    (`actorPoint` → `Vm.actorHitBounds`, which works headless via
    `prepareActorDraw` — see [INPUT §5](pages/docs/scumm/input.md)), so the suite
    stays coord-free. **Carried** targets (object A, a carried object B —
    the two-inventory combine — or a one-object verb on a carried item)
    resolve as inventory-slot clicks in the panel's *visible window*:
    `use`/`useWith`/`give` scan the live slot table (g133+) and click the
    arrow verbs 208/209 until the item shows. Never compute a slot as
    `200 + inventoryIndex` — past the window that's a different verb
    (208 IS the up arrow), the bug that faked the give-target debt
    (INPUT §8). `pickDialogAnswer(vm, verbId)` walks a conversation tree
    (wait-arm → pick → wait-dismiss; throws if the option never arms), since
    dialog answers are verbs whose ids recur per menu. The caller supplies the
    game's verb/object ids. Split from `drive.ts` (which is pure/synthetic-
    testable) because these compose real input needing a booted VM.
  - `random.ts` — `makeSeededRandom(seed)` (mulberry32), an injectable entropy
    source for `VmInit.random`. The engine's `getRandomNumber` routes through
    `Vm.randomInt` over this (default `Math.random`; app unchanged), so a
    scripted playthrough is **reproducible** — a flaky regression net is
    worthless. Not part of the save snapshot.
  - `scummv5.ts` — load/boot/save **by game directory**: `hasData(dir)`,
    `bootScummV5(dir[, gameId, random])` → `Vm`, `loadScummV5(dir)`,
    `restoreSave(vm, name)` (bare slot → `saves/<name>.websave.json`).
    Re-exports `drive.ts`/`actions.ts`/`random.ts`/`png.ts`/`screenshot.ts` so
    a caller gets the whole harness from one import.
  - `screenshot.ts` + `png.ts` — **render the VM to a PNG.** `screenshot(vm)`
    composes the FULL visible screen (room band + verb/inventory panel +
    dialog) through the session's own pipeline — `composeFrame` → camera
    slice → `composeScreen`, the canonical closure wiring off a live `Vm` —
    and returns `{width, height, pixels (indexed), palette}`;
    `writeScreenshot(vm, path, {scale=3})` pairs it with `writeIndexedPng`.
    `png.ts` is the pure, Node-only indexed-framebuffer→PNG encoder
    (`encodeIndexedPng`/`writeIndexedPng`, 8-bit RGB, nearest-neighbour
    integer upscale). Reach for these instead of re-pasting a crc32/IHDR/IDAT
    block + compose wiring in a scratch render script.
  - Lives in `src/testkit/`, a **sibling of `engine`/`app`, not inside
    `engine/`** — it's the only `node:fs` consumer and the engine stays a
    portable browser-bundled core. Its own tests are synthetic
    (`scummv5.test.ts` exercises `hasData` against a temp dir of empty
    dummy files), so they run in the default suite.

- **`integration/<game>/` — playthroughs against the REAL game.** Code-based
  test suites (no DSL) that drive the game through its own scripts and assert
  mechanics. Driven by **numeric ids** (verb/object/dialog ids in
  `game.ts`), which are game-structural — identical across IT/EN builds (only
  text is translated), so one suite covers a game, not a variation, and the
  same suite passes against both builds. `mi1/` has `game.ts` (data dir + ids,
  no localized strings) and `walkthrough.test.ts` — **the regression net**: ONE
  VM booted once and driven through the game's own solution start→onward, grown
  beat by beat (last green beat = the frontier). Headless (asserts VM *state*,
  renders no pixels → catches logic/playability regressions, not visual ones),
  from boot every run (no save fast-forward), deterministic (seeded RNG). A
  module-level `beat()` guard reds the first failing checkpoint and skips the
  rest, so a refactor's breakage localizes to one beat. Run it end-of-session /
  after a refactor.
  - **Never assert a localized string.** Verify mechanics; when a test must
    check produced text, derive the expectation from the same build (e.g. a
    dialog answer's own `name`), don't hardcode a translation.
  - **Run separately:** `npm run test:integration` (own vitest config). NOT
    part of the default `npm test`, which stays fast/synthetic/data-free.
  - **Data-gated:** each suite self-skips via `describe.skipIf(!hasGame())`
    so a fresh checkout / CI stays green; never commit the copyrighted bytes.
  - **No save-file dependence.** Where regression tests go, by layer:
    once a bug's root cause is identified, its anti-regression test is a
    **synthetic engine unit test** (`src/**/*.test.ts`) capturing the
    mechanism — NOT tied to a save or a game (e.g. the map-labels root cause
    lives in `vm.test.ts`). `integration/` is for *does-the-game-play*
    mechanics only. Save-based troubleshooting stays in `scratch/`.

Scratch note: dead probes that predate the `games/MI1` → `games/MI1-IT-CD-DOS-VGA`
rename were moved to `scratch/archive/`. Before hand-rolling a one-off probe,
reach for the committed building blocks instead of copy-pasting a resource
preamble or a decoder chain:

- **Drive / render real VM state** → the harness (one import: `bootScummV5(dir)`,
  then `drive.ts`/`actions.ts`); for a PNG, `writeScreenshot(vm, path)` or the
  `npm run mugshot` CLI.
- **Inspect a room's contents statically (no boot)** → `listRooms(file, loff)` +
  `extractRoom(file, ref)` (`src/engine/room/extract.ts`): a *graceful* dossier
  (background / objects / scripts / walk boxes / box matrix / scale / z-planes,
  each isolated so one bad section never sinks the rest), plus
  `referencedGlobalScripts(...)`. These are the same primitives the resource
  Explorer renders — don't re-call `loadRoom`/`parseRoomObjects`/`decodeZPlanes`
  by hand for inspection.
- **Read a script** → `disassemble(bytecode)` or the `npm run disgrogate` CLI.

A probe that outgrows throwaway and proves reusable earns a move to `tools/`.

### Command-line tools (`tools/`)

Committed CLIs — the home for an *established* front-end, as opposed to the
throwaway probes in gitignored `scratch/`. Each is a thin arg-parser +
file-loader over a tested `src/` module (the logic + tests live there; the CLI
never owns behaviour), runs via an npm script, and writes throwaway output to
`scratch/` (gitignored). A probe earns a move here once it's reusable and
worth keeping.

- **`npm run disgrogate -- <args>`** (`tools/disgrogate.ts`) — the
  disassembler CLI over `src/engine/vm/disasm.ts`. See the disassembler
  section above for the arg forms.
- **`npm run mugshot -- <save> [ticks]`** (`tools/mugshot.ts`) — render a
  frame to PNG over `src/testkit/screenshot.ts`. Boots the game, optionally
  restores a save (`fresh` to skip), drives `[ticks]` jiffies, writes the PNG.
  Flags: `--out=` (default `scratch/mugshot.png`), `--scale=` (default 3),
  `--game=`, `--seed=`.

### The hang watchdog (`Vm.enableHangWatchdog`)

Opt-in diagnostic (wired into the always-on debug panel): fires when N
consecutive clicks each produce **no progress** — no room change, no talk, no
committed sentence, no walk. It fingerprints *progress-only* signals (monotonic
`talkSeq`/`sentenceSeq` + room + walk targets), deliberately NOT the live-script
set (a click always transiently spawns the verb-redraw #12) nor raw vars (the
music timer churns). Surfaces a console warning + panel banner naming the room +
`VAR_VERB_SCRIPT`. Catches the *symptom* of any input-misroute / wait-on-a-var-
that-never-changes hang — the class of bug (e.g. the deferred-room-script dialog
freeze) that otherwise costs hours to localize.

## Known gotchas (will bite if forgotten)

- **TypeScript 6 narrows typed-array buffer generics.**
  `Uint8ClampedArray` defaults to `Uint8ClampedArray<ArrayBufferLike>`
  but `ImageData` wants `Uint8ClampedArray<ArrayBuffer>`. If you see
  `Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'`,
  add the explicit `<ArrayBuffer>` type argument to the return type of
  whichever function built the buffer (see
  `src/engine/render/indexed-to-rgba.ts`).
- **SMAP strip offsets are header-inclusive.** The decoder gets the
  payload (block header already stripped) and subtracts 8 from each
  offset internally. Symptom of wrong handling: compression codes
  look like 255, 0, 247, … instead of the expected bands.
- **SMAP Method 2 delta sign is inverted** vs. documented notes. The
  working dispatch is `color -= (4 - d)`. See `pages/docs/scumm/smap.md`
  §9.
- **SMAP paletteBits subtract for `0x54..0x58` is `0x50`** (not
  `0x51`). All Method 2 subtracts step by 20: `0x3C, 0x50, 0x64,
  0x78`. Symptom of `0x51`: localized garbage on codes 87 / 88.
- **Brave** disables the File System Access API even with Shields off
  for the site — the per-site toggle does not cover this. Users need
  `brave://flags/#file-system-access-api` enabled, then a relaunch.
  The unsupported-browser screen has a Brave-specific hint
  (`src/platform/browser-support.ts`).
- **Canvas2DRenderer clears before each `present()`.** The session now
  presents the assembled screen opaque (no transparent index), but the
  explorer and any direct renderer user can still present with
  transparency — the clear keeps transparent pixels exposing the canvas
  background (the CSS checkerboard) instead of compositing with the
  previous frame.

## When asked to start a significant piece of work

1. Read PROGRESS.md — the work ahead lives as one-liners under
   **Next**.
2. Write a detailed planning section into PROGRESS.md following the
   shape of earlier plans: **Goal**, **Definition of done**, **Tasks**
   (broken into subsections), **Design notes**, **Out of scope**.
3. Show the plan to the user. Wait for review before implementing.
4. Implement in order, keeping types green and tests passing after
   each meaningful step.
5. Verify in the browser with the user (especially for graphics
   work — unit tests can't catch "this image looks wrong").
6. When the user says "commit", update PROGRESS.md first — record what
   shipped, the design decisions, and any new gotchas in **Current**
   (lab-notebook style; the wrap flow below drains it later). Then
   commit. Do **not** add a `Co-Authored-By` / "Generated with Claude"
   trailer — commit messages carry no assistant attribution.

## When asked to wrap a session

Wrapping = draining this session's lab-notes from the **Current** section
of PROGRESS.md into their durable homes. It is NOT printing a status
summary in chat. Do this before stopping:

1. Re-read the notes added to **Current** this session.
2. Extract only the **facts** — settled conclusions (root cause, opcode
   semantics, the *why*), never the failed hypotheses, dead ends, or the
   blow-by-blow of getting there — and write them into the right doc, routed
   by kind (see ## Documentation): a SCUMM format/behaviour fact →
   `pages/docs/scumm/<doc>.md`, a durable engine-implementation fact →
   `pages/docs/engine/<doc>.md`, an open limitation/bug → it stays in
   PROGRESS. Git keeps the blow-by-blow, so it never belongs in docs.
   Follow the ## Documentation rules (facts-only, no phases, no fragile code
   pointers) — and verify any "we do/defer X" claim against the code first.
3. Once a finding lives in a doc, condense its PROGRESS.md note to **1–2
   sentences max** — a pointer + the `[DOC §N]` link, like the existing
   "Migrated to [ROOM §6]" entries — so **Current** stays lean and free of
   clutter.

This is the lab-notebook → docs flow PROGRESS.md's own header describes: a
finding stays in Current only until it is written into docs, *then* it is
trimmed. Capture from the notebook while fresh — don't reconstruct doc prose
from memory later; that's how bad claims get in. (Committing is still
manual — see Durable preferences; wrapping edits files, it doesn't commit.)

## Quick health checks

```bash
npm run typecheck     # 0 errors expected
npm test              # full synthetic suite should pass
npm run build         # must be green; the engine lands only in the
                      # play/explore chunks — library + content pages
                      # stay engine-free (a few KB of JS each)
```
