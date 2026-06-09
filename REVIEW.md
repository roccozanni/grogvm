# GrogVM — Architectural Review (2026-06-09)

A deep review of the codebase looking for serious flaws and bad architectural
choices. Method: six parallel review passes (VM, session/timing, graphics,
resources/world model, app/build/harness, docs-vs-code audit), with every
load-bearing claim personally re-verified against the code before inclusion.
Findings that did not survive verification are listed at the end so they don't
resurface.

This is a point-in-time document — file/line references are valid as of the
commit it was written against and will rot.

**TL;DR:** The engine code is in considerably better shape than the iterative
history would suggest — the layering contract actually holds, the
indexed-pixel invariant is real, and the test harness is principled. Three
genuine architectural problems remain:

1. The `Vm` class has become the de-facto engine god-object.
2. The engine's frame output is incomplete — dialog text and the verb bar are
   painted by the app layer, outside the Renderer seam.
3. The disassembler and the executing opcode table are two parallel bytecode
   decoders with no shared source of truth.

(The review originally led with a fourth finding — ARCHITECTURE.md and stale
module headers describing an engine that was never built. Fixed since: the
live design doc is pages/docs/engine/architecture.md and the false headers
are gone, so that section has been removed from this document.)

---

## 1. The `Vm` class is the engine, not a VM

`vm.tick()` (vm.ts:1961-2008) is SCUMM's mainline: it advances audio timers,
drains delays, gates the game frame, runs the sentence queue, resumes and runs
scripts, **steps actor walks, steps costume animation, advances the camera pan
and camera follow**, and runs the watchdog. `Vm` itself owns actors, object
state/owner/class maps, the draw queue, palette overrides, dialog and system
text, mouse mirrors, the camera, the audio backend, and box-flag overrides.
The session layer on top (`session.ts`) adds only throttling, idle detection,
and frame composition.

Two ways to read this:

- **Defensible as a design.** The original interpreter's mainline does run
  everything per frame, and having one canonical per-jiffy driver ("the timing
  model lives in one place" — vm.ts:1956) is a real virtue; the session and
  the headless harness both calling the same `tick()` is why the from-boot
  walkthrough is trustworthy.
- **Costly as a pattern.** vm.ts is ~2,400 lines and growing without a
  stated boundary, so there is no principled answer to "does this new state
  belong on Vm?" — the answer in practice has always been yes, which is how
  god-objects form. The shell rebuild fought exactly this pattern (the
  1900-line inspector) and won; the same pattern has quietly re-formed one
  layer down. (The docs now admit the mainline role —
  pages/docs/engine/architecture.md — so the remaining issue is the
  unbounded growth, not the description.)

Adjacent: `opcodes/index.ts` is ~3,100 lines in a single file by accretion,
with several 200-line handlers (`printHandler`, `actorOpsHandler`). It works,
but combined with vm.ts it means the project's two largest files are also its
least navigable — in a codebase whose stated goal is learning/clarity.

---

## 2. The engine's frame is incomplete — text and verbs bypass the Renderer seam

Verified directly: `src/engine/render/compositor.ts` contains zero text/verb
code. `src/app/player/play-area.ts` imports `renderText` from engine graphics
and paints dialog (`drawDialog`, play-area.ts:271-281, reading
`vm.activeDialog` and `vm.systemTexts`) and the entire verb bar
(`paintVerbBar`, play-area.ts:444) directly onto the 2D canvas context,
*after* the engine presents.

Consequences:

- **The swappable-renderer story is broken in practice.** A `WebGLRenderer`
  implementing the documented interface would render a game with no text and
  no verbs — the rest of the visible image is painted via
  `CanvasRenderingContext2D` calls in the app layer. The seam exists, but the
  product crossing it is only part of the frame.
- **The frame is untestable as a whole.** `MemoryRenderer` tests can assert
  room/actor/object pixels but can never see dialog or verb pixels — despite
  the project's "render actual pixels" debugging rule.
- **The Worker migration story (ARCHITECTURE §11 Q5)** — "the boundary is
  message-shaped, frames out" — is no longer true: the app reads
  `vm.activeDialog`, `vm.systemTexts`, charset resources, and verb state every
  frame to build the visible image.
- The app layer grew its own charset/room caches (play-area.ts `charsetCache`
  / `roomCache`) — duplicate resource plumbing that exists only because
  composition leaked upward.

The engine owns all the *state* (dialog, verb table, charsets) and the app
owns only the rasterization — neither layer is self-sufficient. The split is
now documented as the chosen design (pages/docs/engine/architecture.md,
"Frame ownership"), so the remaining question is whether to eventually move
text/verb composition into the engine compositor — which is what a WebGL
renderer or frame-level pixel tests would require.

---

## 3. Two parallel bytecode decoders (disasm vs. handlers)

`src/engine/vm/disasm.ts` (~613 lines) re-implements operand decoding for
every opcode independently of the executing handlers in
`src/engine/vm/opcodes/index.ts`. There is no shared operand-size table — this
has drifted before, and the failure mode is nasty: a mismatch shows up as
garbage disassembly or a misaligned PC far downstream, not at the divergence
point. For a project whose debug tooling is a stated permanent feature, the
disassembler silently lying about what the engine will execute is a
tooling-trust problem. A shared parameter-decode layer (both consumers reading
one table, as `params.ts` partially is) is the structural fix.

---

## 4. Secondary findings (real, lower stakes)

- **Savestate reaches directly into Vm private fields**
  (`src/engine/vm/savestate.ts:224-439` reads/writes `vars.globals`,
  `objectStates`, slot internals). Consistent with the project's "trust
  internal callers" convention and covered by round-trip tests, but it means
  every Vm state refactor is silently load-bearing for saves, with only a
  single global `SAVE_VERSION` as the tripwire.
- **`createSession` cannot be seeded.** `bootGame` accepts an injected
  `random` (boot.ts:72) and the integration harness uses it, but
  session.ts:447 and :466 hardcode `undefined` — so browser sessions and the
  `restore()` / `reboot()` paths are permanently `Math.random`. Deliberate per
  the jsdoc, but the session API forecloses determinism rather than defaulting
  away from it.
- **Costume frames are decoded fresh every frame, per limb, per actor**
  (`composite.ts` → `decodeCostumeFrame` allocates a new buffer each call). At
  320×200 with a handful of actors this is fine today; it is the one place
  "clarity over performance" has a plausibly visible cost (GC churn in long
  cutscenes). Worth a note, not a fix.
- **Sync resource resolution inside the tick** (`vm.getCostume` parses on
  miss, blocking the frame). Harmless at MI1's 4.8MB-fully-in-RAM scale; just
  contradicts the documented lazy model.
- **`graphics/composite.ts` vs `render/compositor.ts`** — the division of
  labor is actually clean (actor blit vs. frame assembly) but the
  near-identical names invite confusion.

---

## 5. Claims checked and rejected (so they don't come back)

- **"Restore-while-playing causes a timing burst."** Wrong. `restore()` goes
  through `play()`, which sets `needsTimeSync`; the first clock tick resets
  the time base and runs a single tick (session.ts:333-339, :392). The
  mechanism is explicit and commented.
- **"Critical: whole .001 in RAM / unbounded caches will exhaust memory."**
  Miscalibrated. `MONKEY.001` is 4.8MB; eager-load-everything is a sound
  choice for this project (and is now what the architecture doc describes).
- **"Unimplemented opcodes shouldn't all halt."** Backwards; loud-halt is the
  deliberate, recently reaffirmed policy and is right for a learning
  interpreter.
- **"Idle fingerprint unstable across batches."** Speculative; the fingerprint
  is computed fresh per framed tick and compared as a whole
  (session.ts:119-171). No instability mechanism exists.

---

## 6. What's genuinely good (verified, not vibes)

- The indexed-pixel invariant holds end-to-end, with `indexedToRgba` as a pure
  function used identically by both renderers.
- The single-z-plane occlusion model is correctly implemented, with the
  room-30 reasoning documented at the point of use.
- Clock injection is real and the loop is deterministic headless.
- The §8 import-direction contract was verified by actual import inspection
  and **holds with zero violations**.
- The reactive core is ~190 lines with correct disposal semantics.
- Room teardown on `enterRoom` is complete (draw queue, scripts, box
  overrides, scroll, shake).
- Halt-as-first-class-state plus the trace ring is a better design than most
  hobby interpreters ever get.
- The walkthrough harness genuinely has zero `driveTicks` — every beat is
  condition-driven.

---

## 7. Ranked action items

1. **Unify operand decoding** between disasm and the executing handlers behind
   one shared table.
2. **Frame ownership** — the engine/shell split is now documented design;
   move text/verb composition into the engine compositor if/when a second
   renderer or frame-level pixel tests are wanted.
3. The Vm god-object is real, but is the kind of thing to chip at with a
   stated boundary rather than refactor wholesale.
