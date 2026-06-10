# SCUMM v5 timing — the jiffy / frame split

The single most important timing fact in SCUMM v5: there are **two
clocks**, and conflating them makes everything that moves run too fast.

```
 jiffies (1/60 s):   │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ │ …
                     └─────┬─────┘ └─────┬─────┘ └────┬────
 game frames           one frame      next frame        …
 (every VAR_TIMER_NEXT = 6 jiffies → ~10 fps)

 counted in JIFFIES:  delay · VAR_MUSIC_TIMER · the talk timer
                      — wall-time accurate at any frame rate
 advance per FRAME:   scripts (breakHere) · actor walking ·
                      costume animation — all at ~10 fps
```

## The two clocks

- **Jiffy** — 1/60 s, the hardware tick. `delay`, `VAR_MUSIC_TIMER`,
  `VAR_TIMER`, and the talk timer are all counted in jiffies, so they
  are **wall-time accurate at any frame rate**.
- **Game frame** — one iteration of the SCUMM main loop: run scripts,
  walk actors, advance costume animation, render. A frame fires only
  **once every `VAR_TIMER_NEXT` jiffies**. MI1's intro runs
  `VAR_TIMER_NEXT = 6` → **~10 fps**.

So a script's `breakHere` yields until the **next frame** (not the next
jiffy), an actor moves its walk-speed **per frame**, and a costume
animation advances one cmd-stream byte **per frame** — all at ~10 fps —
while a `delay 120` waits a wall-accurate 120 jiffies = 2 s.

## Why it matters (the bug this fixed)

The engine originally ran the whole main loop — scripts, walking, anim —
**every jiffy** (60 Hz). Delay-gated cutscene timing stayed correct
(delays count jiffies), so total cutscene wall-time matched ScummVM. But
everything that *moves* ran **~6× too fast**: the Mêlée clouds zoomed
off-screen, the LucasArts sparkles and lookout fire flickered too fast,
and Guybrush walked across a room in a fraction of a second. The user's
exact report: *"the cutscene takes about the same time, but things move
too fast."* That asymmetry — wall-time right, motion fast — is the
signature of running frame work on the jiffy clock.

## The model in this engine

A single **per-jiffy** tick is the canonical driver — the shell loop and
the headless harnesses all advance time through it, so the model lives in
one place:

```
tick():                       // one jiffy (1/60 s)
  beginTick()                 // input/cursor mirror, VAR_MUSIC_TIMER++,
                              //   talk timer, camera follow — every jiffy
  for each slot: delayRemaining--   // delay countdown — every jiffy
  frameAccumulator++
  if frameAccumulator < VAR_TIMER_NEXT: return   // not a frame yet
  frameAccumulator = 0
  // ── one game frame ──
  processSentence()
  resume yielded, non-frozen, delay==0 slots
  runScriptsUntilAllYield()   // scripts
  stepAllActorWalks()         // walking
  stepAnim() for each actor   // costume animation
```

- Frozen slots (cutscene / `freezeScripts`) are never resumed and their
  `delay` countdown is paused — matching the original.
- The frame interval is read from `VAR_TIMER_NEXT`, clamped to `[1, 60]`,
  with a fallback of 6 jiffies when it's unset or nonsensical.
- The shell loop ticks at 60 Hz (jiffies); idle / all-dead detection only
  evaluates on **framed** jiffies, so a stable wait-loop isn't counted 6×
  per frame.
- `delay N` decrements per jiffy, so it stays wall-accurate.
- Walk speed (`8 px` x / `2 px` y per **frame**) × ~10 fps ≈ 80 px/s —
  a 320-px room in ~4 s, the right feel. At 60 Hz it was ~480 px/s.

## Likely also fixed by this

The "Le tre prove" interstitial that played in **under a second** (it
should hold for several) was almost certainly a breakHere-loop-gated
cutscene running 6× too fast — the same root cause. Verify visually.

## Pitfalls

- Don't move the per-jiffy timers (music / talk) onto the frame clock —
  they're jiffy-accurate and scripts poll `VAR_MUSIC_TIMER` to pace
  cutscenes against real time.
- A headless harness that wants the poller / scripts to run must tick
  **enough jiffies to cross a frame boundary** (≥ `VAR_TIMER_NEXT`);
  ticking 3 jiffies may run zero frames.
- `VAR_TIMER_NEXT` is a *variable* scripts can change mid-game (MI1 also
  uses 5 briefly); read it live each tick, don't cache.
