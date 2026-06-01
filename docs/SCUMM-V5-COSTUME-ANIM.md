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

## Anim ids — the `animateActor` operand

The `animateActor` operand is a **chore number**, not a raw anim-record
index. The chore plays for the actor's current facing, resolving to anim
record `chore*4 + dir(facing)`. The wiki documents the standard chore →
record-range assignments:

```
records 04-07  chore 1 = init   (4 directions: W, E, S, N)
records 08-11  chore 2 = walk
records 12-15  chore 3 = stand
records 16-19  chore 4 = talk start
records 20-23  chore 5 = talk stop
```

i.e. `animateActor X 1` = init, `X 2` = walk, `X 3` = stand, and 6+ are
the costume's custom chores.

Values **244-255 are pseudo-anims** — no frame data, just a direction in
the low 2 bits (`dir = anim & 3`):

```
244-247  turn to direction      (snapped; no turn animation modelled)
248-251  set direction now
252-255  stop walking (+ stand)
```

A set/turn-direction pseudo-anim **re-points the chore that's already
playing** to the new facing (SCUMM re-decodes the running animation for the
new direction) — it does NOT switch chores or clear the animation. This is
the load-bearing detail: `animateActor 3 250` (set-dir-S) on the SCUMM-Bar
pirates keeps their **init chore** running while facing south. The init
chore is started when the costume is set (chore 1 is the actor's default
animation); for cost24 that chore is a multi-frame drink loop (record 6),
so the pirates animate even though `250` itself carries no frames. An actor
that only ever gets a direction pseudo-anim therefore still animates — via
its init chore — which an earlier reading (treating 250 as a no-op with "no
active limbs") missed.

> Caveat: `cmd = anim/4` (specials at 8-19) was an earlier, incorrect
> reading. The specials are 244-255; 8-19 are real chores. The handler in
> `vm/opcodes/index.ts` and this table now agree.

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

## Session findings — MI1 costume #111 (the intro sparkle)

Concrete data from `scratch/probe-cutscene-anim.ts` + `scratch/dump-anim111.ts`
against the real game (room 10 intro, the LucasArts-logo sparkle). This
pins down where the decoder diverges from reality.

Costume #111 is **492 bytes**, `numAnim=12`, format `0x58` (16-colour),
`animCmdOffset=0x84`, `limbOffsets=[0x91, 0xa1×15]`,
`animOffsets=[0x52,0x56,0x5a,0x5e,0x62,0x66,0x6a,0x6f,0x73,0x77,0x7b,0x80]`.

What is **correct**:

- **Limb 0's image table (`0x91`) and the frame decoder.** Its first
  five frame pointers `0xcb, 0xee, 0x115, 0x14a, 0x187` decode cleanly
  as 7×7, 9×9, 11×11, 13×13, 19×19 — a sparkle growing frame by frame.
- **The animation cmd data exists and is findable.** Bytes at `0x80`:
  `03 04 05 06 07 06 05 04 03 02` — a grow-then-shrink frame-index
  sequence indexing limb 0's image table. This is the sparkle's
  playback stream (limb `start` offsets appear to be **absolute**
  payload offsets, matching `currentAnimCmd`'s `payload[start+cursor]`).

What is **wrong**:

- **The anim-record decoder is misaligned.** `animOffsets` entries are
  only 4–5 bytes apart, so each record is tiny — yet the documented
  "`u16 mask` + per-set-bit (`u16 start` + `u8 len`)" shape makes a
  one-limb record 5 bytes and we decode `mask=0xffff` as *all 16 limbs
  active*. The real records look like: `ff ff 00 80` (anims 0–4,7,8),
  `00 00 80 00` (anim 5), `01 00 8b 00` (anim 9). `mask=0x0000` (anim 5)
  is the documented empty-anim sentinel; **`mask=0xffff` is evidently a
  second sentinel** (not 16 active limbs). The true per-limb modifier
  encoding inside a 4-byte record is not yet cracked — the `0x8000`
  (bit-15) pattern in `00 80` is the prime suspect for a flag.
- **The compositor draws frame-0 of every limb regardless of
  `active`** (`compositor.ts` ~L222, a Phase 6 "show *something*"
  stopgap). For #111 limbs 1–15 share dummy table `0xa1`, whose first
  entry `0x3a` points back into the `animOffsets` table — read as an
  82×86 "frame" it overruns the 492-byte payload. That is the
  `ran out of RLE bytes … frame at 0x3a` spam. SCUMM only composites
  limbs the current anim activated.

### Implication for a fix

Two coupled defects:

1. **Anim-record format** (`startAnim` in `costume-anim.ts`) — needs the
   real 4-byte-record encoding. Ground truth available: the sparkle
   should resolve to *limb 0, start≈0x80, length≈10*, cycling
   `03 04 05 06 07 06 05 04 03 02`. Validate cursor trajectory against
   ScummVM.
2. **Compositor limb gating** (`compositor.ts`) — should draw a limb
   only when `actor.anim.limbs[i].active`, not frame-0 of all 16. Until
   the record decoder works this would hide actors that currently show
   a (wrong) static frame, so the two fixes are best landed together,
   with an explicit "no active limbs → draw limb 0 frame 0" init-pose
   fallback if we want to keep showing a base sprite.

### Step-2 findings — how the sparkle is triggered, and where the format breaks

Trace of the real intro (`scratch/trace-anim-calls.ts`): room 10 script
**#203** sets up the 9 LucasArts-logo stars as actors 1–9, each:
`actorOps setCostume(111), setPalette` → `animateActor(act, 250)` →
`animateActor(act, 2)`. So **the sparkle is costume 111, anim id 2**
(250 = 0xFA is a direction/stop pseudo-anim per the id table above).

Static analysis of anim 2 hits a wall that confirms the "needs a
reference renderer" caveat:

- anim 2's record (`animOffsets[2]=0x5a`) is **`ff ff 00 80`**.
  `mask=0xffff` cannot be a real 16-limb record: per COST §3.6 that
  would be 16 × 3-byte SlotModifiers = 50 bytes, but the next anim
  begins 4 bytes later. **`mask=0xffff` is therefore a sentinel** whose
  meaning isn't in our notes (distinct from the documented `mask=0`
  empty case, e.g. anim 5 = `00 00 80 00`).
- `frameOffs` (the flat frame-index array at `animCmdOffset=0x84`) is
  `07 06 05 04 03 02 7b …` — indices 7,6,5,4,3,2 then `0x7b`
  ("don't draw" command). But **limb 0's image table has only 5 valid
  frames** (indices 0–4 → 7×7,9×9,11×11,13×13,19×19; entries 5–7 are
  `0x0001`/`0x0045` garbage). So a naive "frameOffs index → image
  table" lookup indexes past the real frames — the index→table mapping
  has a twist (the reserved top bit on frame indices, or a per-anim
  base) we can't pin from one costume's bytes alone.

**Status:** compositor limb gating is fixed and shipped (no more
garbage-limb spam, static sprites render, no regression). Making the
sparkle actually *cycle* is blocked on cracking the `mask=0xffff`
record + the frameOffs→image-table index mapping, which per the
Validation path below should be done by comparing our `(frameIndex,
cursor, picture_idx)` trajectory against ScummVM rendering these exact
stars — not by guessing from static bytes.

### BREAKTHROUGH — frame indices use a −6 image-table base

The sparkle (costume 111) image table for limb 0, indexed from
`limbOffsets[0]=0x91`, gives 5 frames (indices 0..4 = 7,9,11,13,19 px;
verified by ASCII render — they are unmistakable growing star shapes).
But the `frameOffs` cmd stream uses indices **2..7**, which over-run
that 5-entry table.

Resolution: frame indices resolve against an image table based at
**`limbOffsets[limb] − 6`** (raw stored value `0x91`, so base `0x8b`).
Under that base the `frameOffs` cycle `3 4 5 6 7 6 5 4 3 2` renders as
**7×7 → 9×9 → 11×11 → 13×13 → 19×19 → 13 → 11 → 9 → 7 → 5** — a clean
grow-then-shrink twinkle through 6 real frames. This is the same
+6 "pointer lands 6 bytes into the header" convention from
`SCUMM-V5-COST.md §4`, now appearing in frame→table indexing: a frame
index is `n`, and entry `n` lives at `tableBase − 6 + n·2`.

`frameOffs` is at `animCmdOffset=0x84` = `07 06 05 04 03 02 7b …`
(indices 7→2 = shrink 19px→5px, then `0x7b`=no-draw). The grow half
`03 04 05 06 07` sits in the 4 bytes *before* `animCmdOffset`.

**Still open (needs the reference renderer):** how anim 2's record
`ff ff 00 80` decodes to `(limb 0, cmd-stream start, length)`.
`mask=0xffff` still can't be 16 SlotModifiers in 4 bytes; the
`00 80` = `0x8000` looks like a start word whose top bit is a flag
(`start = 0x8000 & 0x7fff = 0` → play from `frameOffs[0]`, the peak,
i.e. pop-at-19px-then-shrink). Whether the star grows-then-shrinks
(start in the grow half) or pops-then-shrinks (start=0) is the
question to settle against ScummVM.

### Validated against ScummVM (user, 2026-05-30)

The LucasArts-logo stars **grow then shrink (a symmetric pulse)** and
twinkle **independently / staggered**. This confirms:

- The visible cycle is the full `03 04 05 06 07 06 05 04 03 02` at
  `0x80` → 7→9→11→13→19→13→11→9→7→5 px, looping. (A start at
  `animCmdOffset=0x84` would give shrink-only `19→5`; ruled out.)
- Per-actor staggering ⇒ each actor runs the same loop at a different
  cursor phase (independent `cursor`, not a different record).

**Remaining blocker (record byte format).** Anim 2's record
`ff ff 00 80` at `animOffsets[2]=0x5a` must decode to
`(limb 0, start→0x80, length 10, loop)`, but no rule tried yields a
start in the grow half: `mask=0xffff` can't be 16 SlotModifiers in
4 bytes, and reading `0x8000`→`start = &0x7fff = 0` gives shrink-only
(contradicting the validated pulse). Next step: **triangulate the
record encoding across 2–3 costumes** (e.g. Guybrush #1, another
simple FX costume) to separate the `−6` convention's generality from
this costume's specifics, and to get more `(record bytes → known
behavior)` pairs. Do NOT apply `−6` to the init-pose (inactive-limb)
path — only to anim-driven frame indices — or Guybrush's static pose
regresses.

### Triangulation across costumes — record STRUCTURE cracked, index mapping still open

Dumping records across several MI1 costumes (`scratch/triangulate-anim.ts`,
`scratch/validate-format.ts`) shows the clean ones (e.g. LFLF#2, a walker)
decode unambiguously as:

```
record = u8 mask + per set bit { u16 LE frameIndex ; u8 len }
```

LFLF#2's directional walk anims are textbook proof:
`anim 7 = 80 04 00 02 00`, `anim 8 = 80 07 00 02 00`,
`anim 9 = 80 0a 00 02 00`, `anim 10 = 80 0d 00 02 00` → one limb,
frameIndex 4,7,10,13 (step 3), len 2 → 3-frame slices
`[4,5,6] [7,8,9] [10,11,12] [13,14,15]` of the `frameOffs` array — the
4 walk directions. So our current `startAnim` is wrong on two counts:
it reads the mask as a 16-bit field (it's effectively a byte;
`mask=0x80` ⇒ limb 0) and mis-sizes the SlotModifier.

**Still open:** the frameIndex→picture resolution. With the `−6` base
that reproduced the #111 sparkle, LFLF#2's walk cmd-bytes (`0x3a..0x3f`)
resolve to 2×2 frames — far too small for a walker — so `−6` is NOT a
universal rule. Either the active limb isn't limb 0 (mask-bit→limb
mapping), or the image-table base differs per costume. Needs another
eyeball-able target to triangulate.

Known-broken targets to triangulate against (all the SAME decoder, none
ever animated correctly): the LucasArts sparkle (costume 111, validated
shape above), the **Mêlée-island clouds** in the intro cutscene
(easy to eyeball), and **Guybrush's walk cycle** (costume 1) — which
has never animated since Phase 6.

### CORRECTION + current best understanding (after deeper triangulation)

The `−6` image-table base claimed above for the sparkle was a
**costume-111-specific artifact** — #111 does not even conform to the
record format (its 4-byte records start `ff ff`, i.e. a `0xff` mask
byte that can't host 8 SlotModifiers). Treat #111 as an oddball; do
NOT generalise its `−6`.

Best current model (from the clean costumes #2 walker + structure):

- **Record:** `u8 mask` (one bit per limb; the active bit for these
  costumes is `0x80`) followed, per set bit, by `{u16 LE frameIndex;
  u8 len}`. A limb plays `frameOffs[frameIndex .. frameIndex+len]`
  (cmd bytes), advancing one per tick, looping.
- **Picture:** each cmd byte indexes the limb's image table at
  `limbOffsets[limb]` (base 0, no −6); `0x71..0x7c` are commands.

Open inconsistencies that block a confident engine change:

1. **Mask width.** #2's records only parse with a *1-byte* mask
   (`0x80`); the wiki documents a *u16* mask. A 1-byte mask addresses
   only 8 limbs, yet Guybrush (#1) has 4 limb groups and 53 anims.
   Need a multi-limb record (Guybrush walk) to settle width + bit order.
2. **Which limb does `0x80` select?** `0x80` = bit 7. Under "MSB=limb0"
   that's limb 0 in a 1-byte mask, but limb 8 in a 16-bit mask. #2's
   limb-0 table gives 2×2 frames (plausibly a genuinely small sprite —
   unconfirmed without eyeballing #2).
3. **Guybrush walk id.** anim 8 (the wiki "walk" slot) is `mask=0`
   (empty) for #1, so his walk lives at another id — needs a trace of
   an actual Guybrush walk to locate.

Intro costumes catalogued: room 10 → 111 (sparkle, oddball), 59
(7.5 KB, limb0 frame won't decode — candidate for the title/clouds
art); room 38 → 1 (Guybrush 32×46), 33 (sentry 32×43), 48 (48×62).
The Mêlée-island cloud room was not reached within 6000 headless ticks
— it likely needs the title/establishing cutscene, which our headless
pacing skips past or hasn't reached.

### Guybrush records — single-limb format CONFIRMED, multi-limb still open

Dumping Guybrush (#1, 53 anims, `scratch/guybrush-records.ts`) confirms
the single-limb record across a second costume and exposes the hard part.

CONFIRMED — single-limb record = `u8 mask + {u16 LE frameIndex, u8 lenFlags}`:
- anims 24-26 `40 02 00 80 00`, 27-30 `40 46 00 81 00`,
  31-34 `40 48 00 81 00`, 35 `40 4a 00 03 00`.
- `mask=0x40` ⇒ bit 6 ⇒ limb 1 (bit7=limb0, bit6=limb1, …).
- `lenFlags`: bit7 = no-loop, low7 = length. (`0x80`→1 frame no-loop;
  `0x03`→4 frames looping.)
- `mask=0xc0` (anim 38) ⇒ limbs 0+1 (2 mods); validated by record length.

STILL OPEN — the complex anims (this is the Guybrush-walk core):
- **Walk anims 4-10** are 8 bytes: `00 00 00 c0 XX 00 YY ZZ`. The
  leading `00 00` + `00 c0` doesn't fit "u8 mask + mods"; looks like a
  redirect-limb or 2-byte-mask form. frameIndex `XX` steps 0,2,3,5,5,c,12
  across the directions — clearly the walk, but the wrapper structure is
  undecoded.
- **`mask=0xff`** (talk anims 16-23, also sparkle #111) is a sentinel,
  NOT limbs 0-7 (record far too short for 8 mods). Meaning unknown.
- **`mask=0x00`** (walk anims) is also clearly not "no limbs."

Bottom line: simple single-limb FX (one moving limb) are now decodable;
multi-limb / walk / talk encodings need the actual v5 algorithm or a
ScummVM cmd-trajectory trace of a Guybrush walk to settle the wrapper.

### SHIPPED — single-limb decoder (2026-05-30)

`startAnim` now decodes the confirmed single-limb record:
`u8 mask` (bit 7 = limb 0 … bit 0 = limb 7) + per set bit
`{u16 LE frameIndex, u8 lenFlags}`; `start = animCmdOffset + frameIndex`
(absolute cmd-stream position), `lenFlags` bit 7 = no-loop. Safety
fallbacks (leave the actor in its static init pose, no crash, no skip
spam):

- `mask == 0x00` or `0xFF` → undecoded (0xFF is the multi-limb/walk/talk
  sentinel form) → inactive.
- `frameIndex == 0xFFFF` → that limb disabled.
- a `start` running past the payload → that limb inactive.

The compositor skips a tick silently when an active limb's cmd byte is
an animation command (`0x71..0x7C`). Verified headlessly: costume 59
(room 10) now drives an active-limb animation; the sparkle (#111,
`mask=0xFF`) and Guybrush (#1, multi-limb) safely stay static — no
regression, no skip spam.

**Still pending (multi-limb wrapper):** Guybrush walk, talk anims, and
the #111 sparkle (its `mask=0xFF` records). Needs the multi-limb /
`00 00 00 c0` wrapper format — best cracked from a ScummVM walk trace.

### CRACKED — the extended (multi-limb / walk) record (2026-05-30)

The multi-limb wrapper that blocked Guybrush's walk is decoded. The
key was dumping **every** Guybrush (#1) anim record and decoding the
frame dimensions each candidate reading would produce
(`scratch/decode-all-anims.ts`, `scratch/verify-guybrush-walk.ts`):
sensible frame sizes (a tall ~20×47 body + an 11×11 head) vs. 2×2 /
decode-fail garbage is an unambiguous oracle, so this is *empirically
validated*, not guessed.

**There are two record layouts**, both carrying the same per-limb
modifier shape (`u8 mask` + per set bit `{u16 LE frameIndex, u8
lenFlags}`):

```
compact:   <u8 mask> <mods…>                    ← byte 0 is the mask
extended:  00 00 00 <u8 mask> <mods…>           ← 3-byte zero prefix
```

The **discriminator is "the first three bytes are all zero"**. That
uniquely marks the extended walk/stand/turn records and excludes the
still-undecoded oddballs.

The earlier "`00 00 00 c0` is an undecoded redirect" note was the
missing piece: it's just a 3-byte `00 00 00` header in front of an
ordinary `c0`-mask record (`c0` = limbs 0+1 = Guybrush's body + head).
The same tail proves it — anim 38 = `c0 4e 00 82 0b` (compact) and
anim 40 = `00 00 00 c0 4e 00 82 0b` (extended) encode the *identical*
modifier; 40 is just 38 with the zero prefix.

**Verified Guybrush walk (anim 7 / 8):**

```
limb 0 (body): frameIndex 5, len 6 → cmd bytes 79 02 03 04 05 06
               → frames  (cmd 0x79 = loop marker, no-draw)
                          22×47 → 21×47 → 20×47 → 19×36 → 17×47 → loop
limb 1 (head): frameIndex 11, len 1 → cmd byte 07 → 11×11 (static)
```

A cycling body stride + a steady head = a walking Guybrush. The stand /
turn anims 40–51 decode the same way (limb 0 a body pose 18×33 … 24×54,
limb 1 the 11×11 head).

**What the prefix bytes *mean* is still not named** (it's plausibly a
redirect/parent-limb word that's zero for these anims), but the
decode is reading the right bytes and producing the right frames. The
implementation (`startAnim`) detects the 3-zero-byte prefix, shifts the
mask position, and is otherwise the existing single-limb path. Records
that don't fit (mask `0x00`/`0xFF`, the `00 00 ff …` talk-pose and
`00 00 08 …` oddballs, out-of-range frames) keep the actor in its
static init pose exactly as before — **no regression**: every record
that animated before still animates, and records that were inactive
either now animate correctly (walk/stand) or stay inactive (oddballs).

**STILL OPEN — the `mask=0xFF` talk records** (anims 16–23, also the
costume-111 sparkle). The record is too short to host 8 modifiers, so
`0xFF` is a sentinel whose meaning we haven't pinned; those stay
static. Best cracked from a ScummVM cmd-trajectory trace of Guybrush
talking.

**NEXT — wire the walk/stand chore trigger (now unblocked).** The
decoder is correct but `stepWalk` doesn't yet *start* the walk anim, so
the fix is only visible to scripts that call `animateActor` directly.
To make Guybrush visibly walk, the actor needs `walkFrame` /
`standFrame` / `initFrame` / `talkFrames` fields (captured from
`actorOps` sub-ops 0x04/0x05/0x06/0x0e, currently consumed-and-ignored)
and the walk loop must call `startAnim(frame*4 + dir)`. **The exact
`frame*4 + dir` mapping needs validation, not a guess** — `oldDir` is
`W=0, E=1, S=2, N=3` per ScummVM's `oldDirToNewDir`, and `walkFrame`
default 1 → records 4–7, but our static decode shows records 4/5/6
resolving to single frames while only 7 cycles, which means either the
side views are mirrored single-frame walks or the per-costume
`walkFrame` differs from the default. Settle against a ScummVM walk
before wiring, or it'll moonwalk.

### REVERTED — the live walk was wrong (playtest, 2026-05-30)

The walk/stand chore trigger (auto-`startAnim` from the walk loop) +
chore-frame capture + a command-byte flicker fix were implemented and
then **reverted** after playtesting showed the actor rendering is wrong
in several independent ways. Screenshots showed: **two heads**, the
**body vanishing** (only a floating head), the body **facing the wrong
way while walking**, and **facing away** (back to camera) when standing.

Rendering the actual limb sprites as ASCII (`scratch/render-walk-limbs.ts`)
explains it and corrects the "CRACKED" section above:

- **Limb 0 is the COMPLETE Guybrush** — head + body + legs in one
  ~22×47 sprite (hair, face, white shirt, black pants, boots all
  present). It is NOT a "body" that pairs with a separate head.
- **Limb 1 is a separate ~11×11 head** positioned at the top
  (`redirY ≈ -46`), for talk / head articulation.
- So the walk record decoding to **two active limbs** (mask `0xc0` →
  limbs 0+1) and drawing both yields **two heads** (limb 0's built-in
  head + limb 1's overlay). The walk is effectively **single-limb**
  (limb 0 = the whole character); the head limb belongs to the talk
  anims, where limb 0 holds a body pose and limb 1 articulates.

So the decoder's *frame sizes* are right but its **limb count /
mask semantics are not** — the `0xc0` → "limbs 0+1" reading is the prime
suspect (the walk should resolve to limb 0 alone). This is exactly the
"needs a reference renderer" caveat: static frame-size plausibility was
NOT enough to validate the limb composition.

**What a correct live walk needs (all blocked on a v5 reference):**

1. **Correct limb composition** — pin the real mask→limb semantics so
   the walk activates limb 0 only (and talk activates body-pose + head).
   `0xc0` decoding to two limbs is almost certainly wrong.
2. **The costume mirror flag** (format bit 7) — NOT implemented
   (`compositor.ts`; Phase 3 known limitation). MI1 stores frames for
   one side and draws the other mirrored; without it half the walk
   directions face backwards ("facing the wrong way while walking").
3. **A validated direction→frame mapping** — standing faced *away*, so
   `record = chore*4 + (W=0,E=1,S=2,N=3)` is not matching the costume's
   actual per-direction frame order. Confirm against ScummVM.

Until those are settled, the engine leaves a walking actor in its
static sprite (the prior known-good state) rather than rendering a
broken multi-limb walk. The decoder (`startAnim`) and its tests remain;
only the auto-trigger was backed out.

### SOLVED — the real v5 algorithm (with a ScummVM reference, 2026-05-30)

The user provided `costumeDecodeData` + `loadCostume` as a reference
(used for understanding only, not copied). Everything above is now
superseded by the correct model — implemented and verified headlessly.

**Base alignment (the root of most of my errors).** From `loadCostume`'s
field layout (`numAnim` at `_baseptr[6]`, `format` at `[7]`, palette at
`[8]`, then the offset tables), our `payload` array begins **6 bytes
past ScummVM's `_baseptr`**. Every stored offset value is `_baseptr`-
relative, so it's read at `payload[value − 6]` — the anim record, the
anim-cmd stream, AND the limb image table. (Frame pointers go through
`decodeCostumeFrame`, whose own −6 is exactly this correction.) Exposed
as `COSTUME_OFFSET_ADJUST = -6`.

**Record format (the earlier 8-bit-mask reading was wrong).**

```
u16 LE mask          — MSB-first; limb i = bit (15-i); loop while bits remain
per set bit:
  u16 LE frameIndex j
  if j != 0xFFFF: u8 extra   — low7 = length-1, bit7 = no-loop
```

`animCmds[j]` (read at the −6 base) decides the limb's fate:
- `0x7A` → **un-stop** the limb (clear a persistent per-limb bit)
- `0x79` → **stop** the limb (set the bit) — neither sets playback
- anything else → play `cmds[j .. j+(extra&0x7f)]`

A **per-limb "stopped" bitmask** lives on the actor's `AnimState` and
**persists across `startAnim`** (`AnimState.stopped`). A stopped limb
does not draw. Limbs not named by the mask are left untouched.

**This explains every bug.** For Guybrush:
- **limb 0 is the whole character** (head+body+legs); **limb 1 is a
  separate head** for articulation.
- **WALK** (chore 2, records 8–11): body (limb 0) cycles, head (limb 1)
  is **stopped** → one Guybrush, no double head.
- **STAND** (chore 3, 12–15): body pose, head **un-stopped**.
- **TALK** (chore 4/5, 16–23): head cycles (lip-sync), body untouched
  (holds its pose because the talk mask doesn't name limb 0).
- **Mirror**: W and E share the *same* frames — a walk's West record and
  East record play the **identical picture sequence** (`scratch/compare-we.ts`),
  so the engine flips one horizontally; that's genuine engine behaviour,
  not a compositor shortcut. The costume `mirrorFlag` (format bit 0x80)
  gives the art's native horizontal orientation: clear (every MI1
  costume) ⇒ art faces right ⇒ flip West; set ⇒ art faces left ⇒ flip
  East. Only horizontal facings flip (N/S are front/back views with their
  own art). `compositeActor` reflects about the anchor X;
  `mirror = horizontal && (facingWest XOR mirrorFlag)`. (Confirmed
  in-game for the flag-clear case; the flag-set branch follows the SCUMM
  convention but no MI1 costume exercises it.)

**Walk trigger.** `Actor` carries `walk/stand/init/talk*` chore frames
(from `actorOps`, SCUMM `initActor` defaults). `stepAllActorWalks` plays
`walkFrame*4+dir` while moving, `standFrame*4+dir` on arrival, and seeds
`initFrame*4+dir` once for an idle costumed actor (so the head limb has
playback that stand/walk later resume/freeze). `dir = newDirToOldDir`
(`W=0,E=1,S=2,N=3`). FX actors driven by `animateActor` are untouched.

Verified headlessly: the walk decodes to a single cycling body with the
head stopped; the intro (rooms 10/38, up to 9 actors) composites with
zero limb-skip errors. Visual confirmation (mirror direction especially)
is the user's to give.

### Clouds — SOLVED: positional actors that were invisible (animateActor mapping bug, 2026-05-30)

The earlier "clouds are a different mechanism, not the record decoder"
note was **half right**. The Mêlée-island clouds live in the wide
establishing pan, **room 10** (640×200), *not* room 38. They are
**actors**, driven by `room-10/L202`:

- Three **foreground clouds** = actors 7–9, costume **59**, set to
  `animateActor anim=4/5/6`, repositioned each loop with `putActor x=L3
  y=84` while `L2--` → a right-to-left slide. The slide (positional) was
  already correct.
- Eleven **background sparkles/clouds** (the LucasArts-logo stars) =
  actors 1–11, costume **111**, `animateActor anim=2`, spawned by
  `L204→L203` at scattered positions.

The clouds *moved* but **rendered invisible** because the costume frame
never resolved. Root cause was **not** the record decoder — it was the
`animateActor` opcode handler. SCUMM v5 `Actor::animateActor(anim)`
treats its operand as `cmd*4 + dir`: it calls `startAnimActor(anim)`,
which resolves the anim record as **`anim * 4 + dir(facing)`** (in
`costumeDecodeData`). The old handler passed the raw operand straight
through as the record index, skipping the ×4 — so `animateActor 4`
landed on record **4** instead of record **16**.

For costume 59 the difference is decisive (`scratch/cloud-records.ts`):

```
record  4–7  (j=0) → cmd[0]=0x7b  (a no-draw command → nothing drawn)
record 16–19 (j=1) → picture 0  (cloud sprite 122×45)
record 20–23 (j=2) → picture 1  (cloud sprite 128×55)
record 24–27 (j=3) → picture 2  (cloud sprite 124×47)
```

`animateActor 4/5/6` × 4 (+ default facing S = dir 2) → records
18/22/26 → cloud pictures 0/1/2. Costume 111's sparkle likewise lives at
record **10** (`2*4 + 2`), the validated 5→7→9→11→13→19→…→5 pulse — not
the `0xff ff` sentinel at raw record 2 that earlier analysis was stuck
on. (The `mask=0xFF`/`0xFFFF` "oddball" records were a red herring: the
clouds/sparkles never used those records; the wrong index did.)

**Fix.** `animateActorHandler` now implements the v5 dispatch:
`cmd = anim/4`, `dir = anim&3`; cmd 2 = stop + stand pose, cmd 3 = set
facing, cmd 4 = turn (snap facing), **else** play chore `anim` via the
shared `startActorChore` (`record = anim*4 + dir(facing)` — the same
helper the walk loop uses through `applyChore`/`choreRecord` in
`walk.ts`). `anim=250` (the `animateActor 250` idiom that precedes the
real anim) is `cmd 62` → out-of-range chore → no-op, as intended.

**Verified headlessly (`scratch/clouds-render.ts`, `scratch/intro-smoke.ts`):**
room 10 goes from **0 → 9** actors drawn, the three cloud sprites render
and slide right-to-left, the full intro reaches room 33 with **zero
active-limb skip events** and no halts. Visual confirmation in-app is
the user's to give.

---

## Head re-point — the head limb must track facing at rest (2026-05-31)

**Symptom (user-reported, live).** Guybrush's **head (limb 1)** faced the
camera at rest regardless of which way he stood or walked, while his
**body (limb 0)** faced correctly. Surfaced while testing save/load, but
confirmed a live rendering bug (a faithful save reproduces it).

**Root cause.** For costume 1, the per-direction records resolve like so
(`chore*4 + dir`, dir W=0/E=1/S=2/N=3):

| chore | head limb (1) behaviour |
|-------|--------------------------|
| init (4–7)  | **sets** the head's per-direction frame: W/E→`490` (pic 6, side), S→`491` (pic 0, front), N→`493` (pic 14, back) |
| stand (12–15) | only **un-stops** the head (`0x7A`) — does *not* re-frame it |
| walk (8–11)   | only **stops** the head (`0x79`) — the body sprite carries it |
| talk (16–19)  | animates the head |

So the head's directional frame is established **only by `init`** (and
talk). `stand`/`walk` assume it's already correct for the facing. Our
engine bakes direction into the anim record at `startAnim` time, and the
walk loop re-applied `walk`/`stand` on a facing change — but those records
never re-frame the head. Result: the head kept whatever frame `init` last
set. In one save `init` had last run facing **S** (head `491`, front), so
a West-facing Guybrush drew a front "looking-at-camera" head.

**Fix (`stepAllActorWalks`, walk.ts).** On the walk→stand transition,
re-apply the **init** chore for the *current* facing (which re-points the
head limb), then apply **stand** (un-stops the head, sets the stand body
frame). `init` and `stand` share the body frame per direction, so the
body is unchanged; only the head is corrected. Verified (`scratch/
head-verify2.ts`): rest head start is now `490`/`490`/`491`/`493` for
W/E/S/N (distinct, body-matching, un-stopped). Regression test in
`mi1-smoke.test.ts` ("rest head limb tracks facing").

**Known follow-up.** This covers walk→stop (the reported case). A *turn
in place while already idle* (a script changing `facing` without a walk)
is not yet re-pointed — wire the same re-point on any facing change if a
scene surfaces it. The room-33 cliff N/S facing flip-flop (a separate
walk *direction-picker* issue) and the room-38 entry head-loss transient
also remain on the backlog.
