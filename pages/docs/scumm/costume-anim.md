# SCUMM v5 — Costume Animation

How a costume's still frames (documented in [`cost.md`](cost.md)) are sequenced
into motion: the on-disk **animation records**, the per-limb **command stream**,
the `animateActor` **chore** model, and the **mirror** convention. This is the
playback side of the format; the static frame layout and RLE pixel decoding are
in `cost.md`.

## At a glance

```
  animateActor actor, chore
        │
        │   record = chore × 4 + dir      (W=0  E=1  S=2  N=3)
        ▼
  animation record:  mask of limbs  +  per-limb (start, length, loop)
        │
        │   each named limb gets a window; unnamed limbs keep doing
        │   what they were doing (talk drives the head, walk the body)
        ▼
  anim-command stream:  [ 12  13  14  0x79  … ]   one byte per tick
        │
        │   0x71–0x7C are commands (stop / un-stop / cues),
        │   everything else is a picture index
        ▼
  limb's image table  →  picture  →  pixels  (cost.md)
```

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

---

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

### `actorOps` init (SO_DEFAULT) preserves facing

SCUMM's `o5_actorOps` SO_DEFAULT (subop `0x08`) calls `initActor(0)`, which
clears the per-actor flags (costume, `forceClip`, `ignoreBoxes`, scale, walk box
— see [ZPLANE §7](zplane.md)) but **does not touch `_facing`**. Only the full
game-start `initActor(1)` (and mode 2) reset facing. This matters because a
script can set a direction (`animateActor` set-dir) *before* re-initialising and
re-costuming an actor and rely on that facing surviving the init. Room 60's
teaching machine is the case: `animateActor 3 249` (set-dir → East) runs *before*
`actorOps 3 [init; setCostume(107)]`, and setCostume's init chore then renders
for the still-East facing. Resetting facing to South on init would drop it onto
cost107's stub S-records (only the cart/wheel limb) — the contraption collapses
to its wheel. The give-away that this is faithful: the pre-init set-direction is
meaningless unless init preserves facing.

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

### Limbs assemble via the running `_xmove` / `_ymove`

Drawing a multi-limb sprite is not "place each limb at `actor + picture.x/y`
independently." The engine keeps a running `_xmove`/`_ymove`, **reset to 0 at the
start of each actor's per-tick draw**, and draws the limbs in **index order**;
each drawn limb is placed at `actor + (_xmove + picture.x, _ymove + picture.y)`,
then that limb's picture `xinc`/`yinc` are **folded into `_xmove`/`_ymove`** so
they shift every *subsequent* limb (see [`cost.md §4.1`](cost.md), which also
flags that only the `xinc` side is verified — every MI1 in-play costume is
`yinc = 0`). Limbs that don't draw (unused / inactive / stopped) never read a
picture, so they don't accumulate. This is what assembles a multi-limb
costume — e.g. cost44's fencing torso (limb 2) rides the legs limb's (limb 1)
`xinc`, and the cost107 machine stacks across its cart/spring/dummy limbs.
Ignore it and the parts drift apart (the torso renders ~8–17px off the legs).
Most MI1 costumes carry `xinc = 0`
(including Guybrush, cost1, on every chore and direction — MI1 moves walkers by
the actor's room x, *not* by costume xinc), so the accumulation is a no-op except
for the few props that use it.

## Mirroring

Most costumes store side-view art for only one horizontal side and draw the
opposite side by reflecting it. The art natively faces **East** (right): the
West facing plays the identical picture sequence flipped horizontally about the
actor's anchor X, and East draws native. East is **never** the flipped side.

```
mirror = (facing is West) AND NOT mirrorFlag
```

The **mirror flag** (format byte bit 7) means **"the West anims must NOT be
mirrored"** — i.e. this costume ships *dedicated per-direction art* for both
sides, so neither facing is reflected. It is **not** a "native orientation"
selector and does not make East flip; setting it simply suppresses the West
reflection. North and South are genuine front/back views with their own art and
never mirror.

**The flag is rare but real — it is NOT always clear in MI1.** Exactly two MI1
costumes set it: **cost107** (Captain Smirk's swordfighting *teaching machine*,
room 60) and **cost47**. cost107 carries distinct full art on both its West
chores (init/stand records 4/12) and its East chores (5/13); the setup script
faces it East — a side with full art — and it must render native (un-flipped) so
it aims at the student, while its West *entry* pose (pushed in from offscreen)
also stays native. Reflecting East here (the `facing-is-West XOR mirrorFlag`
reading this doc carried before) mirrored the whole contraption.
