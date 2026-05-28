# SCUMM v5 — Costume animation records

## Sources

- *"Costume spec"* (mixnmojo) — archived at
  <https://web.archive.org/web/20070803050102/http://scumm.mixnmojo.com/?page=specs&file=costumespec.txt>.
  Describes the on-disk anim record as `u16 mask + per-set-bit
  SlotModifier` and explains the cmd-byte magic values (`0x71-0x7C`).
- ScummVM Technical Reference — Costume resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Costume_resources>.
  Specifies "limbs are reverse-indexed" (mask bit `b` → limb
  `15 - b`) and the special anim id ranges in the table below.

## On-disk format

Each anim record at `costume.payload[header.animOffsets[id]]`:

```
u16 LE  activeSlots        — which of the 16 slots this anim modifies
per set bit (MSB → LSB):
  u16 LE  frameIndex       — start index in the frameOffs (cmd) table
  if frameIndex != 0xFFFF:
    u8  lengthAndFlags     — bit 7 = no-loop, bits 0..6 = (length - 1)
```

Limbs are reverse-indexed: bit `b` of the mask = limb `15 - b`. Records
are variable-length (record length = `2 + Σ(2 or 3)` over set bits).

**Records can overlap**. `animOffsets[i+1]` doesn't necessarily mark the
end of record `i` — the engine reads as many modifier triplets as the
popcount of `activeSlots` says, regardless of where the next anim's
offset points. SCUMM packs data tightly; an "empty" anim (mask=0)
can be just 2 bytes even if the next offset is 6 bytes later (the gap
is unused padding or simply where the next anim's data happens to
begin).

## Anim ids — special ranges per the SCUMM v5 wiki

```
00-03 unknown
04-07 init      (4 directions: W, E, S, N)
08-11 walk
12-15 stand
16-19 talk start
20-23 talk stop
244-247  turn to new direction          ← pseudo-anims, no frame data
248-251  change direction immediately    ← pseudo-anims, no frame data
252-255  stop walking                    ← pseudo-anims, no frame data
```

So `animateActor(actor=1, anim=250)` is a **direction change**, not
a frame-cycle animation. An actor whose `animId` is 250 will
correctly show "no active limbs" — there's nothing for the
compositor to advance.

## Reference implementation

[`src/engine/graphics/costume-anim.ts`](../src/engine/graphics/costume-anim.ts)
exposes the runtime types and the three entry points consumers
need:

- `AnimState` — `{ animId, limbs[16] }`, where each `LimbPlayback`
  carries `{ active, start, length, noLoop, cursor, finished }`.
- `createAnimState(header)` — initial state with every limb
  inactive.
- `startAnim(state, animId, header, payload)` — decodes the anim
  record at `animOffsets[animId]`. Pseudo-anim ids (any id whose
  record decodes to zero modifiers, including 244..255) record the
  `animId` but leave limbs inactive. Bad frame indices fall through
  to a defensive "inactive limb" rather than throwing.
- `stepAnim(state)` — advances every active limb's cursor each
  tick. Loops on default anims; sticks on the final cursor for
  no-loop anims and flips `finished` true.
- `currentAnimCmd(state, limbIdx, payload)` — reads
  `payload[limb.start + cursor]`, the picture index for the
  compositor.

The compositor (`src/engine/render/compositor.ts`) calls
`currentAnimCmd` per limb. A frame-pointer sentinel filter
(`framePtr < 6` or `framePtr + 6 > payload.length`) silently drops
out-of-range lookups, including cmd bytes in the `0x71-0x7C`
command range — those would otherwise be interpreted as picture
indices well outside the limb's frame table.

The `animateActor` opcode (`0x11` / `0x91`) routes through to
`startAnim` when the actor's costume is loaded; otherwise it
stashes the anim id so it can bind on the next `setActorCostume`.

## Known limitations

- **High-bit flag convention on `frameIndex` not fully decoded.**
  Some `frameIndex` values come out larger than the cmd array's
  byte length (e.g. `0x0180`, `0x0280`, `0xff*`). These probably
  encode shared-cmd-pool or per-slot-image-table addressing that
  the documented format doesn't cover. The defensive fallback keeps
  the limb inactive rather than rendering garbage, so the actor
  stays in its init pose.
- **Command-byte dispatch** (`0x71-0x7C`) — the implementation
  treats these as picture indices, which land outside the limb's
  frame table and get silently skipped by the sentinel guard.
  Correct enough for static rendering; a complete implementation
  should short-circuit these and update slot state directly
  (pause / resume / hide / skip).
- **Validation requires a reference renderer.** The decoder is
  implemented from the format spec; ground truth for "does this
  actor look right at frame N" requires side-by-side comparison
  against a known-good v5 interpreter (for example ScummVM).

## Validation path

1. Run MI1 in a v5 reference engine and record the cmd-byte
   sequence for a known actor's walk anim under each direction.
   This produces ground truth for `(frameIndex, cursor,
   picture_idx)` triples.
2. Run the same anim id through `startAnim` + `stepAnim` and
   compare the cursor trajectory.
3. Where they diverge, look at the high-bit pattern on the
   diverging frameIndex values — that's where the missing format
   convention lives.
