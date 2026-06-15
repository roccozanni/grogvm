---
title: Architecture — Layers & Seams
description: The as-built shape of GrogVM — the layer map from markdown pages down to the headless engine core, the seams that keep it testable (renderer, clock, audio timing), and the principles behind them.
---

# Architecture — Layers & Seams

GrogVM is a from-scratch TypeScript reimplementation of SCUMM v5 that runs
natively in the browser, built to learn the engine by rebuilding it. It targets
*The Secret of Monkey Island* (CD, VGA, 256-color) and *Monkey Island 2:
LeChuck's Revenge* (DOS) — the two share an engine version, container layout,
and graphics pipeline, so one engine runs both.

This page is the map: the layers, what each one owns, and the seams between
them. Subsystem behavior lives in the sibling docs, linked throughout.

## At a glance

```
        ┌────────────┬───────────────────────────────────────────┐
        │  pages     │  every page is markdown; path = route     │
        ├────────────┼───────────────────────────────────────────┤
        │  site      │  static page shell — nav, theme           │
        ├────────────┼───────────────────────────────────────────┤
        │  app       │  islands: Library · Explorer · Player     │
        ├────────────┼───────────────────────────────────────────┤
        │  platform  │  browser adapters — files, IndexedDB,     │
        │            │  routing                                  │
        ├────────────┼───────────────────────────────────────────┤
        │  engine    │  headless core — no DOM, no browser       │
        │            │  globals; same code runs in Node          │
        │            │  seams: renderer · clock · audio backend  │
        └────────────┴───────────────────────────────────────────┘
          imports point only downward

          beside the stack: build — the owned markdown→HTML
          generator; offline tooling, nothing imports it
```

The whole site ships as static files — no server, ever. The engine at the
bottom is fully headless: everything it needs from the outside world (a
renderer, a clock, an audio backend) is injected, which is what lets the same
code run a real game in the browser and a scripted playthrough in Node.

## 1. Scope & non-goals

The non-goals shape the code as much as the goals do:

- **Two games only.** No other SCUMM versions (v4, v6+), no non-SCUMM titles.
- **"Plays correctly enough to finish", not preservation.** No bit-exact
  reproduction of original timing or audio mixing.
- **Clean room.** No ScummVM source reuse — the engine is built from
  long-circulating public format notes (which contain errors) validated
  against real game data, and from disassembling the games' own bytecode.
- **No server, ever.** The whole site — these docs and the playable engine —
  ships as static files.
- **Desktop browsers.** Mobile/touch input is not a target.

## 2. Principles

1. **Learning first.** Code clarity beats performance; a 50-line decoder that
   reads clearly beats a 10-line one full of bit tricks. The engine doubles as
   an inspection tool, so debug and inspection surfaces are permanent features,
   not scaffolding.
2. **Verify behavior, not bookkeeping.** A claim about the engine is trusted
   once the real game has been driven to the point that exercises it — render
   the pixels, reproduce the flow (see [the test harness](harness.md)).
3. **Fail loud.** An unimplemented opcode or a VM-level error does not get a
   silent stub: the VM halts into a first-class, inspectable halt state that
   carries the trace that led to it.
4. **Determinism by injection.** Nothing inside the engine reads wall-clock
   time or global entropy: the clock and the random source are injected, so
   the same inputs replay the same game headlessly.
5. **No premature abstraction.** Interfaces exist only where a second
   implementation is real. The handful that do exist — the renderer, the audio
   backend, the clock — are exactly what lets the engine run without a DOM.

## 3. The layer map

What each layer in the stack owns:

- **pages** — every page of the site is markdown; the file path is the route.
  A page becomes interactive purely by declaring an *island* in its
  frontmatter.
- **build** — a small owned markdown→HTML generator (two slow-moving utility
  dependencies: a markdown renderer and a frontmatter parser). Offline
  tooling; nothing imports it.
- **site** — the shared static page shell (nav, theme). Presentation only; it
  knows nothing of the engine or the browser adapters.
- **app** — the interactive islands: **Library** (installed games),
  **Explorer** (static resource browser), **Player** (the running game). The
  islands share a tiny owned signal/effect reactive core — the one UI
  primitive the project allows itself instead of a framework.
- **platform** — browser-API adapters: File System Access (the user installs
  a game by pointing at a local folder), IndexedDB persistence, path-based
  routing. No UI; may use the engine (game detection, save format).
- **engine** — the headless core. No DOM, no browser globals; the same code
  runs in Node under the test harness.

**Fine print — the static build.** The site is a multi-page static build:
each page is a real HTML file, so refresh and deep links work and the content
pages are crawler-indexable with no server and no SPA fallback. Each page also
publishes its markdown beside the HTML at `<page url>.md` (append `.md` to the
path), with relative `.md` links rewritten to absolute so the markdown stands
on its own. Per-page bundles mean the engine chunk loads only on the screens
that run it.
Client-only parameters — which *installed* game to open — ride the query
string, since they are IndexedDB keys local to one browser profile and not
meaningful to share.

## 4. The engine core

One picture before the parts — how a tick becomes pixels:

```
   game files (in memory, decrypted up front, block tree parsed once)
                        │
                        │  injected resolvers — the VM asks for
                        │  "costume 12", never sees bytes or offsets
                        ▼
  clock ──jiffy──▶ ┌───────────────────────────────────────────┐
  (injected)       │  VM — the mainline                        │
                   │  scripts · sentences · actor walking ·    │
                   │  costume animation · camera · audio clock │
                   └────────────────────┬──────────────────────┘
                                        │  compose (indexed pixels)
                                        ▼
                   ┌───────────────────────────────────────────┐
                   │  frame compositor → screen composer       │
                   │  room scene → camera slice → verb band +  │
                   │  dialog text → one 320×200 framebuffer    │
                   └────────────────────┬──────────────────────┘
                                        │  present (palette + indices)
                                        ▼
                            renderer seam (injected)
                     Canvas2D in the browser · an in-memory
                     recorder under the test harness
```

### Resources — everything in memory

A game is two files: an index (directories of every resource) and a resource
container, both XOR-encrypted byte-wise with `0x69`
(see [the index file](../scumm/index-file.md)). On open, both are read fully
into memory and decrypted up front, and the container's block tree is parsed
once — a few megabytes per game, which buys a simple synchronous engine with
no streaming, no read-ahead, and no I/O during play.

Individual resources are decoded **on demand** through resolver functions
injected into the VM at boot — the VM asks for "costume 12" and never knows
about bytes, offsets, or encryption. Decoded costumes and sounds are cached
for the life of the session; the games' resource sets are small enough that
nothing is ever evicted. Rooms are loaded one at a time, fully decoded
(background, z-planes, objects, walk boxes) on entry.

### The VM — the engine's mainline

The VM is deliberately broader than a bytecode interpreter: like the original
engine's mainline, its per-jiffy tick is the **single canonical driver** of
everything that advances with time — script scheduling, sentence processing,
actor walking, costume animation, camera pan and follow, and the audio clock.
The browser session and the headless harness both drive this same tick, so
the timing model lives in one place (see [timing](../scumm/timing.md) for the
jiffy/frame split it implements).

Beyond the dispatch loop, the VM owns the world state the bytecode acts on:
variables and script slots, actors, object state, the camera, dialog state,
and box-flag overrides. Scripts schedule cooperatively — each runs until it
yields — and a VM-level error freezes the machine into an inspectable halt
snapshot with a trace ring of the last dispatched opcodes.

Both games run on this one engine. Code branches on the detected game
identity at the small number of known difference points
(see [game identity](game-identity.md)); the codebase is never forked per
game.

### Graphics — indexed pixels end to end

Decoders ([backgrounds](../scumm/smap.md), [costumes](costumes.md),
[fonts](../scumm/char.md), [z-planes](../scumm/zplane.md)) produce palette
*indices*, never colors. The palette travels separately, and RGBA exists only
inside the renderer at present time. Nothing pre-multiplies the palette into
pixels, which is what keeps palette effects cheap and renderers swappable.

### The renderer seam

The engine talks to an injected **renderer** with a deliberately small
contract: take a palette, a transparent index, a surface size, and an indexed
framebuffer to present. Two implementations exist — a Canvas2D renderer in
the browser, and an in-memory recorder that lets headless tests assert on
real presented pixels.

Each produced frame is **recomposed from scratch** — room background, drawn
objects, then actors sorted by depth with z-plane occlusion. No dirty-rect
tracking: a 320×200-class indexed buffer is cheap enough that the simple
approach wins.

### Frame ownership — the engine emits the complete screen

The engine composes and presents the **entire visible game image** as one
indexed framebuffer: the camera's window into the room (objects, actors,
z-plane occlusion), the verb/inventory panel, the sentence line, and dialog /
system text. Room-scene assembly lives in the frame compositor; the screen
composer layers the verb band and text over the camera-sliced scene and is
what actually crosses the renderer seam (see [the session](session.md),
"Frame production"). The whole pipeline stays pure indexed-pixel work — text
glyphs and verb sprites stamp CLUT indices; RGBA conversion still happens
only at present.

Because the presented framebuffer *is* the complete frame, a renderer
implementation renders the whole game, and frame-level pixel tests can assert
dialog and verb pixels through the in-memory recorder. The shell paints only
non-game chrome over the blit: the cursor crosshair and the debug overlays.
The engine also owns the verb **hit-test** — the session uses it for the
hover highlight and the shell for click routing, so painted verbs and
clickable verbs can never disagree.

### Sound — a timing seam first

Sound sits behind an injected **audio backend**. Its first job is not output
but *time*: scripts pace cutscenes by polling whether a sound is still
playing, so the backend tracks real durations on the engine's own tick clock
— deterministic and savestate-safe (see [audio timing](audio.md)).

### The session — one object runs the game

The shell holds a single **engine session** that wires VM, compositor,
renderer, and an injected clock into a small control surface — play, pause,
single-step, input, snapshot/restore, and debug drivers. Its loop
throttles and batches ticks at a fixed 60 Hz, auto-pauses an idle game, and
never touches the DOM (see [the session](session.md)).

### Save states

A save is a versioned snapshot of the live VM — variables, script slots with
their bytecode, actors, objects, audio timers. Each live slot's bytecode is
stored verbatim because its program counter points mid-stream: re-deriving the
source on restore (global script, entry script, local, verb, sentence) is
fragile, and the bytecode itself is small. Restore boots a fresh VM and
applies the snapshot. The format is GrogVM's own (original SCUMM saves are a
non-goal) and moves forward without compatibility shims: a format change
bumps the version rather than accreting fallbacks.

### The disassembler — the static companion

Alongside the executing dispatcher lives a read-only disassembler used for
reverse-engineering and the script inspectors. Both are consumers of a single
opcode registry: each opcode family is defined once — its opcode bytes, its
operand layout (written against an operand-reader interface with a live
implementation that dereferences variables and a static one that labels
them), its execution, and its disassembly text. An operand encoding therefore
exists in exactly one place and the two consumers cannot drift
(see [opcode dispatch](../scumm/opcodes.md)). The one exception is
`expression`, whose stream interleaves nested opcode *execution* with
decoding: its live side stays a streaming evaluator and only the subop shapes
are shared. A corpus integration test disassembles every script in the
installed game and holds the line at zero misalignments.

## 5. The player & the explorer

The **Player** hosts one session and shows two faces of the same running
tick: the clean play surface, and a **read-only** debug drawer with live VM
inspection (slots, variables, trace, actors, walk-box overlay) that reads the
session's VM directly — privileged access, by design, because a learning tool
keeps its internals visible. The drawer observes; it never drives the clock,
so a stray click in it can't desync the game you're playing. The **Explorer**
is a separate, session-free screen: pure
static analysis of an installed game's resources using the same decoders the
VM uses, so it works even on a game the VM cannot yet play.

The engine always works in native low-resolution pixels — mouse input,
geometry, and the framebuffer all share the original game's units. The shell
upscales the canvas with CSS (`image-rendering: pixelated`); no scaling
exists inside the engine.

## 6. Testing

Three tiers, one principle — the browser is for integration and rendering
issues, never the primary verifier:

- **Unit tests** run in Node against synthetic, handcrafted fixtures. No
  game assets are committed; decoders and VM behavior are pinned by bytes
  constructed in the tests themselves.
- **Integration playthroughs** drive the real game files (opt-in, local
  path) through the genuine input path from boot, asserting mechanics — see
  [the test harness](harness.md).
- **In-browser verification** confirms what only a human can judge: that it
  looks and feels right.

## 7. Decided trade-offs

Choices that could have gone another way, and why they went this way:

- **Main thread, not a Web Worker.** Isolation would add message-passing
  complexity for no learning benefit, and the debug surfaces read VM state
  directly every frame.
- **An owned page generator, not a site framework.** The pages are plain
  markdown + frontmatter with file-based routing, so a future migration to a
  framework would be mechanical — but a framework owning the build to serve a
  handful of pages is exactly the maintenance surface this project avoids.
- **A tiny owned reactive core, not a UI library.** The live, ticking
  inspector made hand-rolled DOM diffing unmaintainable; a small owned
  signal/effect kernel fixes that without taking on a dependency.
- **Square pixels.** The framebuffer is always the original logical
  resolution; any 4:3 aspect correction is a presentation-layer concern, not
  an engine one.
