# SCUMM v5 — Costume animation records

## On-disk format (verified against the SCUMM v5 wiki + ScummVM reference)

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

So `animateActor(actor=1, anim=250)` from MI1's boot is a **direction
change**, not a frame-cycle animation. The actor's state correctly
shows `animId=250` with no active limbs — there's nothing for the
compositor to advance.

## What's in this codebase

**`src/engine/graphics/costume-anim.ts`**:

- `AnimState`: `{ animId, limbs[16] }` — each `LimbPlayback` is
  `{ active, start, length, noLoop, cursor, finished }`.
- `createAnimState`: every limb inactive.
- `startAnim(state, animId, header, payload)`: decodes the anim
  record at `animOffsets[animId]`. Pseudo-anim ids (244-255 range,
  any id where the record decodes to zero modifiers) leave all limbs
  inactive — the animId is recorded but no per-frame state changes.
  Defensive fallback for malformed records: bad frame indices are
  treated as inactive limbs.
- `stepAnim`: advances every active limb's cursor each tick. Loops
  on default anims, sticks-on-last for no-loop anims.
- `currentAnimCmd(state, limbIdx, payload)`: reads
  `payload[limb.start + cursor]` — the picture index the compositor
  needs.

**Compositor**: calls `currentAnimCmd` to get the active picture
index for each limb. Frame-pointer sentinel filter (`framePtr < 6` or
`framePtr + 6 > payload.length`) silently drops out-of-range
lookups, including cmd bytes that are actually commands (0x71-0x7C
range — sound / stop / start / hide / skip — which our compositor
doesn't dispatch yet).

**`animateActor` opcode** (0x11 / 0x91): wires through to `startAnim`
when the costume is loaded, else stashes the anim id for binding
after `setActorCostume`.

**Inspector**: per-engine-tick `stepAnim` call. Actor table shows
`animId (N L)` with active-limb count; expandable details panel
shows each active limb's `start / cursor / length / noLoop / state`
so anim playback is visible.

## Known limitations (revisit when better visual reference is available)

- **High-bit flag convention on `frameIndex` not fully decoded.**
  Some `frameIndex` values come out larger than the cmd array's
  byte length (e.g. 0x0180, 0x0280, 0xff*). These probably encode
  shared-cmd-pool or per-slot-image-table addressing that the wiki
  prose doesn't cover. Defensive fallback keeps the limb inactive
  rather than crash, so the actor renders correctly in its init
  pose.
- **Command-byte dispatch** (`0x71-0x7C`) — the compositor reads
  these as picture indices, which land outside the limb's frame
  table and get silently skipped by the existing sentinel guard.
  Correct enough for static rendering; a future iteration could
  short-circuit these and update slot state (pause / resume / hide).
- **Validation requires a v5 reference renderer**. The decoder is
  implemented from the format spec; without a running v5 game (in
  ScummVM, for instance) to side-by-side compare, we don't have a
  ground truth for "does the actor look right at frame N." Phase 7
  + click-to-walk will trigger real walk anims, which will surface
  any remaining decode issues empirically.

## Validation path when revisiting

1. Run MI1 in a v5 reference engine (ScummVM). Record the cmd-byte
   sequence for Guybrush's walk anim under each direction. This
   gives ground truth for `(frameIndex, cursor, picture_idx)`
   triples.
2. Compare to webscumm's `startAnim` + `stepAnim` output for the
   same anim id.
3. Where they diverge, identify the high-bit flag or special-case
   the decoder needs.
