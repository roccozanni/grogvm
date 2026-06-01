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
3. **[docs/SCUMM-V5-SMAP.md](docs/SCUMM-V5-SMAP.md)** — the gnarliest
   format we've cracked so far. Worth skimming even if you're not
   working on graphics; it sets the tone for how the user wants
   reverse-engineering knowledge captured.

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
- **Don't cite URLs for the SCUMM reverse-engineering notes.** The
  user found them on a deleted page in the Internet Archive; they're
  not attributable to the official ScummVM wiki.
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

## Project structure

```
ARCHITECTURE.md           overall design
PROGRESS.md               phase tracker, current state
README.md                 human-facing intro
docs/
  SCUMM-V5-SMAP.md        SMAP format reference
src/
  main.ts                 shell entry
  shell/                  host UI: library, install, player
    library/              installed-games list + flash messages
    install/              directory picker + game detection
    player/               room viewer + block-tree dump
    storage/              IndexedDB wrappers, FS-Access permission
  engine/                 (no DOM imports anywhere below this line)
    resources/            .000/.001 parsing — XOR, blocks, tree nav,
                          per-tag description catalog
    graphics/             rmhd, clut, smap, trns, room composition
    render/               renderer interface + Canvas2D + Memory +
                          indexed-to-rgba pure helper
    vm/                   the script VM — variables, slots, params,
                          boot, vars.ts (name→index map), lighting.ts;
                          opcodes/index.ts is the EXECUTING opcode table,
                          disasm.ts is the read-only DISASSEMBLER (below)
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
  working dispatch is `color -= (4 - d)`. See `docs/SCUMM-V5-SMAP.md`
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
   commit, with `Co-Authored-By: Claude Opus 4.7 (1M context)
   <noreply@anthropic.com>` in the trailer.

## Quick health checks

```bash
npm run typecheck     # 0 errors expected
npm test              # 116 tests across 14 files at last count
npm run build         # production bundle should land < 30 KB JS
```
