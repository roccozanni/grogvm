# Pathfinding — SCUMM Box-Graph Routing (BOXM)

GrogVM routes the way the original SCUMM engine does: **across the graph
of walk boxes**, planned through the `BOXM` matrix. (Phase 6 shipped a
grid-A*-over-a-rasterized-mask stand-in; it was replaced by this faithful
box-graph router because the two pick *different routes* through the same
geometry — see §8.)

The thing that walks is `Actor.walkPath`, an array of pixel waypoints.
Pathfinding's job is to populate it given a start point, a target point,
and the room's walk-box geometry + matrix. The walker (`stepWalk` in
`src/engine/actor/walk.ts`) doesn't care how the path got there — it just
steps toward the next waypoint each tick.

## 1. The two data blocks

A room's walk geometry is two ROOM child blocks:

- **`BOXD`** — the walk boxes. Each box is a convex quadrilateral (four
  corners UL, UR, LR, LL) plus a z-plane mask byte, a flags byte (bit
  `0x80` = invisible / non-walkable), and a `SCAL` scale slot. Parsed by
  `parseWalkBoxes` (see [`walk-boxes.md`](scumm/walk-boxes.md)).
- **`BOXM`** — the box matrix: SCUMM's per-box shortest-path lookup. For
  each source box it answers "to reach box *D*, which box do I step into
  next?" Parsed by `parseBoxMatrix`.

Many MI1 rooms include **degenerate "line" boxes** — quads collapsed to a
zero-area segment (a staircase tread, a cliff edge, the room-52 bridge).
They're pure routing connectors: an actor stands *on* the line, and the
box graph threads through them. The grid-mask approach mangled these
(A* hugged the single rasterized pixel row); the box graph routes them
as first-class hops.

## 2. The BOXM format

Verified empirically against MI1 rooms 28/33/38/52:

```
BOXM payload:
  numBoxes rows, stored back-to-back in box-id order. Each row:
    a run of 3-byte (from, to, next) triples, 0xFF-terminated.
  The whole block is padded to even length with a trailing 0x00.
```

A triple `(from, to, next)` means "to reach any destination box in the
inclusive range `[from, to]`, step into box `next`." `getNextBox(from, to)`
scans `from`'s row for the triple whose range covers `to` and returns its
`next`, or `-1` when `to` is unreachable from `from`.

Example (room 38, box 1): `(1,1,1) (2,5,3)` — "to reach box 1, you're
there; to reach any of boxes 2..5, step into box 3."

There is no count header — `numBoxes` comes from `BOXD`. Rooms with `BOXD`
but no `BOXM` route straight-line (none in MI1's walkable rooms).

## 3. The router

`routeThroughBoxes(boxes, matrix, start, goal)`:

1. **Snap endpoints to boxes.** `startBox` / `destBox` via
   `findBoxAtOrNearest` (nearest visible box when the point is off every
   box — clicks land off the floor all the time).
2. **Clamp the target into its box** (`closestPointInBox`, SCUMM's
   `adjustXYToBeInBox`): a click off the floor walks to the nearest floor
   point; an off-screen exit target inside a box that extends past the
   screen edge is reached exactly (MI1 room 78's exit is at x=-25).
3. **Follow BOXM.** `next = getNextBox(cur, destBox)` until `cur ==
   destBox`, building the box sequence. Bounded by box count so a
   malformed matrix can't loop forever.
4. **Gate per transition.** For each consecutive box pair, a crossing
   point on their shared boundary (§4); string them together, ending at
   the (clamped) target.

Each straight segment of the result lies inside one convex box
(start→gate ⊆ box A, gate→nextgate ⊆ box B), so the walker can
interpolate it directly — no per-pixel path, no mask. This is why
box-graph paths "stride through the middle" of a room.

`reachedGoal` is false when the box chain can't reach the target's box
(a sealed route). The final waypoint is then clamped into the *furthest
reachable* box, so the actor stops at the seal instead of walking straight
through the locked region.

## 4. Gate points

`gateBetween(a, b, target)` picks where an actor crosses from box `a` into
adjacent box `b`. SCUMM transitions at the shared boundary; we find it as a
**collinear, overlapping edge pair** — `a`'s edge and `b`'s edge on the same
vertical (shared x) or horizontal (shared y) line, with an overlapping
span. The gate is the point on that overlap closest to the target (clamped
to the span), so the actor heads toward its goal as it crosses; the widest
shared edge wins when several qualify.

Diagonal / corner-touching boxes (the staircase and cliff "line" boxes
share an *endpoint*, not an axis-aligned edge) have no collinear edge —
there we fall back to the midpoint of the closest pair of points between
the two outlines (segment-segment closest point, Ericson), which resolves
to the shared corner.

> **Fidelity note.** SCUMM's exact gate routine (`findPathTowards`) is
> engine C, not game bytecode, so it can't be ground-truthed against the
> data files here. The collinear-edge gate is geometrically faithful and
> validated by rendering real routes, not by claiming bit-exactness.

## 5. Runtime box locking (`matrixOp setBoxFlags`)

Walk-box flags are runtime state: a script locks a box (flag bit `0x80`)
to seal a corridor when a door shuts, unlocks it when the door opens.
SCUMM stores box flags in the in-memory room and resets them to disk
values on every room load; the entry script (ENCD) re-applies the locks.

We mirror that with **per-box overrides** in `vm.boxFlagOverrides` (box id
→ flags), the same pattern as `objectStates`/`objectOwners`, rather than
mutating the readonly room:

- `vm.setBoxFlags(boxId, flags)` (the `matrixOp` 0x30 sub 0x01 opcode)
  records the override. Nothing is rebuilt — the router reads overrides
  **live** each walk.
- `startWalk` folds overrides into the box list (`effectiveBoxes`) before
  routing, so `isInvisibleBox` drops a locked box from both endpoint
  snapping and the hop chain — you can't route through a sealed corridor.
- Overrides reset on a real room change (`enterRoom` clears them; ENCD
  re-applies) and are saved (`SaveState.boxFlags`), because restore
  reloads the room fresh but does not re-run ENCD.

Example: room 41's door 564 — its ENCD locks boxes 4/5 when the door is
closed, sealing the corridor behind it. `setBoxScale` (sub 0x02/0x03) and
`createBoxMatrix` (sub 0x04) remain no-ops (scale is read from SCAL at
load; the matrix is parsed from disk).

## 6. Walker integration

When `walkActorTo(actor, x, y)` fires:

1. The opcode handler calls `startWalk(vm, actor, target)`.
2. `startWalk` bails to a straight-line walk (via `stepWalk`'s
   `walkTarget` fallback) when the room has no boxes or the actor's
   `ignoreBoxes` flag is set (cutscene movement that crosses non-walkable
   regions).
3. Otherwise `routeThroughBoxes` runs over `effectiveBoxes`; its waypoints
   become `actor.walkPath`. The actor's current position is *not* prepended
   — the walker starts from where the actor already is.

Per tick, `stepWalk` advances `actor.x` / `actor.y` toward the active
waypoint by `walkSpeedX` / `walkSpeedY` (SCUMM defaults 8 / 2 —
horizontal-biased), bumps the index on arrival, and stops on the final
waypoint. Facing follows a short look-ahead along the path.

## 7. The room-52 high/low guard (worked example)

Room 52 (the Fettucini clearing) is a high zone (right, where you enter)
and a low zone (left, the tent), joined by the diagonal bridge **box 7**.
Local script 202 force-stops the ego whenever it's in box 7 at `x > 200`,
so you can't walk straight across — you descend into the low zone first,
then walk to the tent. The box-graph route threads the whole 12-box chain
correctly; the guard is faithful game logic, and the walkthrough stages the
walk in short hops exactly as a player clicks their way down.

## 8. Why box graph, not grid A*

Phase 6's grid-A*-over-a-rasterized-mask flattened the union of all visible
boxes into a binary mask and ran A* over it. It worked on every room and
was easy to visualize, but it **ignored BOXM** — A* hugged whatever pixels
were shortest. Two confirmed divergences it caused:

- **Room 28 cook.** Between x≈367–466 the only walk box is box 6, a
  degenerate line at y=140. The mask had walkable pixels only there, so A*
  routed the cook along that bottom edge, where the foreground table
  z-plane sliced its torso. The box graph follows BOXM's intended sequence
  instead.
- **Room 52 → circus.** The long route to the tent threads 14 boxes,
  several degenerate. A* over the mask truncated it (the ego stalled
  partway, sometimes heading for the exit). The box graph walks the full
  chain.

Trade-off inherited from the box-graph model: paths cut diagonally through
the middle of boxes (one edge crossing per transition) rather than hugging
walls — which reads as "the actor walks through the room," matching the
original.

## 9. Known limitation — independent-axis stepping vs. line-following

`stepWalk` advances X and Y by `walkSpeedX` / `walkSpeedY`
**independently** (each clamped to the remaining distance). SCUMM moves the
actor *along the line* toward the waypoint (`calcMovementFactor`: dominant
axis at full speed, the other proportional). On a near-horizontal diagonal
connector box, our walker exhausts the small Y delta in one tick and then
drifts straight along the wrong Y, leaving the thin box; `getActorWalkBox`
(which re-derives the box from position) then reports the wrong box.

This is why a *single* click can't cross room 52's bridge (§7) and why thin
diagonal connectors are fragile in general. The faithful follow-up is a
two-part change, deferred as its own task: (a) a line-following walker
(`calcMovementFactor` with sub-pixel accumulation), and (b) tracking the
actor's walk-box as state updated at gate crossings (SCUMM's `_walkbox`)
rather than re-deriving it from pixel position. Tracked in PROGRESS.

## 10. Reference implementation

- [`src/engine/pathfinding/boxes.ts`](../src/engine/pathfinding/boxes.ts)
  — `parseWalkBoxes` (BOXD), `parseBoxMatrix` + `getNextBox` (BOXM),
  `pointInBox`, `findBoxAt` / `findBoxAtOrNearest`.
- [`src/engine/pathfinding/boxgraph.ts`](../src/engine/pathfinding/boxgraph.ts)
  — `routeThroughBoxes`, `gateBetween`, `closestPointInBox`, the
  segment-segment closest-point helper.
- [`src/engine/actor/walk.ts`](../src/engine/actor/walk.ts) — `startWalk`
  (routing + `effectiveBoxes`), `stepWalk`, the path-follow state machine.
- Tests:
  [`boxes.test.ts`](../src/engine/pathfinding/boxes.test.ts) (BOXD + BOXM
  decode),
  [`boxgraph.test.ts`](../src/engine/pathfinding/boxgraph.test.ts) (router,
  gates, locked-box seal, box clamping),
  [`walk.test.ts`](../src/engine/actor/walk.test.ts) (stepping, off-screen
  box targets, scale).
