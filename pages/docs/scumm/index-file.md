# SCUMM v5 — Index File (`MONKEY.000`) and LOFF

This document covers the layout of the index file (`MONKEY.000` for
MI1, `MONKEY2.000` for MI2) and the `LOFF` block that lives at the
top of the matching resource file. Together they map a script /
sound / costume / charset id to a byte position in the `.001` file.

We worked this out empirically against MI1; the lane encoding below
is consistent across all five resource directories in our sample but
the lane-1 *semantics* differ between `DROO` and the rest — a surprise
worth flagging up front.

## Sources

- ScummVM Technical Reference — Index file, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Index_File>.
  Describes the directory layouts and the `LOFF` purpose; the
  lane-1-disk-vs-room distinction in §4 was derived empirically
  against MI1.

> ⚠️ **The first lane is the *owning room id*, not the disk number,
> for `DSCR` / `DSOU` / `DCOS` / `DCHR`.** Only `DROO` uses lane 1 for
> a disk number. Long-circulating notes don't make this distinction
> consistently. See §4.

---

## 1. Top-level blocks in `.000`

MI1's `MONKEY.000` carries eight top-level blocks in source order:

| Tag    | Purpose                                                                 |
|--------|-------------------------------------------------------------------------|
| `RNAM` | Debug room labels (internal names like "scumm-bar"). Unused at runtime. |
| `MAXS` | Upper-bound counts the engine needs at boot — see §2.                   |
| `DROO` | Per-room directory: disk membership + reserved offset (see §3, §4).     |
| `DSCR` | Global-script directory.                                                |
| `DSOU` | Sound directory.                                                        |
| `DCOS` | Costume directory.                                                      |
| `DCHR` | Charset directory.                                                      |
| `DOBJ` | Object table: owner, state, class flags. Phase-deferred.                |

All five `D*` directories share the lane-encoded shape in §3. `DOBJ`
has a different layout we don't yet decode.

---

## 2. `MAXS`

18-byte payload, parsed as nine `u16 LE` fields. MI1's values:

```
[0] numVariables       = 800
[1] (unknown)          = 16
[2] numBitVariables    = 2048
[3] numLocalObjects    = 200
[4] (unknown)          = 50
[5] numCharsets        = 7
[6] numVerbs           = 100
[7] (unknown)          = 50
[8] (unknown)          = 80
```

The slots we name come from cross-referencing the values against the
real resource counts (e.g. MI1 ships 7 `CHAR` blocks → `[5] = 7`).
The remaining slots vary by reverse-engineering source and aren't yet
load-bearing in our VM, so we expose them as `maxs.raw` and name
them as our code starts reading them.

---

## 3. Lane encoding

All five `D*` directory payloads share this column-wise layout:

```
   ┌────────┬─────────────────────┬────────────────────────────────┐
   │ u16 LE │ count × u8          │ count × u32 LE                 │
   │ count  │   (lane 1)          │   (lane 2)                     │
   └────────┴─────────────────────┴────────────────────────────────┘
```

Total payload size = `2 + count + 4 * count = 2 + 5 * count`.

The alternative row-wise interpretation (each row is `u8 + u32 LE`,
5 bytes interleaved) is **wrong**. It validates against payload size
just as well — both layouts add up to `2 + 5 * count` — but lane
encoding is the only one whose values resolve to plausible file
positions in `.001`. With MI1:

- Row-wise reading of `DROO`'s 100 entries: 1 row out of 100 has
  non-sentinel offset values.
- Lane-wise reading of the same data: every row carries `disk = 1`
  (matching every real room) and `offset = 0` (consistent with §4).

The same test on `DSCR` is even more decisive: 178 of 199 lane-decoded
entries resolve to a real `SCRP` block in `.001` (the other 21 are
zero-room "unused" slots). The row-wise reading produces zero matches.

---

## 4. Lane-1 semantics differ by directory family

This is the trap that consumed an evening of head-scratching.

### `DROO`

Lane 1 is the **disk number**. Slot `i` (= room id `i`) is present
on the `.001` file if `disk != 0`. MI1 is single-disk so every present
room has `disk = 1` and every absent slot has `disk = 0`.

Lane 2 is *reserved* — every value is `0` in single-disk releases.
The real room offsets live in `LOFF` (see §5). DROO offsets may carry
meaning on the multi-disk floppy variants of v5 games we don't target;
we treat them as `0` and ignore them.

### `DSCR` / `DSOU` / `DCOS` / `DCHR`

Lane 1 is the **owning room id**. The script (or sound, costume,
charset) physically lives *inside that room's LFLF*. A glance at
`DSCR` makes this obvious — many global scripts in MI1 cluster in
room 10, which is the de-facto "globals" room:

```
script # 0   room=  0   offset=0x00000000   (unused — room=0)
script # 1   room= 10   offset=0x0000dc18   ◀ boot script
script # 2   room= 10   offset=0x0000f14d
script # 3   room= 10   offset=0x0000f513
...
```

Lane 2 is the byte offset of the resource's block header, **relative
to its owning room's `ROOM` block file offset**.

A row with `room = 0` is the SCUMM convention for "this id is reserved
but unused". MI1 has 21 such entries in DSCR.

### Why this is confusing

Long-circulating notes describe all five `D*` directories with the
phrase "disk + offset" and don't always carve out the per-directory
exceptions. If you assume lane 1 is *always* a disk number, every
`DSCR` script appears to live on disk 10, disk 32, disk 80, etc.
(whatever the real room id is). The first sanity check is: do any of
the lane-1 values exceed the number of physical `.NNN` files? If yes,
it's a room id, not a disk number.

---

## 5. `LOFF` — the room offset table (lives in `.001`)

The `.000` index *does not* tell you where the rooms live. That's the
job of `LOFF`, which is the first child of the top-level `LECF`
container in the resource file.

Payload layout (after the 8-byte block header):

```
   u8       count
   count × {
     u8     roomId
     u32 LE offset      ◀ byte offset of the ROOM block in .001
   }
```

Total payload = `1 + 5 * count`. MI1's LOFF has 83 entries matching
the 83 LFLFs in the file.

The offset points at the `ROOM` block's own 8-byte header, **not** at
the enclosing LFLF or at the ROOM payload. The ROOM block then
contains the room's geometry, palette, etc. — but for resolving a
script (or any other LFLF resource) we only care about the ROOM block
offset, which is the anchor for the DSCR/DSOU/DCOS/DCHR lane-2
offsets in §4.

---

## 6. End-to-end resolve walkthrough

To find the bytecode of global script `N`:

```
1. Read index.scripts[N]:
     entry = { room, offset }
   If entry.room == 0 → unused slot, fail.

2. Read loff.get(entry.room):
     roomOffset = absolute file position of the room's ROOM block.

3. Absolute file position of script N's SCRP header:
     scrpOffset = roomOffset + entry.offset

4. Verify the 4-byte tag at scrpOffset is 'SCRP'.
   Read the 4-byte BE size at scrpOffset + 4.
   The bytecode is bytes [scrpOffset + 8, scrpOffset + size).
```

Worked MI1 example (`script #1`, the boot script):

```
DSCR[1]               = { room: 10, offset: 0x0000DC18 }
LOFF[10]              = 0x57106                  (ROOM block of room 10)
scrpOffset            = 0x57106 + 0xDC18 = 0x64D1E
file[0x64D1E..0x64D22] = 'SCRP'                  ✓
SCRP size (BE u32)    = 0x152D                   (= 5421 bytes)
bytecode              = file[0x64D26..0x6624B]
```

Sound, costume, and charset resolution work the same way against
`DSOU`, `DCOS`, `DCHR` respectively.

---

## 7. Verification recipe

A useful sanity check when you ship a parser change: walk all DSCR
rows, resolve each to an absolute file position, and count how many
land on a `SCRP` tag in `.001`.

For MI1: **178 of 199** DSCR rows resolve cleanly; the other 21 have
`room = 0` and are correctly rejected as unused. Anything other than
"all non-zero-room entries resolve" is a parser bug.

`scratch/inspect-index.ts` carries this verification in script form.

---

## 8. Pitfalls cheat sheet

| Trap | Symptom | Cure |
|------|---------|------|
| Reading DSCR as `u8 + u32` interleaved | Most offsets look like junk; zero or one row validates | Use the lane-encoded layout in §3 |
| Treating DSCR lane 1 as disk number | Every script appears to live on a disk you don't have | Lane 1 is room id for DSCR/DSOU/DCOS/DCHR |
| Treating DROO lane 1 as room id | Self-reference loop (slot `i` claims to live in room `i`) | Lane 1 is disk for DROO only |
| Using DROO offsets to find rooms | All offsets are 0 → "every room at file start" | Use LOFF in `.001` |
| Adding DSCR offset to LFLF offset (instead of ROOM offset) | Resolves to inside `LECF` header padding, garbage tags | Anchor on the ROOM block from LOFF, not the LFLF wrapper |
| LOFF count read as `u16` instead of `u8` | Size mismatch | LOFF's count is one byte |
| MAXS field semantics from a single source of notes | Some slot names disagree across sources | Cross-reference values against real resource counts (charset count, room count …) before naming a slot |
