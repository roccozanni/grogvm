# SCUMM v5 — Walk Boxes (`BOXD` + `BOXM`)

Walk boxes describe **where in a room an actor is allowed to walk**.
They're convex quadrilaterals (think trapezoids that fit the
perspective of the room art) tiling the floor, with metadata for how
boxes connect to each other and how actor scale changes with depth.

A room has two blocks for this:

- **`BOXD`** — *box data*. The geometry of each box (four corner
  points), plus per-box flags, a mask byte, and a scale word.
- **`BOXM`** — *box matrix*. A compressed per-box next-hop table the
  original engine uses to plan walks across the box graph. The router
  follows it box-to-box; see [`pathfinding.md`](../engine/pathfinding.md).

## At a glance

```
        UL ─────────────── UR
       /                     \      one BOXD record: a convex quad,
      /      walkable         \     corners stored UL → UR → LR → LL
     LL ─────────────────────── LR  (signed i16 pixel coords)

   + mask   u8   z-plane clip level for actors standing here
                 (0 = in front of every plane, k = masked by ZP0k)
   + flags  u8   bit 0x80 = invisible — excluded from paths
   + scale  u16  bit 0x8000 set: SCAL slot ref · clear: fixed 1..255

   BOXM, per box: "to reach box D from S, step into box N next" —
   the precomputed next-hop table the router follows
```

## Sources

The per-box record layout here was derived empirically from MI1
rooms 10 (title), 30 (an interior with 9 boxes), and 32. The
`2 + 20 × count` payload shape holds across every room we sampled,
and the per-field interpretation is consistent with the way
the SCAL block and `actorOps SO_IGNORE_BOXES` opcode reference
these fields.

---

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
| 16     | u8   | `mask`        | The box's **z-plane clip level**: `0` = in front of every plane, `k` = masked by `ZP0k`. |
| 17     | u8   | `flags`       | Per-box flags. **Bit 0x80 = invisible** (excluded from paths).|
| 18     | u16  | `scale`       | Bit `0x8000` set: `SCAL`-slot reference (slot = value `& 0x7FFF`). Clear: direct fixed scale `1..255`. |

**Offset 16 is the box's default actor depth**, not a Y-mask for
`SCAL` as it has sometimes been described: an actor standing in the
box inherits the mask as its `_zbuf` clip level unless a script forces
one. MI1 uses values `0`/`1`/`2` (rooms 10/38/33). How the compositor
consumes it is covered in [ZPLANE](zplane.md)'s box-mask section.

**Offset 18 is a full u16**, not a slot byte plus padding. With bit
`0x8000` set, the low 15 bits index the room's `SCAL` table; with it
clear, the value *is* the scale — a direct fixed `1..255`. Reading
only the low byte as a slot index, a shortcut some long-circulating
notes take, happens to work for slot references but misreads
fixed-scale boxes.

**The corners are stored UL → UR → LR → LL.** A box with corners
`(0, 0, 100, 0, 100, 50, 0, 50)` is the standard `0..100 × 0..50`
rectangle.

**Corners are pixel positions, not pixel ranges.** A box from
`(0, 0)` to `(4, 2)` covers pixels `(0..4, 0..2)` = 5×3 = **15
pixels**, not 8. A common bug when implementing a rasterizer is
treating the second corner as exclusive — the result is a box one
pixel narrower and shorter than intended.

### The "invisible" flag

Box id 0 is conventionally the **"out of bounds" sentinel** — all
four of its corners sit at `(-32000, -32000)` and its flags have bit
`0x80` set. The pathfinder skips it during rasterization, so it never
appears on the walkable mask. Real walkable area starts at box id 1.

The collapsed corners are also a trap for point-in-box tests: every
edge cross-product is 0, so a naive same-side containment test claims
**every** point in the room and resolves everything to box 0. A
containment test needs a degenerate-case guard — the corner bounding
box rejects any real room coordinate.

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
special case needed *for rasterization*. But they are real, walked-on
geometry, not discardable corner cases: MI1 room 38's box 1 is a
zero-area horizontal line (`UL==LL`, `UR==LR`), and room 33's
staircase boxes are diagonal lines actors stand on. Containment and
routing code must treat them as first-class boxes — see
[`pathfinding.md`](../engine/pathfinding.md).

## 4. BOXM — the box matrix

`BOXM` is SCUMM's per-box shortest-path lookup: "to reach box *D* from box
*S*, step into box *N* next." The payload is `numBoxes` rows, stored
back-to-back in box-id order; each row is a run of 3-byte `(from, to, next)`
triples, `0xFF`-terminated, and the whole block is padded to even length
with a trailing `0x00`:

```
BOXM payload:
  numBoxes rows, in box-id order. Each row:
    a run of 3-byte (from, to, next) triples, 0xFF-terminated.
  Block padded to even length with a trailing 0x00.
```

A triple `(from, to, next)` means "to reach any destination box in the
inclusive range `[from, to]`, step into box `next`." A next-hop lookup scans
the source box's row for the triple whose range covers the destination.
Example (room 38, box 1): `(1,1,1) (2,5,3)` — "to reach box 1 you're already
there; to reach any of boxes 2..5, step into box 3."

There is **no count header** — `numBoxes` comes from `BOXD`. A room with
`BOXD` but no `BOXM` routes straight-line (none in MI1's walkable rooms).
Verified empirically against MI1 rooms 28/33/38/52.

The engine routes over this graph — the faithful SCUMM approach. See
[`pathfinding.md`](../engine/pathfinding.md) for the router, the gate
computation, and why it replaced an earlier grid-A*-over-a-mask.

## 5. The runtime: walk planning

When a script issues `walkActorTo(id, x, y)`:

1. The walk routine plans a path from the actor's position to the target.
2. It bails to a straight-line walk when the room has no boxes or the
   actor's `ignoreBoxes` flag is set — SCUMM uses the latter for
   camera-locked cinematic motion that crosses non-walkable regions.
3. Otherwise it routes through the boxes (honoring any runtime flag
   overrides; locked `0x80` boxes are excluded), producing a gate-waypoint
   list. The waypoints become the actor's walk path — the actor's current
   position is not prepended — and the walker advances toward the active
   waypoint each tick, bumping the index on arrival.

### Placement clamps the position into a box

A discrete placement of a box-following actor snaps the actor's *position* onto
the nearest walkbox (SCUMM's `adjustXYToBeInBox`), not just its scale.
Object-anchored placement (`loadRoomWithEgo`, `putActorAtObject`) clamps the
object's walk-to point; raw-coordinate `putActor` clamps the coordinates the
script handed it. This is why a script can drop an actor a little short of a thin
perspective box and still have it stand flush: the Governor's-mansion gauntlet
(room 53) ends by `putActor`-ing ego about 30px above the top-of-stairs landing
line, and the engine drops him onto it — without the clamp he hovers in mid-air
over the steps. The same exemptions as box scaling apply — an `ignoreBoxes`
actor, an actor placed into a room that isn't current, or a hidden actor keeps
the exact coordinates it was given (cinematic motion and off-screen staging
depend on the raw position surviving).

### Perspective-scale recompute timing

An actor's scale is resolved from the scale field of the box it stands in —
a `SCAL` slot interpolated by its `y` (small at the back, full at the
front), or a direct fixed value. The non-obvious part is
*when* to recompute it: on **position change**, not on every tick. The
rescale lookup runs at two moments — each walk step (while the actor is
moving), **and every discrete placement event**: `loadRoomWithEgo`,
`putActor`, `putActorAtObject`, and the **room load itself** (for every
actor already placed in the arriving room). The room-load case exists
because a `putActor` into a room that isn't current has no boxes to resolve
against — the intro parks ego on the cliff path (room 38) from the title
room, and without the load-time pass he renders full-size on the path's
first frame, snapping smaller only when the entry walk starts. The
placement rescale is load-bearing: enter a far-view
room (e.g. the street, 78) via `loadRoomWithEgo` and a *standing* ego would
otherwise keep its pre-transition scale and render full-size until its
first walk step. It is deliberately kept **off** the per-idle-tick path so
a script-pinned static actor (the room-38 fire, set smaller than its floor
scale via `setScale`) isn't clobbered — placement is one-shot, so a
`setScale` that runs after placement in the same script still wins. A box
whose scale resolves to full size (or no box at all) resets the actor to
255, so a sub-255 scale never sticks across rooms.

**`ignoreBoxes` actors are exempt from box scaling.** An actor off the walk-box
grid keeps the scale a script set — the rescale early-returns for an
`ignoreBoxes` actor. Room 51's cannon launch is the case: the flight actor (11,
costume 40) is set `ignoreBoxes; scale 255,255` and arcs up to y≈36, where the
box's `SCAL` slot interpolates to ~1; without the exemption the placement
rescale shrank it to a **single dot** mid-flight. (Same off-grid principle as
z-clip: an `ignoreBoxes` actor keeps its last-assigned `_walkbox` rather than
being re-snapped to a box — see [ZPLANE](zplane.md).)

**`initActor` (`actorOps SO_DEFAULT`, 0x08) must clear `ignoreBoxes` + reset
scale.** Because the exemption above freezes scaling, a *stuck* `ignoreBoxes`
flag freezes the actor at a fixed size across every room. The intro credits
(room-10 #203) repurpose actors 1–9 — Guybrush included — as free-moving
montage puppets (`ignoreBoxes`), clearing `followBoxes` only at the end of each
one's segment. Skipping the credits with **Escape** jumps the cutscene to its
override (see [CUTSCENES](cutscenes.md)), so #203's `followBoxes` never runs and
the room change then kills #203 — leaving Guybrush stuck `ignoreBoxes`, rendered
full-size from the cliff onward. SCUMM's `initActor` resets `_ignoreBoxes = 0`
and `_scalex/y = 0xFF`, so the ego's game-start `init` is what clears the
otherwise-stuck flag; a later `ignoreBoxes`/`scale` subop in the *same*
`actorOps` still wins (the cannon flight actor). The witness is ESC-skipping
the intro: without the resets the ego reaches the cliff at scale 255 instead
of 210.
