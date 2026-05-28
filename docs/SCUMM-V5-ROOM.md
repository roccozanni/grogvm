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
| `CYCL` | 10    | Palette cycle table. Phase-deferred (visual polish).                     |
| `TRNS` | 10    | Transparent palette index. See §4.                                       |
| `EPAL` | 264   | EGA palette mirror (back-compat). Ignored by the VGA path.               |
| `BOXD` | 50    | Walk-box geometry. See [`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md). |
| `BOXM` | 16    | Walk-box adjacency matrix. Captured but not consumed yet.                |
| `CLUT` | 776   | Room palette — 256 RGB triples + 8-byte block header.                    |
| `SCAL` | 40    | Per-y actor scaling slots. Phase-deferred.                               |
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
image. The compositor honours it by emitting RGBA alpha-0 for that
index in the final framebuffer; the inspector renders a checkerboard
backdrop behind the canvas so transparent regions are visible.

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
`webscumm` decodes `RMHD` for plane count, then `SMAP` for the bitmap
and each `ZP##` in source order for occlusion. The compositor stacks
the SMAP under any drawn objects and actors, with each z-plane index
hiding actors whose `actorZ` is less than the plane's 1-based index.

## 6. ENCD / EXCD — room entry / exit scripts

Each is raw SCUMM bytecode (no header). The Phase 6 main loop runs
them as **synthetic script slots** whenever the VM enters or leaves a
room:

1. When the script dispatches a `loadRoom` opcode, `vm.enterRoom`
   first checks the **outgoing** room for an `EXCD`. If present, it
   starts that bytecode in a free slot labelled `EXCD-{prevRoomId}`
   so it runs alongside any still-live scripts.
2. The new room's `LoadedRoom` (with palette, SMAP, etc.) is then
   bound to `vm.loadedRoom`.
3. If the new room has an `ENCD`, that's started in another free
   slot labelled `ENCD-{newRoomId}`. Same scheduling as any global
   script — yields and runs over multiple engine ticks.

These slots have `scriptId = 0` (they're not global scripts) and a
non-empty `label` so the inspector can tell them apart in the slot
table.

The EXCD/ENCD bytecode is captured up-front into `Uint8Array` copies
when the room loads; we don't need the original resource file open
once `enterRoom` returns.

## 7. LSCR — local scripts

A `ROOM` can carry an arbitrary number of `LSCR` children, each
holding one **room-local script**. The first byte of an `LSCR`
payload is the script's id (typically 200..255); the rest is the
bytecode.

SCUMM v5 routes `startScript` opcodes with id ≥ 200 through the
current room's local-script table rather than the global directory.
The room loader collects every `LSCR` into a `Map<id, Uint8Array>`,
and the `startScript` handler dispatches to either `vm.loadedRoom?
.localScripts.get(id)` (for `id >= 200`) or `vm.resolveGlobalScript
(id)` (for `id < 200`).

Mid-cutscene scripts often live as LSCRs — they're tightly bound to
one room and don't need to be exposed in the global directory. MI1's
title room has 5 LSCRs (200..204) covering the menu, intro music
cue, and copy-protection check sequencing.

When `enterRoom` swaps to a new room, the previous room's LSCR
bytecode is no longer reachable (it lived inside the previous
`LoadedRoom`). Any still-running slot referencing it keeps its
`Uint8Array` alive by reference — JavaScript GC takes care of the
rest.

## 8. CYCL, SCAL — deferred

- **CYCL** lists palette-index ranges that cycle on a timer (water,
  flames, animated mouths). The compositor would mutate the
  palette's RGB triplets in place at the cycle rate. Phase 9
  alongside audio + polish.
- **SCAL** holds 4 perspective-scale slots, each `(scale1, y1,
  scale2, y2)`, defining a per-y interpolation that scales actors as
  they walk toward / away from the camera. Walk boxes reference one
  of these slots via `box.scaleSlot`. Phase 7 polish item — most
  MI1 rooms work fine without it visually until walking-into-distance
  scenes need it (Scumm Bar dock, Big Whoop, …).

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
