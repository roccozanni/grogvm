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

### SHIPPED — the walk/stand chore trigger (2026-05-30)

The decoder is now driven by the walk loop, so Guybrush visibly walks.
The chore→record mapping was **validated against MI1's own data**, not
guessed:

- **Record = `chore * 4 + dir`**, `dir` = `W=0, E=1, S=2, N=3` (ScummVM
  `oldDirToNewDir`).
- Decoding all four directional records per chore for Guybrush #1
  (`scratch/validate-chore-mapping.ts`) shows **chore 2 = walk** (records
  8–11: W/E/S all *cycle*, N a pose) and chore 1 = the single-frame
  directional *poses* (records 4–7). Chores 3/4/5 (stand/talk) are
  data-empty sentinels.
- Tracing the boot+intro (`scratch/trace-chore-frames.ts`) confirms MI1
  sets **no** chore frames on any actor — every actor keeps SCUMM's
  `initActor` defaults `walk=2, stand=3, init=1, talk=4/5`. So walk
  chore 2 → records 8–11, exactly the cycling walk. This triangulates
  cleanly: SCUMM defaults ⋂ the doc's id table ⋂ the decoded frames all
  agree.

Implementation: `Actor` gains `walkFrame/standFrame/initFrame/
talkStartFrame/talkStopFrame` (captured from `actorOps` sub-ops
0x04/0x06/0x0e/0x05, reset on initActor). `stepAllActorWalks` calls
`startAnim(walkFrame*4 + dir)` while moving (re-aimed on a facing flip,
not restarted every tick) and `startAnim(initFrame*4 + dir)` — the
directional standing pose — on the moving→stopped transition. It touches
the anim **only while walking or at arrival**, never while idle, so it
never clobbers script-driven FX actors (the intro sparkles, which
`animateActor` controls directly). Verified end-to-end
(`scratch/verify-walk-trigger.ts`): walk-E drives record 9 with the body
limb cycling 0→5 + a static head; arrival settles to the init pose.

The resting pose uses the *init* chore (chore 1) — Guybrush's literal
stand chore (3) is data-empty — and is then **frozen** (`freezeAnim`) so
it holds a single static frame. Without the freeze, record 7 (facing-N)
would *cycle* (it shares bytes with walk-W), animating a standing actor
in place.

### FIX — command bytes were blanking the walk (flicker) (2026-05-30)

First playtest showed Guybrush's body **flickering / vanishing** for one
tick every walk cycle, and odd standing poses. Cause: the walk cmd
stream interleaves picture indices with **command bytes** (`0x71-0x7C`:
sound triggers, loop/start markers), and MI1's walk loops *begin on a
`0x79` marker* (`frameOffs[5] = 0x79`, walk-W's `frameIndex`). The
compositor's naive rule "cmd byte → draw nothing" blanked the body limb
on the first tick of every loop.

Fix — command bytes are never drawable pictures, so playback advances
*past* them, it never blanks:

- `startAnim` **trims leading command bytes** from each limb's loop
  window, so the loop starts on a real picture (walk-W becomes a clean
  even 5-frame cycle `02 03 04 05 06` instead of `79 02 03 04 05 06`
  with a blank).
- `currentLimbPicture` (used by the compositor instead of the raw
  `currentAnimCmd`) **skips command bytes mid-window**, wrapping within
  the loop, and only returns -1 ("draw nothing") if the *entire* window
  is commands. An active limb never blanks for a tick.

Verified headlessly: the walk now cycles `02 03 04 05 06` with the body
present every tick.

**Still open — `mask=0xFF` talk records** (anims 16–23, costume-111
sparkle): the record is too short to host 8 modifiers, so `0xFF` is a
sentinel whose meaning we haven't pinned; those stay static. Best
cracked from a ScummVM cmd-trajectory trace of Guybrush talking.

### Clouds are a DIFFERENT mechanism (not the record decoder)

User confirmed (screenshot, room 38 Mêlée-island lookout): the clouds
**slide right-to-left** — a positional translation, not a frame-cycle.
So the clouds are driven by frame displacement (`xinc`/`yinc` on the
image header) or a script/engine position update, NOT the anim-record
decoder. They will not be fixed by the costume-anim work; track as a
separate "scrolling background element" item.
