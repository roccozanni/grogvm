# SCUMM v5 — Boot and System Variables

When a SCUMM v5 game starts, the engine seeds a set of *system
variables* the scripts expect to find already populated, then runs the
**boot script** (global script `#1`). The boot script sets up the rest
of the game state and starts the title/intro sequence. This document
covers what the engine must seed before `#1` runs, and the one
non-obvious mechanic by which MI1's intro flows from the credits into
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

### MI1 copy protection (the "track-b-size" variable)

MI1's reset also writes one game-specific magic value: variable **74 =
1225**. This is the size, in sectors, of audio track 2 on the original
CD-ROM. The copy-protection script reads it and quits if it is outside
the expected range (roughly 1200–1250). With no physical CD, an engine
seeds the known-good `1225` so the check passes.

## 2. The boot script

Global script `#1` runs after the seed. Its first local is a **boot
parameter** that selects how far in to start:

- `0` — play the credits / attract sequence (the normal cold boot).
- non-zero — skip the credits and jump nearer a new game (a debug
  shortcut).

A cold boot therefore plays the full credits, then transitions into the
opening scene as described next.

## 3. Credits → first room: following an actor loads it

The transition from the credits room into the first playable room uses a
SCUMM mechanic that is easy to miss: **making the camera follow an actor
who is in a different room loads that room.**

After the credits, MI1's boot does, in effect:

```
putActorInRoom(ego, 38)      // place Guybrush in the lookout room…
actorFollowCamera(ego)       // …and follow him — which loads room 38
```

`actorFollowCamera` doesn't just move the viewport; if the followed
actor is in a room other than the current one, the engine performs a
full room change (the same path as an explicit room load) to get to
them. This is the entire mechanism behind "the credits end and we're
suddenly in the game" — there is no explicit `loadRoom` for the first
scene.

Two related facts an engine must get right for this to work:

- **`putActorInRoom` keeps the actor's room** — placing an actor sets
  its position but its room is whatever you pass, not silently the
  current room. (Mixing this up makes "follow ego into room 38" a no-op
  because ego is still recorded as being in the credits room.)
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
