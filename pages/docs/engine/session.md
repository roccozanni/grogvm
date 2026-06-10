# The Engine Session — Game Loop & Runtime Control

The **engine session** is the single object that runs a game. It wires the VM,
the frame compositor, a renderer, and a clock into one small control surface,
and it is fully **headless** — it touches no DOM and never schedules its own
animation frames. The browser shell drives it from the outside; the same
session runs unchanged under a test harness that feeds it time by hand.

## At a glance

```
        the injected clock calls back: "it is now T ms"
                            │
                            ▼
              throttle — elapsed ≥ 1000/rate ?
                 │ no                │ yes
                 ▼                   ▼
          nothing to do      batch: run floor(elapsed/interval)
          this callback      jiffies, capped at 64 per callback
                                     │
                                     │   each tick: idle-settle /
                                     │   all-dead / halt checks
                                     │   → may auto-pause
                                     ▼
                             produce one frame:
                             compose room → assemble screen
                             → palette → present → frame-info
```

Time enters only through the clock seam, so the entire loop — throttling,
batching, idle detection, pause logic — is deterministic and runs identically
in the browser and under the headless harness. The rest of this doc walks the
funnel top to bottom, then covers lifecycle, debug drivers, the hang
watchdog, and input.

## 1. The clock seam

The session does not own a timer. Time is **injected** as a clock that
repeatedly calls back with a monotonic millisecond timestamp. Two clocks exist:

- A **real clock** in the browser, ticking off the display's refresh.
- A **manual clock** for headless runs, advanced explicitly by the caller.

Because the loop only ever sees "the clock said it is now time T," nothing
inside the engine reads wall-clock time.

## 2. The tick model

The unit of simulation is the **jiffy**: one VM tick. The loop's job is to
turn elapsed real time into the right number of jiffies, then produce a
frame.

The loop **throttles to a target rate** (default 60 Hz): the minimum interval
between simulated frames is `1000 / rate` milliseconds. When more time has
elapsed than one interval — a slow frame, or a target rate above the clock's
own cadence — the loop **batches** jiffies to catch up: it runs
`floor(elapsed / interval)` ticks, **capped at 64** per callback so a long
stall can never trigger an unbounded catch-up spiral.

Two control knobs sit on top of the model:

- **`step`** advances exactly one jiffy and produces a frame — the primitive
  the debug surface single-steps with.
- **The rate is adjustable at runtime**; lowering it slows the simulation
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

1. **Composes the room scene** — background, actors currently in the room,
   and the queued drawn objects — into a room-sized indexed buffer, then
   slices the camera's viewport out of it and applies the screen shake, if
   any.
2. **Assembles the full screen** around that room band with the engine's
   screen composer: the verb/inventory panel (text verbs in their own
   charsets, image verbs from their home rooms, hover/armed highlight from
   the mouse vars and the armed-verb global) and dialog / system text,
   clipped to the room band. The result is the complete visible game as one
   indexed framebuffer — typically 320×200.
3. Applies the **palette** — the room's, or the *last-seen* palette while no
   room is loaded, so text baked into the frame stays visible over the black
   band between rooms. The frame presents **opaque** (no transparent index):
   transparency is a compositing concern inside the frame, not a property of
   the finished screen.
4. **Presents** the framebuffer to the injected renderer, resizing the
   renderer first if the screen dimensions changed.
5. Emits a **frame-info** record to subscribers: the tick count, the screen
   dimensions plus the room-band geometry (`viewportWidth`, `roomHeight` —
   the shell's input mapping needs the band split), current room id, the
   palette, a copy of the presented framebuffer, and compositor diagnostics.
   The shell blits the presented frame onto its screen canvas and paints only
   non-game chrome on top — the cursor crosshair and debug overlays.

The session also exposes **present()** — compose and present the current VM
state *without* ticking. The shell calls it on pointer moves while paused so
the engine-painted hover highlight tracks the cursor; while playing, the next
frame picks up the same state anyway.

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

## 7. The hang watchdog

An **opt-in** diagnostic for the failure mode auto-pause can't see: a game that
looks alive but has stopped responding to the player. It fires when **three
consecutive clicks** each produce no progress within a settle window of about
twelve frames (≈1 s at MI1's ~10 fps pacing). Progress is fingerprinted from
*progress-only* signals — the current room, monotonic talk/sentence counters,
commanded walks — deliberately **not** the live-script set (every click
transiently spawns the verb-redraw script, #12) and not raw variables (the
music timer churns every tick), either of which would mask a real hang as
activity. When it trips, it surfaces a warning naming the room and the active
verb script — catching the input-misroute / wait-on-a-variable-that-never-changes
class of hang.

## 8. Input

The session handles **engine-level input only**:

- **Mouse movement** writes the room coordinates and the four cursor/virtual-
  mouse variables the bytecode reads.
- **Button down/up** sets and clears the left/right hold flags.
- **Escape** aborts the current cutscene.

Everything higher-level — deciding that a left click runs a particular verb
script against the hovered object — is the **shell's** responsibility, built
on top of the session. The shell's click routing resolves verb-band clicks
through the engine's own verb hit-test (the same one the frame composer
uses for the hover highlight, fed by the mouse vars the input layer
maintains), then dispatches via the VM's verb/scene click handlers. The
session itself never dispatches clicks; it only *renders* verb state as part
of the frame.
