# SCUMM v5 — Cutscenes, Freezing, and Override

A *cutscene* in SCUMM is a scripted sequence that takes control away
from the player: the cursor and verb bar disappear, background scripts
pause, the sequence plays, and then everything is restored. The engine
provides a small bracket — `cutscene` / `endCutscene` — and two hook
scripts the game supplies; almost all of the "hide the UI, freeze the
world, put it back" behaviour is in those scripts, not the engine.

This document covers the cutscene bracket, the `freezeScripts`
mechanism it leans on, and the *override* path that lets the player skip
a cutscene.

---

## 1. The bracket: `cutscene` / `endCutscene`

- **`cutscene` (`0x40`)** opens a cutscene. It pushes a frame onto the
  engine's *cutscene stack* (remembering enough room/camera/state to
  restore later), clears `VAR_OVERRIDE`, and runs the game's **cutscene
  start script** (`VAR_CUTSCENE_START_SCRIPT`; MI1 = `#18`). The script
  that opened the cutscene keeps running — opening a cutscene does **not**
  itself freeze scripts; the start script does that explicitly.
- **`endCutscene` (`0xC0`)** closes it: it pops the frame, clears
  `VAR_OVERRIDE`, and runs the game's **cutscene end script**
  (`VAR_CUTSCENE_END_SCRIPT`; MI1 = `#19`).

The stack means cutscenes can nest; each `endCutscene` unwinds one
level.

## 2. What the hook scripts do

The start/end scripts are where the user-visible cutscene behaviour
lives. MI1's `#18` (start) does, in order:

- `cursorCommand` **cursor soft off** + **userput soft off** — hide the
  cursor and stop accepting input.
- `saveRestoreVerbs` **save** over the command-verb and inventory
  ranges — this hides the verb bar (the slots are stashed and emptied).
- `freezeScripts` — pause every other script (see §3).

`#19` (end) mirrors it: cursor soft on, userput soft on, `saveRestore
Verbs` **restore** (the bar refills), `freezeScripts 0` (thaw). Because
the cursor/userput moves are the *soft* variants, they nest correctly
with whatever state was active before the cutscene.

So an engine that faithfully runs `#18` / `#19` gets the UI hide/restore
for free; it does not need special cutscene handling beyond the bracket
and the `freezeScripts` / `saveRestoreVerbs` opcodes.

**Run the hooks *nested*, in order.** `#18` and `#19` must execute to
completion synchronously at the point they're invoked (run nested,
see OPCODES §6) — *not* queued as new slots. A door-open handler runs
`cutscene … endCutscene` in one pass; if the start hook is deferred, its
`freezeScripts 127` lands *after* `#19` is created and freezes it, so
`#19` never runs its `freezeScripts 0` / `userput on` and input stays
dead.

## 3. `freezeScripts`

**`freezeScripts` (`0x60`)** pauses script execution. It takes a flag:

- `0` — thaw everything.
- non-zero — freeze. A flag `>= 0x80` also freezes
  "freeze-resistant" scripts (those started with the freeze-resistant
  bit); a smaller non-zero flag spares them.

Freezing is **cumulative** — each freeze deepens a per-script freeze
count, and a script only runs again when its count returns to zero.
Two scripts are spared:

- the script that issued the freeze (so it can keep running), and
- the script that opened the current cutscene (so the cutscene can play
  out even though `#18` froze "everything").

This last rule is why a cutscene's driving script survives its own start
script's `freezeScripts`.

## 4. Override: skipping a cutscene

A cutscene can mark itself skippable with **`beginOverride`** (a
sub-op of `0x58`). The original encodes it as the override opcode
followed immediately by an embedded jump instruction: the engine records
the jump target as the cutscene's **skip point** and clears
`VAR_OVERRIDE` to 0. The jump bytes are consumed by `beginOverride`
itself — they are *not* executed inline (doing so would skip the
cutscene body unconditionally).

When the player presses the cutscene-exit key (Escape), the engine runs
**`abortCutscene`**: if an override is armed, it jumps the arming script
straight to its recorded skip point, thaws it, and sets `VAR_OVERRIDE = 1`
so the skip code can tell it was aborted. The skip code typically
fast-forwards to the cutscene's end state and calls `endCutscene` itself.

If no `beginOverride` is armed, Escape does nothing — the cutscene is
simply not skippable. (Many gameplay cutscenes arm an override; some short
scripted beats deliberately do not.)

**An override is not tied to an *open* cutscene.** SCUMM keys the override
by cutscene-stack *level*, and the **base level (no open `cutScene`) is
valid**: MI1's "le tre prove" (`g#57`) ends its setup cutscenes, *then*
arms `beginOverride` for the long sound-gated trials intro — so the gate is
escapable with no active cutscene frame. The override lives on the arming
script's slot (`overridePc`), set by `beginOverride` and cleared by
`endOverride` / slot death, so a slot carries it exactly during its
escapable window; `abortCutscene` skips whichever slot holds one (it does
**not** require an open cutscene). Tying the skip to an active cutscene
frame is the bug that made "le tre prove" unskippable once the sound gate
actually held — see [sound.md](sound.md).

## 5. The variables involved

| Variable | Role in cutscenes |
|----------|-------------------|
| `VAR_OVERRIDE` (g5) | `0` while a cutscene runs normally; set to `1` by `abortCutscene` so the skip code knows the player bailed. `beginOverride` resets it to `0`. |
| `VAR_CURSORSTATE` (g52) / `VAR_USERPUT` (g53) | driven down by `#18`'s soft-off, back up by `#19`'s soft-on (see [input.md](input.md) §1). |
| `VAR_CUTSCENE_START_SCRIPT` / `VAR_CUTSCENE_END_SCRIPT` | ids of the hook scripts (`#18` / `#19` in MI1). |
| `VAR_CUTSCENEEXIT_KEY` | the key that triggers `abortCutscene` (Escape). |
