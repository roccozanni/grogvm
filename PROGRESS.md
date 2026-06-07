# GrogVM — Progress

Lean tracker. Two buckets:

- **Current** — what's in flight and what's open right now. This is also the
  **lab notebook**: capture each concrete finding as it happens — root causes,
  exact opcode numbers, semantics, the *why* — because this is the source
  material the end-of-phase doc update is written from. Don't reconstruct doc
  prose from memory later; that's how bad claims get in. A finding stays here
  until it has been written into the right `pages/docs/` file — only then trim it.
- **Next** — the work ahead, as one-liners. Broken into tasks only when we start.

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

### Open bug-report saves (reported, not yet fixed)

- **Forest maze z-plane positioning** (`MI1-Italiano-forest-occlusion` 212,
  `MI1-Italiano-flowers-occlusion` 215, `MI1-Italiano-wrong-strip` 202) — tiles
  occlude ego where they shouldn't. See the **H** Tier-2 item below for the full
  theory + findings.

### Tier-2 divergence checklist

Silent, self-flagged approximations (run `git grep -nE "for now|doesn't yet|best-effort|we don't yet"`
to refresh). Tiering: **Tier 1** = loud (halts on unknown opcode — fine). **Tier 2**
= these (silent until a script ordering makes them observable, like the EXCD bug).
**Tier 3** = unknown unknowns (only ScummVM differential tracing finds them).

Priority H/M/L = likelihood of biting current/near play × severity.

- [ ] **H — forest maze object/z-plane positioning: tiles occlude ego when they
  should be offscreen.** The forest (pseudo-rooms 201–220, all aliasing physical
  room 58 — `loadedRoom.id` 58, `VAR_ROOM`/g4 = the pseudo) is built **entirely
  from opaque drawn tile-objects**: room 58's SMAP is all-black, and the per-screen
  ENCD re-dresses it. The ENCD parks every tile offscreen (`drawObject N at
  x=100 y=0` = 800px, then `setState 0`), then a per-`g4` branch redraws that
  screen's tile set on a 3×2 grid (`drawObject … at x,y`, **SO_AT operands are in
  strips → ×8**). **Theory (where to resume): an object/z-plane positioning slip
  leaves a tile on-screen — occluding ego — when it should be offscreen for this
  pseudo-room.** Repro saves (gitignored): `MI1-Italiano-forest-occlusion` (212,
  z-plane over the sky), `MI1-Italiano-flowers-occlusion` (215, trunk z-plane over
  the flowers), `MI1-Italiano-wrong-strip` (202). The **`Z-planes` play-bar toggle**
  (added this session) visualises the merged actor-occlusion stack — use it.

  Findings (2026-06-07, paused for fresh eyes):
  • **#673 is the one culprit found so far** — drawn on only 6 of 20 screens
    (203/204/205/213/216/218, always bottom band `y=11`) and the **one object the
    park-all loop omits** (it parks 656–688 *except* 673). On the 14 screens that
    don't dress it, our room-init auto-draw (`vm.ts applyRoomResources` re-queues
    every persistent `state>0` object) resurrects it at its IMHD default (0,0),
    stamping its trunk z-plane over the wrong screen — the sky in 212, the flowers
    (#678 "le piante") in 215.
  • **Attempted fix — NOT committed, rolled back to restart clean:** gate the
    auto-draw to skip a pseudo-room hop (resolved physical room unchanged) so the
    per-screen ENCD is the sole authority on what's drawn. Fixed #673 on *fresh
    navigation* (212 + 215 verified by render). Caveat: only fixes fresh nav —
    a corrupt save bakes the bad draw-queue and `restoreVm` replays it verbatim
    (it deliberately skips the ENCD re-dress, savestate.ts:424). Whether that
    gating is the faithful model, or #673 should instead be *parked*, is the open
    question — #673 is the only known orphan but the user expects more.
  • **The all-1s heuristic was coincidental** — #673 is shaped (53%, decodes
    correctly); its bug is positioning, not solidity. **The all-1s hack is now
    REMOVED** (`decodeObjectZPlanes` keeps every plane). Removing it re-armed the
    `il sentiero` path objects (#685/#687/#688, class 0x0, solid ZP01): they are
    *correctly positioned* but occlude ego near the cave/edges — likely a separate
    z-plane-rule question, not this positioning bug. (Prior "ruled out" list for
    the all-1s rule, kept for reference: object class incl. class-32, `ZP0k→plane
    k` index, name-vs-order indexing, walk-box clip plane, image transparency, the
    ZP decoder.)
  • **Background tile seams** (hard vertical cuts at tile boundaries x=104/208)
    are **GENUINE** — present in the original game. Not a bug; ignore. → [ZPLANE].
- [ ] **M — dialog/string escape codes still deferred**
  (`decodeScummString` / `expandSubstitution`, `opcodes/index.ts:~2155`):
  keep-text `0xFF02`, sound `0xFF09`, actor-name `0xFF0A`, mid-string colour
  `0xFF0E` (each consumed but emits nothing). Surfaces as blank/wrong text or
  missing inline colour in dialogue-heavy content. (Also in Stubbed opcodes
  below.) *Done since last review:* `0x04` int, `0x05` verb-name, `0x06`
  object/actor-name, `0x07` string-resource all expand now.
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~524`).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
- [ ] **L — system `print` text clears on cutscene-end / room-change / overwrite /
  camera scroll, not the talk timer** (`vm.ts advanceOrEndTalk` + `endCutscene` +
  `moveCameraTo`). Faithful for the known cases (treasure-map close-up room 63
  prints the dance steps then waits for a *click* → text must persist; the cook's
  "Non puoi venire di qui!" clears at its `endCutScene`; room 64's "Passano ore"
  clears when the dig cutscene pans the camera back to the ego). The talk timer
  still only governs actor speech + `VAR_HAVE_MSG`. Regression surface: a
  non-keepText system `print` during *free gameplay* with no following
  cutscene-end / room-change / print / camera move would still linger; none in
  the walkthrough net, but not exhaustively ruled out. SCUMM's real eraser is
  `restoreCharsetBg` (screen redraw); we approximate it with those triggers, a
  camera scroll being the literal redraw.
- [ ] **L — flashlight gfx not modelled** (`opcodes/index.ts:~577`, dark-room
  strip extent). Cosmetic; only the flashlight rooms.
- [ ] **? — `actorOps` subop `0x0f` treated as no-arg no-op "for now"**
  (`opcodes/index.ts:~1874`; seen in MI1 boot after setCostume, not in the
  wiki). Assess whether it affects behaviour or is genuinely inert.
- Already tracked elsewhere (cross-ref, not duplicated here): line-following
  walker (Pathfinding backlog), `screenEffect` animation + `VAR_CURRENT_LIGHTS`
  darkening (Rendering backlog), `saveRestoreVerbs` subset (Watch-for), audio /
  `resourceRoutines` (Out of scope — Phase 11).

**Watch for** (recurring failure modes in newly-reached content):

- Unimplemented opcodes → an unknown-opcode halt freezes the *whole* VM.
- Object states beyond the initial `DOBJ` seed (only initial owner/state/class
  is parsed). See [OBJECTS §7a](pages/docs/scumm/objects.md).
- `saveRestoreVerbs`: we render-skip archived verbs (a subset of SCUMM's
  per-verb `saveid` model); revisit if a scene re-creates a saved verb id.
  See [INPUT §6](pages/docs/scumm/input.md).

**Tooling:** `npm run disgrogate` (+ `SCAN grep=`) is the disassembler CLI
(`tools/disgrogate.ts`) — keep it in sync with the executing opcode table
(AGENTS.md).

### Open backlog

Deferred out of earlier phases; none block current play. Detail in the linked docs.

**Input / UI**

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
- **Costume head-limb facing — remaining edges.** The head limb is re-pointed on
  the walk→stop transition (shipped 2026-05-31). Not yet handled: a *turn in
  place while idle* (a script changing `facing` with no walk) — the head keeps
  its last init-set frame; wire the same init-re-point on any at-rest facing
  change when a scene surfaces it. Two scene-specific symptoms noted earlier and
  **not since re-confirmed** (verify before chasing): a room-33 cliff N/S facing
  flip-flop (likely a walk direction-picker issue, separate from the head) and a
  room-38 entry head-loss transient. See [COSTUME-ANIM](pages/docs/scumm/costume-anim.md).

**Pathfinding**

- **Line-following walker (`calcMovementFactor`) — the faithful follow-up,
  deferred.** `stepWalk` steps X/Y independently; SCUMM moves along the line.
  Without this, thin diagonal connector boxes are fragile (actor drifts off) —
  the room-52 single-click bridge crossing is the live symptom (staged in the
  walkthrough). Touches every walk + the stepWalk unit tests (which encode the
  current independent-step behaviour) → re-verify intro/bar/kitchen + render.
  [PATHFINDING §9](pages/docs/engine/pathfinding.md). *(The walk-box-as-state
  half — tracking `_walkbox` instead of re-deriving it at draw time — is DONE;
  see the finding above.)*

**Stubbed opcodes (cosmetic / peripheral)**

- `roomOps`: `shakeOn`/`shakeOff`, `roomIntensity` / `setRGBRoomIntensity`,
  `saveString` / `loadString`.
- `cursorCommand` image subops (0x2C): `setCursorImage` / `setCursorHotspot` /
  `setCursor`.
- `matrixOp` (0x30): `setBoxScale` / `createBoxMatrix` no-ops (`setBoxFlags`
  is implemented — per-screen box locking).
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
