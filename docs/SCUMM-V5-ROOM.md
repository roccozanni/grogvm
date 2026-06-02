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

- [`SCUMM-V5-SMAP.md`](SCUMM-V5-SMAP.md) — background bitmap encoding
  inside `RMIM > IM00 > SMAP`.
- [`SCUMM-V5-ZPLANE.md`](SCUMM-V5-ZPLANE.md) — z-plane masks
  (`RMIM > IM00 > ZP##`).
- [`SCUMM-V5-OBJECTS.md`](SCUMM-V5-OBJECTS.md) — `OBCD` + `OBIM`
  pairs.
- [`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md) — `BOXD` and
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
of `LECF`. See [`SCUMM-V5-INDEX.md`](SCUMM-V5-INDEX.md).

## 2. Child blocks (canonical order)

Source order matters — the original engine reads them sequentially.
A real MI1 game room (id 10, the title screen) contains:

| Tag    | Bytes | Purpose                                                                  |
|--------|-------|--------------------------------------------------------------------------|
| `RMHD` | 14    | Room header — width, height, num-objects. See §3.                        |
| `CYCL` | 10    | Palette cycle table. Visual polish; GrogVM doesn't yet honour it.      |
| `TRNS` | 10    | Transparent palette index. See §4.                                       |
| `EPAL` | 264   | EGA palette mirror (back-compat). Ignored by the VGA path.               |
| `BOXD` | 50    | Walk-box geometry. See [`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md). |
| `BOXM` | 16    | Walk-box adjacency matrix. Captured but not consumed yet.                |
| `CLUT` | 776   | Room palette — 256 RGB triples + 8-byte block header.                    |
| `SCAL` | 40    | Per-y actor scaling slots. Not yet consumed by the compositor.           |
| `RMIM` | big   | Room image container (SMAP + z-planes). See §5.                          |
| `OBIM` | each  | Object image — one block per object. See [`SCUMM-V5-OBJECTS.md`](SCUMM-V5-OBJECTS.md). |
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
SMAP under any drawn objects and actors, with each z-plane index
hiding actors whose `actorZ` is less than the plane's 1-based index.

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
`startScene` invokes `runExitScript()` / `runEntryScript()` (→ `runScript`
→ `runScriptNested`) synchronously, so the script that issued `loadRoom`
observes the room as the exit/entry scripts left it. They are NOT
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
clicking did nothing. `runScriptNested` stops at the first `breakHere`, so
an ENCD that spans frames still yields back to the scheduler after its
prologue — exactly the original. (Guarded by `vm.test.ts` "runs ENCD/EXCD
NESTED …" + the MI1-smoke pirate-conversation regression.)

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

The `pseudoRoom` opcode (`0xCC`) builds an alias map — MI1 boot does
`pseudoRoom 58 [201,202,203] …`, aliasing a span of logical room ids onto
one physical room (rooms 73–92 → 58, a shared close-up stage). The trap:
the alias is a **fallback for ids that have no physical room of their
own**, *not* a blanket override. `loadRoom N` must resolve **N's own
ROOM first**, and only consult the alias map when N has no physical room.
Rooms 73–90 physically exist with their own art (room 82 = an orange
pirate close-up); only the genuinely-absent ids (91/92) fall through to
58. Remapping *every* id sends `loadRoom 82` to the all-black room 58 and
the close-up renders blank.

## 8. CYCL, SCAL — not yet consumed

- **CYCL** lists palette-index ranges that cycle on a timer (water,
  flames, animated mouths). A renderer honouring it would mutate the
  palette's RGB triplets in place at the cycle rate.
- **SCAL** holds 4 perspective-scale slots, each `(scale1, y1,
  scale2, y2)`, defining a per-y interpolation that scales actors as
  they walk toward / away from the camera. Walk boxes reference one
  of these slots via `box.scaleSlot`. Without it, actors render at
  100% scale regardless of room depth.

## 9. Reference implementation

[`src/engine/room/loader.ts`](../src/engine/room/loader.ts) exposes
`loadRoom(file, loff, roomId)` returning a `LoadedRoom` struct with:

- `width`, `height`, `numObjects` from RMHD
- `palette` from CLUT, `transparentIndex` from TRNS
- `indexed` (decoded SMAP background)
- `zPlanes` (decoded ZP##)
- `entryScript` / `exitScript` (ENCD / EXCD payloads)
- `localScripts` (LSCR id → bytecode)
- `objects` (id → LoadedObject; see OBJECTS doc)
- `walkBoxes`, `walkableMask` (BOXD parsed + rasterised; see
  WALK-BOXES doc)

The loader resolves the room via LOFF (room id → `ROOM` block file
offset) and walks the block tree to find the ROOM at that offset.
`RoomLoadError` flags missing rooms, decode failures, and the
room-0 sentinel that scripts use as "no room loaded" between
transitions.

Tests in
[`src/engine/room/loader.test.ts`](../src/engine/room/loader.test.ts)
cover synthetic LECF/LFLF/ROOM fixtures with every combination of
optional children, ENCD/EXCD capture, LSCR collection, and the
error paths.
