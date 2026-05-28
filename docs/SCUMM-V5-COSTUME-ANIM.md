# SCUMM v5 — Costume animation records *(spike notes, partial)*

> ⚠️ **This format is not yet fully decoded in webscumm.** Phase 6
> ships a deliberate stub (`src/engine/graphics/costume-anim.ts`)
> that returns frame 0 for every limb. Actors render in a static
> "init pose" until we resolve the open question below and unstub
> the playback path.
>
> This doc captures what the spike turned up so the next attempt
> can start from the empirical findings instead of from scratch.

## 1. What's documented elsewhere

Section 3.6 of [SCUMM-V5-COST.md](SCUMM-V5-COST.md) describes the
*intended* layout, sourced from the long-circulating
reverse-engineering notes:

```
struct AnimRecord {
  u16 LE limbMask;        // MSB = limb 0, LSB = limb 15
  for each set bit (MSB-first):
    u16 LE frameIndex;    // 0xFFFF = "this limb disabled"
    u8     frameLen;      // low 7 bits = frame count
                          // high bit  = loop flag
}
```

Total bytes = `2 + 3 × popcount(limbMask)`.

## 2. What the data actually shows

Inspecting MI1 costume #0 (Guybrush) end-to-end: the offset table
gives 16 populated anim records, and we know their lengths exactly
from the gaps between consecutive `animOffs[i]` values.

| Anim | First byte | Length | Mask popcount under §1 spec | Predicted length under §1 spec | Match? |
|------|------------|--------|-----------------------------|---------------------------------|--------|
| 4    | `0x80`     | 5      | 1 *or* 2 depending on byte order | 5 *or* 8 | partial |
| 5    | `0x80`     | 5      | 1 *or* 2 | 5 *or* 8 | partial |
| 6    | `0x80`     | 5      | 1 *or* 2 | 5 *or* 8 | partial |
| 7    | `0x80`     | 5      | 1 *or* 2 | 5 *or* 8 | partial |
| 8    | `0xc0`     | 7      | 2 *or* 3 | 8 *or* 11 | ✗ |
| 9    | `0xc0`     | 7      | 2 *or* 3 | 8 *or* 11 | ✗ |
| 10   | `0xf0`     | 13     | 4 *or* 5 | 14 *or* 17 | ✗ |

Under no consistent reading do all six lengths match the §1 spec.

A **simpler interpretation** that *does* match every record except
single-mask-byte anims (which come up 1 byte long):

```
struct AnimRecord {
  u8 limbMask;            // bit i = limb (i ?)  ← bit-order TBD
  for each set bit:
    u16 LE frameIndex;
    u8     frameLen;
}
```

- 1-limb anims: `1 + 3 = 4`. **Observed: 5** → 1-byte discrepancy.
- 2-limb anims: `1 + 6 = 7`. **Observed: 7**. ✓
- 4-limb anims: `1 + 12 = 13`. **Observed: 13**. ✓

So multi-limb anims match a `u8 limbMask + 3-byte-per-limb` reading
exactly. Single-limb anims have one mystery trailing byte.

## 3. Sample data (Guybrush, MI1)

```
animTableEnd = 0x74     (first byte of the anim-records region)
animCmdOff   = 0xe0     (end of the anim-records region)

0x0074  00 80 00 00 00 00 80 01 00 00 00 80 02 00 00 00
0x0084  80 03 00 00 00 c0 04 00 01 ff ff 00 c0 04 00 01
0x0094  ff ff 00 f0 06 00 01 ff ff 08 00 00 08 00 00 00
0x00a4  c0 09 00 01 ff ff 00 80 00 00 00 00 80 01 00 00
0x00b4  00 80 02 00 00 00 80 03 00 00 00 c0 ff ff 0b 00
0x00c4  87 00 c0 ff ff 0b 00 87 00 c0 ff ff 13 00 87 00
0x00d4  c0 ff ff 1b 00 87 02 03 06 00 04 05
```

The mystery bytes 0x74..0x79 (`00 80 00 00 00 00`, 6 bytes between
`animTableEnd` and the first populated anim at 0x7a) are also
unexplained.

## 4. Hypotheses worth testing next

1. **`u8 mask + 3 bytes per limb + 1-byte alignment pad** when the
   record would otherwise be even.** Plausible — encoders sometimes
   pad to alignment, and 5/7/13 are all odd, so the pad lands only
   when the natural length is even (1-limb = 4 bytes naturally).
2. **A 1-byte prefix preceding the mask** (separator, anim-flag, or
   some sort of record-type byte). The `0x80`/`0xc0`/`0xf0` bytes
   we treat as masks would then be the *second* byte of each record,
   and the actual mask would be the byte before. Worth testing by
   decoding the record one byte earlier than `animOffs[i]` says.
3. **A 1-byte trailing terminator** (e.g. `0x00`) that's only
   emitted for single-limb records. Engineering rationale unclear.
4. **The 6 "pre-record" bytes at `animTableEnd`** are a default-anim
   record (used when a script asks for an unpopulated anim id).
   Decoding them under the same rules might reveal the actual record
   shape.

## 5. How to validate

The deciding test should be **visual + behavioural**:

1. Drive an MI1 actor through a real script-issued animation (e.g.
   the boot script's idle-pose setup for Guybrush, or a `walkActor`
   call once the walk path lands).
2. Capture the per-tick `(limb, frameIndex)` pairs the candidate
   decoder produces.
3. Cross-reference against descumm's textual output for the same
   anim, or against a screenshot of MI1 running in another v5
   interpreter at the same script step.

Until that loop is closed, decoder hypotheses can't be
discriminated — the synthetic-byte tests for "is the math
consistent" are necessary but not sufficient.

## 6. Current behaviour

`createAnimState` allocates per-limb arrays sized to the costume's
limb count. `startAnim`, `stepAnim`, `currentLimbFrame` all behave
as if every limb is on its image-table entry 0 — a static "init
pose". The compositor reads through this path and produces a
single-frame render of every actor.

The frame chosen by limb 0's `imageTableOffs[0]` is, for Guybrush
in MI1, a frontal idle stance — close enough to "Guybrush in his
starting position" for the Phase 6 milestone. Animation playback
unblocks the moment the decode question above is settled.
