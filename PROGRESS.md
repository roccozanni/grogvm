# GrogVM — Progress

Lean tracker. Three buckets:

- **Current** — what's in flight and what's open right now. This is also the
  **lab notebook**: capture each concrete finding as it happens — root causes,
  exact opcode numbers, semantics, the *why* — because this is the source
  material the end-of-phase doc update is written from. Don't reconstruct doc
  prose from memory later; that's how bad claims get in. A finding stays here
  until it has been written into the right `pages/docs/` file — only then trim it.
- **Next** — the work ahead, as one-liners. Broken into tasks only when we start.
- **Done** — one or two lines per concluded chunk of work. The durable knowledge
  lives in `pages/docs/` and the code; git has the blow-by-blow. When something
  concludes, first migrate its findings from Current into the right `pages/docs/`
  file, *then* shrink the entry here to a line or two.

---

## Current — natural play through MI1

Playing MI1 from the start and fixing each blocker as it's hit (engine-faithful,
committed on `main`). **Unit suite green + tsc clean**, plus a data-gated
integration playthrough (`npm run test:integration`). The intro → room 33 →
SCUMM Bar (room 28) → pirate-conversation close-up is playable end-to-end, with
verbs, inventory, and two-object "Usa X con Y" / "Dai X a Y" working.

**Working principle (agreed 2026-06-02):** no hacks/shortcuts — every change is
the final, SCUMM-faithful solution. Confirm the real mechanism first (disassemble
the original, check ScummVM semantics) before editing; when engine-faithful and a
quick shell workaround disagree, faithful wins. Verify the actual outcome (render
real pixels for visual bugs; reproduce the real flow for behaviour) — not the
bookkeeping. Surface any deferral/approximation explicitly and track it here;
never bury a shortcut. If "faithful" needs a bigger refactor, raise the tradeoff
rather than silently taking either the heavy path or the shortcut.

**In flight — MI1 full walkthrough (the regression net), started 2026-06-04.**
`integration/mi1/walkthrough.test.ts`: ONE seeded VM driven through the game's
own solution start→onward, grown beat by beat (last green beat = the frontier);
run end-of-session / after a refactor. Design + the testkit pieces it added
(`actions.ts` faithful action vocabulary, `random.ts` seeded-RNG seam,
`beat()` guard, headless/from-boot/deterministic rationale) →
[AGENTS "The harness"](AGENTS.md). Engine finding — *a printing sentence blocks
the next one* (command mid-speech no-ops; wait for the line to clear) →
[INPUT §5](pages/docs/scumm/input.md). The beats carry **zero `driveTicks`**:
each `use`/`walkTo`/`give` first waits on `waitReady` (control back + ego
stopped + no line/cutscene — the one condition all the old magic-number
"settles" were approximating), and outcomes are asserted with named
condition-waiters beside `driveToRoom` — `waitPickedUp` (ego owns an object),
`waitGlobal` (a story flag/counter hits a value), `waitPlayable` (control +
verb bar back) — falling back to a raw `driveUntil` only for bespoke predicates
(cook sweep, gull bolt, staged crossings) and to the real signal for genuine
event-waits (e.g. the dock door's state flipping to open, `vm.objectStates`).
So beats read as a plain action sequence, and comments are pruned to only what
explains a game mechanic / puzzle (the cook window, the room-52 high/low guard,
the cannon-gag auto-return, the store-door open-handler quirk, …) — the helper
calls speak for themselves. Old `playthrough.test.ts` deleted (its
mechanics are now the first five beats). The final beat snapshots the end state
to `saves/MI1-walkthrough-frontier.websave.json` (gitignored, regenerated every
green run so it can't drift): the net itself always runs from boot, but the *next*
beat can be developed by `restoreSave`-ing the frontier instead of re-driving the
whole game — the buggy `Italiano-2-post-fettuccini` save is **not** trustworthy
(broken actor scale from the `ignoreBoxes` bug), so generate from the run.

Beats are named `<Part> · <Room> — <what it proves>` (Part = the game's own
part; I = "The Three Trials"), **no ordinal** — file order *is* run order.
Per-game ids/vars live in `game.ts`: `ROOMS` (room-grouped objects/scripts),
`VERBS`, and `VARS` (story/puzzle globals — assert these over localized text).

Frontier (all Part I): **Mêlée Lookout** boot→33, floor-walk, look-at poster,
open+walk the bar door→28 → **SCUMM Bar** LOOM-ad pirate close-up (talk #333 →
room 82, answer #121/goodbye #124); three important-looking pirates (#322, inline
conv #220, answer #122/goodbye #127) → trials learned (`VARS.trialsLearned`/g197
0→1); wait out the cook (actor #6, ~2000t hidden / ~800t out wandering) and walk
the open kitchen door (#316→41 — a *verb-11 sentence* on the door, since a bare
floor click won't run its walk-through script) → **Kitchen** take meat #566 + pot
#567; stomp the loose board #575 3× to scare the seagull (actor #7) — fish #568 is
grabbable only DURING the fly-away (its class-6 "the bird will peck" guard lifts
only mid-flight), keyed off `VARS.gullScare`/g272 → retrace out (kitchen door
#570→bar, exit door #315→lookout, one-time Sheriff cutscene 70→72) → **Mêlée
Lookout** walk west off the cliff (#426→38) → **cliff path** take the path
(#487, verbs [90,255] → walk-11 falls back to the 0xFF/255 default) → **Mêlée
map** (85, verb-11 location nodes) click the clearing (#912→52) → **clearing**
walk to the circus tent (#621→51) → **Fettucini circus** break into the
brothers' auto-argument (local #207) with "ahem", negotiate the cannonball job
(answer ids are `120 + optionIndex-1`, so 120 recurs per menu — sequence by
speech), **give the pot as the helmet** (Give/verb-4 *to actor 3* — the first
give-to-actor; sets `bit#103` → cannon launch → amnesia gag → payout) and get
paid **478 pieces of eight** (`VARS.money`/g195 0→478, object #488 verb-250).
The room-52 clearing crossing is staged (descend to the low zone first — local
script 202's high/low guard, not a routing workaround; see Pathfinding) →
**back to the Mêlée town** (one grouped travel beat): circus exit #617→52, climb
back to the high zone, path #622→map, the map's *village* node #917 (its verb-11
branches on g196 — still 0 this early, so it lands in the wide lookout/town room
33, not the docks 83), then room-33 east arch #427→**Mêlée town street 35** →
**buy the treasure map** off citizen #441 (an *object*, talk #218; the cousin-
Dominique opener #123 then "take it" #121 → map #442 to ego, g195 478→378) →
**Voodoo Lady 29** (open+walk door #444, pocket the rubber chicken #377, back out
#367) → **general store** (arch #451→street 34, then the store door #437 — its
open handler only takes with ego *standing at it*, so approach→open→enter, unlike
the bar/voodoo doors) → **buy the sword #388 + shovel #396** (grab both off the
shelf first, then ring the bell — Push/verb-5 #399 — and settle up with shopkeeper
#394: buy menu reuses ids, sequence `aboutSword 120 → wantIt 120 → aboutShovel
121 → wantIt 120 → lookAround 125`; g195 378→203) → exit #387 back to street 34.
Next: the three trials proper — swordfighting (the *house* map node → Captain
Smirk → fight pirates for insults → the Sword Master node #918), thievery, treasure.

**Capability landed this session — headless actor hit-testing** (so the net can
click actors for Talk-to / Give-to-actor): `prepareActorDraw` is the shared
sprite-box source the compositor and `Vm.actorHitBounds` both use, with testkit
`actorPoint`/`pickDialogAnswer` on top. Dialog answer-verb scheme (`120 +
optionIndex−1`, g194, per-menu reuse) + give-to-actor → [INPUT §5](pages/docs/scumm/input.md);
harness helpers → [AGENTS "The harness"](AGENTS.md). **Give X to <actor>**
(verb 4) now exercised end-to-end.

### Forest maze (room 58) — "the fork" black-room fix (2026-06-06, awaiting in-browser confirm)

Clicking **il bivio** (map node #911, `loadRoomWithEgo room=218`) landed in a
fully-black room. Two independent bugs, both now fixed (pending user verify):

1. **pseudoRoom (0xCC) keyed by `j & 0x7F` instead of the raw byte.** MI1's
   forest maze is a single shared background (room **58**) reused as logical
   "screens" **201–220**, declared via `pseudoRoom` blocks (`201–220 → 58`,
   `130–132 → 1`). The game keeps the high bit live: room 58's ENCD branches on
   `VAR_ROOM == 201..215+` and scripts call `loadRoom 130` directly, so
   `VAR_ROOM`/`currentRoom` legitimately hold 218. Masking to `j & 0x7F` stored
   keys 73–92 — which never match the raw request **and** would collide with the
   real dialog-close-up rooms 73–90. Fix: store the raw byte (`pseudoRooms.set(j,
   id)`); pseudo ids are always ≥ 128 so they never shadow a real room, and the
   "direct room first, alias as fallback" order in `applyRoomResources` is now
   belt-and-braces, not a collision guard. (The old 73–90 close-up collision
   story was an artifact of the masking bug.) → doc target [OBJECTS]/[ROOM].
2. **`drawObject … at x,y` (SO_AT) reposition was a no-op.** room 58 has **no
   background bitmap** (all index-0) — each screen is composed entirely by
   repositioning a shared set of scenery tiles (objs 656–688) via SO_AT. We drew
   every object at its IMHD default (all piled at x=0), so even with room 58
   loaded the screen was ~87% black. Fix: SO_AT now moves the object to
   `(x * 8, y * 8)` — **both** operands in strips — stored in
   `vm.objectDrawPositions` (cleared on room change, persisted in the save as a
   **required** field), read by the compositor in preference to IMHD. Evidence
   the units are strips on both axes: `cdhd.width * 8 == imhd.width`; the
   `x=100`→800px "park offscreen" idiom; and the vertical tiling — each forest
   screen is a top band (objs h=88) at strip-y 0 and a bottom band (h=56) at
   strip-y 11 → 88px, which butt together to exactly fill the 144-row room.
   Treating y as pixels stacks the bands at y=11, collapsing the scene into the
   top ~99 rows (the "squashed, only-upper-part" symptom).
   drawObject's same-box eviction now compares effective (runtime) boxes so
   distinct tiles sharing an IMHD origin aren't falsely evicted. Renders as a
   proper framed forest now. → doc target [OBJECTS] (drawObject) / [SMAP] (a
   no-background room is legal). Only rooms **39** and **58** use SO_AT in room
   scripts (object-script SO_AT unscanned); confirmed-path rooms (28/33/51/29…)
   don't, so no visual regression there — unit (859) + integration (21) green.
   **Watch:** forest navigation objects — the repositioned tiles are class-32
   Untouchable (skipped in hit-testing), so clicks route via separate exits, but
   if any *clickable* object is ever SO_AT-moved, `hittest.ts` (uses `cdhd.x*8`,
   the design hotspot) won't follow it. Not exercised yet.

3. **Ego entered on the wrong side (left, x=42) instead of the right.** The
   fork node #911 does `loadRoomWithEgo obj=687`, and `loadRoomWithEgo` /
   `putActorAtObject` placed ego at the object's **static** `cdhd.walkX/walkY` —
   but 687 (the right-edge path/trunk) is SO_AT-moved to x=296, so its walk-to
   point moves with it. Fix: a shared `objectWalkPoint(vm, obj)` (SCUMM's
   `getObjectXYPos`) shifts the CDHD walk point by the object's SO_AT
   displacement `(drawPos − imhd)` and clamps into the walk boxes
   (`clampPointToBoxes`, SCUMM's adjustXYToBeInBox). Ego now enters at the right
   edge (behind the front trunk, symmetric to the left path's off-edge entry)
   and the player walks it into the clearing. → doc target [INPUT]/[PATHFINDING].
4. **SO_AT runtime position was applied inconsistently — the real root.** A
   `drawObject … at` reposition must move *everything* tied to the object:
   image (compositor), z-plane (occlusion), hotspot (hit-test), and walk-to
   (getObjectXYPos). We'd taught only the compositor + walk-to about it, so the
   forest tiles' hit boxes stayed pinned at their design x=0 (visible in the
   "Hit areas" overlay — the tell that surfaced this) and object occlusion was
   briefly mis-modelled. Fix: one displacement `(drawPos − imhd)` applied at
   every site — the **`findObject` opcode** (the script-facing hit-test the
   hover-poller/click run; the one that left the mouse reacting at x=0 while the
   overlay already rendered correctly), `pickObject`/`objectHitBox` + the
   hit-area overlay, `objActPos` (getObjectXYPos, so getDist proximity +
   `walkActorToObject` + face all follow), and `objectDrawPositions` feeds the
   compositor's `mergeForeground` at runtime positions. A drawn object's z-plane
   occludes actors only when the object is flagged a foreground occluder —
   **class 32** (bit 31), which MI1 toggles per object via `setClass`: room 58's
   scenery foliage (671/673, ego walks *behind*) keeps it; the touchable
   "il sentiero" path trunks (685/686/687, ego walks *in front*) have it cleared
   by the ENCD/local #204. Both carry a full ZP01 at the same index, so that
   class flag is the only thing separating them (the z-plane index can't — they're
   all ZP01). `composeFrame.isObjectOccluder` gates it; room z-planes still always
   apply (the room-28 table / room-33 houses are room planes, untouched).
   → doc target [ZPLANE]/[OBJECTS].

5. **Ego didn't walk in on entry — `VAR_WALKTO_OBJ` was the wrong slot.**
   The forest's ENCD walks ego in from the entry edge via a `walkActorTo ego`
   gated on `g113 == <entry object>` (e.g. 687 from the map's fork node, 688/685
   between screens), fired after the ENCD's first `breakHere`. `g113` is
   `VAR_WALKTO_OBJ`, which `loadRoomWithEgo` sets to the entry object — but our
   `VAR_WALKTO_OBJ` was defined as **38** (the generic SCUMM table value, never
   exercised) when MI1's slot is **113**. Fixes: corrected `VAR_WALKTO_OBJ` to
   113; `loadRoomWithEgo` now sets it to the entry object (kept set across the
   room change — the next loadRoomWithEgo overwrites it). Ordering: ego is placed
   at the entry object's (SO_AT-displaced) walk-to *after* `enterRoom` runs the
   ENCD's first slice (so it lands at the entry edge, ~322), then the ENCD's
   post-breakHere walk pulls it inward (to 294 for the fork) — so ego enters from
   the right edge, walks in, and stops, matching the original. → doc target
   [INPUT]/[BOOT].

Note: this was **not** the deferred `VAR_CURRENT_LIGHTS` darkening item —
`g9` was 7 (lit) the whole time; the room simply wasn't loading/composing.

### Open bug-report saves (reported, not yet fixed)

- **Room 28 cook drawn behind the table (compositor, not pathfinding).**
  With box-graph routing the cook (actor 6, `alwaysZclip=1`) now walks a
  natural path (no longer the y=140 line) — user-confirmed 2026-06-05 — but
  the compositor still draws it behind the foreground table z-plane. So the
  remaining slice is a z-clip/compositor bug, *not* a routing one. Chase the
  cook's resolved clip plane vs. the table band (y≈102–122); see
  [ZPLANE](pages/docs/scumm/zplane.md).

### Tier-2 divergence checklist

Silent, self-flagged approximations (run `git grep -nE "for now|doesn't yet|best-effort|we don't yet"`
to refresh). Tiering: **Tier 1** = loud (halts on unknown opcode — fine). **Tier 2**
= these (silent until a script ordering makes them observable, like the EXCD bug).
**Tier 3** = unknown unknowns (only ScummVM differential tracing finds them).

Priority H/M/L = likelihood of biting current/near play × severity.

- [ ] **M — dialog/string escape codes still deferred**
  (`decodeScummString` / `expandSubstitution`, `opcodes/index.ts:~2155`):
  keep-text `0xFF02`, sound `0xFF09`, actor-name `0xFF0A`, mid-string colour
  `0xFF0E` (each consumed but emits nothing). Surfaces as blank/wrong text or
  missing inline colour in dialogue-heavy content. (Also in Stubbed opcodes
  below.) *Done since last review:* `0x04` int, `0x05` verb-name, `0x06`
  object/actor-name, `0x07` string-resource all expand now.
- [x] **M — actor names not stored** — DONE (7d3754f). `setActorName` (`0x0D`)
  now writes `actor.name`; `vm.objectName` resolves actor-or-object, actor
  first → [INPUT §6](pages/docs/scumm/input.md). Persists across rooms + saves.
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~524`).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
- [ ] **L — camera scroll "snap both for now"** (`opcodes/index.ts:~411`) +
  smooth `panCameraTo` (Open backlog). Gradual scroll over frames; no current
  scene validates it.
- [ ] **L — flashlight gfx not modelled** (`opcodes/index.ts:~577`, dark-room
  strip extent). Cosmetic; only the flashlight rooms.
- [ ] **? — `actorOps` subop `0x0f` treated as no-arg no-op "for now"**
  (`opcodes/index.ts:~1874`; seen in MI1 boot after setCostume, not in the
  wiki). Assess whether it affects behaviour or is genuinely inert.
- Already tracked elsewhere (cross-ref, not duplicated here): line-following
  walker (Pathfinding backlog), `screenEffect` animation + `VAR_CURRENT_LIGHTS`
  darkening (Rendering backlog), `saveRestoreVerbs` subset (Watch-for), audio /
  `resourceRoutines` (Out of scope — Phase 11).

**Box-graph routing landed this session (2026-06-05)**, replacing
grid-A*-over-mask — full writeup in [PATHFINDING](pages/docs/engine/pathfinding.md) (incl.
the room-52 high/low guard §7 and the deferred line-following-walker follow-up
§9). User-confirmed in-browser. Remaining open item is the room-28 cook z-clip
(above) — compositor, not routing.

**Watch for** (recurring failure modes in newly-reached content):

- Unimplemented opcodes → an unknown-opcode halt freezes the *whole* VM.
- Object states beyond the initial `DOBJ` seed (only initial owner/state/class
  is parsed). See [OBJECTS §7a](pages/docs/scumm/objects.md).
- `saveRestoreVerbs`: we render-skip archived verbs (a subset of SCUMM's
  per-verb `saveid` model); revisit if a scene re-creates a saved verb id.
  See [INPUT §6](pages/docs/scumm/input.md).

**Tooling:** `scratch/dis.ts` (+ `SCAN grep=`) is the disassembler CLI — keep it
in sync with the executing opcode table (AGENTS.md).

### Open backlog

Deferred out of earlier phases; none block current play. Detail in the linked docs.

**Input / UI**

- **Two-object "Use X with Y" end-to-end** — *done*; A+B commit + `g110`
  preposition + faithful #100 sentence line all confirmed. **Give X to
  <actor>** (verb 4) — *now done too* (Fettucini circus: give the pot to a
  brother actor). Needed headless actor hit-testing (`prepareActorDraw` /
  `Vm.actorHitBounds` / testkit `actorPoint`) — see Current. [INPUT §5](pages/docs/scumm/input.md).
- **Inventory scroll arrows** (verbs 208/209) for >8 items — needs a full
  inventory to exercise.

**Rendering**

- **Unify the render surface — Phase A done; Phase B (engine-side) remaining.**
  Phase A (done): the room slice and the verb/inventory panel now share ONE
  visible canvas. The engine compositor presents the room into the renderer's
  *offscreen* canvas; the shell blits it into the top rows of the screen canvas
  and paints the verb panel + overlays below/over it. A single `mountScreenInput`
  drives the lot in unified screen coords (true screen position → VARs 44/45,
  room coords → 20/21), so the cursor glides continuously from the room into the
  inventory and #23 sees the inventory band natively — the dual-write coordinate
  bridge is gone. Phase B (the fully faithful end-state, deferred): move the
  verb-panel rendering *into* the engine compositor so it emits the whole 320×200
  framebuffer with 1:1 coords (the sentence line is already engine verb #100,
  assembled from `0xFF NN` substitution codes). All of Phase A's canvas / input /
  cursor plumbing is reused unchanged — only the verb-pixel source swaps. Take it
  on when a *render-side* reason appears (mid-string dialogue colours `0x0E`, the
  copy-protection wheel) — not speculatively.
- **Compositor honours `VAR_CURRENT_LIGHTS`** — darken a night room via the
  lights flag, not only a dark palette (may be subtle; night rooms already ship
  dark palettes — check it's visible first). [LIGHTING §4](pages/docs/scumm/lighting.md).
- **`screenEffect` transition animation** — state is modelled; the
  dissolve/scroll/instant *animation* is deferred (intro is all instant cuts).
  [SCREEN-EFFECT](pages/docs/scumm/screen-effect.md).
- **Palette cycling (`CYCL`) not animated** — the room's `CYCL` block is
  catalogued but the engine doesn't cycle the palette ranges, so animated
  palette effects (water shimmer, etc.) are static. No intro-path room depends
  on it; wire it when a scene surfaces. [ROOM](pages/docs/scumm/room.md).
- **Smooth `panCameraTo`** — snaps today; no intro-reachable scene uses it, so
  the pan rate has no validation target. Wire it when a scene surfaces.
- **Costume head-limb facing — remaining edges.** The head limb is re-pointed on
  the walk→stop transition (shipped 2026-05-31). Not yet handled: a *turn in
  place while idle* (a script changing `facing` with no walk) — the head keeps
  its last init-set frame; wire the same init-re-point on any at-rest facing
  change when a scene surfaces it. Two scene-specific symptoms noted earlier and
  **not since re-confirmed** (verify before chasing): a room-33 cliff N/S facing
  flip-flop (likely a walk direction-picker issue, separate from the head) and a
  room-38 entry head-loss transient. See [COSTUME-ANIM](pages/docs/scumm/costume-anim.md).

**Pathfinding**

- **Box-graph routing — DONE (2026-06-05).** BOXM-driven box-to-box routing
  replaced grid-A*-over-mask; see Current + [PATHFINDING](pages/docs/engine/pathfinding.md).
- **Line-following walker (`calcMovementFactor`) + walk-box-as-state — the
  faithful follow-up, deferred.** `stepWalk` steps X/Y independently; SCUMM
  moves along the line, and tracks the actor's box as walk state (`_walkbox`)
  rather than re-deriving it from pixel position. Without this, thin diagonal
  connector boxes are fragile (actor drifts off; `getActorWalkBox` mis-reports)
  — the room-52 single-click bridge crossing is the live symptom (staged in the
  walkthrough). Touches every walk + the stepWalk unit tests (which encode the
  current independent-step behaviour) → re-verify intro/bar/kitchen + render.
  [PATHFINDING §9](pages/docs/engine/pathfinding.md).

**Stubbed opcodes (cosmetic / peripheral)**

- `roomOps`: `shakeOn`/`shakeOff`, `roomIntensity` / `setRGBRoomIntensity`,
  `saveString` / `loadString`.
- `cursorCommand` image subops (0x2C): `setCursorImage` / `setCursorHotspot` /
  `setCursor`.
- `matrixOp` (0x30): box connectivity flags / scale / create-box-matrix.
- Dialog escape codes still deferred: keep-text `0x02`, sound `0x09`, actor
  name `0x0A`, mid-string colour `0x0E`. (`0x04`–`0x07` now expand — see the
  Tier-2 entry above.)

**Tooling**

- `disasm.ts` drifts past a non-print opcode mis-size on some scripts (e.g.
  global #178 tail) — chase only if a task needs that script.

### Out of scope (their own phases)

- **Audio** — sound opcodes stay silent stubs (`isSoundRunning → 0` lets
  sound-waits fall through). Fixes the "Le tre prove" ~5 s sound-gated hold for
  free. → Phase 11.
- **Resource-heap management** — `resourceRoutines` stay no-ops (resources load
  lazily; there's no managed heap to model).

---

## Next

Three items ahead, one of which — keep playing MI1 — is the Current section
above. We no longer track by phase number; ARCHITECTURE §9 keeps the historical
phase roadmap (and git matches it).

- **Audio** — iMUSE + AdLib first; MT-32 and CD redbook later.
- **MI2** — verify it boots on the same engine; fix the v5-but-slightly-different
  edge cases. Known unimplemented one: MI2 `COST` payloads need their first 2
  bytes skipped before parsing (every payload-relative offset is 2 bytes too
  small otherwise) — the costume decoder doesn't yet apply this shift.

---

## Done

- **Website — public-launch prep** *(2026-06-05)*. Licensed GPL-3.0-or-later
  (`LICENSE` = canonical GPLv3 text; README + site footer credit the ScummVM
  derivation, and the source-exposure audit is kept public for transparency with
  the author name scrubbed). Added the discoverability layer to the shared shell
  (`renderDocument`): per-page meta description, canonical, Open Graph + Twitter
  tags, favicon, `sitemap.xml`, `robots.txt`, and a `noindex` 404 — all keyed to
  `grogvm.dev`. Footer carries license · source · provenance · privacy; new
  `/privacy` page (no analytics/tracking/cookies, static S3 + CloudFront with
  access logging off, "verify it in the source"). AI-disclosure section (largely
  Claude Opus 4.8 under human steering — craft, not one-shot). Home + docs gained
  an accurate **Project status**; nav constrained to the content column. New
  engine doc [HARNESS](pages/docs/engine/harness.md) on the testkit + from-boot
  integration playthrough. Exact unit-test counts removed from all `.md`
  (stale-prone).

- **Documentation — reference/engine split + facts-only pass** *(2026-06-05)*.
  Reorganised `pages/docs/` into a public SCUMM v5 reference (`scumm/`) and
  engine notes (`engine/`); rewrote the engine-session task contract and the
  costume-anim session journal into standing docs; scrubbed every doc of phase
  references, fragile code/line/function pointers, and stale implementation
  status — verifying each "we do/defer X" claim against the code first
  (corrected DOBJ, object verb dispatch, BOXM decoding, freezeScripts, DCOS).
  Durable engine facts moved to `engine/`; open limitations (MI2 `COST` shift,
  `CYCL` cycling, head-limb facing) moved here. Doc-authoring conventions are
  now in [AGENTS "Documentation"](AGENTS.md).

- **Website — unified markdown page model** *(2026-06-05)*. (The page-model
  migration; ARCHITECTURE §9 records it as "Phase 12", stages 1–5.) Every page —
  home, the SCUMM-v5 docs,
  and the library/explore/play app screens — is authored as markdown under
  `pages/` (file path = route) and rendered by an owned generator (markdown-it +
  gray-matter + a Vite plugin) into a single `dist/` with path-based routing; no
  hand-authored HTML. The final stage unified the app pages with the content
  pages: one shared HTML shell (`renderDocument`) + one dark monospace `site.css`
  on every page (shared nav + `.content` frame), markdown typography scoped to
  `.prose` (so it stays off the app screens), and the play canvas centered. Retro/
  terminal aesthetic throughout. See ARCHITECTURE §8, §9 Phase 12, §11 Q13.

- **Shell rebuild + EngineSession** *(2026-05-31)*. Rebuilt the shell
  around an `EngineSession` seam (engine owns the loop, clock injected →
  Node-testable) with a multi-page static build (`/`, `/explore`, `/play`); split
  the resource browser into a standalone Explorer and rebuilt the Player as a
  camera-driven canvas + always-on Debug panel; deleted both shell god-objects.
  See [ENGINE-SESSION](pages/docs/engine/session.md) + ARCHITECTURE.md §4/§7.
  Engine composition + natural-play fixes landed alongside (sessions 8–11, all
  engine-faithful, user-confirmed): actor + box/`SCAL` scaling, ego box-mask
  z-occlusion, camera-follow ordering, and the SCUMM-Bar / pirate-dialog blocker
  fixes (chainScript, drawObject subop/state/eviction, room-change script stop,
  pseudo-room fallback, archived-verb render skip, DOBJ seeding + Untouchable
  class). Semantics in OPCODES / OBJECTS / ROOM / ZPLANE / CUTSCENES / INPUT.

- **Save states** *(2026-05-31)*. Full live-VM snapshot/restore to a
  versioned JSON blob (typed arrays base64); bytecode/rooms/costumes reload from
  the game files. Per-game localStorage slots + file export/import; the real-MI1
  round-trip is byte-identical. Confirmed in-app.

- **Polish — first-rooms fidelity** *(2026-05-31)*. Closed the gap from "runs without halting"
  to "behaves like the original" for the first rooms: z-plane occlusion,
  jiffy/frame pacing, the magenta UI palette + sentence-line-as-verb-#100,
  costume-anim head tracking. Remaining cosmetic stubs are in Open backlog above.

- **Verb UI + input** *(2026-05-30)*. MI1 interactively playable boot →
  intro → first room via the original's own scripts (hover poller → verb-input
  script → sentence script; cutscenes; room lighting; inventory-as-verbs). See
  [INPUT](pages/docs/scumm/input.md), [CUTSCENES](pages/docs/scumm/cutscenes.md),
  [BOOT](pages/docs/scumm/boot.md).

- **Enough engine to walk** *(2026-05-28)*. 30+ opcodes, room/costume/
  object loaders, 13-slot actor table, pathfinding (A* over the walkable mask),
  frame compositor with z-planes, rAF main loop. Boot dispatches 3500+ opcodes
  into the title-screen idle. (Costume-anim decoder was still a known-bad spike
  here; solved in Phase 7 — see [COSTUME-ANIM](pages/docs/scumm/costume-anim.md).)

- **VM skeleton** *(2026-05-27)*. SCUMM v5 bytecode interpreter
  end-to-end at the structural level: index/LOFF/script loaders, var banks, 25
  cooperative slots, an opcode dispatch table (seed set), halt-as-first-class-state,
  and a VM inspector. See [INDEX](pages/docs/scumm/index-file.md),
  [OPCODES](pages/docs/scumm/opcodes.md).

- **Text — CHAR fonts** *(2026-05-26)*. `CHAR` bitmap-font decoder at 1 and 2 bpp +
  a string → indexed-buffer renderer; charset inspector. See
  [CHAR](pages/docs/scumm/char.md).

- **Costumes** *(2026-05-26)*. Costume decode end-to-end (sub-palette,
  image tables, RLE frames) + z-plane occlusion masks + an actor compositor. See
  [COST](pages/docs/scumm/cost.md), [ZPLANE](pages/docs/scumm/zplane.md).

- **First pixels** *(2026-05-26)*. Room palette + background bitmap
  decode (full SMAP method dispatch) rendered on Canvas2D with TRNS transparency.
  See [SMAP](pages/docs/scumm/smap.md).

- **Resource catalog** *(2026-05-25)*. Parse MONKEY.000/.001:
  XOR-decrypt (key 0x69), recursive block-tree walk, indented tree dump with a
  tag-description catalog.

- **Scaffold** *(2026-05-25)*. Vite + TS + Vitest; library / install /
  player screens; game detection; IndexedDB handle persistence; browser-support
  gate.
