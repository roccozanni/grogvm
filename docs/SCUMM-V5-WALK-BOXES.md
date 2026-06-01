# SCUMM v5 — Walk Boxes (`BOXD` + `BOXM`)

Walk boxes describe **where in a room an actor is allowed to walk**.
They're convex quadrilaterals (think trapezoids that fit the
perspective of the room art) tiling the floor, with metadata for how
boxes connect to each other and how actor scale changes with depth.

A room has two blocks for this:

- **`BOXD`** — *box data*. The geometry of each box (four corner
  points), plus per-box flags and a SCAL slot.
- **`BOXM`** — *box matrix*. A compressed `N × N` adjacency table
  the original engine uses to plan walks across boxes via a graph
  search. GrogVM doesn't decode it; the included pathfinder
  works off a rasterized version of `BOXD` directly. See
  [`PATHFINDING.md`](PATHFINDING.md).

## Sources

The per-box record layout here was derived empirically from MI1
rooms 10 (title), 30 (an interior with 9 boxes), and 32. The
`2 + 20 × count` payload shape holds across every room we sampled,
and the per-byte field interpretation is consistent with the way
the SCAL block and `actorOps SO_IGNORE_BOXES` opcode reference
these fields.

## 1. Where they live

```
LECF
└── LFLF
    └── ROOM
        ├── ... (RMHD, CLUT, SMAP, etc.)
        ├── BOXD     ← THIS DOCUMENT — usually present, sometimes absent
        └── BOXM     ← paired with BOXD, also usually present
```

A room can omit both — title-screen rooms, cutscene rooms, and
inventory pop-ups have no walk geometry. The loader treats absence
as "no walk boxes" rather than throwing, and the pathfinder falls
back to straight-line walking in that case.

## 2. BOXD layout

```
┌────────────────────┬─────────────────────────────────┐
│ count   (u16 LE)   │ count × 20-byte box records     │
└────────────────────┴─────────────────────────────────┘
```

Total payload = `2 + 20 × count`.

### Per-box record (20 bytes)

| Offset | Size | Field         | Meaning                                                       |
|--------|------|---------------|---------------------------------------------------------------|
| 0      | i16  | `ulx`, `uly`  | Upper-left corner (signed pixel coords).                      |
| 4      | i16  | `urx`, `ury`  | Upper-right corner.                                           |
| 8      | i16  | `lrx`, `lry`  | Lower-right corner.                                           |
| 12     | i16  | `llx`, `lly`  | Lower-left corner.                                            |
| 16     | u8   | `mask`        | Y-mask for SCAL. `0x83` is the "no mask" sentinel in MI1.     |
| 17     | u8   | `flags`       | Per-box flags. **Bit 0x80 = invisible** (excluded from paths).|
| 18     | u8   | `scaleSlot`   | Index into the room's `SCAL` table (0 = no per-box scaling).  |
| 19     | u8   | _padding_     | Always zero in MI1/MI2.                                       |

**The corners are stored UL → UR → LR → LL.** A box with corners
`(0, 0, 100, 0, 100, 50, 0, 50)` is the standard `0..100 × 0..50`
rectangle.

**Corners are pixel positions, not pixel ranges.** A box from
`(0, 0)` to `(4, 2)` covers pixels `(0..4, 0..2)` = 5×3 = **15
pixels**, not 8. A common bug when implementing a rasterizer is
treating the second corner as exclusive — the result is a box one
pixel narrower and shorter than intended.

### The "invisible" flag

Box id 0 is conventionally the **"out of bounds" sentinel** — its
corners are all set to a magic value (typically `(0x83, 0x83, ...)`
in MI1) and its flags have bit `0x80` set. The pathfinder skips it
during rasterization, so it never appears on the walkable mask.
Real walkable area starts at box id 1.

Some rooms use the invisible flag for boxes the player can walk
*through* but shouldn't be able to *stop in* (entry portals,
camera-pan trigger zones). The pathfinder treats them all the
same: invisible = no walk.

## 3. Convex quad assumption

Walk boxes in MI1 and MI2 are **always convex**. A rasterizer can
therefore use trapezoid scan-line fill — for each row in the box's
bounding span, compute the leftmost and rightmost edge
intersection, then fill the inclusive span. Cheaper than a general
polygon fill and with no edge cases.

Concretely: at each row `y` between `yMin` and `yMax` (inclusive),
iterate the four edges (UL→UR, UR→LR, LR→LL, LL→UL), and for any
edge whose y-range straddles the row, compute its intersection x
via linear interpolation. The min and max x become the row's left
and right span.

Degenerate boxes (a corner repeated, or all corners collinear like
the box-0 sentinel) produce zero or single-pixel coverage — no
special case needed.

## 4. The walkable mask

The room loader builds a `width × height` byte mask at room-load
time by rasterizing the union of all *visible* boxes. Each byte is
`1` (walkable) or `0` (blocked). Cached on the `LoadedRoom` as
`walkableMask`.

This mask is what the A* pathfinder operates on. See
[`PATHFINDING.md`](PATHFINDING.md) for the search algorithm. The
inspector's walk overlay toggle draws the mask as a faint green
tint over the room canvas, plus the individual box outlines (one
colour per box id) on top.

## 5. BOXM — adjacency matrix

`BOXM` encodes "which boxes you can walk from box A to box B
*directly*" — the SCUMM v5 engine uses this to build paths as a
sequence of box transitions, then refines the in-box trajectory.
Compressed format: per box, a list of `(toBox, viaBox)` runs
terminated by `0xFF`.

GrogVM currently doesn't decode BOXM. A grid A* pathfinder over
the rasterized mask handles every routing case the original
box-graph would, with slightly different aesthetics (grid paths
hug walls; box-graph paths cut diagonally through the middle of
boxes). A box-graph implementation can replace the grid one
without changing the `walkActorTo` call site — both populate
`actor.walkPath`.

## 6. The runtime: walk planning

When a script issues `walkActorTo(id, x, y)`:

1. The opcode handler in `src/engine/vm/opcodes/index.ts` calls
   `startWalk(vm, actor, target)`.
2. `startWalk` checks `vm.loadedRoom?.walkableMask`. If absent or
   empty (rooms without `BOXD`), the actor walks straight-line
   toward the target via the `walkTarget` fallback in `stepWalk`.
3. Otherwise it calls `findPath(mask, width, height, start,
   target)` from the A* module, which returns a waypoint list. The
   first waypoint (= snapped-to-walkable start) is dropped so the
   actor doesn't appear to teleport onto the nearest box edge.
4. The remaining waypoints become `actor.walkPath`. `stepWalk`
   advances toward `walkPath[walkPathIdx]` each tick, bumping the
   index on arrival.

If the actor's `ignoreBoxes` flag is set (cutscene movement bypass,
set by `actorOps` subop `0x14` / `SO_IGNORE_BOXES`), the pathfinder
is skipped entirely and the actor walks straight-line. SCUMM uses
this for camera-locked cinematic motion where the actor needs to
cross non-walkable regions.

## 7. Reference implementation

- Parser: [`src/engine/pathfinding/boxes.ts`](../src/engine/pathfinding/boxes.ts)
  — `parseWalkBoxes(payload) → WalkBox[]` + `isInvisibleBox(box)`.
- Rasterizer: [`src/engine/pathfinding/mask.ts`](../src/engine/pathfinding/mask.ts)
  — `buildWalkableMask(boxes, w, h) → Uint8Array`.
- Tests:
  [`boxes.test.ts`](../src/engine/pathfinding/boxes.test.ts) and
  [`mask.test.ts`](../src/engine/pathfinding/mask.test.ts) — synthetic
  fixtures: single rectangle, overlapping boxes, invisible-flag skip,
  trapezoid scan-line fill, mask-bounds clipping.

## 8. Inspector overlay

The VM frame canvas has a "walk overlay" checkbox. When on, a
transparent canvas stacked over the frame draws:

- Faint green tint (alpha ~11%) on every walkable pixel.
- One-pixel outline of each visible box, colour-keyed by box id,
  with the id as a small label at the box's top-left.
- Active actor walk paths as yellow polylines with waypoint dots.
- Each actor's current position as an orange marker.

Off by default — the colours add visual noise that's only useful
while debugging walks.
