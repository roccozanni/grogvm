# AGENTS.md — GrogVM briefing for AI assistants

You are joining a side project where the user is building a TypeScript
SCUMM v5 reimplementation from scratch, for fun and learning. This
file captures the user's collaboration style, the project's working
conventions, and the non-obvious knowledge that's easy to lose between
sessions.

## Read these first, in order

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — destination design and
   the load-bearing principles.
2. **[PROGRESS.md](PROGRESS.md)** — current phase state, what's done,
   what's queued. Status line at the top says where we are.

## Project intent

GrogVM targets MI1 (CD VGA) + MI2 (DOS). **Primary goal is
learning**, not shipping a ScummVM alternative. Clarity beats
performance. Built in phases (0 scaffold → 1 resources → 2 graphics →
3 costumes → …); each phase ends with something visible and tested.

## How the user collaborates

- **Plan first, implement second.** When asked to start a phase or a
  significant change, write the plan into PROGRESS.md (or propose it
  in chat) and let the user review before touching code.
- **Detail the active phase, leave future phases as one-liners.** The
  user explicitly does not want pre-planning of phases beyond the
  current one — speculative breakdowns rot.
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
  for warning callouts (see SCUMM-V5-SMAP.md).
- **The user commits manually.** Never `git commit` without an
  explicit instruction. The user always says "commit" first.

## Code conventions

- **Engine code (`src/engine/**`) is DOM-free.** No `window`, no
  `document`, no browser globals. The shell at `src/shell/**` adapts
  `FileSystemDirectoryHandle` → `File` → `Uint8Array` and hands the
  bytes down to the engine.
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
- **No comments explaining what the code does.** Comments are for the
  non-obvious *why*: hidden constraints, surprising invariants,
  corrections to public-format-notes (see `smap.ts`).

## Documentation

`pages/docs/` is the durable knowledge base **and a public website**. Two
halves, kept separate:

- **`scumm/`** — reverse-engineered reference for the SCUMM v5 engine and its
  file formats. What the *original* does.
- **`engine/`** — how GrogVM itself is built (the session/game-loop, costume
  loading, pathfinding). What *we* do.

Because the docs are public and double as the project's memory, hold to these
rules when writing or editing them:

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
ARCHITECTURE.md           overall design
PROGRESS.md               phase tracker, current state
README.md                 human-facing intro
pages/docs/               public documentation (file path = route); see ## Documentation
  scumm/                  SCUMM v5 reference — file formats + original-engine behaviour
  engine/                 how GrogVM itself is built (session, costumes, pathfinding)
  index.md                docs landing page
src/
  main.ts                 shell entry
  shell/                  host UI: library, install, player
    library/              installed-games list + flash messages
    install/              directory picker + game detection
    player/               room viewer + block-tree dump
    storage/              IndexedDB wrappers, FS-Access permission
  engine/                 (no DOM imports, no node:fs — portable core)
    resources/            .000/.001 parsing — XOR, blocks, tree nav,
                          per-tag description catalog
    graphics/             rmhd, clut, smap, trns, room composition
    render/               renderer interface + Canvas2D + Memory +
                          indexed-to-rgba pure helper
    vm/                   the script VM — variables, slots, params,
                          boot, vars.ts (name→index map), lighting.ts;
                          opcodes/index.ts is the EXECUTING opcode table,
                          disasm.ts is the read-only DISASSEMBLER (below)
  testkit/                dev/test harness — sibling of engine, NOT inside
                          it (see below). drive.ts = game-agnostic VM
                          drivers (pure, synthetic-testable); scummv5.ts =
                          load/boot/save by game dir (Node-only, node:fs)
integration/              root-level playthroughs — drive the REAL game files
  mi1/                    & saves, run via `npm run test:integration` (NOT
                          default `npm test`). game.ts = data dir + ids;
                          walkthrough.test.ts = the continuous regression net
```

### The disassembler (`src/engine/vm/disasm.ts`)

A first-class, tested, read-only SCUMM v5 disassembler — the static
companion to the executing opcode table in `opcodes/index.ts`. Use it
whenever you need to read what a script actually does (reverse-
engineering flow, confirming an opcode encoding, hunting who sets a
var).

- API: `disassemble(bytecode: Uint8Array): DisasmInstruction[]`
  (`{offset, opcode, text, aligned}`). It executes nothing and is
  reentrant (safe to call on arbitrary/garbage bytes — loops are
  bounded). A run that ends with `aligned: false` means it hit a byte
  it couldn't decode and stopped; treat everything after as unknown.
- CLI front-end: `npx tsx scratch/dis.ts <id>` (`L<id> <room>`,
  `ENCD/EXCD <room>`, or `SCAN grep=<term>` to sweep every script).
  The CLI is just file-loading; the decode logic + tests live in the
  module.
- **Keep it in sync with `opcodes/index.ts`.** The two decode the same
  byte stream and MUST agree on operand lengths / param-mode bits — a
  divergence makes the disassembler silently misalign. When you add or
  fix an opcode in the executing table, mirror the operand layout here
  (and vice-versa). Known limitation: a linear sweep still misaligns on
  ~13% of MI1 scripts (rare opcodes / embedded data) — `SCAN` hits in a
  script that reports "misaligned" are leads, not proof.

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
    (`drive.test.ts`), runs everywhere incl. CI.
  - `actions.ts` — **game-agnostic** faithful player-action vocabulary:
    `walkTo`/`use`/`pickAnswer`/`pickDialogAnswer`/`objectPoint`/`actorPoint`/
    `waitIdle`. Thin sugar over the real click flow (hover poller →
    active-object global → `doSentence`) — no sentence injection, so a
    playthrough built on it guards the genuine input path. Object targets
    derive their hover point from the CDHD hit-box center (`objectPoint`);
    **actor** targets (Talk-to / Give-to-actor) from the sprite-box center
    (`actorPoint` → `Vm.actorHitBounds`, which works headless via
    `prepareActorDraw` — see [INPUT §5](pages/docs/scumm/input.md)), so the suite
    stays coord-free. `pickDialogAnswer(vm, verbId)` walks a conversation tree
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
    Re-exports `drive.ts`/`actions.ts`/`random.ts` so a caller gets the whole
    harness from one import.
  - Lives in `src/testkit/`, a **sibling of `engine`/`shell`, not inside
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
rename were moved to `scratch/archive/`. New probes should use the harness
(one import — `bootScummV5(dir)`) rather than copy-pasting the resource preamble.

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
  (`src/shell/browser-support.ts`).
- **Canvas2DRenderer clears before each `present()`.** Required so
  transparent pixels in the new frame actually expose the canvas
  background (the CSS checkerboard) instead of compositing with the
  previous frame.

## When asked to start a phase

1. Read PROGRESS.md to see the one-line description of the requested
   phase.
2. Write a detailed planning section into PROGRESS.md following the
   shape of the previous phase's plan: **Goal**, **Definition of
   done**, **Tasks** (broken into subsections), **Design notes**,
   **Out of scope**.
3. Show the plan to the user. Wait for review before implementing.
4. Implement in order, keeping types green and tests passing after
   each meaningful step.
5. Verify in the browser with the user (especially for graphics
   work — unit tests can't catch "this image looks wrong").
6. When the user says "commit", move the phase to **Done** in
   PROGRESS.md with the full task checklist ticked, plus a notes
   section documenting design decisions and any new gotchas. Then
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
npm test              # 116 tests across 14 files at last count
npm run build         # production bundle should land < 30 KB JS
```
