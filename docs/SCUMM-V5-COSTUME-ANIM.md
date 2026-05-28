# SCUMM v5 — Costume animation records

> Phase 6 ships a decoder based on the SCUMM v5 wiki's documented
> layout. It works for simple costumes (synthetic test fixtures pass)
> but does NOT match MI1 Guybrush (costume id 1) — that costume's
> records produce out-of-range `start` offsets under the wiki spec.
> The decoder is defensive: bad records mark the limb inactive
> (static "init pose" frame) rather than crash.

## Wiki-specified format

From the SCUMM v5 wiki (Costume formats, section 1):

```
anim
  limb_mask : 16le
  anim_definitions : variable length, one per set bit in mask
    0xFFFF       : 16le (disabled limb — no length byte follows)
   OR
    start        : 16le  (offset into anim cmds array)
    noloop       : 1     (high bit of length byte)
    end_offset   : 7     (low 7 bits, length = end_offset + 1)
```

Plus an important detail on limb numbering:

> "When one numbers the limbs from their corresponding bit in the
> limb masks, they are then indexed in reverse order. This means the
> first entry in the limb table is limb 15, then comes limb 14, etc."

So bit `b` of the mask corresponds to limb `15 - b`, and we iterate
bits MSB→LSB to read per-limb bytes in encoded order.

## Anim cmd array

`header.animCmdOffset` points at a flat byte array. At each engine
tick, an active limb's cursor walks `anim_cmds[start..start+length]`.
Each byte is either:

- A **picture index** when `< 0x70` — the limb's image table at
  `limbOffsets[limb] + cmd × 2` gives the frame pointer to render.
- A **command** `0x71-0x78` (add sound), `0x79` (stop), `0x7A`
  (start), `0x7B` (hide), `0x7C` (skip frame).

The Phase 6 implementation reads the cmd byte and feeds it straight
into the limb-table lookup as if it's always a picture index. Command
bytes typically land out-of-range in the limb's table, which our
"frame ptr can't fit a 12-byte header" sentinel filters out cleanly.

## What landed

**`src/engine/graphics/costume-anim.ts`**:

- `AnimState`: `{ animId, limbs[16] }` with each `LimbPlayback` =
  `{ active, start, length, noLoop, cursor, finished }`.
- `createAnimState(header)`: all 16 limbs inactive.
- `startAnim(state, animId, header, payload)`: reads the anim record
  at `header.animOffsets[animId]`, populates per-limb slots from the
  mask + (start, length) pairs. Out-of-range `animOffsets` → all
  limbs inactive. Out-of-range `start` (record format mismatch) →
  that limb inactive.
- `stepAnim(state)`: per-tick cursor advance, with loop-on-end for
  default anims and stick-on-last for no-loop anims.
- `currentLimbFrame(state, limbIdx)`: returns the limb's cursor for
  active limbs (0 for inactive). Used by simpler callers.
- `currentAnimCmd(state, limbIdx, payload)`: returns the byte at
  `payload[limb.start + cursor]`. Used by the compositor.

**Compositor**: replaced the previous "every limb shows frame 0"
stub. Now calls `currentAnimCmd` to get the active picture index.

**Opcode wiring**: `animateActor` (0x11 / 0x91) calls `startAnim`
when the actor has a loaded costume, otherwise stashes the anim id
on the actor for later binding.

## Known limitations

- **MI1 Guybrush (costume id 1)** — anim records produce `start`
  values of `0xff0e`, `0x4800`, etc., which are way past the 10909-
  byte payload. The wiki's exact format doesn't match this costume's
  data; an unknown bit in `format` (= `0x58` here) likely changes the
  record layout. Defensive fallback: that limb stays inactive (static
  init pose), so the actor still renders, just not animated.
- **Anim cmds are read as pure picture indices** — sound / skip /
  hide commands aren't dispatched. The compositor's frame-ptr
  sentinel filter (any ptr that can't fit a 12-byte header) makes
  command bytes (≥ 0x71) silently skip, which happens to do the
  right thing for command bytes since they'd never be valid frame
  table indices anyway.

## How to validate the next attempt

A scratch script (`scratch/probe-anim-layouts.ts`) enumerates seven
candidate record layouts against any MI1 costume — none of them
matched Guybrush's records consistently. The next iteration should:

1. Find a costume whose `format` byte differs from 0x58 and try the
   decoder against it (e.g. MI1 LFLF#0 costume vs Guybrush).
2. Pick an anim id that the boot scripts actually trigger (e.g. anim
   1 = the "init" frame the boot's `animateActor` sets), record what
   the engine *would* play, compare against MI1 running in another
   v5 interpreter.
3. Once one costume decodes correctly, generalise — likely the fix
   is a format-bit check that swaps record layouts.

The defensive `start >= payload.length` check makes it safe to flip
hypotheses in `startAnim` without risking crashes elsewhere in the
engine.
