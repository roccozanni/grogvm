# The Engine Session — Game Loop & Runtime Control

The **engine session** is the single object that runs a game. It wires the VM,
the frame compositor, a renderer, and a clock into one small control surface,
and it is fully **headless** — it touches no DOM and never schedules its own
animation frames. The browser shell drives it from the outside; the same
session runs unchanged under a test harness that feeds it time by hand.

This doc describes the durable runtime behavior: how time enters the loop, how
ticks are throttled and batched, when the game auto-pauses, how a frame is
produced, and the lifecycle / debug controls the session exposes.

## 1. The clock seam

The session does not own a timer. Time is **injected** as a clock that
repeatedly calls back with a monotonic millisecond timestamp. Two clocks exist:

- A **real clock** in the browser, ticking off the display's refresh.
- A **manual clock** for headless runs, advanced explicitly by the caller.

Because the loop only ever sees "the clock said it is now time T," the entire
loop — throttling, batching, idle detection, pause logic — is **deterministic**
and testable without a browser. Nothing inside the engine reads wall-clock time.

## 2. The tick model

The unit of simulation is the **jiffy**: one VM tick. The loop's job is to turn
elapsed real time into the right number of jiffies, then produce a frame.

- The loop **throttles to a target rate** (default 60 Hz). The minimum interval
  between simulated frames is `1000 / rate` milliseconds.
- When more time has elapsed than one interval (a slow frame, or a target rate
  above the clock's own cadence), the loop **batches** jiffies to catch up:
  it runs `floor(elapsed / interval)` ticks, **capped at 64** per callback so a
  long stall can never trigger an unbounded catch-up spiral.
- `step` advances **exactly one jiffy** and produces a frame — the primitive the
  debug surface single-steps with.
- The rate is adjustable at runtime; lowering it slows the simulation
  uniformly (fewer jiffies per second of real time), it does not drop frames.

## 3. Auto-pause

A running session pauses itself in three situations, so it never burns cycles
on a game that has nothing left to do:

- **Idle settle.** Each tick the loop computes a *fingerprint* of everything
  that could be making progress — script slot states and program counters,
  which actors are moving, animation cursors, and the most recent trace of each
  active script. When the fingerprint stops changing for **ten consecutive
  ticks** outside a cutscene, the game has settled waiting for player input, and
  the session auto-pauses. (Note: an idle actor whose costume keeps animating
  keeps the fingerprint changing, so such a room never settles on its own — this
  is expected, not a bug.)
- **All slots dead.** If a tick runs no script, moves nothing, has nothing
  delaying, and resumed nothing, there is no work pending and the loop pauses.
- **Halt.** A VM that has halted pauses the loop.

Pausing is recoverable: resuming play resets the idle tracking and the loop
picks up where it left off.

## 4. Frame production

Each produced frame, the session:

1. Reads the current room to size the framebuffer (defaulting to a
   320×144-class indexed buffer when no room is loaded).
2. **Composes** the VM state — room background, actors currently in the room,
   and the queued drawn objects — into that indexed framebuffer.
3. Applies the room's **palette** and **transparent index**; between rooms,
   while none is loaded, it presents on black so the backdrop is predictable.
4. **Presents** the framebuffer to the injected renderer, resizing the renderer
   first if the room dimensions changed.
5. Emits a **frame-info** record to subscribers: the tick count, frame
   dimensions, current room id, the palette, a copy of the presented
   framebuffer, and compositor diagnostics (how many actors were drawn or
   skipped). Overlays — cursor, verb bar, sentence line, talk text — are *not*
   part of this framebuffer; the shell draws them on separate layers above it.

## 5. Lifecycle

- **Boot** starts a fresh game.
- **Reboot** boots the same game again from scratch.
- **Snapshot** serializes the live VM into a save state.
- **Restore** boots fresh and then applies a save state, and it **preserves the
  play/pause state** — a session that was playing resumes playing; one that was
  paused stays paused with an idle banner. (Restore reloads the target room from
  disk rather than re-running its entry script, so any runtime room state that
  the entry script would normally re-apply — such as locked walk boxes — is
  carried in the save state itself.)

## 6. Debug drivers

Beyond plain play/pause, the session exposes drivers the debug surface uses:

- **Step** — advance one jiffy and present.
- **Enter room** — warp directly to a room and let its entry script settle,
  bounded by a tick cap so a misbehaving entry can't hang the warp.
- **Skip cutscene** — run the VM forward until interactive control returns
  (a verb becomes available), bounded by a tick cap.

## 7. Input

The session handles **engine-level input only**:

- **Mouse movement** writes the room coordinates and the four cursor/virtual-
  mouse variables the bytecode reads.
- **Button down/up** sets and clears the left/right hold flags.
- **Escape** aborts the current cutscene.

Everything higher-level — deciding that a left click runs a particular verb
script against the hovered object, the verb bar, the sentence line — is the
**shell's** responsibility, built on top of the session by reading VM state. The
session deliberately knows nothing about verbs.
