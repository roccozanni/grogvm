# SCUMM v5 — Boot and System Variables

When a SCUMM v5 game starts, the engine seeds a set of *system
variables* the scripts expect to find already populated, then runs the
**boot script** (global script `#1`). The boot script sets up the rest
of the game state and starts the title/intro sequence. This document
covers what the engine must seed before `#1` runs, and the one
non-obvious mechanic by which MI1's intro flows from the title into
the first playable room.

---

## 1. Engine-seeded variables

A handful of variables are the *engine's* responsibility to set before
any script runs (the scripts read, never initialise, them):

- **Screen dimensions** — the visible resolution (320×200 for v5).
- **Game id** — which game this is, so shared scripts can branch.
- **`VAR_CURRENT_LIGHTS`** — seeded to the lit default so rooms aren't
  all dark; see [lighting.md](lighting.md).
- **`VAR_CURSORSTATE` / `VAR_USERPUT`** — start dead/disabled; the boot
  and room scripts turn them on via `cursorCommand`.
- **`VAR_VIDEOMODE` (variable 49) = 19** — the BIOS video mode (0x13 =
  VGA 320×200×256). MI1's entry-hook script `#6` (run on every room
  load via `VAR_ENTRY_SCRIPT`) branches on `g49 == 19`: VGA re-applies
  the UI palette the boot script stashed in `g377–g388` (the verb-panel
  purples — slots 1/2/3/6); any other value falls into an EGA-era
  fallback that sets slots 1/2 to black and slot 3 to `(255,0,255)` —
  the verb panel loses its purple box grid and the verb ink turns
  hot magenta.

Two variable-number assignments in the same space are easy to get
wrong:

- Variables **15/16** are **`VAR_ACTOR_RANGE_MIN` / `VAR_ACTOR_RANGE_MAX`**
  — system slots, never scratch space.
- **`VAR_WALKTO_OBJ` is variable 113 in MI1**, not the 38 that generic
  v5 tables circulate. Room 58's forest-maze scripts pin it down: they
  gate on `g113 == 687/688`, the objects the ego is walking to.

### MI1 copy protection (the "track-b-size" variable)

MI1's reset also writes one game-specific magic value: variable **74 =
1225** — the "track-b-size", the length in sectors of audio track 2 on
the original CD-ROM (≈1225 sectors). The copy-protection script
(global `#176`) reads it and quits unless it falls in **[1200, 1250]**.
The original engine seeds `1225` unconditionally for MONKEY; an engine
with no physical CD does the same and the check passes.

## 2. The boot script

Global script `#1` runs after the seed. Its first local (`L0`) is a
**boot parameter** that selects the path:

- `L0 == 0` — the normal cold boot: the credits (room 10), then the
  attract/title idle — ego parked in room 0 with script `#23` spinning.
  The title menu itself is gated on the music timer: it appears once
  `g14 > 5700`, i.e. after the theme has played far enough in.
- `L0 != 0` (1 or 2) — start a new game directly at the lookout
  (room 38).

On a cold boot, then, the move from credits to the lookout is driven by
the **title-idle state** — the player starting a game from the title —
not by the parameter.

## 3. Title → first room: following an actor loads it

The transition into the first playable room (the lookout, room 38) uses
a SCUMM mechanic that is easy to miss: **making the camera follow an
actor who is in a different room loads that room.**

When a new game starts, MI1's boot does, in effect:

```
putActorInRoom(ego, 38)      // place Guybrush in the lookout room…
actorFollowCamera(ego)       // …and follow him — which loads room 38
```

`actorFollowCamera` doesn't just move the viewport; if the followed
actor is in a room other than the current one, the engine performs a
full room change (the same path as an explicit room load) to get to
them. This is the entire mechanism behind "the title ends and we're
suddenly in the game" — there is no explicit `loadRoom` for the first
scene.

Two related facts an engine must get right for this to work:

- **`putActorInRoom` keeps the actor's room** — placing an actor sets
  its position but its room is whatever you pass, not silently the
  current room. (Mixing this up makes "follow ego into room 38" a no-op
  because ego is still recorded as being in room 0, where the title
  idle parked it.)
- **`actorFollowCamera` triggers the room load** when the target actor
  is elsewhere.

## 4. A note on opcode families

The boot and intro paths exercise many of the **non-orthogonal opcode
families** described in
[opcodes.md](opcodes.md) — opcode bytes that share
their low five bits but mean different things depending on a high bit
(for example `0x0D` walkActorToActor vs `0x2D` putActorInRoom). Decoding
the boot script is the quickest way to get these wrong, so it is worth
cross-checking each against the per-opcode reference rather than
registering all eight high-bit variants of a family at once.
