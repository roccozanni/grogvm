# SCUMM v5 — Resource File (`MONKEY.001`)

The resource file (`MONKEY.001` for MI1, `MONKEY2.001` for MI2) holds the
game's bulk data: every room, global script, sound, costume, and charset. It
is one big tree of tagged blocks under a single `LECF` container. The `.000`
[index file](index-file.md) and the `LOFF` table at the top of this file are
what turn a resource *id* into a byte position inside it.

## At a glance

```
MONKEY.001
└─ LECF                    LucasArts container — the whole file
   ├─ LOFF                 room id → ROOM offset  (see Index File)
   └─ LFLF × N             one bundle per room
      ├─ ROOM              the room itself  (see ROOM Block)
      │  ├─ RMHD           width, height, object count
      │  ├─ CLUT           256-entry room palette
      │  ├─ TRNS           transparent palette index
      │  ├─ EPAL           legacy EGA palette (unused on VGA)
      │  ├─ CYCL           colour-cycling effects
      │  ├─ SCAL           perspective actor scaling
      │  ├─ BOXD           walk boxes  (see Walk Boxes)
      │  ├─ BOXM           walk-box adjacency matrix
      │  ├─ RMIM           background image container
      │  │  ├─ RMIH        image header — z-plane count
      │  │  └─ IMxx        one image frame
      │  │     ├─ SMAP     background bitmap (strips)
      │  │     └─ ZPxx     z-plane masks
      │  ├─ OBIM × M       object image
      │  │  ├─ IMHD        object image header
      │  │  └─ IMxx        per-state image frames
      │  ├─ OBCD × M       object code + name
      │  │  ├─ CDHD        object code header
      │  │  ├─ VERB        verb → script handlers
      │  │  └─ OBNA        object display name
      │  ├─ ENCD           entry script
      │  ├─ EXCD           exit script
      │  ├─ NLSC           local-script count
      │  └─ LSCR × K       room-local scripts
      ├─ SCRP              global script
      ├─ SOUN              sound resource
      ├─ COST              costume (actor animation)
      └─ CHAR              character set / font
```

Every node is a block: a 4-character ASCII tag, then a `u32` **big-endian**
size, then the payload. The size *includes* the 8-byte header, so a block runs
from its tag to `start + size`. Container blocks (`LECF`, `LFLF`, `ROOM`,
`RMIM`, `OBIM`, `OBCD`, `IMxx`) hold other blocks as their payload; the rest
are leaves carrying data. The `.000` index never stores an absolute position
into this file — `LOFF` does.

## Sources

- ScummVM Technical Reference — block / resource layout, at
  <https://wiki.scummvm.org/index.php?title=SCUMM/Technical_Reference>. Block
  roles are summarized in our own words and confirmed empirically against MI1;
  the `LOFF`-points-at-`ROOM` detail below was derived against MI1 (see the
  [index file](index-file.md) doc).

> ⚠️ **Block sizes are big-endian; payload fields are little-endian.** The
> `u32` size after each tag reads big-endian and counts the 8-byte header,
> but the integers *inside* a payload (counts, offsets, coordinates) are
> little-endian. Mixing the two is the classic first-parse bug.

---

## 1. The container layers — `LECF`, `LOFF`, `LFLF`

`LECF` is the single top-level block: the entire `.001` file is its payload.
Its first child is `LOFF`, a table mapping each room id to the absolute byte
offset of that room's `ROOM` block — **not** the enclosing `LFLF` wrapper (the
distinction matters when resolving resources; the byte layout and the reasoning
live in the [index file](index-file.md) doc, §5).

After `LOFF` come the `LFLF` blocks, one per room. An `LFLF` is a "disk" bundle:
it carries that room's `ROOM` block plus any global scripts, sounds, costumes,
and charsets that ship alongside it. A resource directory in the `.000` index
names the *owning room* of each global resource, and the resource physically
lives inside that room's `LFLF` — so a single `LFLF` (in MI1, room 10's) holds
the bulk of the game's global scripts.

---

## 2. Inside a `ROOM`

A `ROOM` block bundles everything about one room — geometry, palette,
background, walkable floor, objects, and scripts — in a canonical child order.
The blocks below are catalogued here as a map of the file; each has its own
deep-dive doc.

| Tag    | Holds                                                                          |
|--------|--------------------------------------------------------------------------------|
| `RMHD` | Room width, height, and object count. *(see [ROOM Block](room.md))*            |
| `CLUT` | The room's 256-entry RGB palette — every indexed pixel maps through it.        |
| `TRNS` | Which palette index is "transparent" when compositing actors/objects.          |
| `EPAL` | Legacy 16-colour EGA palette. Present but unused in the VGA releases we target. |
| `CYCL` | Colour cycling — palette-rotation effects (water shimmer, candle flicker, fire). |
| `SCAL` | Y-scaled actor sizing — smaller "into" the screen, larger toward the camera. *(palette + scale: [Room Lighting](lighting.md))* |
| `BOXD` | Convex polygons for the walkable floor — the pathfinding graph.                |
| `BOXM` | Walk-box adjacency matrix. *(both: [Walk Boxes](walk-boxes.md))*               |

**Background image (`RMIM`).** `RMIM` is a container for the room's background
and its z-plane masks: `RMIH` (a header whose key field is the number of
z-planes that follow), then one `IMxx` frame holding the `SMAP` bitmap and any
`ZPxx` masks. `SMAP` stores the picture as 8-pixel-wide vertical strips, each
compressed independently; each `ZPxx` is a per-strip mask of the pixels actors
should be drawn *behind*. See [Background Bitmaps](smap.md) and
[Z-Plane Masks](zplane.md).

**Objects (`OBIM` + `OBCD`).** Each room object has two blocks. `OBIM` is its
visual — an `IMHD` (position, dimensions, number of states) plus one or more
`IMxx` frames (e.g. a chest's closed/open states). `OBCD` is its interactive
side — a `CDHD` (id, position, dimensions, parent object), a `VERB`
(verb-id → bytecode handlers for Look At / Pick Up / Use), and `OBNA` (the
display name shown on hover). See [Room Objects](objects.md).

**Room scripts.** `ENCD` and `EXCD` are the bytecode that runs as the player
enters and leaves the room. `NLSC` gives the count of room-local scripts, each
of which follows as an `LSCR` block (id + bytecode body). The bytecode itself
is the [opcode reference](opcodes.md)'s subject.

---

## 3. Per-`LFLF` global leaves

Alongside the `ROOM`, an `LFLF` may carry global resources that the `.000`
directories assign to this room:

| Tag    | Holds                                                                       |
|--------|-----------------------------------------------------------------------------|
| `SCRP` | A global script callable from anywhere — cutscenes, recurring routines. *(see [Opcodes](opcodes.md))* |
| `SOUN` | One sound resource — iMUSE MIDI for music, samples/speech for effects/voice. *(see [Sound](sound.md))* |
| `COST` | An actor's animation data — limbs × frames × commands. *(see [Costumes](cost.md))* |
| `CHAR` | A bitmap font for dialogue and the verb interface. *(see [Bitmap Fonts](char.md))* |

---

## 4. Pitfalls cheat-sheet

| Trap | Symptom | Cure |
|------|---------|------|
| Reading the block size little-endian | Sizes are absurdly large; the walk overruns the file | The 4-byte size after a tag is big-endian (§At a glance) |
| Treating the size as payload-only | Every nested block lands 8 bytes short | Size includes the 8-byte header — payload is `[start+8, start+size)` |
| Anchoring resource offsets on the `LFLF` | Resolves into header padding / garbage tags | `LOFF` and the index offsets anchor on the `ROOM` block (§1) |
| Expecting room positions in the `.000` index | No usable offsets there | `LOFF` at the top of `.001` carries them (see [Index File](index-file.md)) |
| Rendering through `EPAL` | Wrong, washed-out colours | `EPAL` is the unused EGA palette; VGA rooms use `CLUT` |
