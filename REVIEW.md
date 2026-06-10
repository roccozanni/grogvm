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
indexed-pixel invariant is real, and the test harness is principled. One
genuine architectural problem remains:

1. The `Vm` class has become the de-facto engine god-object.

(Three further findings were fixed since and their sections removed from this
document: ARCHITECTURE.md and stale module headers describing an engine that
was never built — the live design doc is pages/docs/engine/architecture.md
and the false headers are gone; the disassembler and the executing opcode
table being two parallel bytecode decoders with no shared source of truth —
both now read one opcode registry, each opcode's operand layout defined
exactly once, with a corpus test pinning zero misalignments; and the engine's
frame output being incomplete — dialog text and the verb bar were painted by
the app layer outside the Renderer seam; the engine now emits the complete
320×200 screen through one screen composer, the duplicate shell caches and
hit-test are gone, and frame-level pixel tests can see text
(pages/docs/engine/architecture.md "Frame ownership"). The audits and
resolution records live in PROGRESS.md.)

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

## 2. Secondary findings (real, lower stakes)

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

## 3. Claims checked and rejected (so they don't come back)

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

## 4. What's genuinely good (verified, not vibes)

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

## 5. Ranked action items

1. The Vm god-object is real, but is the kind of thing to chip at with a
   stated boundary rather than refactor wholesale.
