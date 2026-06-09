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

Playing MI1 from boot and fixing each blocker engine-faithfully (committed on
`main`). **Unit suite green + tsc clean**, plus a data-gated, from-boot
integration playthrough (`npm run test:integration`). The whole of **Part I is
playable end-to-end** — intro, the three-trials setup, the kitchen/circus/shops
loop, the forest maze, and the insult-swordfighting grind up to the Sword Master
gate (see Frontier below).

**Working principle (agreed 2026-06-02):** no hacks/shortcuts — every change is
the final, SCUMM-faithful solution. Confirm the real mechanism first (disassemble
the original, check ScummVM semantics) before editing; when engine-faithful and a
quick shell workaround disagree, faithful wins. Verify the actual outcome (render
real pixels for visual bugs; reproduce the real flow for behaviour) — not the
bookkeeping. Surface any deferral/approximation explicitly and track it here;
never bury a shortcut. If "faithful" needs a bigger refactor, raise the tradeoff
rather than silently taking either the heavy path or the shortcut.

**The regression net — MI1 full walkthrough** (`integration/mi1/walkthrough.test.ts`,
started 2026-06-04). ONE seeded VM driven through the game's own solution from boot,
grown beat by beat; the **last green beat = the frontier**. From-boot + deterministic
(seeded RNG) so early regressions can't hide. Beats carry **zero `driveTicks`** — each
action waits on `waitReady`, then asserts via named condition-waiters (`waitPickedUp` /
`waitGlobal` / `waitPlayable`; a raw `driveUntil` only for bespoke predicates). Named
`<Part> · <Room> — <what it proves>`, file order = run order; per-game ids/vars in
`game.ts` (`ROOMS`/`VERBS`/`VARS`). Design + testkit pieces → [AGENTS "The harness"](AGENTS.md);
the *printing-sentence-blocks-the-next* finding → [INPUT §5](pages/docs/scumm/input.md).
A clean fast-forward save (`saves/MI1-walkthrough-frontier.websave.json`, gitignored,
written by the ALWAYS-LAST `frontier` beat and regenerated each green run) sits at the furthest
clean state — currently the sea bottom (room 42) with the idol ("l'idolo meraviglioso", #578) recovered.

**Frontier: ALL THREE Part-I trials are effectively done — swordfighting + treasure + the stolen idol.
The full thievery trial is now in the net: dogs → mansion gauntlet → Otis's cake/file → grab the idol
→ caught by the Sheriff → dumped in the sea → idol recovered. 46/46 green from boot.** Next: the
rope-cutting escape off the sea floor (room 42 is littered with sharp things), then Part I's wrap-up.
The idol-theft route as built (each a from-boot beat): **(a)** enter the mansion + trip the right-door
gauntlet for the loot → **(b)** prison: talk Otis → buy the mint → give Otis mint + rat repellent for
the cake → open it for the file → **(c)** back to the mansion, Walk to the hole (spioncino #637) with
the file → grab cutscene #211 → the idol (#635) → **(d)** the grab chains into the Sheriff/Governor
catch (#212; pick any excuse + the smitten-stammer menus), control returns, then leaving via door #633
with the idol fires the Sheriff block (#217) — taunt #122 "stai bloccando l'uscita" → thrown in the
harbor (rooms 53→83→42) → Pick up the sea idol (#578) = prize in hand. ALL DONE.
Routes + mechanics live in the walkthrough beats and `game.ts` helpers, not here. Findings worth keeping:

- **Into the mansion:** dogs-asleep (#201) lifts the dog-pen box lock and sets the gate door's class,
  so gate door #465 now opens (Open → global #25 → state 1) and Walk-to → `loadRoomWithEgo room=53`.
  Inside, the right-hand door #632 — opened, then Walk-to — runs the gauntlet cutscene (local #210),
  which arms the joke items and hands ego four of them (#640 rat repellent, #641 style manual, #642
  wax lips, #643 staple remover) before returning control.
- **Grabbing the idol:** the idol #635 is NOT directly pickable (verbs 8/90/91 only), and the broken
  window #638's own verbs are dead ends ("careful not to cut myself"). The hole you go through is the
  **spioncino #637** (its only verb is 11/walk-to): a bare click runs verb-11, which checks ego holds
  the file then `startScript 211` — the grab cutscene reaches through the gauntlet and `pickupObject`s
  the idol. (Confirmed by driving; the disasm of #637's class gate reads inverted vs the executing
  engine — ground truth is the run.)
- **The Sheriff catch + the sea.** The grab cutscene #211 chains straight into the catch #212 (it does
  NOT wait for a manual exit): the Sheriff + Governor confront ego with an excuse menu, then the
  smitten-stammer cascade in the Governor's close-up (room 23) — all don't-care options. Only AFTER
  that does control return in the mansion AND #215 reposition ego near the door. THEN leaving via door
  #633 (Open) with the idol runs #217 (Fester blocks the exit); its taunt menu's #122 "stai bloccando
  l'uscita" provokes the throw (rooms 53→83→42). (A plain Open *before* finishing the convo can't fire
  #217 — ego is parked far right by the grab and can't path to the door yet; that earlier dead-end was
  the convo not being complete, not a bug.) In the sea (room 42) the idol is a fresh object #578 with a
  real Pick up verb — grab it for the prize.
- **The prison (Otis) leg.** Talking to Otis (#405/actor 4) sets bit#420 and returns control with no
  menu — his breath complaint IS the trigger; bit#420 unlocks the store shopkeeper's "Avrei bisogno
  d'una mentina" line (verb 124, 1 piece of eight → mint #395). Otis DEFAULTS to class 6 (death-breath);
  giving him the mint CLEARS class 6, and his give-handler (verb-80 → room-local #203) only takes the
  repellent once class 6 is clear — then he hands over the cake (#420). **Opening the cake** sets class 3
  and clears class 6 (`actorSetClass [6,131]` = clear-6, set-3, since 131 = 0x80|3), renaming it
  "la lima" — that class-3 flip is the file marker the beat asserts (the disasm read these inverted; the
  executing engine is ground truth — #203/#420 are in the misaligning ~13%).
- **Rat-animation drawObject fix (committed engine fix, confirmed in-browser).** Entering the prison
  froze the VM: room 31's three #207 loops animate a rat-hole by re-picking one of its three same-box
  frames whose state is 0 and drawing it — but our `drawObject` set each drawn frame to state 1 and
  never reverted the previous, so after one pass all three latched at state 1 and the picker spun (100k-
  step guard). Fix (`opcodes/index.ts` `drawObjectHandler`): the same-box eviction we already do now
  ALSO reverts the overdrawn object's state to 0 (erased = hidden), sustaining the loop. Unit-pinned in
  `phase8.test.ts`; 892 unit + 44 integration green.

- **The petal:** in the flower screen (`g4==215`) Pick up the plant #678 → its verb-9
  `pickupObject`s #689 ("il petalo giallo") into inventory; #689 itself carries no Pick up verb, and
  every other forest screen's flowers are red (refused). Drug the meat by **Use petal with meat**
  (#566's verb-7 sets the drugged class + runs global #182: renames it "la carne condita", consumes
  the petal), then **Give** the drugged meat to the dogs (#467) — *Give*, not *Use*, is the verb that
  reaches the feed branch (#80 → room-local #201), which checks the drugged class and sets bit#15.
- **getDist box-clamp fix (committed-worthy engine fix).** "Give meat to dogs" aborted with "Non
  riesco ad arrivarci": room 36's ENCD locks boxes 1–6 (the dog-pen sleep-gate), the dogs' walk-to
  (140,132) sits in locked box 6, so the ego clamps to box 8's edge (x=191) and the sentence-#2
  proximity gate (`getDist >= 32`) failed at dist 51. Fix: `getDistHandler` now mirrors SCUMM's
  `getObjActToObjActDist` — it clamps an OBJECT's point into the box the ACTOR can reach
  (`clampPointToBoxes` over `effectiveBoxes`) before measuring, so the gate passes once the ego is as
  close as the open boxes allow. No-op for objects whose walk-to is already in a visible box.
  Confirmed in-browser by the user; 892 unit + 40 integration green.

**Testkit debt — `pushSentence` shortcuts (flagged at each call site).** A few beats commit a
sentence directly because the faithful click flow can't drive the gesture headlessly. Re-assessed
2026-06-09 (each verified, not assumed):
- **Two-inventory combine** (dog beat: Use petal with meat) — both objects are carried; the kit's
  `useWith` takes object B from the *room*, not a second inventory slot.
- **Give onto an actor-object** (dog beat: give meat to dogs; Otis: give mint/repellent to #405) —
  the receive-handler is verb-80 on the OBJECT, but `give(item, actorId)` resolves to the actor (no
  verb-80 there) and `useWith(item, objId)`'s scene click doesn't resolve object B onto an actor-
  overlaid object; both hit global #3 "Non sembra funzionare". (Contrast the troll/brother gives,
  whose actors ARE reachable by the actor-give path — `give()` drives those for real.)
- **One-object verb on a carried item** (Otis beat: Open the cake) — no kit gesture for arming a verb
  and clicking an inventory slot to commit a one-object sentence.
Each `pushSentence` is the exact `doSentence` the verb input would build, so the engine path under
test is identical. Retire them by teaching the testkit: two-inventory object B, a give committed onto
an actor-object, and a one-object inventory-slot verb. (Backlog item under Input / UI below.)

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
  • **RULED OUT — "object z-planes shouldn't occlude actors" (room ZP01 only).**
    Theory: drop object planes from `actorOcclusionPlanes`, leaving only room
    background planes (objects composite in draw-queue order, no z-plane
    object↔object layering, so the object plane would have no other consumer).
    Tried it (return `room.zPlanes`); **refuted in-browser** — the title-screen
    cloud and a forest rock both stopped occluding ego when they must. Object
    z-planes genuinely occlude actors (single-plane `ZP0k→k`, per `bde2e96`).
    The forest bug is positioning, not the occlusion model.
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
- [ ] **M — system `print` text lifetime: `restoreCharsetBg` approximated by
  cutscene-end / room-change / overwrite / camera scroll, not real screen
  redraws** (`vm.ts advanceOrEndTalk` + `endCutscene` + `moveCameraTo`). Faithful
  for the known cases (treasure-map close-up room 63 prints the dance steps then
  waits for a *click* → text must persist; the cook's "Non puoi venire di qui!"
  clears at its `endCutScene`; room 64's "Passano ore" clears when the dig
  cutscene pans the camera back). SCUMM's real eraser is `restoreCharsetBg` (the
  background under the blasted text is redrawn) — we approximate it with those
  triggers. **CONCRETE FAILING CASE (deferred, user-reported in-browser): room
  36's "no animals harmed" disclaimer renders WRONG.** Three coupled problems,
  all diagnosed:
  • **Text never shows.** Room-36 local #201 prints the 8 disclaimer lines
    (`print a=254`, charset 1, colours 2/8/3, offsets 227–434) then hits
    `endCutScene` (528) on the very next opcode with no delay; our `endCutscene`
    → `eraseTransientSystemText()` wipes them the same tick, before a frame draws
    → the white box (object #468, drawn at 219) shows empty.
  • **Lifecycle is click-dismiss.** `move g32=203` (g32 = VAR_VERB_SCRIPT) routes
    the next click to room-36 #203, which does `setState 468 0` (hide the box) +
    restore g32. In SCUMM hiding the box redraws that region → `restoreCharsetBg`
    erases the text. We DON'T model object-`setState` redraws as a clear trigger,
    so naively dropping the `endCutscene` erase makes the text stick forever
    (verified — lingers over the scene after the box is gone). The cook-shout
    unit test (`vm.test.ts`) pins the current `endCutscene`-clear, so the faithful
    fix (clear on real redraws incl. object setState) must re-verify the cook +
    other banners in-browser.
  • **Render off:** colours (EN "IMPORTANT NOTICE" green vs our magenta) and font
    weight differ — a charset/CLUT-mapping issue on the `charsetSet=1` + colour
    2/3/8 path. NOT audio (no sound op gates the disclaimer span; confirmed).
  Fixing this is the deferred `restoreCharsetBg` refactor + a charset/colour pass;
  needs in-browser pixel iteration.
- [ ] **L — flashlight gfx not modelled** (`opcodes/index.ts:~577`, dark-room
  strip extent). Cosmetic; only the flashlight rooms.
- [ ] **L — global arithmetic doesn't wrap at int16** (`Variables` is
  `Int32Array`, `value|0`). SCUMM globals are int16, so arithmetic past ±32767
  wraps in the original; ours saturates to 32-bit. Rare in MI1, and int16-clamping
  risks engine counters/timers — audit before touching.
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
- **Testkit gestures to retire the `pushSentence` debt** (see the debt note in
  Current): a two-inventory combine (object B from a second inventory slot), a
  give committed onto an actor-object (verb-80 receiver), and a one-object verb
  on an inventory slot. Each would let a flagged shortcut become a real click.

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

- **Disassembler misaligns on ~13% of MI1 scripts (want to address).** The
  linear sweep in `disasm.ts` hits a byte it can't size (a rare opcode whose
  operand layout we don't mirror, or embedded non-code data), then every
  instruction after it is garbage until — if ever — it re-syncs; a run ending
  `aligned: false` flags it. Concrete fallout:
  • `disgrogate SCAN` hits inside a misaligned script are *leads, not proof*.
  • the Explorer's **referenced global scripts** scan (`referencedGlobalScripts`
    in `room/extract.ts` — regexes `startScript`/`chainScript` lines for literal
    ids) silently misses any reference that lands in a misaligned tail, so a
    room's global list can be incomplete.
  • `global #178 tail` is one reproducible instance of the mis-size.
  Fixes to weigh: (a) close the remaining operand-size gaps so the linear decode
  aligns — `opcodes/index.ts` (the executing table) decodes the same stream
  correctly, so the disassembler is missing/mismatching some operand lengths;
  diffing the two would surface which. (b) decode from real entry points and
  follow jumps instead of a blind linear pass, so embedded data is never decoded
  as code. (a) is the smaller, higher-leverage fix.

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
