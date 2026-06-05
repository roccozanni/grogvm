# The Test Harness — Driving the Real Game

The harness is the dynamic counterpart to the disassembler and the resource
inspectors: where those read a game's bytes statically, the harness **loads,
boots, drives, and inspects the real game running on the VM**. It exists to
serve one principle — *verify behaviour, not bookkeeping*. A claim about how the
engine behaves is trusted only once the real game has been driven to the point
that exercises it.

It comes in two layers: a reusable, game-agnostic harness, and per-game
playthroughs built on top.

## 1. Two layers

- The **reusable harness** is game-agnostic. It knows how to drive *a* SCUMM v5
  VM — advance time, move the mouse, wait for conditions, perform player
  actions — without knowing anything about a specific game's rooms or objects.
  Any v5 game reuses it unchanged.
- A **playthrough** is per-game. It supplies that game's own numeric ids and
  walks the VM through the game's solution, asserting that the mechanics hold.

The split matters: the reusable layer is itself exercised against a *synthetic*
VM, so it runs everywhere — including CI with no game data present — while the
playthroughs need the real game bytes and run separately.

## 2. Driving the VM

The lowest layer operates on a bare VM: set the mouse position, advance a fixed
number of ticks, or advance until a predicate holds — bounded by a tick cap, so
a condition that never comes true fails loudly instead of hanging — plus a
convenience to drive straight to a given room. These primitives only read and
nudge VM state, nothing more, which is what lets the same drivers serve any v5
game.

## 3. The faithful action vocabulary

On top of the raw drivers sits a vocabulary of **player actions**: walk to a
spot, use an object, use one object with another, talk, pick a dialogue answer,
wait for the game to settle. The defining rule is that these are **thin sugar
over the genuine input path, not shortcuts around it.** An action drives the
same flow a real click would — the hover poller notices the target under the
cursor, the engine records it as the active object, and a sentence is dispatched
from there — with **no sentence injected directly.** A playthrough built on this
vocabulary therefore guards the real input machinery, not a parallel,
test-only path.

Two consequences keep the suite **coordinate-free**:

- Object targets resolve their hover point from the object's hit-box center, so
  a test names an object by id, never by pixel.
- Actor targets (talk-to, give-to-actor) resolve from the actor's on-screen
  sprite-box center. That requires hit-testing an actor **headless** — computing
  where its sprite would land without drawing it — which the engine supports by
  sharing the very same sprite-box computation the compositor uses to draw.

Dialogue is a special case. A conversation's answers are presented as **verbs
whose ids recur from one menu to the next**, so there is no stable per-answer id
to aim at. Picking an answer instead walks the live conversation tree — wait for
the option to arm, pick it, wait for it to dismiss — and fails loudly if the
expected option never appears.

## 4. Determinism

A regression net that flakes is worse than none. The engine's source of
randomness is a **seam**: the VM draws random numbers from an injected
generator, defaulting to the platform's in the browser but replaced under test
with a **seeded generator** (a small, fast mulberry32). Given the same seed, a
scripted playthrough takes the same branches on every run. The seed is a test
fixture, not game state — it is deliberately *not* part of a save snapshot.

## 5. Loading the real game

The harness loads a game **by its directory**: detect whether a directory holds
a supported game, boot it to a live VM, or restore a save onto one. This is the
one corner of the project that touches the filesystem — which is exactly why it
lives *beside* the engine rather than inside it. The engine core stays portable
and browser-bundled, free of any file API.

Because the games cannot be redistributed, every playthrough is **data-gated**:
with no game directory present it skips itself, so a fresh checkout and CI stay
green. The copyrighted bytes are never committed.

## 6. The regression net

A game's playthrough is **one VM, booted once, and driven through the game's own
solution from the start onward** — the same sequence a player following a
walkthrough would perform. It is grown **beat by beat**: each beat is a named
checkpoint proving one piece of progress (reach a room, learn a fact, acquire an
item, clear a puzzle), and the last passing beat marks the project's current
frontier.

Three properties are deliberate:

- **Headless.** It asserts VM *state*, not pixels — so it catches logic and
  playability regressions (a script that stops advancing, an item that can no
  longer be taken) but not visual ones, which are verified by rendering real
  pixels instead.
- **From boot every run.** No save fast-forwards it to the middle; the whole
  path runs each time, so a regression anywhere upstream still surfaces.
- **Localized failure.** A per-beat guard reds the first failing checkpoint and
  skips the rest, so after a refactor the breakage points at a single beat
  instead of collapsing the entire run.

It runs apart from the fast synthetic suite — at the end of a work session, or
after a refactor.

## 7. Ids, not strings

Playthroughs are driven entirely by **numeric ids** — verb, object, and dialogue
ids — kept in a per-game data table that holds no localized text. These ids are
**structural**: they are identical across a game's localized builds, where only
the displayed text is translated. One suite therefore covers a *game* rather
than a single language build, and the same suite passes against, for example,
both the English and Italian releases.

The corollary is a hard rule: **never assert a localized string.** When a test
must check produced text at all, it derives the expectation from the same build
it is running against — a dialogue answer's own stored name, say — rather than
hardcoding one translation.

## 8. Where a regression test belongs

The playthrough proves the game *plays*; it is not where a fixed bug's guard
lives. Once a bug's root cause is pinned, its anti-regression test is a
**synthetic engine unit test** that captures the mechanism directly —
independent of any save or game data — and joins the fast suite. The playthrough
stays focused on does-the-game-play mechanics; save-file-specific probing stays
in scratch space, out of the committed test suites entirely.
