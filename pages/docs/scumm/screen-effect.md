# SCUMM v5 — screen effects (`roomOps screenEffect`, 0x33 sub-op 0x0A)

How room-transition fades are requested, what MI1 actually uses, and why
only the effect *state* — not the transition animation — is modelled.

## 1. The opcode

`roomOps` (0x33) sub-op **0x0A** is `SO_ROOM_FADE`. It reads **one**
var-or-word operand `a` and splits it:

- `switchRoomEffect  = a & 0xFF`   — the **fade-IN** effect, played when
  the *next* room is revealed.
- `switchRoomEffect2 = a >> 8`     — the **fade-OUT** effect, played when
  *leaving* the current room.

Special case: **`a == 0`** is not "effect 0" — it is the
"**fade the current room in NOW**" trigger. It reveals the current room
with the pending effect and leaves the two effect numbers unchanged.

This is all derivable from the opcode shape, so the engine records the two
effect numbers plus the "fade in now" request as state.

## 2. The MI1 idiom

Every room change is bracketed by two fades:

```
cutScene []
roomOps screenEffect 0x8180   ; in=0x80(128) out=0x81(129)
loadRoom room=86              ; leave → fadeOut(switchRoomEffect2), then load
roomOps screenEffect 0x8181   ; in=0x81(129) out=0x81(129)
...
endCutScene
roomOps screenEffect 0x8181
```

(`global #103`, room 25 — the smallest clean example.)

## 3. The effect vocabulary MI1 uses

Across all global scripts (`SCAN grep="fade effect"`), only three
operand values ever appear:

| operand  | hex     | in (low) | out (high) | count |
|----------|---------|----------|------------|-------|
| 33153    | 0x8181  | 129      | 129        | 27    |
| 33152    | 0x8180  | 128      | 129        |  9    |
|   257    | 0x0101  |   1      |   1        |  2    |

The `0x80`-high-bit values (128/129) dominate; effect **1** (a genuine
transition wipe) appears only twice, in rooms not on the intro path.

## 4. State modelled, animation not

The engine records the requested effect numbers faithfully but renders
every transition as an **instant cut** — because the effect-number →
animation mapping (which of 1 / 128 / 129 is an instant cut vs. a dissolve
vs. a scroll, and the exact pattern) isn't available from any public source.

On the **intro-reachable path** — Mêlée title (room 10) → "Le Tre Prove"
(room 96) → first room (33) — only effect **129** appears, alongside a bare
`loadRoomWithEgo` (room 96's entry has no fade at all). So every transition
that can currently be watched is an instant cut in the original too, and the
instant-cut rendering matches. Validating a real wipe animation would need a
non-instant effect (1 or 128) to reach the screen.
