# Pathfinding — Grid A* over a Walkable Mask

GrogVM uses **grid A***, not the original SCUMM box-graph
pathfinder. This document explains the architecture, the rationale,
and the trade-offs.

The thing that walks is `Actor.walkPath`, an array of pixel
waypoints. Pathfinding's job is to populate it given a start point,
a target point, and the room's walk-box geometry. The walker
(`stepWalk` in `src/engine/actor/walk.ts`) doesn't care how the
path got there — it just steps toward the next waypoint each tick.

## 1. The two ways SCUMM v5 pathfinds

The original engine walks **across a graph of walk boxes**. Each
box has a polygon outline; the `BOXM` block lists which boxes are
directly reachable from which other boxes. A path is planned as a
sequence of box transitions (`5 → 7 → 8`), and the in-box trajectory
is refined per transition.

GrogVM uses a different approach: **flatten the union of all
visible walk boxes into a binary mask, then A* over that mask**.
The boxes are still parsed for their flags and SCAL slots (per
[`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md)), but only the
geometry is used at planning time.

Reasons to prefer the grid approach:

- A binary mask is **straightforward to visualize** — tint
  walkable pixels and the route options are obvious at a glance.
- A* is **a well-known algorithm** with predictable performance
  and known correctness, with no dependence on decoding BOXM's
  compressed adjacency encoding.
- The output (a list of pixel waypoints) is the same shape as the
  box-graph approach, so the walker doesn't care which algorithm
  produced it. A box-graph pathfinder is a drop-in replacement.

Trade-off: A* paths **hug walls** (shortest grid path) while
box-graph paths **cut diagonally through the middle of boxes**
(each box transition is a single edge crossing). The box-graph
version reads more like "the actor walks through the room"; the
grid version reads more like "the actor hugs the corridor." Choose
based on the aesthetic you want.

## 2. The mask

`buildWalkableMask(boxes, width, height)` rasterizes the union of
all *visible* boxes (skipping any with the `0x80` flag bit set)
into a `width × height` byte buffer. 1 = walkable, 0 = blocked.

The rasterizer uses **convex-quad scan-line fill** since every walk
box is a convex quadrilateral. For each row in the box's bounding
span, it computes the left and right edge intersections by linear
interpolation across the four edges, then fills the inclusive span.
Cheaper than a general polygon fill, and no need for the standard
edge-table / active-edge-list machinery a general polygon-fill
algorithm uses.

The mask is cached on `LoadedRoom.walkableMask` at room-load time,
so a path query is `findPath(mask, w, h, start, target)` with no
per-query rasterization.

## 3. The A* search

`findPath` is straight A*:

- **State** — one byte per cell (the mask byte) plus per-search
  `Float64Array` for `gScore` and `Int32Array` for `cameFrom`.
- **Open list** — a binary min-heap keyed by `gScore + heuristic`.
  Storing cell indices as `Int32` rather than allocating objects
  per node keeps the hot loop allocation-free after warmup.
- **Closed set** — a `Uint8Array` flag per cell; cells whose
  closed flag is set are skipped when popped from the heap, which
  handles the "stale entry" case without needing a decrease-key
  operation.
- **Neighbours** — 8-connectivity. Cardinal moves cost 1, diagonal
  moves cost √2. Gives smoother paths than 4-connectivity without
  much extra work.
- **Heuristic** — *octile distance*: `dx + dy + (√2 - 2) ×
  min(dx, dy)`. Admissible (never overestimates), tighter than
  Manhattan for 8-connectivity, faster than Euclidean (no `sqrt`
  in the inner loop).
- **Termination** — pop until the goal is reached, the heap empties,
  or every reachable cell has been expanded. The last case happens
  when the goal is in a disjoint region from the start (e.g. an
  unreachable obstacle); a partial path to the closest expanded
  cell is returned instead.

The output is a flat list of pixel waypoints from start to
(best-reachable) goal. A `reachedGoal: false` flag signals that the
requested goal proper is unreachable — the walker can still walk
the partial path so the actor doesn't appear stuck.

## 4. Snapping endpoints

Start or goal coordinates **off the walkable mask** are normal —
a script can call `walkActorTo(actor, 320, 200)` with no regard
for whether `(320, 200)` is actually a walk-box pixel. Both
endpoints should be snapped to the nearest walkable cell via a
bounded breadth-first search before launching A*. The snap returns
`null` (and hence "no path") only when the entire mask is empty.

Out-of-bounds coords should be clamped to the mask's
`[0, width) × [0, height)` rectangle before snapping. A click
outside the room boundary then produces a sensible target inside
the walkable area.

Snap distance can be large (a click far from any walkable region
snaps to the nearest edge), but it's bounded by the mask size and
the search itself is `O(width × height)` worst case. At MI1's
typical 320×144 = 46k pixels, the worst-case snap is
sub-millisecond.

## 5. Path simplification

Raw A* output is per-pixel — a 100-pixel diagonal walk produces
100 waypoints. The simplifier collapses runs of waypoints that
share a direction into single segments, so the polyline is
**corner turns only**. A diagonal walk through an empty room
becomes 2 waypoints (start, end). An L-shaped walk around an
obstacle is 3 waypoints (start, corner, end).

This is what the walker wants — it interpolates straight-line
motion between waypoints, so fewer waypoints means fewer
arrival-and-advance cycles per second. The actor moves visually
identically to the per-pixel path but with much less per-tick
overhead.

## 6. Walker integration

When `walkActorTo(actor, x, y)` fires:

1. The opcode handler in `src/engine/vm/opcodes/index.ts` calls
   `startWalk(vm, actor, target)`.
2. `startWalk` checks `vm.loadedRoom?.walkableMask`. If absent /
   empty, the actor's `walkTarget` is set and `walkPath` left
   empty — `stepWalk` then walks straight-line via the fallback.
3. Otherwise `findPath` runs. The first waypoint (= snapped start)
   is dropped so the actor doesn't appear to teleport onto the
   nearest box edge; the rest become `actor.walkPath`.
4. `actor.isMoving` flips true, `walkPathIdx` starts at 0.

Per-tick, `stepWalk` advances `actor.x` / `actor.y` toward
`walkPath[walkPathIdx]` by the actor's `walkSpeedX` / `walkSpeedY`
(SCUMM defaults 8 / 2 — horizontal-biased to match the engine's
perspective convention). On arrival at a waypoint the index is
bumped; on arrival at the *final* waypoint `isMoving` flips off
and the walk is done.

The actor's `facing` updates each tick from the dominant
component of the step (`|dx| ≥ |dy|` → E/W, otherwise N/S).

If the actor's `ignoreBoxes` flag is set (cutscene movement
bypass, via the `actorOps` subop `0x14`), the pathfinder is
skipped and the actor walks straight-line. SCUMM uses this for
camera-locked cinematic motion that needs to cross non-walkable
regions.

## 7. Performance

A* on the rasterized mask is comfortably real-time at MI1's
resolution. A worst-case probe — 320×144 mask, start at one
corner, goal at the opposite — completes in well under 50 ms on
modest hardware. The dominant cost is the priority queue at high
node counts; the binary heap with packed `Int32Array` storage
keeps the constants small.

In practice rooms route in a few milliseconds at most. A wider
room (640×200 for MI1's title scrolling room) doubles the worst
case to ~100 ms which is still fine for once-per-walk planning.

The mask itself is computed once at room-load time and reused for
every walk that takes place in that room.

## 8. BOXM-style box-graph alternative

For the more cinematic "actor strides through the middle of the
box" aesthetic — or to handle walk geometry that doesn't
rasterize cleanly — a box-graph pathfinder can replace `findPath`
without changing the call site. Both populate `actor.walkPath` with
the same `Point[]` shape.

What's needed:
- A BOXM decoder for the per-box "next-hop" adjacency table.
- A path-planning routine that, given start box and goal box,
  emits the corner-to-corner waypoint sequence the actor walks.

The existing walk-box parser already extracts everything else
(corners, flags, scale slots), so a box-graph pathfinder is mostly
a routing layer on top of it.

### Known divergence this would fix (deferred)

Grid-A*-over-mask and SCUMM's box-graph pick **different routes** through
the same geometry, and the difference is visible. In **room 28** (the SCUMM
Bar) the cook (actor 6, `alwaysZclip=1`) walks across the bar; between
x≈367–466 the only walk box is **box 6, a degenerate line at y=140** (its
four corners all share y=140). Our mask therefore has walkable pixels *only*
at y=140 there, so A* routes the cook along that bottom edge. At y=140 the
room's foreground z-plane — a horizontal band at the table top (y≈102–122) —
slices the cook's torso out (head above the band, legs below, middle hidden).
ScummVM's box-graph routes the same walk box-to-box (nearer the box "centre"
line), keeping the actor higher where it clears the band. The clip and the
z-plane are both faithful; only the **route** differs. Confirmed by comparing
our path to ScummVM's on the same save. Tabled until/unless we add the
box-graph router above.

## 9. Reference implementation

- [`src/engine/pathfinding/grid.ts`](../src/engine/pathfinding/grid.ts)
  — `findPath(mask, w, h, start, goal) → PathResult`, the binary
  heap, the BFS snap, the simplifier.
- [`src/engine/pathfinding/mask.ts`](../src/engine/pathfinding/mask.ts)
  — `buildWalkableMask(boxes, w, h)` with the convex-quad scan-line
  fill.
- [`src/engine/actor/walk.ts`](../src/engine/actor/walk.ts) —
  `stepWalk(actor)`, `stepAllActorWalks(vm)`, the path-following
  state machine.
- Tests:
  [`grid.test.ts`](../src/engine/pathfinding/grid.test.ts),
  [`mask.test.ts`](../src/engine/pathfinding/mask.test.ts),
  [`walk.test.ts`](../src/engine/actor/walk.test.ts) — synthetic
  fixtures covering open rooms, single-obstacle routing, disjoint
  regions, snap-to-walkable, single-pixel islands, mask-bounds
  clipping, path-following with multi-waypoint paths.

## 10. Runtime box locking (`matrixOp setBoxFlags`)

Walk-box flags are **runtime state**, not just disk data: a script locks a
box (flag bit `0x80`) to seal a corridor when a door is shut, and unlocks it
when the door opens. SCUMM stores box flags in the in-memory room, resets
them to disk values on every room load, and the entry script (ENCD)
re-applies the door-state locks.

We mirror that:
- The room re-parses fresh from disk on every entry (no VM room cache), so
  `LoadedRoom.walkBoxes` always carry the disk flags. Runtime changes layer
  on top as **per-box overrides** in `vm.boxFlagOverrides` (box id → flags) —
  the same pattern as `objectStates`/`objectOwners`, *not* a mutation of the
  readonly room.
- `vm.setBoxFlags(boxId, flags)` (called by the `matrixOp` opcode, 0x30 sub
  0x01) records the override and rebuilds `LoadedRoom.walkableMask` in place
  via `buildWalkableMask` with the overrides applied (`maskFromBox`/§2 already
  drop `0x80` boxes, so the pathfinder needs no change).
- Overrides **reset on a real room change** (`enterRoom` clears them; ENCD
  re-applies) and are **saved** (`SaveState.boxFlags`), because restore
  reloads the room fresh but does *not* re-run ENCD.

Example: room 41's door 564 — its ENCD locks boxes 4/5 (`setBoxFlags 4,128`)
when the door's state is closed, sealing the corridor behind it; opening it
unlocks them. Before this landed, `matrixOp` was a no-op and you could walk
through closed doors. `setBoxScale` (sub 0x02/0x03) and `createBoxMatrix`
(sub 0x04) remain no-ops — scale is read from SCAL at load, and the mask is
already rebuilt per `setBoxFlags`.
