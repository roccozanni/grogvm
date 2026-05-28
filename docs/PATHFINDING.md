# Pathfinding — Grid A* over a Walkable Mask

webscumm uses **grid A***, not the original SCUMM box-graph
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

webscumm uses a different approach for Phase 6: **flatten the union
of all visible walk boxes into a binary mask, then A* over that
mask**. The boxes are still parsed for their flags and SCAL slots
(per [`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md)), but only
the geometry is used at planning time.

Why?

- The mask is **straightforward to visualize** — the inspector
  tints walkable pixels green so the user can see exactly where
  the actor can step.
- A* is **a well-known algorithm** with predictable performance
  and known correctness — no need to chase down BOXM's compressed
  adjacency encoding to make walking work.
- The output (a list of pixel waypoints) is the same shape as the
  box-graph approach, so the walker doesn't care which algorithm
  produced it. Swapping in a box-graph pathfinder later is a
  drop-in replacement.

Trade-off: A* paths **hug walls** (they take the shortest grid
path) while box-graph paths **cut diagonally through the middle of
boxes** (since each box transition is a single edge crossing).
Aesthetically the box-graph version reads more like "the actor is
walking through the room" while the grid version reads more like
"the actor is hugging the corridor." For Phase 6 we accept the
hugging style; Phase 7+ can switch if it matters.

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
- **Closed set** — a `Uint8Array` flag per cell; we skip cells
  whose closed flag is set when popping from the heap, which
  handles the "stale entry" case without needing a decrease-key
  operation.
- **Neighbours** — 8-connectivity. Cardinal moves cost 1, diagonal
  moves cost √2. This gives smoother paths than 4-connectivity
  without much extra work.
- **Heuristic** — *octile distance*: `dx + dy + (√2 - 2) ×
  min(dx, dy)`. Admissible (never overestimates), tighter than
  Manhattan for 8-connectivity. Faster than Euclidean (no sqrt
  in the inner loop).
- **Termination** — pop until we hit the goal, run out of nodes,
  or every reachable cell has been expanded. The last case happens
  when the goal is in a disjoint region from the start (e.g. an
  unreachable obstacle); we then return a partial path to the
  closest cell we expanded.

The output is a flat list of pixel waypoints from start to
(best-reachable) goal. A `reachedGoal: false` flag tells the
caller "we got close, but the goal proper is unreachable" — the
walker still walks the partial path so the actor doesn't just
stand there.

## 4. Snapping endpoints

Start or goal coordinates **off the walkable mask** are normal —
the script can call `walkActorTo(actor, 320, 200)` with no regard
for whether `(320, 200)` is actually a walk-box pixel. We snap
both endpoints to the nearest walkable cell via a bounded
breadth-first search before launching A*. Returns `null` (and
hence "no path") only when the entire mask is empty — the
"no walk boxes at all" case.

Out-of-bounds coords are first clamped to the mask's `[0, width)
× [0, height)` rectangle, then snapped. So a click outside the
room boundary still produces a sensible target inside the
walkable area.

The snap distance can sometimes be large (an actor click far from
any walkable region snaps to the nearest edge), but it's still
bounded by the mask size and the search itself is `O(width ×
height)` worst case. At MI1's typical 320×144 = 46k pixels, the
worst-case snap is sub-millisecond.

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

## 8. Inspector overlay

The VM frame canvas has a "walk overlay" checkbox (see
[`SCUMM-V5-WALK-BOXES.md`](SCUMM-V5-WALK-BOXES.md) §8). When on,
it draws the walkable mask as a faint green tint plus the
per-actor walkPath as a yellow polyline with waypoint dots and an
orange marker on the actor's current position. Off by default —
adds visual noise that's only useful while debugging walks.

## 9. Future: BOXM-style box-graph

If we ever want box-graph paths (for the more cinematic "actor
strides through the middle of the box" aesthetic, or for
correctness with custom walk geometry not representable as a
rasterized mask), the architecture supports a swap:

- `findPath` becomes the only thing that changes. Same signature,
  same return type.
- Walk-box parsing (`parseWalkBoxes`) already extracts everything
  the box-graph would need.
- `BOXM` parsing would be a new module that decodes the per-box
  "next-hop" adjacency table.

Currently no plans to do this. Grid A* is correct, fast, and
visually reasonable; the box-graph approach is a polish step.

## 10. Reference implementation

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
