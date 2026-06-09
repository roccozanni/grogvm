# SCUMM v5 — `ROOM` Block

A `ROOM` block is the container for everything that makes one room:
background bitmap, palette, transparency colour, foreground occlusion
masks, walk-box geometry, perspective scaling table, palette cycles,
object code + image data, room-entry / room-exit scripts, and a small
table of room-local scripts. It's the heaviest single block in a v5
resource file — Monkey Island's title-screen room is around 50 kB —
and it's also the unit of work the engine swaps in and out as the
player moves between locations.

This document is the top-level reference for how those pieces fit
together. Each interesting sub-block has its own deep dive:

- [`smap.md`](smap.md) — background bitmap encoding
  inside `RMIM > IM00 > SMAP`.
- [`zplane.md`](zplane.md) — z-plane masks
  (`RMIM > IM00 > ZP##`).
- [`objects.md`](objects.md) — `OBCD` + `OBIM`
  pairs.
- [`walk-boxes.md`](walk-boxes.md) — `BOXD` and
  `BOXM`.

## Sources

- ScummVM Technical Reference — Room resources, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference/Room_resources>.
  Authoritative on the child-block list and the canonical order, plus
  the meaning of less common children (`CYCL` for palette cycling,
  `SCAL` for per-y scaling).
- Cross-checked against MI1 rooms 10 (title screen, 640×200, 9 walk
  boxes) and 30 (interior, 9 walk boxes, plenty of objects).

## 1. Where ROOMs live

Inside a SCUMM v5 resource file (`MONKEY.001` / `MONKEY2.001`):

```
LECF                  top-level container
└── LFLF              one bundle per "disk"
    └── ROOM          ← THIS DOCUMENT — zero or one per LFLF
```

A `LECF` block holds many `LFLF` bundles and each one *may* hold one
`ROOM`. Some `LFLF`s carry only costumes / scripts / sounds with no
room — that's fine. The mapping from room id to file offset doesn't
go through the block tree; it lives in the `LOFF` block at the top
of `LECF`. See [`index-file.md`](index-file.md).

Room **0** is a special case: it has no `LOFF` entry and no `ROOM`
block anywhere. Boot scripts use `loadRoom 0` mid-initialisation as a
**blank-screen sentinel** — it binds "no room" and loads nothing.

## 2. Child blocks (canonical order)

Source order matters — the original engine reads them sequentially.
A real MI1 game room (id 10, the title screen) contains:

| Tag    | Bytes | Purpose                                                                  |
|--------|-------|--------------------------------------------------------------------------|
| `RMHD` | 14    | Room header — width, height, num-objects. See §3.                        |
| `CYCL` | 10    | Palette cycle table — animated palette ranges (visual polish).           |
| `TRNS` | 10    | Transparent palette index. See §4.                                       |
| `EPAL` | 264   | EGA palette mirror. Ignored by the VGA path.                             |
| `BOXD` | 50    | Walk-box geometry. See [`walk-boxes.md`](walk-boxes.md). |
| `BOXM` | 16    | Walk-box adjacency matrix (next-hop routing). See [`walk-boxes.md`](walk-boxes.md). |
| `CLUT` | 776   | Room palette — 256 RGB triples + 8-byte block header. See §4b.           |
| `SCAL` | 40    | Per-y actor scaling slots. Not yet consumed by the compositor.           |
| `RMIM` | big   | Room image container (SMAP + z-planes). See §5.                          |
| `OBIM` | each  | Object image — one block per object. See [`objects.md`](objects.md). |
| `OBCD` | each  | Object code — one block per object, paired with OBIM by id.              |
| `EXCD` | small | Bytecode that runs when the player **leaves** this room. See §6.          |
| `ENCD` | small | Bytecode that runs when the player **enters** this room. See §6.          |
| `NLSC` | 10    | Local-script count. Diagnostic; ignored at runtime.                      |
| `LSCR` | each  | Local script — one block per script. See §7.                             |

Rooms can omit any of these — some title / cutscene rooms have no
`BOXD`, some have no `OBIM`. The room loader treats missing blocks
as "default to empty" rather than throwing.

## 3. RMHD — room header

Three little-endian u16 fields:

- `width` — total pixel width of the room background. Most MI1 rooms
  are 320 wide (single screen); some are 640 (scrolling rooms).
- `height` — pixel height. Usually 144 (interior) or 200 (exterior),
  occasionally other values.
- `numObjects` — the number of objects defined in this room's
  `OBCD` / `OBIM` siblings. Diagnostic; the loader counts the actual
  blocks rather than trusting this.

## 4. TRNS — transparent palette index

A two-byte field giving the **CLUT index that should render as
transparent** anywhere it appears in the background or in an object
image. A renderer honours it by emitting alpha-0 for that index in
the final framebuffer.

When the room has no `TRNS` block, every CLUT index is opaque. Most
MI1 rooms have TRNS = 5 (the bright magenta the encoder uses as a
"keep this transparent" marker).

## 4b. CLUT — room palette

256 RGB triples — 768 payload bytes after the 8-byte block header, one
triple per palette index. The component values are **full-range
0–255**, not VGA DAC 0–63: circulating notes disagree about the scale
for v5 palettes, but the shipped data settles it — MI1 CD VGA and MI2
DOS CLUTs use the full range and need no ×4 step-up.

## 5. RMIM — room image

A two-level container:

```
RMIM
├── RMHD                   (a *different* RMHD — image-header, not room-header)
└── IM00                   primary background image
    ├── SMAP               background bitmap
    ├── ZP01               z-plane 1 (foreground occlusion mask)
    ├── ZP02               …
    └── ZPNN               up to N planes
```

The image is at native room dimensions (`RMHD.width × RMHD.height`).
A decoder reads RMHD for plane count, then SMAP for the bitmap and
each `ZP##` in source order for occlusion. A compositor stacks the
SMAP under any drawn objects and actors, with each z-plane `ZP0k`
masking the actors at clip level `k` alone — the single-plane rule;
see [`zplane.md`](zplane.md).

## 6. ENCD / EXCD — room entry / exit scripts

Each is raw SCUMM bytecode (no header). The main loop runs them as
**synthetic script slots** whenever the VM enters or leaves a room:

1. When the script dispatches a `loadRoom` opcode, the engine first
   checks the **outgoing** room for an `EXCD`. If present, it starts
   that bytecode in a free slot labelled `EXCD-{prevRoomId}` and runs
   it **nested** (see below).
2. The new room is bound as the current room.
3. If the new room has an `ENCD`, that's started in another free
   slot labelled `ENCD-{newRoomId}`, also run **nested**.

These slots have `scriptId = 0` (they're not global scripts) and a
non-empty `label` to distinguish them from numbered global scripts
in trace output.

**EXCD and ENCD run NESTED — to their first yield — inside the
`loadRoom` opcode, before it returns to the calling script.** SCUMM's
`startScene` invokes `runExitScript()` / `runEntryScript()` synchronously
and nested, so the script that issued `loadRoom` observes the room as the
exit/entry scripts left it. They are NOT
deferred slots picked up on a later tick — that would let the caller's
own *next* opcodes run first and then get clobbered by the room script.

Concrete failure if deferred (the bug that motivated this): the LOOM-ad
pirate conversation script #93 does `loadRoom 82` then, on its very next
opcode, `g32 = 14` (`VAR_VERB_SCRIPT` → the dialog input script #14).
Room 28's `EXCD` resets `g32 = 4` (the default verb script). Run nested,
EXCD's `g32 = 4` happens *during* `loadRoom` and #93's `g32 = 14` sticks.
Run deferred, EXCD fired after #93's frame and overwrote 14 with 4, so
dialog-answer clicks routed to #4 (which only *arms* a verb, never commits
a dialog pick) and the conversation hung — answers highlighted on hover but
clicking did nothing. The nested run stops at the first `breakHere`, so an
ENCD that spans frames still yields back to the scheduler after its prologue
— exactly the original.

**Transient ("blasted") text clears before the new room's ENCD runs —
never after.** A room change wipes any leftover overlay text as part of
the transition, but the wipe must precede the entry script: room 96's
"Le tre prove" title is printed *by* its ENCD, so a clear that runs
after entry erases the title the room has just drawn.

**A room change stops the old room's scripts.** SCUMM's `startScene`
kills every room-local (`WIO_ROOM`) and object/verb (`WIO_FLOBJECT`)
script before binding the new room; only **globals** (`WIO_GLOBAL`)
survive. So `enterRoom` must stop slots whose `scriptId ≥ 200` or whose
label is a `VERB-*` (sparing globals and the scriptId-0 ENCD/EXCD) before
starting the new ENCD. Without this, the old room's ambient loop bleeds
into the new room and tries to `startScript` a local that doesn't exist
there → halt. A global driver (e.g. a dialog script that issues the
`loadRoom`) deliberately keeps running across the load — that's why the
rule spares globals.

## 7. LSCR — local scripts

A `ROOM` can carry an arbitrary number of `LSCR` children, each
holding one **room-local script**. The first byte of an `LSCR`
payload is the script's id (typically 200..255); the rest is the
bytecode.

SCUMM v5 routes `startScript` opcodes with id ≥ 200 through the
current room's local-script table rather than the global directory.
A room loader should collect every `LSCR` into a map keyed by id,
and the `startScript` opcode handler should dispatch to that map for
ids ≥ 200 and fall through to the global script resolver for lower
ids.

Mid-cutscene scripts often live as LSCRs — they're tightly bound to
one room and don't need to be exposed in the global directory. MI1's
title room has 5 LSCRs (200..204) covering the menu, intro music
cue, and copy-protection check sequencing.

When the engine swaps to a new room, the previous room's LSCR
bytecode goes out of scope. Any still-running slot referencing it
should keep a reference to its bytecode buffer until that slot
finishes.

## 7b. Pseudo-rooms (a `loadRoom` *fallback*, not an override)

The `pseudoRoom` opcode (`0xCC`) aliases high-numbered logical room ids
onto one physical room's resources. MI1 boot declares the **forest maze**,
`201–220 → 58`, plus `130–132 → 1`. The game uses these ids *verbatim* —
`VAR_ROOM` cycles through 201–220 (one logical "screen" per id) and room
58's entry script branches on `VAR_ROOM == 201..220` to compose each screen
from a shared tile set — so the raw id has to reach the engine intact (it is
**not** collapsed to `id & 0x7F`). Room 58 is the single shared forest
background.

The alias is a **fallback for ids with no physical room of their own**,
*not* a blanket override: `loadRoom N` resolves **N's own `ROOM` first** and
consults the alias map only when N is absent. Pseudo ids are always ≥ 128,
so they never collide with a real room (1–127) — the direct-first order is
belt-and-braces, and a real room always loads its own art.

## 8. CYCL, SCAL — not yet consumed

- **CYCL** lists palette-index ranges that cycle on a timer (water,
  flames, animated mouths). A renderer honouring it would mutate the
  palette's RGB triplets in place at the cycle rate.
- **SCAL** holds 4 perspective-scale slots, each `(scale1, y1,
  scale2, y2)`, defining a per-y interpolation that scales actors as
  they walk toward / away from the camera. Walk boxes reference one
  of these slots via `box.scaleSlot`. Without it, actors render at
  100% scale regardless of room depth.
