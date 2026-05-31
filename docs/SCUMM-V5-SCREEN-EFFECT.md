# SCUMM v5 — screen effects (`roomOps screenEffect`, 0x33 sub-op 0x0A)

How room-transition fades are requested, what MI1 actually uses, and
why the *animation* is deferred while the *state* is modelled.

## Sources

- The MI1 bytecode itself (`scratch/dis.ts SCAN grep="fade effect"`).
- The documented v5 opcode shape (`SO_ROOM_FADE`): a single var-or-word
  operand, split into two effect numbers.
- The exact effect-number → animation mapping lives only in ScummVM's
  `gfx.cpp` (`fadeIn`/`fadeOut`/`transitionEffect`/`dissolveEffect`/
  `scrollEffect`). Per project policy we do **not** transcribe engine
  `.cpp`; prose sources (wiki, blogs) do not document the mapping. So
  the animation is deferred until we can validate it (see §4).

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

This is all derivable from the opcode shape, so we model it on
`vm.screenEffect = { switchRoomEffect, switchRoomEffect2, requestFadeIn }`
(`src/engine/vm/opcodes/index.ts`, `roomOpsHandler` case 0x0a). It's
surfaced in the inspector Input panel when non-default.

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

## 4. Why the animation is deferred (not the state)

The **intro-reachable path** — Mêlée title (room 10) → "Le Tre Prove"
(room 96) → first room (33) — uses only effect **129** and a bare
`loadRoomWithEgo` (room 96 `L200` has no fade at all). So on everything
we can actually run and watch today, transitions are **instant cuts**.

That means:

1. There is **no non-instant transition to validate against** yet — the
   same situation as `panCameraTo` (see PROGRESS). Implementing a
   dissolve/scroll animation now would be drawing pixels we can't
   confirm against the original.
2. The effect-number → animation mapping (which of 1 / 128 / 129 is
   instant vs. dissolve vs. scroll, and the exact pattern) is only in
   `gfx.cpp`, which we don't copy.

So we **record** the effect numbers faithfully (correct regardless of
the animation, removes the stub, gives the inspector something to show)
and **defer the animation** until either:

- a scene that uses a non-instant effect (1 or 128) becomes reachable,
  giving a visual target to validate the wipe against; or
- the `gfx.cpp` `fadeIn`/`fadeOut` effect table is available "for
  understanding only" to pin the mapping.

Until then, instant cuts are already what the engine does, so the
intro looks correct.
