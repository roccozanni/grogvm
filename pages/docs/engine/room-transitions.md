# Room Transitions — Entering & Leaving a Room

Every room change runs through one ordered sequence, GrogVM's reconstruction
of SCUMM's `startScene`. Getting the *order* wrong is what breaks transitions:
a room's entry/exit scripts, the ego's placement, and the resource swap all
interlock, and several MI1 scenes only work if each step happens at the right
moment. This note is that sequence and the gotchas that pin each step in place.

The two entry points:

- **`loadRoom N`** — swap to room `N`, leave the ego wherever it is. Used for
  off-screen / scripted scene changes.
- **`loadRoomWithEgo obj N x y`** — swap to room `N` *and* bring the ego in,
  positioned relative to object `obj`. This is how the player walks between
  rooms (an exit object's walk-to script runs it) and how the map/menu jumps
  to a location.

Both funnel into the same transition; `loadRoomWithEgo` adds the ego handling
described in §3.

## 1. The transition sequence

On a room change, in this exact order:

1. **Clear the draw queue and per-object draw positions.** A fresh room starts
   with nothing queued; its entry script repopulates what should be visible.
2. **Run the exit side, nested: the exit hook, the previous room's `EXCD`,
   the second exit hook.** SCUMM brackets each room's own script with two
   global *hook scripts* whose ids live in `VAR_EXIT_SCRIPT` /
   `VAR_EXIT_SCRIPT2`; everything here runs to completion *before* the
   transition returns to the caller — not deferred as a normal slot (see §4).
   MI1 points the exit hook at `#7`, which records the room being left in
   `g101` — entry scripts branch on it (Hook Isle's side-dependent
   touchability, the Voodoo Lady's entrance choreography that closes the door
   behind you).
3. **Stop the old room's local + object/verb scripts.** Room-scoped scripts
   (`WIO_ROOM` / `WIO_FLOBJECT`) die on a room change; only globals survive.
   Without this, an old room's ambient/animation loop keeps running into the
   new room and tries to start locals that don't exist there. The same purge
   covers a previous `ENCD`/`EXCD` still yielded mid-slice: a stale
   entry-script slice that survives resumes against the *new* room's local
   table and starts whatever script owns that id there (a previous room's
   entry script resuming two rooms later is a VM halt, not a glitch).
4. **Reset per-room box flags** to the new room's on-disk values (the entry
   script re-applies any door locks).
5. **Set `currentRoom` and `VAR_ROOM`** to the requested id — the *raw* id even
   for a pseudo-room (the forest maze keeps `VAR_ROOM` at 201–220; see
   [room §7b](../scumm/room.md)).
6. **Load the room's resources.** Decode the background, palette, z-planes,
   scripts; resolve a pseudo-room alias if the id has no physical room
   ([room §7b](../scumm/room.md)); re-apply the persistent UI-palette overrides
   over the freshly-decoded CLUT; and re-queue every object already in a
   non-zero, image-backed state (so a door left open stays drawn open across
   re-entry and save/restore).
7. **Resolve box + scale for every actor already placed in the room.** A
   `putActor` into a room that isn't current can't resolve a walk box — those
   boxes aren't loaded — so the room load is itself a placement event (see
   [walk-boxes §"Perspective-scale recompute timing"](../scumm/walk-boxes.md)).
   The intro is the witness: the boot script parks ego on the cliff path
   (room 38) while the title room is still current; the path room's first
   frame must already show him at path scale, not full-size.
8. **Place the entering ego** (`loadRoomWithEgo` only — §3), *between* the
   resource load and the entry script.
9. **Run the entry side, nested: the entry hook (`VAR_ENTRY_SCRIPT`), the new
   room's `ENCD` to its first `breakHere` (see §4), then the second entry
   hook (`VAR_ENTRY_SCRIPT2`).** MI1 boots `#5`/`#6` into the entry hooks;
   `#6` re-runs the verb-bar scripts and clears pending sentences on every
   entry, so the verb panel arrives consistent in each room.

Screen-effect fades bracket the transition but render as instant cuts today
(state modelled, animation deferred) — see [screen effects](../scumm/screen-effect.md).

## 2. `VAR_ROOM` is the raw id

`VAR_ROOM` holds the id the script asked for, untranslated — including a
pseudo-room id with its high bit. The forest maze depends on this: its single
shared room branches on `VAR_ROOM == 201..220` to compose the right "screen,"
so collapsing the id (e.g. to `& 0x7F`) would feed the entry script the wrong
screen. The pseudo-room alias affects only which *resources* load, never the
id the scripts see. (`VAR_WALKTO_OBJ`, below, is the other variable a room's
entry script reads to know how the ego arrived.)

## 3. Bringing the ego in — `loadRoomWithEgo`

`loadRoomWithEgo obj N x y` places the ego relative to the **entry object** and
lets the new room's entry script walk it the rest of the way:

- **`VAR_WALKTO_OBJ` is set to `obj` across the transition**, so the new room's
  `ENCD` can branch on *which object/edge the ego came in through*. It stays set
  through the entry script (the next `loadRoomWithEgo` overwrites it).
- **The ego is placed at the entry object's walk-to point** — `getObjectXYPos`
  (the object's `walkX/walkY`, *not* its image origin), shifted by any
  `drawObject … at` reposition the object has had, then clamped into the walk
  boxes (SCUMM's `adjustXYToBeInBox`). Placement happens *after* the entry
  script's first slice has run (step 9 begins the script; the placement reads
  the now-repositioned object), so the ego lands at the screen *edge* the entry
  object occupies — not at the object's design coordinates.
- **The entry script walks the ego in.** Gated on `VAR_WALKTO_OBJ`, the `ENCD`
  issues a `walkActorTo` after its first `breakHere`, pulling the ego from the
  edge to its resting spot. So the ego *enters walking* rather than snapping
  into place.
- **An explicit `(x, y)` operand overrides the entry walk** — when it isn't
  `(-1, -1)`, the ego walks straight to that point instead.

The **forest fork** is the worked example. The map node runs
`loadRoomWithEgo obj=687 room=218`: object 687 is the right-edge path trunk, so
the ego is placed at the right edge, and room 58's entry script — seeing
`VAR_WALKTO_OBJ == 687` — walks it left into the clearing. Enter via a
different edge object and the ego comes in from that edge instead.

## 4. Why `EXCD` and `ENCD` run *nested*

Both scripts run **nested** — inline, finishing (or yielding at the first
`breakHere`) before the `loadRoom`/`loadRoomWithEgo` opcode returns — rather
than being queued as ordinary cooperative slots. The reason is ordering: the
transition's caller (a global script) keeps executing its own opcodes right
after the room change, and those opcodes assume the entry/exit scripts have
already set the scene up.

- **`EXCD` must finish first.** MI1's pirate-conversation script does
  `loadRoom 82` then immediately sets the dialog verb-script variable. The
  bar's exit script resets that same variable to its default; queued as a
  deferred slot it would run *after* the caller's set and clobber it, leaving
  dialog clicks routed to the wrong script. Running `EXCD` nested — before the
  opcode returns — restores the original ordering.
- **`ENCD` runs to its first `breakHere`.** The entry script's prologue (draw
  the scene, position actors) must be in effect before the caller's next
  opcode observes the room; an `ENCD` that spans frames still yields back to the
  per-frame scheduler after that prologue, exactly as the original does. The
  ego entry-walk (§3) lives *after* this first `breakHere`, which is why the
  ego's placement is read while `VAR_WALKTO_OBJ` is still set and isn't
  clobbered by it.

Cutscene freezing, `override`, and the cooperative slot model these scripts run
under are covered in [cutscenes](../scumm/cutscenes.md); the boot-time first
room entry in [boot](../scumm/boot.md).
