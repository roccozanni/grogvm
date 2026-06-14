# Pathfinding — SCUMM Box-Graph Routing (BOXM)

GrogVM routes the way the original SCUMM engine does: **across the graph
of walk boxes**, planned through the `BOXM` matrix — not by running a grid
search over a rasterized floor mask. The two approaches pick *different
routes* through the same geometry (see §8), and only the box graph matches
the original.

## At a glance

```
  ● start (in box A)
  │
  │    each straight segment lies inside ONE convex box,
  │    so the walker can interpolate it directly
  ▼
 ─┼─  gate: the crossing point on the shared A|B edge,
  │         placed as close to the target as the edge allows
  ▼
 ─┼─  gate (B|C)
  │
  ▼
  ✕ target (in box C — clamped into the box when the click
            landed off the floor)

  the box sequence A → B → C comes straight out of BOXM:
  "to reach C from A, step into B next" — a chain of lookups,
  no search at routing time
```

The thing that walks is the actor's **walk path**, an array of pixel
waypoints. Pathfinding's job is to populate it given a start point, a
target point, and the room's walk-box geometry + matrix. The walker doesn't
care how the path got there — it just steps toward the next waypoint each
tick.

## 1. The inputs

A room's walk geometry is two `ROOM` child blocks: **`BOXD`**, the walk
boxes (convex quads with a flags byte, z-plane mask, and scale slot), and
**`BOXM`**, the box matrix — SCUMM's per-box "to reach box *D*, step into
box *N* next" lookup. Their wire formats are in
[`walk-boxes.md`](../scumm/walk-boxes.md); this doc is about turning them
into a walk path.

Many MI1 rooms include **degenerate "line" boxes** — quads collapsed to a
zero-area segment (a staircase tread, a cliff edge, the room-52 bridge).
They're pure routing connectors: an actor stands *on* the line, and the
box graph threads through them as first-class hops. The grid-mask approach
mangled these (A* hugged the single rasterized pixel row).

## 2. Reading the matrix

The router consumes the room's *current* matrix as a next-hop oracle — the
disk `BOXM` until a script rebuilds it at runtime (§5): given the current box
and a destination box, it returns the box to step into next (or
"unreachable"). Following that from the start box to the destination box
yields the box sequence to traverse. The matrix encodes shortest paths
directly, so no search is needed at routing time — just the chain of lookups.

## 3. The router

The router, given the boxes, the matrix, a start point and a goal point:

1. **Snap endpoints to boxes.** Resolve the start and destination boxes;
   when a point lands off every box — clicks land off the floor all the
   time — snap to the nearest visible box.
2. **Clamp the target into its box** (SCUMM's `adjustXYToBeInBox`): a click
   off the floor walks to the nearest floor point; an off-screen exit
   target inside a box that extends past the screen edge is reached exactly
   (MI1 room 78's exit is at x=-25).
3. **Follow `BOXM`.** Step from the current box to the matrix's "next box"
   toward the destination, repeatedly, until arriving — building the box
   sequence. Bounded by box count so a malformed matrix can't loop forever.
4. **Gate per transition.** For each consecutive box pair, a crossing
   point on their shared boundary (§4); string them together, ending at
   the (clamped) target.

Each straight segment of the result lies inside one convex box
(start→gate ⊆ box A, gate→nextgate ⊆ box B), so the walker can
interpolate it directly — no per-pixel path, no mask. This is why
box-graph paths "stride through the middle" of a room.

The route reports *goal not reached* when the box chain can't reach the
target's box (a sealed route). The final waypoint is then clamped into the
*furthest reachable* box, so the actor stops at the seal instead of walking
straight through the locked region.

## 4. Gate points

The gate between two adjacent boxes `a` and `b` is where an actor crosses
from one into the other. SCUMM transitions at the shared boundary; we find
it as a **collinear, overlapping edge pair** — `a`'s edge and `b`'s edge on
the same vertical (shared x) or horizontal (shared y) line, with an
overlapping span:

```
   ┌────────────────────┐
   │       box a        │      a's bottom edge and b's top edge
   └────┬───────────┬───┘      sit on the same line and overlap
        │  overlap  │
   ┌────┴───────────┴─────────┐
   │       box b              │
   └──────────────────────────┘

   the gate is the point on the overlap closest to the target
   (clamped to the span) — the actor heads toward its goal as
   it crosses; the widest shared edge wins when several qualify
```

Diagonal / corner-touching boxes (the staircase and cliff "line" boxes
share an *endpoint*, not an axis-aligned edge) have no collinear edge —
there we fall back to the midpoint of the closest pair of points between
the two outlines (segment-segment closest point, Ericson), which resolves
to the shared corner.

> **Fidelity note.** SCUMM's exact gate routine (`findPathTowards`) is
> engine C, not game bytecode, so it can't be ground-truthed against the
> data files here. The collinear-edge gate is geometrically faithful and
> validated by rendering real routes, not by claiming bit-exactness.

## 5. Runtime box locking + matrix rebuild (`matrixOp`)

Walk-box flags are runtime state: a script locks a box (flag bit `0x80`)
to seal a corridor when a door shuts, unlocks it when the door opens.
SCUMM stores box flags in the in-memory room and resets them to disk
values on every room load; the entry script (ENCD) re-applies the locks.

GrogVM mirrors that with **per-box flag overrides** kept beside the room
(the same pattern as object state and ownership), rather than mutating the
read-only room data:

- The `matrixOp setBoxFlags` opcode records an override. The router reads
  overrides **live** on each walk: before routing they're folded into the
  box list, so a locked box drops out of both endpoint snapping and the
  hop chain — you can't route *through* a sealed corridor.
- Overrides reset on a real room change (entering a room clears them; ENCD
  re-applies) and are saved in the save state, because restore reloads the
  room fresh but does not re-run ENCD.

A lock alone only *seals*: the disk matrix still names the locked box as
the next hop, so the route breaks there and the actor stops at the seam
(room 41's door 564 — its ENCD locks boxes 4/5 while the door is closed,
closing the corridor behind it; there is no way around, so stopping is the
whole story).

**`matrixOp createBoxMatrix` rebuilds the routing matrix** from the
current boxes: locked boxes drop out of the box graph entirely and the
next-hop table is recomputed as shortest hop chains (BFS) over the
remaining neighbors — so where an alternative route *does* exist, walks
detour around a freshly sealed region instead of stopping at its seam.
The rebuilt matrix replaces the disk `BOXM` for routing until the next
room change. The save state records that a rebuild happened and recomputes
the matrix from the restored flags on restore.

**Fine print (MI1):** the showcase is the Sea Monkey cabin (room 7):
dragging the Captain's heavy chest out of the cabinet sets it down on the
floor, locks walkbox 11 under it, and rebuilds. The disk matrix routes
2→1 straight through the now-sealed strip — without the rebuild ego is
trapped in front of the cabinet; the rebuilt matrix detours 2→10→9→1
around the chest. The only rebuild sites in MI1 are room 7 (ENCD + the
chest drag) and room 39, both immediately after `setBoxFlags`.

### The neighbor predicate

The rebuild needs to know which boxes connect. SCUMM's own neighbor test
is engine C, not game bytecode, so — like the gate routine (§4) — it can't
be read out of the data files; the rule here is instead *derived from*
them, by classifying every direct hop in MI1's 83 disk matrices against
the pair's geometry. Two boxes connect iff:

1. they have **collinear axis-aligned edges overlapping a positive
   span** — the ordinary abutting-floor case; or
2. a **collapsed (zero-length) edge vertex of one box touches the other
   box's outline** — how the staircase/cliff "line" boxes (both endpoints
   collapsed) and sliver triangles chain together.

Rectangle corners touching point-to-point do **not** connect (room 40's
matrix routes 1→2 via a third box), and neither do two line boxes crossing
mid-span (room 58's forest verticals cross the ground line unlinked).

> ⚠️ The disk `BOXM` generator **ignored the `0x80` flag** — room 85's
> matrix routes straight through flagged boxes — while the runtime rebuild
> must respect it (detouring around fresh locks is its entire purpose).
> Built with flags ignored, the predicate above reproduces the disk
> matrices **hop-for-hop in 82 of 83 rooms**; the exception is room 2's
> box 5, authored-isolated despite real shared edges — and room 2 never
> rebuilds at runtime, so the difference is unobservable in play.

## 6. Walker integration

When a walk-to command fires for an actor, the **no-op case comes first**: if
the actor already stands exactly on the target, SCUMM's `startWalkActor`
returns early and leaves it at rest — it is *not* flagged moving, not even for
the single frame the command lands on. Otherwise:

1. The walk routine plans a path from the actor's current position to the
   target.
2. It bails to a **straight-line walk** when the room has no boxes or the
   actor's *ignore-boxes* flag is set (cutscene movement that crosses
   non-walkable regions).
3. Otherwise it routes through the boxes (honoring any lock overrides), and
   the resulting waypoints become the actor's walk path. The actor's current
   position is *not* prepended — the walker starts from where the actor
   already is.

That zero-distance early-out is load-bearing because **scripts run before the
walk step each frame**: a walk that flagged the actor moving for even one frame
would read as `getActorMoving != 0` to a gate polling that same frame. MI1's
LeChuck-finale punch trigger is exactly such a gate — it fires the instant ego
moves — and the root beer that ends the fight sits on ego's *own* walk-spot, so
picking it up must register as no movement or the punch lands and cancels the
pickup.

Per tick the walker advances the actor toward the active waypoint **along
the line to it** (§9), bumps the waypoint index on arrival, and stops on
the final waypoint.

**Facing while walking** derives from a point **16 px ahead along the
path**, not from the final target. Aimed at the final target, ego faces the
far-east dock for the entire room-33 cliff descent; the look-ahead reads
south down the cliff first, then east along the dock. The distance is
tuned both ways: large enough to smooth the ±1 px jitter of pixel
stepping, small enough that the facing still turns at corners.

**Perspective scale during the walk** comes from the box **assigned** at
each movement step — the same assignment that feeds z-clip (see
[ZPLANE](../scumm/zplane.md)), so the two always agree. The assignment uses
a **nearest-box** fallback rather than strict containment: MI1's thin and
degenerate boxes (the room-33 cliff again) mean a walking actor often sits
strictly inside *no* box, and strict containment left the scale stuck at
its last value until the actor reached a wide box, then popping. Nearest-box
tracks the box the actor is actually walking on, so the scale interpolates
smoothly.

## 7. The room-52 high/low guard (worked example)

Room 52 (the Fettucini clearing) is a high zone (right, where you enter)
and a low zone (left, the tent), joined by the diagonal bridge **box 7**.
Local script 202 force-stops the ego whenever it's in box 7 at `x > 200`,
so you can't walk straight across — you descend into the low zone first,
then walk to the tent. The box-graph route threads the whole 12-box chain
correctly; the guard is faithful game logic, and the walkthrough stages the
walk in short hops exactly as a player clicks their way down.

## 8. Why box graph, not grid A*

The grid-A*-over-a-rasterized-mask approach flattened the union of all
visible boxes into a binary mask and ran A* over it. It worked on every
room and was easy to visualize, but it **ignored BOXM** — A* hugged
whatever pixels were shortest. Two confirmed divergences it caused:

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

## 9. The stepping model — line-following legs

Each straight leg of the path has its movement fixed once, when the leg
starts (SCUMM's `calcMovementFactor`): the dominant axis runs at the
actor's full walk speed for that axis (defaults 8 px/tick horizontal, 2
vertical — horizontal-biased), and the other axis steps proportionally, so
the actor tracks the *line* to the waypoint. The per-tick deltas are 16.16
fixed point with truncating division, and the fractional remainders
accumulate across ticks — an actor can cover 6 px one tick and 7 the next.
An axis that steps past the waypoint is pinned to it, so a leg always ends
exactly on its waypoint. A leg's factors are re-derived whenever the
waypoint it aims at changes; a teleport mid-walk discards them. Mid-leg
state (factors and sub-pixel remainders) is part of the save state, so a
restored mid-walk actor resumes on the same line.

Each tick's advance is then **throttled by the actor's current perspective
scale** — the factors are scaled by `scale/255` — so an actor scaled down
with distance walks proportionally slower, decelerating smoothly as it
recedes (the scale is re-resolved from the box every movement step, §6).
The model is perspective itself: apparent speed tracks apparent size — a
half-size actor stands twice as far away, so it covers half the screen
distance per tick. Full size (255) walks at exactly the nominal speeds.
Like the gate routine (§4 fidelity note), the walker's math is
engine-internal and can't be ground-truthed against the data files; it is
validated by timing walks against the running original.

**Fine print (MI1):** the general-store street (room 34) is the showcase
for the throttle — its walkable boxes resolve through the room's `SCAL`
slot to scales 33–75, so ego crosses the far-view street at 13–29% of
nominal speed. Unthrottled, ego glides across it 3–8× too fast while the
walk cycle animates at the normal rate.

Line-following is what keeps an actor *on* a thin diagonal connector box
(§1). Stepping the axes independently instead exhausts the smaller axis's
delta first and then drifts axis-aligned off the line — and the box
**assigned** from that off-line position (the per-step assignment feeding
scale and z-clip, §6) is then wrong, which is fatal on degenerate boxes
like the room-52 bridge (§7).

The walk box itself is **actor state, not a per-draw derivation**: the
actor stores its assigned box (SCUMM's `_walkbox`), and the compositor and
`getActorWalkBox` read the stored value rather than re-deriving the box at
draw time (see [ZPLANE §7](../scumm/zplane.md)).

## 10. Distance queries clamp into reachable boxes (`getDist`)

`getDist` between an actor and an OBJECT doesn't measure to the object's raw
walk-to point — SCUMM's `getObjActToObjActDist` first clamps the object's
point **into the nearest box the actor can actually reach** (the same
effective box set the router uses, runtime locks included), and measures to
the clamped point. The point is a no-op for objects whose walk-to already
sits in a visible box.

The witness is "give meat to the piranha poodles" (room 36): the dogs'
walk-to point sits in a **locked** box, so ego's walk clamps to a far box
edge — and a raw point-to-point `getDist` then fails the sentence script's
proximity gate (`getDist >= 32` → "Non riesco ad arrivarci") even though ego
stands as close as the box graph allows. Clamping the object's point into
ego's reachable set measures the distance the gate actually intends: "is
the actor at the spot it can reach for this object?"
