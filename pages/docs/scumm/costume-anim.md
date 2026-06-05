# SCUMM v5 — Costume Animation

How a costume's still frames (documented in [`cost.md`](cost.md)) are sequenced
into motion: the on-disk **animation records**, the per-limb **command stream**,
the `animateActor` **chore** model, and the **mirror** convention. This is the
playback side of the format; the static frame layout and RLE pixel decoding are
in `cost.md`.

## Sources

- *"Costume spec"* (anonymous compilation, archived at
  <https://web.archive.org/web/20070803050102/http://scumm.mixnmojo.com/?page=specs&file=costumespec.txt>)
  — the on-disk anim record as a mask + per-set-bit modifier, and the command
  byte values `0x71-0x7C`.
- ScummVM Technical Reference — Costume resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Costume_resources>
  — reverse-indexed limbs and the chore/anim id ranges.

Where the public specs disagree with what real MI1 data decodes to, the data is
the source of truth and the correction is noted here.

## The −6 offset base

Every offset stored inside a `COST` block — `animOffsets[id]`, the anim-command
stream offset, and the per-limb image-table offsets — is measured from an origin
**6 bytes before** the start of the parsed payload (the original engine's costume
base sits 6 bytes ahead of where a v5 block parser lands, because the original
layout places `numAnim`/`format` six bytes into the costume base). So a stored
offset value `v` is read at **`payload[v − 6]`**.

This is the same `−6` that surfaces in `cost.md §4` as "the image-table pointer
lands 6 bytes into the picture header": both are the one base correction. Frame
pointers carry it through the picture-header read; the offset *tables* carry it
through this adjustment.

## Animation records

An animation record lives at `animOffsets[id]` (with the −6 base) and is
variable-length:

```
u16 LE  mask              — which limbs this anim drives; MSB-first, limb i = bit (15 − i)
per set bit (high → low):
  u16 LE  frameIndex      — start index into the anim-command stream
  if frameIndex != 0xFFFF:
    u8  lengthAndFlags    — bits 0..6 = (length − 1); bit 7 = no-loop
  (frameIndex == 0xFFFF is the disabled-limb marker — no length byte follows)
```

The record's length is implied by the popcount of the mask, *not* by the next
entry in `animOffsets` — records can sit closer together than their own length,
and an all-zero mask is a 2-byte "anim not defined" record. An `animOffsets`
entry of `0` (or `0xFFFF`) likewise means "not defined."

**Limbs the mask does not name are left untouched.** Starting a new anim only
rewrites the limbs named by its mask; the others keep whatever they were doing.
This is what lets a talk animation drive the head while the body holds the pose a
walk left it in.

## The anim-command stream

A limb's modifier doesn't point at pictures directly — it names a window into a
flat **anim-command stream** (at the costume's command-stream offset, −6 base). A
limb plays `commands[start .. start + length)`, advancing one byte per engine
tick, looping back to `start` after `length` bytes — unless the no-loop flag is
set, in which case it sticks on the last byte.

Most bytes in the stream are **picture indices** into the limb's image table.
The values **`0x71-0x7C` are commands, not pictures**:

- `0x79` — **stop** the limb: set a persistent per-limb "stopped" bit.
- `0x7A` — **un-stop** the limb: clear that bit.
- the rest of the range carries side effects that don't change which picture
  draws (sound cues, hide / no-draw, and the animation counters noted in
  [`cost.md §3.4`](cost.md)); the public specs disagree on a few of the exact
  assignments. For frame selection they are all simply non-pictures, passed
  over when picking what to draw.

A **stopped** limb does not draw, and the stopped bit **persists across anim
changes**. This is the mechanism behind the player character's walk: the walk
record stops the separate head limb (the walking body sprite already includes a
head), and a later stand or talk un-stops it.

## The `animateActor` operand — chores

`animateActor`'s operand is a **chore number**, not a raw record index. A chore
plays for the actor's current facing, resolving to record **`chore × 4 + dir`**,
where `dir` is the costume's directional index `W=0, E=1, S=2, N=3`. The
conventional chore assignments:

```
chore 1 = init        → records  4–7
chore 2 = walk        → records  8–11
chore 3 = stand       → records 12–15
chore 4 = talk start  → records 16–19
chore 5 = talk stop   → records 20–23
chore 6+              → the costume's custom chores
```

Operand values **244–255 are pseudo-anims** carrying no frame data — only a
direction in the low two bits (`dir = operand & 3`):

```
244–247  turn to direction   (the facing snaps; no turn animation)
248–251  set direction now
252–255  stop walking, then stand facing that direction
```

A facing-changing pseudo-anim (244–251) **re-points the chore that is already
playing** to the new direction — the engine re-decodes the running animation for
the new facing rather than switching chores. (For example, setting a direction on
an actor whose init chore is a looping idle keeps that idle running, now facing
the new way.)

## Limb composition and facing at rest

For a typical player/NPC costume the limbs divide labour like this:

- **Limb 0 is the whole character** — head, body, and legs in one sprite.
- **Limb 1 is a separate head**, overlaid for talk / head articulation.

The records share that division: **init** sets the head limb's per-direction
frame, **talk** animates the head, while **walk** and **stand** only *stop* /
*un-stop* the head — they never re-frame it. So a limb's directional head frame
is established only by `init` (or talk). The consequence for a faithful renderer:
when an idle actor changes facing, the **init** chore for the new facing must be
re-applied to re-point the head, otherwise it keeps the head frame from whatever
direction `init` last ran in (a West-facing character drawn with a front-facing
"looking at the camera" head is the tell).

## Mirroring

A costume stores art for only one horizontal side; the opposite side is drawn by
reflecting it. West-facing and East-facing records play the **identical** picture
sequence, and the engine flips one of them horizontally about the actor's anchor
X. Whether West or East is the flipped one depends on the costume's native
orientation, given by the **mirror flag** (format byte bit 7):

```
mirror = is-horizontal-facing  AND  (facing-is-West  XOR  mirrorFlag)
```

A clear mirror flag — every MI1 costume — means the art natively faces right, so
the **West** facing is the one flipped. Only the horizontal facings mirror; North
and South are genuine front/back views with their own art.
