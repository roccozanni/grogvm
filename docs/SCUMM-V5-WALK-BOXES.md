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

## 4. BOXM — the box matrix

`BOXM` is SCUMM's per-box shortest-path lookup: "to reach box *D*
from box *S*, step into box *N* next." The engine plans a path as a
sequence of box transitions and refines the in-box trajectory per
hop. Format (per box, `0xFF`-terminated, whole block even-padded):
a run of 3-byte `(from, to, next)` triples, where `[from, to]` is an
inclusive *destination* range and `next` the hop. `parseBoxMatrix`
decodes it; `getNextBox(from, to)` reads it.

GrogVM routes over this graph — the faithful SCUMM approach. See
[`PATHFINDING.md`](PATHFINDING.md) for the router, the gate
computation, and why it replaced the earlier grid-A*-over-a-mask.
The inspector's walk overlay toggle draws the box outlines (one
colour per box id) over the room canvas.

## 5. The runtime: walk planning

When a script issues `walkActorTo(id, x, y)`:

1. The opcode handler in `src/engine/vm/opcodes/index.ts` calls
   `startWalk(vm, actor, target)`.
2. `startWalk` bails to a straight-line walk (the `walkTarget`
   fallback in `stepWalk`) when the room has no boxes or the actor's
   `ignoreBoxes` flag is set — SCUMM uses the latter for camera-locked
   cinematic motion that crosses non-walkable regions.
3. Otherwise `routeThroughBoxes(boxes, matrix, start, target)`
   returns a gate-waypoint list (boxes carry any runtime flag
   overrides; locked `0x80` boxes are excluded). The waypoints become
   `actor.walkPath` — the actor's current position is not prepended.
   `stepWalk` advances toward `walkPath[walkPathIdx]` each tick,
   bumping the index on arrival.

### Perspective-scale recompute timing

An actor's scale is resolved from the `SCAL` slot of the box it stands in,
by its `y` (small at the back, full at the front). The non-obvious part is
*when* to recompute it: on **position change**, not on every tick.
`rescaleActorForPosition(vm, actor)` does the lookup, and it runs at two
moments — each walk step (`stepAllActorWalks`, gated on `isMoving`), **and
every discrete placement event**: `loadRoomWithEgo`, `putActor`,
`putActorAtObject`. The placement rescale is load-bearing: enter a far-view
room (e.g. the street, 78) via `loadRoomWithEgo` and a *standing* ego would
otherwise keep its pre-transition scale and render full-size until its
first walk step. It is deliberately kept **off** the per-idle-tick path so
a script-pinned static actor (the room-38 fire, set smaller than its floor
scale via `setScale`) isn't clobbered — placement is one-shot, so a
`setScale` that runs after placement in the same script still wins. A box
with no `SCAL` slot (or no box) resets the actor to full size, so a sub-255
scale never sticks across rooms.

**`ignoreBoxes` actors are exempt from box scaling.** An actor off the walk-box
grid keeps the scale a script set — `rescaleActorForPosition` early-returns when
`actor.ignoreBoxes`. Room 51's cannon launch is the case: the flight actor (11,
costume 40) is set `ignoreBoxes; scale 255,255` and arcs up to y≈36, where the
box's `SCAL` slot interpolates to ~1; without the exemption the placement
rescale shrank it to a **single dot** mid-flight. (Same off-grid principle as
the `ignoreBoxes` z-clip rule — see [ZPLANE](SCUMM-V5-ZPLANE.md).)

## 7. Reference implementation

- Parsers: [`src/engine/pathfinding/boxes.ts`](../src/engine/pathfinding/boxes.ts)
  — `parseWalkBoxes(payload) → WalkBox[]` (BOXD), `parseBoxMatrix(payload,
  numBoxes)` + `getNextBox` (BOXM), `isInvisibleBox`, `findBoxAt` /
  `findBoxAtOrNearest`.
- Router: [`src/engine/pathfinding/boxgraph.ts`](../src/engine/pathfinding/boxgraph.ts)
  — `routeThroughBoxes`, `gateBetween`, `closestPointInBox`.
- Tests:
  [`boxes.test.ts`](../src/engine/pathfinding/boxes.test.ts) (BOXD +
  BOXM decode, point-in-box) and
  [`boxgraph.test.ts`](../src/engine/pathfinding/boxgraph.test.ts)
  (routing, gates, locked-box seal, target clamping).

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
