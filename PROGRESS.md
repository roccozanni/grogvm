# webscumm — Progress

Working tracker of what's done and what's next. The **active phase** is
broken into concrete tasks. **Future phases stay one-liners** until we
actually start them — speculative breakdowns rot.

When a phase is complete, summarize what was built under "Done" and
detail the next phase here.

---

## Status

**Phase 7 in progress — MI1 is now interactively playable in the first
room.** The intro plays automatically from boot through the full opening
with no halt (credits ~5700 ticks → Mêlée lookout room 38 → opening
dialog cutscene #203 → rooms 38 → 96 → 33), and in room 33 the player
can now actually *play*: the verb bar works (hover/click), **Look at**
an object makes Guybrush respond ("Non si riesce, troppo buio"),
**click-to-walk** moves him around with the **camera following**, the
**inventory** renders through the verb slots, and interactions clear
their dialog + deselect the verb. No boot-param hack — the real flow,
confirmed against ScummVM.

This session's work (all below): the inventory subsystem + verb-image
rendering, the click→sentence→verb-script loop, click-to-walk, the
room-33 walkbox-rasterization fix (degenerate staircase boxes), per-tick
camera follow, the door opcode tail (`getDist` / `ifClassOfIs` /
`startObject` variants), and a batch of UI fixes (verb-bar width, the
purple-strip bg, dialog-clear, verb-reset).

⚠️ **Harness note:** `scratch/run-boot.ts` resumes slots unconditionally
and never steps actor walks, so once dialog became paced (the talk-timing
commits) it falsely stalls in room 38 — `wait-for-actor` never releases
because Guybrush never finishes walking. Use **`scratch/drive-intro.ts`**
for end-to-end intro runs: it mirrors the inspector's per-tick loop
(freeze-aware resume + `delayRemaining` countdown, `runUntilAllYield`,
then `stepAllActorWalks` + `stepAnim`). That's what confirmed 0→10→38→96
→33 above.

**How credits→lookout actually works** (it's the boot's L0==0 path, not
L0!=0 — verified via ScummVM `scripts`): after the credits, boot #1's
title block does `putActorInRoom(ego, 38)` then `actorFollowCamera(ego)`
— and *following an actor in another room loads that room* (SCUMM's
startScene). Cracking it fixed four real opcode bugs:
- `0xAD` was mis-registered as `walkActorToActor`; it's `putActorInRoom`
  (the `low5=0x0D` family is non-orthogonal — bit 0x20 selects).
- `putActor` (0x01) clobbered the actor's room with `currentRoom`; SCUMM
  keeps the actor's existing room (`a->putActor(x,y,a->_room)`).
- `actorFollowCamera` didn't load the followed actor's room.
- `animateActor` missing var-operand variants (0x51/0xD1).

Also implemented `cutscene`/`endCutscene`/`freezeScripts` faithfully
(cumulative freeze count; the cutscene script is protected from
freezing) — `endCutscene` runs #19 which restores cursor/input.

⚠️ **Room 38 (lookout) renders very dark** — it's a night scene: its
background is mostly black + dark-blue sky (idx 0 = (0,0,0), idx 20-24 =
(16,16,56)..(36,36,116)), avg pixel brightness ~15%. Reads as "black"
but the data + palette are intact; not a render bug and NOT a lights
issue (the compositor doesn't honor `VAR_CURRENT_LIGHTS`).

`bootGame` defaults to param 0 (`BOOT_PARAM_ATTRACT`); param 1
(`BOOT_PARAM_NEW_GAME`) is a debug shortcut that skips the credits.

**MI1's input model — CORRECTED (bytecode-verified, two investigation
passes).** An earlier note here claimed input was "script #23 polling
g52, so feed g52+mouse → let #23 do it, NOT the handleSceneClick
shortcut." **That premise was wrong.** The real SCUMM v5 model:

- On a click the **engine** (C++ in the original; `vm.runInputScript`
  here) starts **`VAR_VERB_SCRIPT` (g32)** with locals
  `[clickArea, code, button]`, clickArea ∈ {1 verb, 2 scene, 3 inv,
  4 key}. g32 = global #4 at boot, overridden to room-local **#201** by
  room setup (in room 33 it's back to #4, the default handler).
- That script only **arms the active verb** (`g107`), **redraws the
  sentence line** (verb #100, via #12), and resets after action (#11).
  **None of #4/#11/#12/#23 issue `doSentence` for a look-at.**
- The **sentence commit (enqueue) is done engine-side**, not by a
  script — so `vm.handleSceneClick`'s `pushSentence(...)` **IS the
  faithful behavior**, not a shortcut to delete. (Verified: arming
  verb 8 + `handleSceneClick(429)` → #2 runs → `printEgo` "troppo
  buio".)
- **Sentence script #2** (`VAR_SENTENCE_SCRIPT`=2) holds the per-verb
  logic + the print; it runs only when a sentence is queued (our
  per-tick `processSentence` matches). Byte-traced: #2 prints "troppo
  buio" iff verb==8 AND `VAR_CURRENT_LIGHTS`(g9)==0.
- **#23** is the per-frame *hover/highlight* poller (gated on g52>0),
  used in gameplay rooms — complementary to the click hook, NOT the
  click dispatcher. Driving g52 enables in-engine hover highlighting.
- Confirmed runtime: g32=4, g33(sentence)=2, g34(inv)=9, set by boot
  script #1; g32→#201 overridden per room.

So "Step 3 = replace the handleSceneClick shortcut" largely dissolved:
the enqueue IS faithful. Genuine remaining gaps: drive g52 for #23
in-engine hover; faithful click-to-walk via a Walk-to sentence (the one
real shortcut left, `walkActorTo`); `actorFromPos` (still a 0-stub,
needed for Talk-to an actor).

The inspector has stable DOM during Play; controls + frame stack mount
once and only canvas pixels update per tick.

### Session log (right-click look-at + smoke tests + two-object recon)

DoD #3 right-click and the 3 smoke tests landed (see locked list). Open:
- **Right-click look-at is pragmatic** (always verb 8), not the faithful
  g182 per-object default verb — needs hover default-verb tracking.
- **Two-object NOT implemented — investigated only.** It's an engine-
  side sentence-builder state machine (not a verb table); verb ids +
  globals recorded in the locked-list item. Design with Rocco first.

### Session log (opcode-stub audit — DONE, clean)

`scratch/audit-opcodes.ts` traced the whole start→room-33 path: 88
opcodes, **no gameplay-logic stubs**. The 7 stubs are sound (separate
phase), resource-routines (correct no-op), charsetColor (intentional),
and cosmetic roomOps/pseudoRoom — see the locked-list item. With this,
all Phase-7 blockers are addressed. Only loose end: the two-object A+B
*commit* still wants a later room / real inventory item to exercise
end-to-end (single-object + the faithful gather flow are proven).

### Session log (faithful input rebuild — DONE)

Replaced the engine-side click shortcut with MI1's real g52→#23→#4 flow
(details in the locked list). Open / watch:
- **Two-object A+B not yet exercised end-to-end** — room 33's intro has
  no use-with-able object pair; the g110 prep machinery is in place but
  needs a later room / real inventory item to prove the full A+B commit.
- **g52 driven from `cursor.state` counter** (mirrors o5_cursorCommand).
  If a future room shows no hover, check g52>0 (cursor.state) first.
- **Right-click = g182 default verb** now (faithful), not hardcoded
  Look-at. The default verb comes from #23/#4 per hovered object.
- The early "input-model CORRECTED" note (enqueue is engine-side) was
  wrong and is now fully superseded — #4 commits the sentence.

### Session log (cutscene UX — DONE)

Closed DoD #6 + the click-gating blocker. Open / worth remembering:
- **Inspector crosshair still paints during cutscenes** — intentional
  dev-visibility (engine `cursor.visible` is correct, shown separately).
  Revisit if/when we want a faithful "no cursor in cutscene" look.
- **`saveRestoreVerbs` matches by id range, not save-slot id** — fine
  for MI1's symmetric save/restore (#18/#19); a game that nests saves
  under different ids on the same verbs would need real save-slot keys.
- **`abortCutscene` only skips cutscenes that ran `beginOverride`** (per
  the original). Many gameplay cutscenes arm one; the intro mostly
  doesn't, so Escape is often a no-op there — expected, not a bug.

### Session log (room lighting — DONE)

Room-lighting blocker fixed (details in the locked list). Still open /
worth remembering:
- **`lights` flashlight variant (arg3 != 0) is not drawn** — operands
  consumed so scripts stay aligned, but no flashlight gfx yet.
- **Deliberately did NOT port `VAR_V5_TALK_STRING_Y = -0x50`** from the
  original `resetScummVars` — our talk text is positioned from the
  actor's `drawBounds` (above-head), so seeding a hard-coded talk-Y
  would fight it. Revisit only if talk placement regresses.
- **Disassembler is now first-class: `src/engine/vm/disasm.ts`** (tested;
  CLI front-end `scratch/dis.ts` with a `SCAN` mode). It still
  **misaligns on ~13% of scripts** (rare opcodes / embedded data) — treat
  `SCAN` hits in a "misaligned" script as leads, not proof; empirical
  probing (`scratch/probe-lights.ts`) is reliable. Must be kept in sync
  with `opcodes/index.ts` (see AGENTS.md).

### Session log (charset-id resolution fix + talk position)

The lookout-scene talk used the wrong (thin) font and drew over the
actor. Two bugs, both fixed:

- **Charset id → resource was resolved by file-walk order, not the
  `DCHR` directory.** Scripts pass a SCUMM charset id to `initCharset`
  (room 38 talk = id 2); we were doing `walkCharsets()[id]`, but the id
  space comes from the index's `DCHR` directory and is *different* — MI1
  has built-in null entries (ids 0, 5) so the mapping is offset from walk
  order. `initCharset 2` should select the bold 2-bpp talk font (walk[1],
  h9) but `walk[2]` gave the thin 1-bpp font (h8). New
  `resolveCharsetById(file, index, loff, id)` maps id → `DCHR[id]
  {room,offset}` → `loff(room)+offset` → CHAR block; wired onto the VM as
  `vm.resolveCharset` (boot) and used by the shell's `activeCharset`
  (falls back to walk order for the null charsets). The credits' charset
  4 was subtly wrong too (gave walk[4] h14, not the real h15 serif) —
  now correct. +3 tests. Verified vs real data: id 2 → h9 2-bpp bold.
- **Talk text now sits above the actor's head, not over them.** The
  overhead bubble anchored its bottom at `actor.y − 24` (mid-body); it
  now anchors just above `actor.drawBounds.top` (the real drawn sprite
  top recorded by the compositor), falling back to a feet-estimate before
  the first composite.
- **2-bpp text outline is now black, not teal.** MI1's talk/credit fonts
  are 2-bpp: glyph value 1 = inner fill, value 2 = outer outline (decoded
  a real 'M' to confirm). We were colouring the outline from the
  charset's *embedded* `colorMap[2]` — but those ramp entries (teal/red)
  are editor placeholders, not render colours. SCUMM draws the fill in
  the text colour and the outline as a **black shadow**, so `drawText`
  now forces the 2-bpp outline levels (values 2–3) to CLUT 0. Fill stays
  `inkColor` (talk colour / SO_COLOR). Matches the reference (white fill,
  black outline).

Tests: **589 across 46 files**; typecheck clean. ⚠️ Visual: the bolder
font + above-head placement + black outline want an in-browser confirm.
⚠️ **Still open — credits *fill* colour (teal vs magenta).** Bytecode
says the credit names print with `color=3` → CLUT3 = teal (the copyright
line uses `color=5` → CLUT5 = magenta and renders correctly). So teal IS
faithful to this data; the reference's magenta needs a same-version
palette/charset-colourmap comparison before changing anything — do NOT
hard-code (see the long-standing note in Polish/known gaps).

### Session log (dialog word-wrap + \xff\x03 sentence paging)

Dialog text now lays out properly instead of overflowing / mashing:

- **Word-wrap + per-line centring.** `wrapText` (graphics/text.ts) breaks
  talk text on spaces to a `TALK_MAX_WIDTH` (screen − 32px) box; an
  over-long single word stays whole. `drawText` was rewritten to render
  each `\n`-separated line on its own and centre it independently — it
  used to left-align every line within the widest line's bbox. The
  overhead bubble grows upward (block bottom anchored above the speaker)
  and is clamped on-screen. +5 wrapText tests.
- **`\xff\x03` = sentence page break.** MI1 separates sentences with the
  "wait" code, which we used to strip → "Salve!Mi chiamo…" mashed.
  `decodeScummStringPages` splits a print into pages; the first shows
  immediately, the rest queue via `vm.queueTalkPages` and the talk timer
  flips to each in turn (`beginTick`), holding `VAR_HAVE_MSG` until the
  last. Gated on page-count > 1, so single-page lines are unchanged.
  Verified on real data ("Salve!" → "Mi chiamo Guybrush…"; "Yikes!" →
  "Non dovresti…"). +2 vm tests.

(Earlier the same session: actorFromPos/Talk-to + faithful click-to-walk,
committed as d067108; a per-char typewriter was tried and reverted —
v5 has no per-char reveal.)

Tests: **586 across 46 files**; typecheck clean; intro still runs into
room 33. ⚠️ Visual feel of the wrapped/centred bubbles + the page pacing
wants an in-browser look when convenient.

### Session log (Talk-to / actorFromPos + faithful click-to-walk)

Closed both engine "faithful input refinements" (next-steps #3 b+c):

- **`actorFromPos` is real now** (was a 0-stub). The opcode read its
  coords as bytes; the reference says `p16` (words) — fixed, matching
  ScummVM's `getVarOrWord`. New `vm.actorFromPos(x,y)` hit-tests the
  point against each actor's **`drawBounds`** — a room-space bbox the
  compositor records every frame (union of the actor's drawn limb
  extents), the engine's stand-in for SCUMM's per-actor gfx-usage bits.
  Skips the Untouchable class (32); returns the topmost (highest-id)
  overlapping actor. Wired into the play-area hover so clicking an actor
  feeds the sentence → **Talk-to**; the hover box outlines a hovered
  actor too. Cosmetic gap: the sentence line still shows `obj #N` for
  actors (no actor-name table). +8 tests.
- **Faithful click-to-walk — the shortcut is gone.** Investigation
  (`scratch/inspect-walk-click.ts`) showed MI1's verb-input **script #4**
  *already* walks ego to a bare floor click by itself (it reads the
  mouse-coord vars and issues `walkActorToObject`). So instead of
  routing a Walk-to sentence, the fix was to delete the engine-side
  `vm.walkActorTo` call from `onRoomClick` and rely on
  `handleSceneClick` → #4. `input.ts` now also syncs the mouse-coord
  vars on `pointerdown` so the click point is authoritative for touch /
  synthetic input. Headless proof: ego walks 346→160 to the click with
  no shortcut. +1 test.

(A per-char dialog "typewriter" reveal was also tried this session and
then **reverted** — Rocco confirmed MI1 talk pops in all at once in
ScummVM; v5 has no per-char reveal. `VAR_CHARINC` is the hold-duration
multiplier, not a reveal rate. See next-steps #2.)

Tests: **579 across 46 files**; typecheck clean. ⚠️ Both wins are
proven headlessly but the *visual* result (clicking an NPC to talk;
click-to-walk feel) wants a quick in-browser look when convenient.

The one untouched next-steps #3 item is **(a) drive `VAR_CURSORSTATE`
(g52) on clicks for MI1's #23 in-engine hover** — deliberately left:
it's the lowest-value of the three (the inspector already draws its own
hover box, now for actors too), it's purely cosmetic, and it's the one
that most needs live visual tuning to confirm #23 doesn't misbehave when
g52 is driven. Best done with eyes on the browser.

### Session log (input-model correction + dialog/inventory fixes)

This session: investigated the real input model (above) and, in the
process of driving input through MI1's own scripts, fixed real bugs.

- **Carried-item name table** (inventory polish 1a): `vm.inventoryNames`
  snapshots an object's OBNA name at pickup (`captureInventoryName`,
  called from `pickupObject` + `setOwnerOf`), and `vm.objectName(id)`
  resolves current-room-first then the snapshot. So a carried item keeps
  its label after leaving its pickup room instead of showing `obj #N`.
  The sentence line uses `vm.objectName`. +8 tests.
- **Two opcode/string bugs** (surfaced by running the verb scripts #4/
  #11/#12/#23 for real): (a) `verbOps setVerbName` scanned for the
  `0x00` terminator WITHOUT skipping `0xff NN [arg]` escape sequences,
  so it stopped on an escape argument's `0x00` and misaligned the PC →
  halt on a stray `0xff` (MI1's sentence-line verb #100 builds its name
  entirely from substitution codes). Now uses the escape-aware
  `readScummString`. (b) `readScummString` only treated codes 4–9 as
  4-byte; aligned to all codes ≥4, matching `decodeScummString`.
- **Ego-print masking fixed (two text channels).** Persistent system
  text (signs / narrator / credits — reserved actor ids) now lives in
  `vm.systemText`, separate from transient actor speech in
  `vm.activeDialog`. Before, both shared one slot, so Guybrush's reply
  destroyed room 33's "Le Tre Prove" sign (and it never came back). The
  renderer paints both (system under, speech on top); timing
  (VAR_HAVE_MSG / talkDelay) is unchanged. Verified end-to-end: the sign
  persists through and after the spoken reply. +2 tests.

Tests: **570 across 46 files**; typecheck clean.

### Session log (through credits → playable intro)

Highlights of the work that got MI1 booting through its intro into
live scenes. Reference tables added so we stop guessing:
`src/engine/vm/vars.ts` (canonical system-var indices) and
`docs/SCUMM-V5-OPCODE-REFERENCE.md` (per-opcode encodings).

- **Verb dispatch + sentence + wait subsystems**: `parseVerbScripts` +
  `LoadedObject.verbs` + `vm.startVerbScript`; `vm.sentenceStack` +
  `doSentence` + per-tick `vm.processSentence` (sentence script id from
  `VAR_SENTENCE_SCRIPT`=33 → MI1 #2); `wait` (0xAE) via PC-rewind.
- **Object classes**: `actorSetClass` (0x5D) + `vm.objectClasses`;
  `getObjectState`/`getObjectOwner`; a batch of room-entry opcodes
  (`stopScript`, `matrixOp` stub, `saveRestoreVerbs` stub,
  getActor X/Y/Room/WalkBox, isSoundRunning) — rooms now load.
- **Cutscene / freeze (real, was stubbed)**: cumulative
  `ScriptSlot.freezeCount`; `cutscene`/`endCutscene` maintain a stack,
  run `VAR_CUTSCENE_START/END_SCRIPT` (#18/#19), and the cutscene script
  is protected from freezing; `freezeScripts` honoured.
- **Canonical var table reconciliation**: 52 = `VAR_CURSORSTATE`
  (removed a bogus press-pulse hack), 14 = `VAR_MUSIC_TIMER` (15/16 are
  ACTOR_RANGE_MIN/MAX, no longer auto-incremented).
- **Credits → lookout (the milestone)**: cracked via ScummVM `scripts`
  output — boot #1's title path does `putActorInRoom(ego, 38)` then
  `actorFollowCamera(ego)`, and following an actor in another room loads
  it. Fixed 4 opcode bugs: `0xAD` is `putActorInRoom` not
  `walkActorToActor` (split the non-orthogonal `low5=0x0D` family);
  `putActor` keeps the actor's room; `actorFollowCamera` triggers the
  room load; `animateActor` var-operand variants.
- **Intro scenes**: `walkActorToObject`, `faceActor`, `setOwnerOf`,
  `startObject`, `loadRoomWithEgo` — the opening dialog + scene changes
  (rooms 38 → 96 → 33) now play.
- **Inspector dev tools**: 120 Hz Play (batches ticks/frame), "Skip
  cutscene", "Warp to room" probe; idle-detector ignores active
  cutscenes; `delay` countdown counts as progress.
- **Text rendering — charset + credits layout**: the renderer froze the
  charset at mount; now resolves it live from `vm.currentCharset`
  (cached), so the credits' charset-4 serif font + gameplay fonts each
  render correctly. Implemented SCUMM's **sticky `_string[0]` state**:
  system `print`s persist position/colour/centre across calls (incl.
  configure-only prints), so the credit roll inherits its `(160,150)`
  centred anchor instead of falling to a font-naive bottom fallback;
  actor talk stays separate (computes position from the actor). Bottom
  fallback is now block-height-aware so tall/multi-line text can't clip.

Recurring gotcha: **many v5 opcode families are non-orthogonal** — the
same low-5-bits map to *different* ops selected by a high bit (e.g.
`0x0D` walkActorToActor / `0x2D` putActorInRoom; `0x16` getRandomNumber
/ `0x36` walkActorToObject / `0x56` getActorMoving; `0x03/0x23/0x43/0x63`
getActorRoom/Y/X/Facing; `0x05` drawObject / `0x25` pickupObject). Never
register all 8 high-bit variants of a family blindly — decode against
the reference + real bytecode. (This pass found three such bugs: a
blanket `drawObject` registration had eaten `pickupObject`'s opcodes,
and `findInventory` was wired at `0x15` which is really `actorFromPos`.)

- **Inventory subsystem + opcode mis-registration fixes** (cleared the
  last intro blocker). Added `getInventoryCount` ($31/0xB1),
  `findInventory` ($3D family) and `pickupObject` ($25 family); the
  inventory model reuses `vm.objectOwners` (SCUMM ties inventory
  membership to ownership) via new `vm.inventoryCount(owner)` /
  `vm.findInventory(owner, index)` (Map-insertion = pickup order).
  Fixed **three non-orthogonal-family mis-registrations** the previous
  pass left: (a) `findInventory` was wired at `0x15` — but `0x15` is
  `actorFromPos` (now correctly named + decoded with `p8` coords, still
  a return-0 stub until actor hit-testing lands), and the real
  `findInventory` is `$3D`; (b) `drawObject` ($05) was blindly
  registered across all 8 high-bit variants, swallowing `0x25/0x65/
  0xa5/0xe5` which are `pickupObject`; drawObject now owns only
  `0x05/0x85` (its sole `object[p16]` operand). With these, the intro
  runs 0→10→38→96→33 with no halt and script #9 (the inventory-display
  script) polls all 8 slots via `findInventory 0xfd` correctly.

- **Inventory is verb-based — `runInventoryScript` + `getVerbEntryPoint`
  wired** (chose the faithful path over a separate widget). Confirmed
  via the live trace that **MI1's script #9 IS `runInventoryScript`**:
  it reads ego's items via `findInventory` and lays them into the
  **inventory verb slots** (verbs 200–207; 208/209 = scroll arrows), so
  inventory renders *through the verb bar* — no separate widget. Added
  `vm.runInventoryScript(arg)` (runs `VAR_INVENTORY_SCRIPT` = g34 = #9,
  `local0 = arg`, non-recursive — stops any prior instance), called from
  `pickupObject(1)`. Implemented `getVerbEntryPoint` ($0B family) — #9
  used it as "does this object have this verb?" and halted on `0x8b`
  without it. With both, #9 runs to completion and turns verbs 200–207
  **on**. ⚠️ **Items aren't visible yet:** #9 assigns each slot an
  object via `verbOps` subop `0x16` = `SO_VERB_IMAGE_IN_ROOM` — **MI1
  inventory items are object ICONS, not text**. Our `0x16` only
  annotates today; rendering icons needs storing `{obj, room}` on the
  `VerbSlot`, cross-room object-image loading (new), and compositing the
  icon into the verb-bar slot rect. Open question: #9 assigned fixed ids
  1031/1032/1033 from "room 99" (not the live item 426) — understand
  whether those are per-slot UI display objects before building it.

- **Verb bar + sentence line are now screen-width (320), not room-width**
  (they're fixed screen UI; verbs sit in 0..319 screen-space). New
  `VIEWPORT_W` constant drives the canvas width, CSS width, clear/fill,
  and the click hit-test scale. The full-room debug frame + cursor
  overlay stay room-width (correct).

- **Inventory slots now render (image verbs).** Resolved the
  1031/1032/1033 question: **room 99 is the global UI room**; obj 1032 =
  empty bordered slot cell (40×24), obj 1031 = a "filled" slot cell
  (same picture for *every* occupied slot — verified by giving two
  different items, both slots got 1031, so it's a generic occupied
  placeholder, NOT a per-item icon), obj 1033 = the scroll arrow
  (16×24). Implemented the rendering faithfully: `VerbSlot.image
  {obj, room}` set by `verbOps` `setImage` (0x01, current room) /
  `setImageInRoom` (0x16, explicit room) and cleared by `setName`; the
  verb bar composites the object's sprite (cross-room via
  `vm.resolveRoom`, cached by id) into the slot rect — colours through
  the current room's palette, transparency via the sprite's room's TRNS.
  Added an inspector **"Give item"** debug button (gives ego a room
  object + runs #9) so the slots can be seen populating without a real
  pickup. ⚠️ **Open:** since 1031 is a generic placeholder, item
  *identity* (which item is in a slot) must come from a path my
  synthetic scenery-object test can't trigger — needs a real takeable
  item picked up in-game to confirm (text-on-hover via the sentence
  line, or a per-item icon assignment #9 takes for real items).

- **Click-to-walk wired + verb-bar hit-test fix.** Confirmed the
  single-object interaction loop works end-to-end: arm a verb (e.g.
  Esamina) + click a room object → `handleSceneClick` queues the
  sentence → `processSentence` runs script #2 → Guybrush responds
  (verified headlessly: looking at the room-33 poster yields *"Non si
  riesce, troppo buio"*). Added **click-to-walk**: clicking the floor
  (or any click with no verb armed) walks ego to the room coords via
  the pathfinder. Refactor: `startWalk` (walk planner) moved from
  `opcodes/index.ts` into `actor/walk.ts` (exported, shared) and
  surfaced as `vm.walkActorTo(actorId, x, y)`.
  ⚠️ **Pre-existing walkbox/placement issue surfaced in room 33:** ego
  spawns at (13,76) inside an **isolated 13-cell walkable pocket**,
  while the room's real floor is at y≈120–142 (~6000 cells), 1008px
  wide. A* (correctly) can't route out of the pocket — so click-to-walk
  *and* the `walkActorTo` opcode both strand ego there. Not a wiring
  bug; the walkable-mask rasterization or ego's entry Y for room 33 is
  off. Flagged for the pathfinding/walkbox pass.

- **Two interaction-loop fixes** (from live testing the look-at flow):
  (1) **Actor speech now clears when the talk finishes** — `beginTick`
  was draining `talkDelay`/`VAR_HAVE_MSG` but never nulling
  `activeDialog`, so a `print` description lingered forever (and tracked
  the actor as he walked). It now clears actor speech on talk-done;
  system/credit text (actor 255) still persists until overwritten.
  (2) **The armed verb deselects after the action** — `handleSceneClick`
  now resets `currentVerb` to null once the sentence is queued (the
  queued sentence already captured the verb id), matching MI1's
  reset-after-action. +4 tests.

- **Door opcode tail (open-door no longer halts).** Opening a door
  surfaced three missing opcodes in sentence script #2; all are
  fundamental/broadly-used, not door-specific: **`getDist`** (`$34`
  family) — distance between two objects/actors (actor-or-object
  resolved like `faceActor`; SCUMM Chebyshev `max(|dx|,|dy|)`; 0xFF when
  unresolvable) — used as a proximity gate; **`ifClassOfIs`**
  (`0x1d`/`0x9d`) — the read side of the object-class system (was
  write-only via `actorSetClass`): `unless (object matches every listed
  class) goto target`, class value low-7-bits = class, bit 0x80 =
  polarity; **`startObject`** var-mode variants (`0x77`/`0xf7`) — the
  non-orthogonal `low5=0x17` family only had `0x37`/`0xb7` registered.
  Door-open now runs to completion (it won't *visibly* open in room 33
  yet — ego can't reach it, the walkbox issue above). +8 tests.

- **Verb-bar background fix (the purple strip).** The bar filled its
  background with `transparentIndex`-as-colour — but that's a
  transparency *key*, not a colour (room 33's is idx 5 = magenta), so
  the uncovered top strip painted purple. Now fills CLUT 0 (black), per
  MI1.

- **Walkbox rasterization fix — room 33 ego no longer stranded.** Ego
  spawned in a disconnected pocket because room 33's staircase boxes
  (2–6) are *degenerate zero-area quads* — diagonal connector **lines**
  (UL==UR, LR==LL). The mask rasterizer scanned by rows only, so a thin
  line lost connectivity: steep lines survive a row scan but **shallow**
  ones (dx≫dy) put their one-pixel-per-row dots ~5px apart → islanded.
  Fix: `buildWalkableMask` now scans **both axes** (rows *and* columns)
  and unions — connects a thin line of any orientation, idempotent for
  filled quads — plus keeps one centre pixel for sub-pixel-thin spans.
  Ego's walkable component went 13 cells → **100% (6277)**; he now walks
  the full staircase to the floor, and the door gives its real response
  (*"Non riesco ad arrivarci"*) instead of being unreachable. +3 tests.

- **Camera now follows the actor per tick.** `actorFollowCamera` only
  snapped once, so once ego walked he left the static viewport (entered
  room 33 in-view at x=13, walked to x=346 with the camera stuck at
  160 → off-screen). Added `vm.cameraFollowActor` + `moveCameraFollow()`
  (called from `beginTick`, so every driver gets it): a central
  dead-zone band (±80px) — the actor drifts a little before the camera
  scrolls (no jitter) but never leaves the 320-wide view; centre clamped
  to the room. +4 tests.

Tests: **561 across 46 files**; typecheck clean.

### Next steps

> **Canonical remaining-work list = "Remaining to close Phase 7 — LOCKED
> LIST" in the Active Phase section below.** The notes here are kept as
> historical narrative of what was investigated/done; trust the locked
> list for what's still open.

1. **Inventory polish** — slot rendering + hover + click + **(a) the
   carried-item name table (DONE this session)**. Remaining:
   (b) **scroll arrows** (verbs 208/209) for paging when >8 items;
   (c) **two-object sentences** (`Use X with Y`) — note this is best
   done *after* #3 below, since the second-object logic lives in MI1's
   scripts, not engine-side (a hardcoded two-object verb list would be
   throwaway).
2. **Dialog text reveal — NOT a thing in v5 (per-char typewriter was
   reverted).** I briefly added a per-character reveal, but Rocco
   confirmed against ScummVM that MI1 talk **pops in all at once** — the
   v5 engine draws the whole talk string in one pass and `VAR_CHARINC`
   only sets the *hold duration* (`talkDelay = length × charinc`, already
   wired and correct). There is no typewriter for actor talk; the
   reveal was unfaithful and is gone.
   **Word-wrap + per-line centring + `\xff\x03` paging — DONE.** Long
   talk lines now word-wrap to a text box (`wrapText` in
   `graphics/text.ts`, greedy break on spaces to `TALK_MAX_WIDTH` =
   screen − 32px) and `drawText` centres each wrapped line independently
   (it used to left-align lines within one block). The inline `\xff\x03`
   "wait" code — which MI1 puts between sentences — is now honoured as a
   **sentence page break**: `decodeScummStringPages` splits the print
   into pages, the first shows immediately and the rest are queued
   (`vm.queueTalkPages`) and advanced by the talk timer in `beginTick`,
   so "Yikes!" then "Non dovresti…" show one at a time (verified on real
   data). Gated on page-count > 1 → zero change for single-page lines.
   Remaining dialog polish (minor): the overhead bubble's vertical anchor
   is rough, and `\xff\x04+` substitutions are still dropped.
3. **Faithful input refinements** — the big "rebuild input through #23"
   premise was a misread (see the corrected input-model note up top:
   `handleSceneClick`'s enqueue IS faithful). Remaining items:
   (a) drive `VAR_CURSORSTATE` (g52) on real clicks so MI1's #23 does
   in-engine hover highlighting *(still open; lowest value — the
   inspector already draws its own hover box)*;
   (b) **faithful click-to-walk — DONE.** It turned out NOT to need a
   Walk-to sentence at all: MI1's verb-input script **#4** (the
   `VAR_VERB_SCRIPT` for room 33) already walks ego to a bare floor
   click on its own — it reads the mouse-coord vars and issues
   `walkActorToObject`. So the fix was to *remove* the engine-side
   `vm.walkActorTo` shortcut from `onRoomClick` and let `handleSceneClick`
   → #4 do the walk. `input.ts` now also writes the mouse-coord vars on
   `pointerdown` (not just `pointermove`) so the click point is
   authoritative. Proven headlessly in `scratch/inspect-walk-click.ts`
   (ego walks 346→160 to the click, no shortcut).
   (c) **`actorFromPos` — DONE** (was a 0-stub reading bytes; the
   reference says p16 words). Now backed by `vm.actorFromPos(x,y)` which
   hit-tests against each actor's last-drawn bounds — `Actor.drawBounds`,
   the union of limb frame extents the compositor now records each frame
   (our stand-in for SCUMM's per-actor gfx-usage bits). Skips the
   Untouchable class (32); returns the highest-id (topmost) match. Wired
   into the play-area hover so clicking an actor feeds the sentence
   (**Talk-to**); the hover box now also outlines a hovered actor.
   ⚠️ Cosmetic gap: the sentence line shows `obj #N` for an actor (no
   actor-name table is loaded — SCUMM stores actor names separately).

Polish / known gaps (any time):
- **Sentence line should render in-canvas (top of the verb panel), not a
  separate DOM div.** MI1 draws the sentence ("Walk to door") on the
  strip at the top of the verb area (screen y≈144–151). We currently
  render it as an HTML `<div>` above the verb-bar canvas, separate from
  the engine's layout. Faithful fix: draw the sentence text into the
  verb-bar canvas at that strip (via the CHAR renderer) and drop the
  div. Cosmetic/architectural; deferred. (Spotted alongside the purple
  strip, which was a separate bg-colour bug, now fixed.)
- Lookout (room 38) renders very dark — it's a night scene; the
  compositor doesn't honor `VAR_CURRENT_LIGHTS` (cosmetic).
- ~~No word-wrap / per-line centring; `\xff\x03` phrases mashed.~~
  **DONE** — `wrapText` word-wraps talk to a text box, `drawText` centres
  each line, and `\xff\x03` is honoured as a sentence page break
  (`decodeScummStringPages` + `vm.queueTalkPages`, advanced by the talk
  timer). See next-steps #2. Still open (minor): `\xff\x04+`
  substitutions are dropped, and the overhead-bubble vertical anchor is
  approximate.
- **Credits *fill* colour: reference shows magenta, we render teal.**
  Re-investigated exhaustively (2nd pass). Conclusive: **every** credit
  line in script #152 prints with `SO_COLOR 3` literally — traced all of
  them, incl. "Animazione di / Steve Purcell…" (the screenshotted line);
  only the copyright line uses `SO_COLOR 5`. Our `color 5 → CLUT5 →
  magenta` renders correctly, which *proves* the colour→CLUT mapping is
  right, so `color 3 → CLUT3 → teal` is equally faithful. Room 10 issues
  **no** `roomOps`/palette ops and **no** `charsetColor` (verified by
  trace — the only `charsetColor` is room 38's). v5 rooms carry a single
  `CLUT` (no PALS variants), CLUT3 = teal (the water uses it). So nothing
  in the engine is remapping it; teal is what this exact CD-ROM data
  specifies. The reference's magenta must be a **different release**
  (this data is the Italian VGA CD — "Conversione CD-ROM di Aric
  Wilmunder"; the 2009 Special Edition / other localisations recolour the
  credits). **Do NOT hard-code magenta.** ⚠️ Note: `charsetColor` (0x0e)
  IS still a stub, but implementing it naïvely would REGRESS the lookout
  scene (room 38 sets `[0,6,2]`, which doesn't map to the now-correct
  white-fill/black-outline) — our "fill = text colour, outline = black"
  model is the faithful one; leave charsetColor stubbed.
- Smooth camera pan for `panCameraTo`; per-tick actor-follow tracking.
- Costume-anim decoder vs MI1 Guybrush (see SCUMM-V5-COSTUME-ANIM.md).
- **"Le tre prove" cutscene runs too fast.** The short cutscene between
  the lookout scene and room 33 (the one showing "Le tre prove" / the
  Three Trials) ends in under a second; in the real game it holds for
  several seconds. A pacing bug — likely a `delay` / `wait` / talk-timer
  that isn't holding the cutscene as long as the original (our tick rate
  vs. the original's, or a `delay` countdown released too early, or the
  system-text talk-timer draining instead of waiting on a user/timed
  gate). Investigate the cutscene's bytecode (which scripts pace it) and
  compare our per-tick driver's timing against MI1's ~60Hz/jiffy clock.
- **Z-plane occlusion is wrong (actors/objects render in front of
  things that should occlude them).** In the lookout scene the fire
  draws *in front of* the stone wall (should be behind), and actors
  generally composite on top of scenery that should be in front of them.
  The z-plane masks decode (Phase 3) and the "any plane index > actorZ
  hides" rule is implemented, but something in the compositing path is
  off — candidates: object draw order vs. z-planes, the actor's `z`/
  elevation not being set from walk-box or script, the per-object OBIM
  z-plane not being applied to drawn objects (only to actors), or a
  plane-index polarity/threshold bug. Needs a compositor pass:
  re-verify decoded plane masks against room 38/33 geometry and how each
  drawn object + actor picks its occlusion plane. See SCUMM-V5-ZPLANE.md.

---

## Active phase — Phase 7: Verb UI + input

### Goal

Make MI1 *playable*: a cursor, the verb bar (Give / Pick up / Use
/ Open / Look at / Push / Close / Talk to / Pull), the inventory,
click-to-walk routed through the existing pathfinder, click-to-X
wiring through verb scripts. By end of phase we should be able to
start a new game from the title menu, walk Guybrush around the
first real room, and have him interact with objects via the
standard MI1 sentence flow.

This is the longest phase so far — the engine becomes a *game*,
not just a script runner. The plan below is intentionally broken
into small testable units so we can show visible progress at every
step rather than going dark for days.

### Definition of done

By end of phase, all of the following should work end-to-end
against real MI1 data:

1. **Start a new game** from the title menu — click the "Start"
   menu item → script #87 (or whichever the title menu actually
   runs) → arrive in the first interactive room (Mêlée Island,
   outside the Scumm Bar).
2. **Walk** Guybrush around that room by clicking the floor.
   Walk paths follow the existing pathfinder; arrival is
   pixel-precise.
3. **Look at** an object by clicking "Look at" + the object.
   Guybrush walks to the object's walk-to point, faces it, says
   the description; speech bubble renders above his head.
4. **Pick up** an object that's pickable; it appears in the
   inventory area below the verb bar.
5. **Use** an inventory item on an object in the room. Sentence
   line shows "Use stick with door", verb script runs, the right
   thing happens.
6. **Cutscenes** (in-script `cutscene` / `endCutscene` blocks)
   hide the cursor and verb UI, run, then restore. Pressing
   Escape during a cutscene triggers the override path.
7. `npm run typecheck` clean, full test suite green.

### Remaining to close Phase 7 — LOCKED LIST

This is the authoritative checklist to wrap the phase. The detailed
task blocks below are partly **stale** (later sessions completed many
items the inline boxes still show open); trust THIS list. Done already:
click→sentence enqueue, verb-script dispatch, `VAR_HAVE_MSG` driving,
carried-item names, word-wrap + per-line centring, `\xff\x03` paging,
charset-id resolution, `actorFromPos`/Talk-to, faithful click-to-walk,
`cutscene`/`endCutscene` (run #18/#19).

**Blocks the Definition of Done:**

- [x] **Faithful input rebuild — DONE (delivers two-object DoD #5,
      hover, right-click-default-verb).** Retired the engine-side click
      shortcut (`currentVerb` + `handleSceneClick` enqueue) for the real
      MI1 flow: the engine drives **g52 (VAR_CURSORSTATE)** from the
      cursor counters (faithful o5_cursorCommand: `state++/--`, mirrored
      to g52/g53), so per-frame poller **#23** hit-tests under the cursor
      → **g108/g109**; clicks just run **#4** (verb→`runInputScript(1,
      verbid,btn)`, scene→`runInputScript(2,0,btn)` — object NOT passed),
      and #4 commits `doSentence`. Validated headlessly + the 3 smoke
      tests now run this real chain. Right-click uses the hovered
      object's **default verb (g182)** — faithful, supersedes the
      pragmatic hardcoded Look-at. Cursor model is now numeric counters
      (`cursor.state`/`cursor.userput`). ⚠️ Two-object *prep* (g110, set
      by #4 via helper #8's class check) only engages for use-with-able
      objects — none in room 33's intro, so the A+B path needs a later
      room (or a real inventory item) to exercise end-to-end; the
      machinery is in place and proven for single-object + the prep
      branch logic.
      **Mechanism (bytecode), for reference:**
      - MI1 verb ids (room 33): 2 Apri, 3 Chiudi, **4 Dai/Give**, 5 Premi,
        6 Tira, **7 Usa/Use**, 8 Esamina, 9 Prendi, 10 Parla, 11 Vai
        (default/Walk-to). Give(4) + Use(7) take two objects.
      - The gathering is **entirely in the verb-input script #4** (= g32
        in room 33), using game globals: **g107 = active verb, g108 =
        objectA, g109 = objectB, g110 = preposition / "awaiting 2nd
        object" flag** (set when verb∈{Use,Give} and g108 is in). #4
        itself commits with `doSentence verb=g107 objA=g108 objB=g109`
        (offset 1031) once both are gathered. Sentence script #2 is the
        *executor* (walk/face/act), not the gatherer.
      - **Implication:** the faithful fix is to route clicks through #4
        and let it gather + commit — our engine-side `handleSceneClick`
        enqueue is the single-object SHORTCUT to retire here.
      - **SOLVED — full faithful flow cracked + core validated headlessly**
        (`scratch/probe-hover3.ts`). It's the hover poller, not the click,
        that supplies the object:
        1. **Engine drives g52 (VAR_CURSORSTATE) > 0** (no script writes
           it — it's engine-maintained). Then per-frame poller **#23**
           (loops `breakHere; jump -412`, gated `unless 0<g52 goto end`)
           hit-tests the object under the cursor via `findObject`/
           `actorFromPos` at **g20/g21 (VIRT_MOUSE)** and writes it to
           **g108** (or **g109** when g110 prep is set), plus g181 (hover),
           g182 (default verb), and the sentence line (verb 100).
        2. ScummVM `checkExecVerbs` passes: **verb click →
           `runInputScript(1, verbid, button)`**; **scene click →
           `runInputScript(2, 0, button)`** (object is **0** — it comes
           from g108, NOT the arg).
        3. #4 reads g107/g108/g109 and commits `doSentence`. For Use(7)/
           Give(4) it calls helper **#8** (class check) → sets g110 prep
           so the *next* hover fills g109 (the second object).
        Validated: g52=1 + hover poster → g108=429; verb 8 + scene click
        → "Rieleggete il Governatore Marley.". Two-object prep (g110)
        only engages for use-with-able objects (none in room 33's intro).
      - **Implementation plan (faithful input rebuild):** (a) engine
        drives g52>0 when cursor/userput active; (b) keep writing g20/g21
        each frame (done in input.ts); (c) route clicks as
        verb→`(1,verbid,btn)` / scene→`(2,0,btn)` / inv→`(3,…)`; (d)
        **retire** `handleSceneClick`/`handleVerbClick` engine shortcuts
        (currentVerb + engine enqueue) and let #23+#4 drive everything via
        g107/g108/g109. This also yields faithful hover (sentence line,
        g182 default verb) → supersedes the old "drive g52 for #23" item
        and the pragmatic right-click. ⚠️ NOTE: the earlier "input-model
        CORRECTED" note was itself a misread — the enqueue is NOT engine-
        side; #4 does it. Trust THIS block.
      - **Do NOT hardcode a two-object verb list** — #4 already knows.
- [x] **Cutscene UX (DoD #6) — DONE.** Keyboard **Escape → `vm.abort
      Cutscene()`** (jumps the cutscene script to its armed `overridePc`,
      thaws it, sets `VAR_OVERRIDE=1`; no-op when no skippable cutscene
      is active) wired via `input.ts` `onEscape`. **Verb bar now hides +
      restores**: implemented `saveRestoreVerbs` (was a stub) so #18's
      save / #19's restore actually empty + refill the bar (verified:
      verbsOn 0 during the room-38 cutscene, 18 in room 33). Cursor
      *visibility* + userput already flip via #18's cursorSoftOff /
      userputSoftOff. ⚠️ The inspector still paints its crosshair during
      cutscenes (intentional dev-visibility — engine `cursor.visible` is
      correct and shown separately).
- [x] **Right-click → default "Look at" — DONE.** `handleSceneClick`
      with `button===2` enqueues a Look-at sentence (verb 8) on the hit
      object regardless of the armed verb — the v5 default-verb shortcut.
      Verified headlessly: right-click the room-33 poster with no verb
      armed → "Rieleggete il Governatore Marley.". +3 tests. ⚠️ Pragmatic
      vs. fully faithful: MI1's #4 arms `g107 = g182` (the hover-tracked
      per-object default verb); until we track g182 per object, Look-at
      is the universal default (`Vm.VERB_LOOK_AT`). Refine when hover
      default-verb tracking lands.
- [x] **Gate click-to-walk during cutscenes — DONE.** Both scene clicks
      (`onRoomClick`) and verb-bar clicks now gate on `vm.cursor.userput`
      (false during cutscenes via #18), so floor clicks don't walk ego /
      arm verbs mid-cutscene. Verified: userput is true in room-33
      gameplay, false during the credits / lookout cutscenes.
- [x] **"Start a new game" (DoD #1) — N/A, satisfied.** Rocco confirms
      MI1 has **no title menu** — it boots straight into the game. The
      auto boot→intro→room 33 path IS the start flow, and the smoke test
      (`start → first interactive room`) covers it. No clickable menu to
      build.
- [x] **Room lighting / `VAR_CURRENT_LIGHTS` (g9) stuck at 0 — DONE.**
      The lit state is a **boot/reset default**, not a per-room `lights`
      opcode: the original engine's `resetScummVars` seeds g9 to
      `base_palette | colors | room_lights_on` (= 7) for every v4–v5
      game. We never seeded it, so g9 sat at 0 and *every* room read as
      dark — MI1 sentence #2 then answered "Look at" with "Non si riesce,
      troppo buio" instead of the description. Confirmed empirically: the
      `lights` opcode is **never dispatched** on the credits→room-33
      intro path (`scratch/probe-lights.ts`), and room 33's whole entry
      path (ENCD → local 201/203) never calls it — so the seed is the
      only source. Fix: `boot.ts` now seeds `VAR_CURRENT_LIGHTS =
      LIGHTMODE_DEFAULT` (new `src/engine/vm/lighting.ts` holds the flag
      *values*; `vars.ts` stays a pure index map). Also **implemented the
      `lights` opcode (0x70/0xF0)** for the dark rooms that do use it
      (arg3==0 → set g9; flashlight variant consumed, not yet drawn).
      Verified: examining the room-33 poster now yields *"Rieleggete il
      Governatore Marley."*. +6 tests. (Also demystified the "mysterious"
      `_scummVars[74]=1225` from the same reset — it's our existing MI1
      copy-protection seed, CD track-2 size, 0x4a==74.) Distinct from the
      cosmetic "compositor doesn't honor `VAR_CURRENT_LIGHTS`" gap.
- [x] **End-to-end smoke tests (3) — DONE.** `src/engine/mi1-smoke.test
      .ts` drives the real MI1 data through boot→intro→room 33 and asserts:
      (1) start→first-room (room 33, lit, ego placed, userput on, a verb
      active); (2) walk-around (floor click moves ego); (3) verb-dispatch
      (Look at the poster → "Rieleggete il Governatore Marley."). Data-
      gated via `describe.skipIf` so CI stays green without `games/MI1`.
- [x] **FINAL STEP — opcode-stub audit (start → gameplay) — DONE.**
      `scratch/audit-opcodes.ts` traces every opcode dispatched boot →
      room 33 + a look-at interaction. Result: **88 distinct opcodes, 0
      gameplay-logic stubs.** The 7 stubs hit are all non-logic, and each
      is correct-as-is or out-of-scope:
      - `0x0c resourceRoutines` (load/lock/unlock/clearHeap) — correct
        no-op; we load resources lazily, not via a managed heap.
      - `0x1c/0x3c/0x7c` sound (startSound/stopSound/isSoundRunning) —
        **audio is an unbuilt subsystem** (own phase). No hang:
        `isSoundRunning → 0` lets sound-waits fall through.
      - `0x2c` charsetColor — intentionally stubbed (naive impl regresses
        the lookout white/black text — see known-gaps).
      - `0x33 roomOps` setPalColor / screenEffect — cosmetic (palette
        tweaks / fade transitions; needs a mutable-palette + fade layer).
      - `0xcc pseudoRoom` — resource-id aliasing; nothing on this path
        reads an aliased resource (reached room 33 with no halt).
      Conclusion: the start→play path is **faithful at the logic level**;
      remaining stubs belong to the sound phase or cosmetic polish (7.5),
      not Phase 7. No opcodes to implement here.

**Polish — may land in Phase 7 or slip to 7.5:**

- [ ] Inventory **scroll arrows** (verbs 208/209) for >8 items.
- [ ] Dialog escape codes: keep-text `0x02`, substitutions
      `0x04–0x0A` (var/object/verb/actor/string), mid-string colour `0x0E`.
- [ ] Inspector dev panels (sentence / verb-state / inventory / dialog /
      cutscene-stack).
- [ ] Per-module tests (cursor, verb-bar, sentence-line, dialog, inventory).

**Known bugs — tabled / cross-cutting (not Phase-7 blockers):**

- [ ] Credits *fill* colour teal vs magenta — **tabled** (Rocco confirms
      same data files show magenta in ScummVM, so genuinely open; every
      credit line is `color 3` in the bytecode — see the known-gaps note).
- [ ] "Le tre prove" cutscene runs too fast (pacing).
- [ ] Z-plane occlusion wrong (fire over wall; actors over scenery).
- [ ] Room 38 darkness — compositor doesn't honor `VAR_CURRENT_LIGHTS` (cosmetic).

### Tasks

Listed in dependency order. Each block is independently testable;
several can progress in parallel after the input foundation lands.

**Input foundation — `src/shell/player/input.ts`**

- [x] Translate mouse events on the VM frame canvas into native
      room coordinates (account for the 2× CSS scale plus any
      x-scroll from the camera). Surface as
      `{ roomX, roomY, button, modifierKeys }`.
- [x] `pointermove` → updates `vm.mouseRoomX/Y` (new engine state)
      so `VAR_MOUSE_X` / `VAR_MOUSE_Y` (44/45 per the wiki) get
      read correctly by scripts that poll them. Also writes
      `VAR_VIRT_MOUSE_X/Y` (20/21) — same value today; they
      diverge once horizontal camera scroll lands.
- [x] `pointerdown` left / right → routes to caller-provided
      handlers with `{roomX, roomY, button, modifiers}`. Verb UI
      / object hit-tester will wire onto these callbacks in later
      Phase 7 tasks; the inspector currently mounts a "Recent
      clicks" panel as a sanity check. `contextmenu` is
      suppressed so right-click stays available.
- [ ] Disable click-to-walk during cutscenes (consult
      `VAR_CUTSCENEEXIT_KEY` + the freeze-scripts flag). Deferred
      to the cutscene task — there's no click-to-walk to gate yet.
- [x] `input.test.ts` — coordinate translation under scaled
      canvas, mouse-button mapping, modifier-key passthrough, the
      `cameraX` hook, and disposer cleanup (15 tests).

**Cursor — `vm.cursor` state + `src/shell/player/play-area.ts`**

- [x] Cursor visibility state on `vm.cursor.visible` — mutated by
      `cursorCommand` subops `0x01` (cursorOn) / `0x02` (cursorOff)
      plus the soft variants `0x05` / `0x06`. Surfaced live in the
      Input panel.
- [x] User-input enable flag `vm.cursor.userput` — mutated by
      `cursorCommand` subops `0x03` / `0x04` plus soft `0x07` /
      `0x08`. *Not yet consulted* by the click handler — that
      gate lands with the cutscene task.
- [x] Default cursor: a 7-pixel crosshair painted on a transparent
      overlay above the frame canvas (z-stacked, `pointer-events:
      none` so clicks pass through). For dev visibility the
      crosshair always paints in the inspector regardless of
      `vm.cursor.visible` — the engine-truth flag is displayed
      separately. Custom cursor images from `setCursorImage`
      (charset-glyph hand-off) remain deferred.
- [x] Cursor highlight when over an interactive object — yellow
      outline around the hovered object's CDHD bbox plus a colour
      shift on the crosshair itself.
- [ ] `cursor.test.ts` — covered indirectly by
      `opcodes/index.test.ts > cursorCommand state wiring` (4
      tests). A dedicated module-level test lands when we extract
      cursor logic from `play-area.ts`.

**Object hit-testing — `src/engine/object/hittest.ts`**

- [x] `pickObject({objects, drawQueue, x, y}) → objId | null`.
      Walks the drawn objects topmost-first (reverse `Set`
      insertion order of `vm.objectDrawQueue`), then un-drawn
      objects in OBCD source order. CDHD bbox in 8-pixel units;
      right/bottom edges exclusive.
- [x] Honours the "untouchable" flag (CDHD `flags & 0x80`) —
      those objects are invisible to hit-testing even if they have
      an image.
- [x] `hittest.test.ts` — null hit, single object, 8-px-unit
      conversion + edge inclusivity, untouchable skip, drawn beats
      un-drawn, most-recently-queued wins, source-order fallback,
      missing-from-map drawn id (8 tests).

**Verb scripts — `src/engine/object/verbs.ts`**

- [x] Parse the OBCD `VERB` block. Layout:
      `(verb_id u8, script_offset u16)*` terminated by a
      `verb_id = 0x00` byte. **`script_offset` is relative to the
      start of the `VERB` block header** — validated empirically
      against real MI1 (`scratch/inspect-verb-block.ts`): for every
      object the smallest offset resolves to exactly the byte after
      the entry table. Payload-relative index is `offset - 8`.
      Implemented in `parseVerbScripts`.
- [x] Capture per-object: `Map<verbId, scriptBytecode>` on
      `LoadedObject.verbs` — each value a view into the VERB payload
      running from the verb's offset to the end of the payload (the
      VM stops at the script's own stop opcode). Populated by
      `parseRoomObjects`.
- [x] `verbs.test.ts` (12) — single verb, two verbs sharing one
      offset (real MI1 #17), per-verb suffix slices, terminator
      handling, empty payload, out-of-bounds offsets skipped,
      first-wins on repeat, `findVerbScript` default-verb (0xFF)
      fallback, and an end-to-end decode through the live block
      parser. Synthetic byte layouts are lifted from the real-MI1
      spike, so they pin the on-disk semantics without committing
      the copyrighted binary to the test suite.
- [x] Dispatch via `vm.startVerbScript(objId, verbId, args)` →
      looks up the object in the current room, resolves bytecode
      (with the 0xFF default-verb fallback), starts a labelled
      synthetic slot (`VERB-{objId}-{verbId}`) with locals seeded
      `[verb, obj, ...args]`. Returns `null` (never throws) when the
      object/verb is absent or no slot is free. 6 `vm.test.ts` cases.
- [x] **UI-wired (via the sentence flow).** `onRoomClick` →
      `handleSceneClick` enqueues the sentence; `processSentence` runs
      sentence script #2, which dispatches the verb. Confirmed end-to-end
      (look-at the room-33 poster → script #2 → ego responds).
      `startVerbScript` remains the primitive that flow uses.
- ⚠️ **Known gap:** `parseRoomObjects` still drops OBCDs that have
      no OBIM image, so image-less hotspots (some have verbs) aren't
      loaded and can't be clicked yet. Broadening the loader touches
      the compositor's object map; deferred to when a needed hotspot
      surfaces.

**Sentence stack — `src/engine/vm/sentence.ts`**

- [x] `vm.sentenceStack: Sentence[]` (`{verb, objectA, objectB}`),
      treated as LIFO to match the original engine's
      `_sentence[_sentenceNum-1]` pop order. `pushSentence` /
      `clearSentence` mutate it; cleared on `reset()`.
- [x] `doSentence` opcode (`0x19` + family) — *enqueues* a sentence
      when `verb != 0xFE`, or *clears* the queue when `verb == 0xFE`
      (the clear form reads no object operands, matching the
      original's early return). Param modes via the family bits.
- [x] **Sentence script driver** `vm.processSentence()` — called
      once per tick by the inspector (after `beginTick`, before
      draining). If a sentence is queued and the sentence script
      isn't already running, pops the most-recent sentence and starts
      the script whose id is **held in `VAR_SENTENCE_SCRIPT` (global
      33)** with `[verb, objA, objB]` as locals[0..2]. Empirically
      confirmed: MI1's VAR[33] = script **#2**, whose prologue reads
      local1 / local2 (`scratch/inspect-sentence.ts`) — so locals,
      not VARs, are the arg channel.
- [x] `sentence.test.ts` (10) — enqueue (direct + var operands),
      0xFE clear, LIFO pop, locals + `SENTENCE-{v}-{a}-{b}` label,
      no-op while running / empty / unset-var, clear + reset.
- [x] **UI click → sentence is wired.** `handleSceneClick` fires the
      verb-input script (`VAR_VERB_SCRIPT`) AND enqueues the sentence
      engine-side (the faithful model — the input-model investigation
      showed the enqueue is engine-side, not script-side). Single-object
      only; two-object "Use X with Y" is the remaining sentence work.

**Verb bar — `vm.verbs` state + `src/shell/player/play-area.ts`**

- [x] `vm.verbs: Map<verbId, VerbSlot>` where `VerbSlot` carries
      `{ id, name, color, hiColor, dimColor, backColor, key, x, y,
      centered, state }`. Populated by the `verbOps` opcode subops
      we previously discarded — `new`, `setName`, `setColor`,
      `setHiColor`, `setDimColor`, `setBackColor`, `setXY`,
      `setKey`, `setCenter`, `on`, `off`, `setDim`, `delete`.
      `setName` strips `0xFF NN` SCUMM control sequences. Reset on
      `Vm.reset()`. Tested by 5 new verbOps wiring tests in
      `opcodes/index.test.ts`.
- [x] Render the verb bar below the VM frame canvas, using the
      Phase 4 CHAR text renderer for verb names. Lay out by the
      verb's `x` / `y` from `verbOps setXY` (script-space; verb
      bar starts at screen y = 144 for MI1, subtracted to get
      verb-canvas-local y). Inks `color` / `hiColor` / `dimColor`
      from the verb's stored values, driven through the current
      room's CLUT.
- [x] Hover / click handlers: hovering a verb shows it in
      hi-colour; clicking it sets `vm.currentVerb`. Subsequent
      object clicks form the sentence (preview only — dispatch
      lands with the verb-script / sentence-stack tasks).
- [x] Verb state changes — `SO_VERB_ON` / `OFF` / `DELETE` /
      `NEW` / `DIM` mutate the slot AND the bar's paint reflects
      them on the next repaint. `dim` slots reject clicks.
- [ ] Right-click on the room → default "Look at" (the v5
      convention) — deferred until verb-script dispatch lands; the
      hit-tester already identifies the object on right-click.
- [ ] `verb-bar.test.ts` — deferred to a future split that
      extracts the verb-bar rendering / input from `play-area.ts`.
      The current DOM-heavy module is covered by manual browser
      verification + the unit tests for its dependencies
      (`hittest`, verbOps state wiring).

**Sentence line — inside `src/shell/player/play-area.ts`**

- [x] Single-line preview above the verb bar showing the current
      sentence being built. Driven by `vm.currentVerb` (verb the
      user clicked) and a closure-local `hoveredObject` updated on
      each `pointermove` via `pickObject`. Updates live without a
      full inspector repaint — the play-area module owns a direct
      `textContent` setter on the sentence-line element.
- [x] Single-object format `"{verb} {obj.name}"` (or just the
      verb name when nothing is hovered). Defaults to `"Walk to"`
      when no verb is armed.
- [ ] Two-object form `"{verb} {obj1} {preposition} {obj2}"` —
      depends on the inventory + selectedObject state which lands
      with the inventory task.
- [ ] `sentence-line.test.ts` — deferred (see verb-bar note).

**Dialog / print — `vm.activeDialog` + `src/shell/player/play-area.ts`**

- [x] Real `print` / `printEgo` opcode behaviour. New state
      `vm.activeDialog: { actorId, text, x, y, color, center,
      overhead, clipped } | null`. Set by the `0x0F SO_TEXTSTRING`
      subop with the decoded text; cleared by an empty-string
      print. Per-print subops (`SO_AT`, `SO_COLOR`, `SO_CENTER`,
      `SO_LEFT`, `SO_OVERHEAD`, `SO_CLIPPED`, `SO_SAY_VOICE`) all
      mutate the captured state correctly.
- [x] Render text overlay on the cursor canvas via the CHAR
      renderer through `vm.currentCharset`. Position semantics:
      explicit `SO_AT` is screen-space → converted to room-space
      by adding `(camera.x - 160)`; `overhead` mode positions
      above the speaking actor; fallback is centre-bottom of the
      camera viewport.
- [n/a] Per-character reveal — **does not exist in SCUMM v5.** A
      typewriter reveal was tried and reverted: MI1 draws the full talk
      string at once (confirmed vs ScummVM). `VAR_CHARINC` is the
      *hold-duration* multiplier (`talkDelay = length × charinc`), not a
      reveal rate. Text appears whole and lingers for `talkDelay` ticks.
- [x] `VAR_HAVE_MSG` (global #3) flip on print start / completion —
      `beginTalk` sets it to 1, `beginTick` clears it when `talkDelay`
      drains (held across `\xff\x03` pages). Wait-for-message releases.
- [x] Per-line centring for multi-line text — `drawText` now renders
      each `\n`-separated line independently and centres it on `x`
      (was left-aligning lines within the widest line's bbox).
- [ ] Keep-text (`0xFF 0x02`) — credits emit prints with
      `\xff\x02` to accumulate text across separate prints. We
      currently overwrite on each print. Affects multi-stage
      reveal effects.
- [ ] `dialog.test.ts` — covered indirectly by the verbOps tests
      (which exercise `decodeScummString`). Dedicated test lands
      when per-character reveal + VAR_HAVE_MSG are wired.

**Dialog escape codes — `decodeScummString` in `opcodes/index.ts`**

- [x] `0xFF 0x01` newline → `\n`. Verified via the credits
      "Scritto e Programmato da\xff\x01Ron Gilbert..." rendering
      on multiple lines.
- [x] `0xFF NN [args]` other codes are stripped (we don't crash
      on them). Length tracking: codes 0x01–0x03 are 2-byte;
      0x04–0x0E are 4-byte.
- [ ] `0x02` keep-text — see dialog section above.
- [x] `0x03` wait — honoured as a **sentence page break** (not a
      user-click pause). `decodeScummStringPages` splits the message at
      each `\xff\x03`; the talk timer shows one page at a time via
      `vm.queueTalkPages` (advanced in `beginTick`). Verified on MI1's
      "Yikes!\xff\x03Non dovresti…".
- [ ] `0x04..0x0A` variable / object / verb / actor / string
      substitution. None are wired; control sequences silently
      drop.
- [ ] `0x0E` colour change mid-string — switches ink for the
      following glyphs.
- [ ] `dialog-escape.test.ts` — deferred.

**Camera + screen — `vm.camera.x` + `vm.screen.{top,bottom}`**

- [x] `vm.camera.x` tracks the camera centre. Mutated by
      `setCameraAt` (snap), `panCameraTo` (snap for now —
      smooth-scroll lands later), and `actorFollowCamera`
      (snap-only to the followed actor's x). Clamped to the
      room's valid range. Reset on `Vm.reset()`.
- [x] `vm.screen.{top, bottom}` capture the playable viewport
      vertical bounds, mutated by `roomOps setScreen`. The
      inspector's viewport-indicator rectangle reads these.
- [x] Camera-viewport indicator on the cursor overlay — dashed
      white outline showing `[cameraLeft, top]` extending
      `[VIEWPORT_W=320, bottom - top]`. Debug-only; shows the
      slice a real player would see on screen.
- [ ] Smooth camera pan for `panCameraTo` — currently snaps.
- [x] Camera-following an actor whose position is changing —
      `vm.cameraFollowActor` + `moveCameraFollow()` (per-tick dead-zone
      follow, ±80px, clamped to room). `actorFollowCamera` sets the
      follow target + snaps once; `beginTick` tracks thereafter.

**Wait opcodes — `src/engine/vm/wait.ts`**

- [x] `delay` opcode (`0x2E`) — multi-tick countdown via
      `slot.delayRemaining`. Inspector's tick driver decrements
      each tick and only resumes when it hits 0. Critical for
      cutscene pacing — without this MI1's credits flash
      because every `delay 120` releases on the next frame.
- [x] `wait` (`0xAE`) — multi-subop. **Mechanism: PC-rewind**, not a
      stored condition hook — if the condition isn't met the handler
      rewinds PC to the `0xAE` byte and yields, so the next tick
      re-runs the opcode and re-checks (the original engine's
      `_scriptPointer = _scriptOrgPointer; breakHere()`). The subop's
      `0x80` bit selects var-vs-direct for the operand. Empirically
      grounded: MI1's sentence script #2 emits `AE 81 01 00` =
      wait-for-actor on VAR_EGO (see `scratch/scan-wait.ts`).
      - `0x01` SO_WAIT_FOR_ACTOR — yields while `actor.isMoving`
        (actor id direct or var per the 0x80 bit; id 0 → ego). ✓
      - `0x02` SO_WAIT_FOR_MESSAGE — yields while `VAR_HAVE_MSG != 0`.
        Reads the var correctly but never blocks yet (the dialog
        renderer doesn't drive VAR_HAVE_MSG — lands with per-char
        reveal). ✓ dispatch
      - `0x03` SO_WAIT_FOR_CAMERA — never blocks (camera snap-only,
        always "arrived"; revisit with smooth pan). ✓
      - `0x04` SO_WAIT_FOR_SENTENCE — yields while `sentenceStack`
        is non-empty. ✓
      Unknown subops halt loudly (fail-loud design).
- [x] No slot-level condition hook needed — the PC-rewind approach
      reuses the existing yield/resume machinery, so `ScriptSlot`
      gains no new state. (Simpler than the originally-planned hook.)
- [x] `wait.test.ts` (10) — each condition's yield + rewind-to-opcode
      + fall-through, var-operand actor read (the MI1 `AE 81` form),
      resume-then-ready, unknown-subop halt.

**Inventory — opcode/data layer (`vm` + `opcodes/index.ts`) + UI strip
(`src/shell/player/inventory.ts`)**

Data layer ✅ — SCUMM v5 ties inventory membership to ownership, so the
model is just `vm.objectOwners` queried two ways:

- [x] `vm.inventoryCount(owner)` / `vm.findInventory(owner, index)` —
      count and 1-based lookup over `objectOwners` (Map-insertion order
      = pickup order, mirroring SCUMM's inventory-array append).
- [x] `getInventoryCount` opcode (`$31`/`0xB1`) — `result actor[p8]`.
      MI1's intro reads it (sometimes nested inside an `expression`).
- [x] `findInventory` opcode (`$3D`/`0x7D`/`0xBD`/`0xFD`) —
      `result owner[p8] index[p8]`. **Was mis-wired at `0x15`** (which
      is actually `actorFromPos`); moved to the real `$3D` family. MI1
      script #9 (inventory display) polls all 8 visible slots via
      `0xfd` — now returns the right object ids (0 when empty).
- [x] `pickupObject` opcode (`$25`/`0x65`/`0xa5`/`0xe5`) —
      `object[p16] room[p8]`. Sets owner=ego, state 1, dequeues from
      the room, then calls `runInventoryScript(1)`. **`0x25` was
      previously swallowed by `drawObject`'s blanket 8-variant
      registration** — drawObject now owns only `0x05`/`0x85`.
      (Untouchable-class still deferred.)
- [x] `vm.runInventoryScript(arg)` — runs `VAR_INVENTORY_SCRIPT` (g34 =
      #9 for MI1) with `local0 = arg`, non-recursive (stops any prior
      instance). This is the engine hook MI1 uses to repaint inventory.
- [x] `getVerbEntryPoint` (`$0B`/`0x4B`/`0x8B`/`0xCB`) —
      `result object[p16] verb[p16]`; returns 1 if the object has that
      verb, else 0 (we keep bytecode slices, not offsets — callers test
      truthiness). #9 halted on `0x8b` without it.
- [x] `setOwnerOf` (`0x29`) / `getObjectOwner` (`0x10`) — already wired
      (write/read `vm.objectOwners`).
- [x] `actorFromPos` (`0x15`/`0x55`/`0x95`/`0xd5`) — corrected from the
      bogus "findInventory" label. **Now fully implemented** (was a
      0-stub): decodes `p16` coords (words — the earlier `p8`/byte claim
      was wrong, per the opcode reference) and returns the actor under
      the point via `vm.actorFromPos`, which hit-tests against each
      actor's `drawBounds` (recorded by the compositor each frame),
      skips the Untouchable class (32), and returns the topmost
      (highest-id) match. Wired into play-area hover → Talk-to.
- [x] 12 new tests (8 in `opcodes/index.test.ts`: getInventoryCount
      direct/var/empty, findInventory order/out-of-range, pickupObject,
      actorFromPos PC=7/PC=5; getVerbEntryPoint present/absent. 3 in
      `vm.test.ts`: runInventoryScript starts/no-op/non-recursive.)

Verb-based inventory display — slots now render. MI1 lays slot-frame
objects into verbs 200–207 (+ arrows 208/209) via `verbOps` subop `0x16`
(`SO_VERB_IMAGE_IN_ROOM`), all from the global UI room 99:

- [x] `VerbSlot.image {obj, room}` — set by `verbOps` `setImage` (0x01,
      current room) / `setImageInRoom` (0x16, explicit room); cleared by
      `setName`. Defaults null (text verb).
- [x] Cross-room object-image loading in the verb bar via
      `vm.resolveRoom`, cached by room id; composites the sprite into
      the slot rect (current-room palette, sprite-room TRNS).
- [x] Resolved the ids: room 99 = UI room; 1032 = empty slot cell, 1031
      = generic "occupied" cell (same for every item — NOT per-item),
      1033 = scroll arrow.
- [x] Inspector **"Give item"** debug button (give ego a room object +
      run #9) to see slots populate.
- [x] 3 tests (verbOps setImage/setImageInRoom bind + setName clear).
- [x] **Item identity on hover** — hovering an inventory slot now shows
      the item in the sentence line. The verb-bar hit-test (`verbAt`)
      matches image verbs by their sprite bbox; slot `200+i` maps to
      `findInventory(ego, i+1)`, and that item id feeds the sentence
      line (taking priority over a room hover). MI1 shows item identity
      as the *name* here (1031 is just a generic "occupied" cell), so
      e.g. hovering the rock shows "Esamina lo scoglio".
      ⚠️ Name resolves via the **current room's** object table —
      correct for just-picked-up items, but a *carried* item (from
      another room) shows `obj #N` until there's an inventory name table
      (populated at pickup). Tracked.
- [x] Inventory-slot **click** routes the item as an object
      (`handleSceneClick`), not as a command verb (`handleVerbClick`) —
      so clicking an item feeds the sentence rather than arming verb 200.
- [x] Hit-test precedence: `verbAt` prefers an `on` verb over a `dim`
      one. **Gotcha:** MI1's command-verb panel *background* is itself a
      dim image verb (verb 1 → obj 1030, 144×48, covering the whole
      command region). Once image verbs became hittable it shadowed
      every command verb and swallowed clicks; the `on`-over-`dim`
      preference fixes it (the bg is dim, command verbs are on).
- [ ] Carried-item name table (so names survive leaving the pickup room).
- [ ] Scroll arrows (208/209) → paging + two-object sentence
      (`Use X with Y`) once selectedObject lands.
- [ ] `inventory.test.ts`.

**Cutscene control — `src/engine/vm/cutscene.ts`**

- [x] `beginOverride` (0x58 flag=1) — consumes the flag byte
      AND the following 3 bytes (the embedded `jump_opcode delta`
      that encodes the override target). Without this, the
      embedded jump dispatched as a regular opcode and
      unconditionally skipped the cutscene body. The resolved
      target is stored as `slot.overridePc` for future Escape
      handling.
- [x] `cutscene` opcode (`0x40`) — implemented (`beginCutscene`): pushes
      a frame on `vm.cutsceneStack`, freezes non-resistant scripts, runs
      `VAR_CUTSCENE_START_SCRIPT` (#18). Cumulative freeze count; the
      cutscene script itself is protected from freezing.
- [x] `endCutscene` opcode (`0xC0`) — implemented (`endCutscene`): pops
      the frame, runs `VAR_CUTSCENE_END_SCRIPT` (#19, restores
      cursor/input), unfreezes.
- [~] Escape key handler — PARTIAL. `beginOverride` records
      `slot.overridePc`, and the inspector has a "Skip cutscene" button,
      but a **keyboard Escape** isn't wired to the override path yet.
      ⇒ see the locked list (Cutscene UX). Also: hiding the cursor/verb
      bar *during* a cutscene still needs confirming.
- [ ] `cutscene.test.ts` — push/pop stack, freeze/unfreeze
      transitions, override flow.

**Object identification opcodes**

- [x] `findObject` (0x35 / 0x75 / 0xb5 / 0xf5) — reads dest +
      x + y (var-or-word), calls `pickObject` on the loaded
      room, writes the result. Returns 0 when no room is loaded.
- [x] `findInventory` (0x3D / 0x7D / 0xBD / 0xFD) — real, backed by
      `vm.findInventory`. (See the Inventory section. The old stub was
      wrongly at `0x15`, which is `actorFromPos`.)
- [x] `getVerbEntryPoint` (0x0B / 0x4B / 0x8B / 0xCB) — 1 when the
      object has the verb, else 0. (See the Inventory section.)

**Expression mini-VM additions**

- [x] Subop 0x06 (nested opcode) — reads the next byte, calls
      `vm.dispatchInline()` to dispatch the inner opcode (which
      writes its result to global #0), then pushes
      `vars.readGlobal(0)` onto the expression stack. Used by
      MI1's credits for `expression g100 = getRandomNumber(N)`
      patterns.

**Engine variables to wire**

📋 **The complete canonical SCUMM v5 system-var index table now
lives in `src/engine/vm/vars.ts`** — the single source of truth, so
we stop guessing indices empirically. A constant existing there only
records its *meaning*; the engine acts on one only when wired. Several
earlier empirical names were wrong and are reconciled in that file's
header (notably: 52 = `VAR_CURSORSTATE` not "leftbtn", 14 =
`VAR_MUSIC_TIMER`, 15/16 = `VAR_ACTOR_RANGE_MIN/MAX` and must NOT
auto-increment — fixed). Below: which ones the engine currently acts on.

- [x] `VAR_MOUSE_X` (44) / `VAR_MOUSE_Y` (45) — written on every
      `pointermove` by the input layer.
- [x] `VAR_VIRT_MOUSE_X` (20) / `VAR_VIRT_MOUSE_Y` (21) — same
      values today (camera fixed at 0); will diverge once the
      camera scrolls.
- [x] `VAR_USERPUT` (53) — mirrored each tick from
      `vm.cursor.userput` by `Vm.beginTick()`.
- [x] `VAR_CURSORSTATE` (g52) — one-shot left-press pulse, cleared
      the following tick. MI1 boot's script #23 polls it to enter the
      main menu. (Index found by tracing #23's wait loop; the
      canonical name is `VAR_CURSORSTATE` — the press bit lives inside
      the cursor-state var. `VAR_RIGHTBTN_DOWN` has no v5 index.)
- [x] `VAR_EGO` (g1) — set by the boot script. Used by
      `actorOrNull` to resolve `actor=0` to the player character
      (SCUMM v5 ego shorthand). MI1 boot's title-menu setup uses
      `putActor 0` to place Guybrush — without ego resolution
      Guybrush was never placed.
- [x] `VAR_MUSIC_TIMER` (g14) — auto-incremented per tick by
      `Vm.beginTick()`. Scripts reset it to 0 and poll for a target
      to pace cutscenes (MI1 credits wait `g14 > 5700`). **Only 14
      is incremented now** — the old code also bumped 15/16, which
      are `VAR_ACTOR_RANGE_MIN/MAX`, not timers (boot still settles
      at 125 ticks after the fix, confirming only 14 mattered).
- [x] `VAR_SENTENCE_SCRIPT` (g33) — read by `vm.processSentence()`;
      holds the sentence script id (MI1 = #2).
- [x] `VAR_HAVE_MSG` (3) — driven by `beginTalk` (set 1) / `beginTick`
      (clear 0 when the talk timer + any `\xff\x03` pages finish).
- [ ] `VAR_CUTSCENEEXIT_KEY` (24) — key code for "skip cutscene"
      (Escape = 0x1B = 27; confirmed MI1 seeds g24 = 27). Pairs with the
      keyboard-Escape handler in the locked list.
- [ ] `VAR_TALK_ACTOR` (25) — currently-talking actor id (set
      when the dialog renderer activates).

**Inspector additions — `src/shell/player/vm-inspector.ts`**

- [ ] **Sentence panel** — shows `currentVerb`, `hoveredObject`,
      `selectedObject`, and the upcoming sentence string. Helps
      diagnose verb routing.
- [ ] **Verb-state panel** — list of every active verb slot with
      its name, position, current state (on / off / dim).
- [ ] **Inventory panel** — what's currently owned by ego, plus a
      manual "give object N to ego" button for poking.
- [ ] **Dialog panel** — current `vm.activeDialog` state, plus a
      manual "skip current dialog" button (sets VAR_HAVE_MSG=0).
- [ ] **Cutscene-stack panel** — pushed cutscene frames + their
      override script ids.

**Tests**

Per-module tests listed in each section. Plus:

- [ ] **End-to-end smoke**: starting from `bootGame` + the
      synthetic input "click Start", the test framework drives
      the engine through enough ticks to (a) leave the title
      room and (b) arrive in the first interactive room with
      Guybrush placed and the cursor active.
- [ ] **Walk-around smoke**: in the first interactive room,
      synthetic clicks at three floor positions; assert
      Guybrush arrives at each in turn.
- [ ] **Verb dispatch smoke**: synthetic "look at door" against
      a real MI1 door object; assert a verb script slot starts
      with the right bytecode and a dialog activates.
- [ ] No regression in any earlier test.

### Design notes

- **Click semantics follow the v5 convention**: left = use the
  selected verb on the clicked object (or walk if nothing
  selected); right = "Look at" the clicked object (shortcut
  for "Look at" without changing the current verb).
- **Sentence flow is asynchronous**: clicking commits a sentence
  into the queue, the global *sentence script* picks it up next
  tick. We don't run the verb script directly from the click
  handler — that would skip walk-to / face / wait steps the
  sentence script normally handles.
- **VAR_HAVE_MSG is the dialog gate**. Many scripts pattern as
  `print "Hello." ; wait for message ; print "World."`. The
  wait opcode polls this var, so the dialog renderer must set
  it to 1 on start and 0 on completion (or user-skip).
- **The verb bar lives outside the room canvas**. It's its own
  DOM element below the canvas, not painted onto the
  framebuffer. Speech bubbles overlay the canvas. Inventory
  also lives below. Keeps the rendering paths simple.
- **No save / restore in this phase.** The "save game" verb (a
  bit-flag on its slot or a special id) is captured but
  disabled. Phase 8 is the right home for state serialisation.
- **Custom cursor images deferred.** The default crosshair gets
  us through the playable goal; the `setCursorImage` /
  `setCursorHotspot` path needs a charset-glyph-as-cursor
  decoder that's its own small thing.
- **Walk-box-derived actor scale** still deferred. Most MI1
  rooms work fine without it; revisit when the docks /
  Scumm Bar interior obviously need it.

### Out of scope

- **Save / restore** — Phase 8.
- **Audio** — sound opcodes stay silent stubs. iMUSE + AdLib
  is Phase 9.
- **MI2 verification** — Phase 10.
- **Native box-graph pathfinding** — grid A* is good enough; the
  swap is mechanical and can land any time.
- **Real cutscene-skip via mouse-click** — only Escape triggers
  the override path for now. (MI1 traditionally also exits on
  click, but we can wait.)
- **Verb-bar fonts beyond MI1's defaults** — we use whichever
  CHAR the script has selected. No theming.

---

## Future phases

Kept intentionally undetailed. We'll break each into tasks when we start
it. Order and scope may shift as we learn the territory — see
ARCHITECTURE.md §9 for the original outline.

- **Phase 8 — Save states.**
- **Phase 9 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 10 — MI2 + polish.**

A revisit candidate for any phase: **fix the costume-anim decoder
against MI1 Guybrush** so actors actually animate as they walk.
See `docs/SCUMM-V5-COSTUME-ANIM.md`.

---

## Done

### Phase 6 — Enough engine to walk *(2026-05-28)*

End-to-end runnable boot through to the title-screen idle state. The
MI1 boot dispatches every opcode it tries (3500+ across 11 scripts),
settles into the title-screen tick loop, and the VM frame canvas
shows the rendered title room with a Play/Pause-driven main loop.

**What's live:**

- **VM**: 30+ new opcodes wired (cursorCommand, stringOps,
  resourceRoutines, startScript, roomOps, pseudoRoom, setState,
  drawObject, verbOps, actorOps, walkActorTo, walkActorToActor,
  putActor, animateActor, camera ops, print, getRandomNumber,
  loadRoom, systemOps, cutscene/endCutscene, freezeScripts,
  isScriptRunning, beginOverride, audio stubs, setVarRange, and the
  `0xAC` expression mini-VM). All comparison opcodes verified against
  the SCUMM v5 wiki's `unless (value OP var) goto target` form.
  Var-ref scope bits corrected (`0x8000` = bit-var, `0x4000` = local,
  `0x2000` = indexed-array via an extra word).
- **Resource subsystems**: room loader (LoadedRoom = bg + palette +
  TRNS + z-planes + ENCD/EXCD bytecode + LSCR table + objects + walk
  boxes + walkable mask), costume cache with lazy `vm.getCostume`,
  OBCD/OBIM parser (per-state image variants, OBNA names).
- **Actor table**: 13-slot fixed table on the VM. Every actor opcode
  reads/writes it. `__vm` console hook exposes the live state.
- **Walking**: `walkActorTo` runs the pathfinder against the room's
  walkable mask; `stepWalk` advances actors waypoint-by-waypoint
  each tick. Straight-line fall-back when no walk boxes are present.
- **Pathfinding**: BOXD parser, polygon-fill rasterizer, A* over the
  walkable mask with 8-connectivity + octile heuristic. Solves a
  typical 320×144 room in <50 ms.
- **Frame compositor**: room bg → queued objects → actors,
  sorted by actor id for stable layering. Z-planes honoured.
  TRNS-indexed transparency. Per-actor/object/limb skip diagnostics
  surfaced in the inspector.
- **Main loop**: rAF-driven Play/Pause with idle-detection
  auto-pause (fingerprint = slot states + walking positions +
  active anim cursors). Tick counter + Run-to-idle convenience
  button. ENCD/EXCD scripts dispatched as labelled synthetic slots.
- **Inspector additions**: VM frame canvas, actor table, walk-box
  overlay (toggle), tick counter, skip-reason lists.

**Known limitation: costume anim decoder.** The wiki-described
record layout works for synthetic fixtures + simple costumes but
doesn't match MI1 Guybrush's records — they produce out-of-range
`start` offsets. Implementation is defensive (bad records → limb
stays inactive, actor renders in init pose). Real visual
validation requires a v5 reference renderer; deferred. See
`docs/SCUMM-V5-COSTUME-ANIM.md` for the spike findings.

**Variables made lenient.** MI1 ships dead-code paths that write
past MAXS. OOB reads return 0, OOB writes are absorbed, every
access recorded on `vars.oobAccesses` for the inspector. Keeps the
engine progressing past unreachable branches without losing
visibility.

**Copy-protection seeded.** `bootGame` writes `var[0x4a] = 1225` to
satisfy MI1's CD audio-track-2 size check (script #176 quits if
outside `[1200, 1250]`).

**Tests: 414 across 39 files** (+103 since Phase 5). Typecheck
clean.

---

### Phase 5 — VM skeleton *(2026-05-27)*

Stands up a SCUMM v5 bytecode interpreter end-to-end at the *structural*
level: index-file parser (MAXS + lane-encoded DROO/DSCR/DSOU/DCOS/DCHR),
LOFF parser, script loader (global SCRPs only), 800-entry global var
bank + 2048 bit-vars + 16 room-vars + per-slot locals, 25 cooperative
script slots with a clean lifecycle, a 256-entry opcode dispatch table
with a seed set covering the assignment / arithmetic / comparison /
branch / yield / stop families, and a halt-as-first-class-state design
that captures the slot, PC, opcode, last 16 bytecode bytes, and tail of
the trace ring whenever the VM hits an opcode we haven't written. The
player UI gains a full VM inspector: Boot / Step / Run-tick / Reset
controls, a slot table that flags the halted slot with a red badge, a
hex-addressed globals grid, a compact bit-var grid, the trace ring, and
a halt panel with bytecode-context hex highlighting. 272 tests across
28 files; new `docs/SCUMM-V5-INDEX.md` covering the lane-encoding
surprise (the first lane is the **owning room id** for DSCR/DSOU/DCOS/
DCHR, *not* a disk number). Real MI1 boot script dispatches its first
four setVars cleanly and halts loudly on `0x2c` (cursorCommand) as
designed.

#### Original task checklist (all complete)

**Index parsing — `src/engine/resources/index-file.ts`**

- [x] `parseIndexFile(file)` — returns `{ maxs, rooms, scripts, sounds, costumes, charsets }`
- [x] `parseMaxs` — extracts named fields (numVariables, numBitVariables, numLocalObjects, numCharsets, numVerbs) and exposes the raw u16 LE array for unnamed slots
- [x] `parseLaneDirectory` — single decoder for the `count u16 LE` + `count × u8` + `count × u32 LE` shape shared by DROO/DSCR/DSOU/DCOS/DCHR
- [x] `IndexParseError` for missing blocks, size mismatches, truncated payloads

**LOFF parsing — `src/engine/resources/loff.ts`**

- [x] `parseLoff(file)` — returns a `Map<roomId, fileOffset>` populated from `LECF/LOFF`. Counts are u8, entries are `(room u8, offset u32 LE)`. Throws on missing LECF / LOFF or size mismatch.

**Spike — verified the index layout against real MI1**

- [x] `scratch/inspect-index.ts` — printed DSCR/DROO/MAXS under both interleaved and lane-encoded hypotheses, then validated by counting how many resolved offsets land on the expected tags in `.001`. Lane encoding wins decisively; the lane-1 byte resolves as the owning room id, not the disk number (under the disk hypothesis only 1 of 100 DROO rows looked real).

**Script loading — `src/engine/vm/scripts.ts`**

- [x] `loadGlobalScript(file, index, loff, scriptId)` — resolves `LOFF[index.scripts[id].room] + index.scripts[id].offset`, verifies the tag is `SCRP`, returns the bytecode payload + absolute file offset. Verified against real MI1: 178 / 199 scripts resolve, 21 are zero-room "unused" slots that throw `ScriptLoadError` exactly as expected.
- [x] Error paths: out-of-range id, unused entry (room=0), missing room in LOFF, resolved offset doesn't land on SCRP, invalid SCRP block size

**Variable bank — `src/engine/vm/variables.ts`**

- [x] `class Variables` — globals (Int32Array sized from MAXS or 800 floor), bit-buffer (packed Uint8Array sized from MAXS or 2048 floor), room-vars (Int32Array, 16 entries)
- [x] `readGlobal` / `writeGlobal` / `readBit` / `writeBit` / `readRoom` / `writeRoom` with bounds checks
- [x] `VariableError` on out-of-range indices

**Script slot — `src/engine/vm/slot.ts`**

- [x] `class ScriptSlot` — slotIndex, status (`dead`/`running`/`yielded`/`frozen`), scriptId, bytecode (Uint8Array), pc, room, locals (Int32Array(25))
- [x] State machine: `start(opts)` requires status=dead, populates locals[0..args-1] from args; `yield_()`, `resume()`, `freeze()`, `kill()`
- [x] `ScriptSlotError` on illegal transitions (start on non-dead, yield on dead)

**Parameter-mode decoder — `src/engine/vm/params.ts`**

- [x] `isVarParam(opcode, paramIndex)` — bit 7/6/5 of the opcode byte select param 1/2/3 mode
- [x] `readU8` / `readU16` / `readI16` from `slot.bytecode[slot.pc]`, advancing PC
- [x] `readValue(slot, vars, asVar)` — reads u16 immediate or dereferences a var-ref word
- [x] `readVarRef` (read + deref) and `readDestRef` (raw word, no deref) for write paths
- [x] `derefRead(ref, slot, vars)` / `writeRef(ref, value, slot, vars)` — handle the 16-bit reference encoding: bit 15 = local, bit 14 = bit-var, bit 13 = indexed (throws — deferred), else global
- [x] `ParamError` on out-of-range local indices and on indexed refs

**VM core — `src/engine/vm/vm.ts`**

- [x] `class Vm` — owns `Variables`, 25 `ScriptSlot`s, an opcode handler map, a 64-entry circular trace buffer, and a nullable `HaltInfo`
- [x] `startScript(opts)` — picks the lowest-index dead slot
- [x] `step()` — dispatches one opcode in the next runnable slot; round-robin across slots is implicit (next `running` slot in array order)
- [x] `runUntilAllYield(maxSteps=100k)` — drains all runnable slots; treats step-cap exhaustion as a runaway-loop halt
- [x] `halt` is a *state*, not an exception escape: `UnknownOpcodeError` and handler-thrown errors are caught at the dispatch boundary and converted to `haltInfo`. Subsequent `step()` is a no-op.
- [x] `annotate(mnemonic)` — handlers self-describe the trace entry they just produced
- [x] `reset()` — restores pre-Boot state (kills all slots, clears vars-by-instance reuse, clears trace, clears halt)
- [x] `UnknownOpcodeError` carries the opcode byte for clean error reporting

**Seed opcode set — `src/engine/vm/opcodes/index.ts`**

- [x] `0x00` / `0xA0` `stopObjectCode` — kill slot
- [x] `0x80` `breakHere` — yield slot
- [x] `0x18` `jumpRelative` — i16 displacement relative to byte-after-delta
- [x] `0x1A` / `0x9A` `setVar` — dest = raw ref word, source = u16 immediate or var-ref (bit-7 toggle)
- [x] `0x46` `inc` / `0xC6` `dec` — single var-ref param, ±1
- [x] `0x5A` / `0xDA` `addVar`, `0x3A` / `0xBA` `subVar`
- [x] Comparison + jump family (`0x48/C8` isEqual, `0x08/88` isNotEqual, `0x04/84` isGE, `0x44/C4` isLess, `0x78/F8` isGreater, `0x38/B8` isLE) — read var, read value-or-var, read i16 delta, jump if **not** condition (SCUMM "jump if false" convention)
- [x] `0x28` equalZero / `0xA8` notEqualZero — single-var test + conditional jump
- [x] `0x2E` `delay` — consumes 3-byte tick count, yields (stub; real tick accounting is Phase 6)

**Boot driver — `src/engine/vm/boot.ts`**

- [x] `bootGame(file, index, loff, gameId)` — builds a `Vm` sized from MAXS (with a `Math.max` floor), seeds the system vars we know the boot prefix needs (screen w/h, game id, charset), calls `loadGlobalScript(..., 1)`, starts it in a slot, returns `{ vm, bootScriptId, bytecodeLength }`
- [x] Engine-var seeding is on-demand: we populated only what the boot prefix touches (screen width, screen height, game id, charset id) and will grow the list as the boot script reveals more reads — keeps the var bank honest as a diagnostic

**VM inspector UI — `src/shell/player/vm-inspector.ts`**

- [x] Self-contained `<section>` that mounts above the index/resource block-tree dumps
- [x] Controls bar: **Boot**, **Step**, **Run tick**, **Reset**
- [x] Slot table — populated slots only by default; columns id, script, room, status (color-coded per state), pc, bytecode size, last opcode + mnemonic; red **HALTED** badge on the slot that halted the VM
- [x] Trace ring — newest at top, last 64 entries, with full `slot, script, pc, opcode, mnemonic` line
- [x] Globals grid — hex addresses (0x00..0x3f by default), non-zero values get an accent border + accent text, "show more" button extends by 64 at a time
- [x] Bit-var grid — 256 bits visible by default in a 32-wide grid, 1-bits highlighted in accent yellow; "show more" extends by 256
- [x] Halt panel — red banner with reason, slot/script/pc/opcode metadata, bytecode-context hex strip with the offending byte in red, and the last 16 trace entries

**Tests**

- [x] `index-file.test.ts` (10) — MAXS field extraction, lane-directory decoding, malformed-block error paths, end-to-end parse of a synthetic .000-shaped buffer
- [x] `loff.test.ts` (5) — round-trip room→offset map, count=0 edge, u32 high-bit unsigned read, missing-LECF and size-mismatch errors
- [x] `scripts.test.ts` (6) — DSCR room id + LOFF lookup, two-rooms-same-relative-offset disambiguation (the bug the spike revealed), unused entries, out-of-range ids, missing LOFF entry, wrong-tag landing
- [x] `variables.test.ts` (12) — round-trip per scope, bit packing, signed/unsigned correctness, out-of-range bounds
- [x] `slot.test.ts` (9) — state-machine transitions, args populate locals, restart-in-place rejected, locals isolated between slots
- [x] `params.test.ts` (13) — `isVarParam` per index, fixed-width readers, sign extension, var-ref dereference across globals/locals/bits, indexed throws, `writeRef` per scope
- [x] `vm.test.ts` (13) — slot allocation + exhaustion, dispatch advances PC, unknown opcode → halt, halt is sticky and stops further dispatch, trace ring wraps at 64, runaway-loop step-cap halt, `reset()` clears state
- [x] `opcodes/index.test.ts` (14) — flow opcodes, setVar variants (immediate / var-ref / local target), inc/dec/add/sub, conditional branch families (taken and not-taken paths), delay stub, **and an end-to-end test that runs the verbatim opening bytes of MI1 boot script and asserts it halts on 0x2c with the right trace mnemonics**

**Format reference — `docs/SCUMM-V5-INDEX.md`**

- [x] Top-level block tour of `.000` (RNAM, MAXS, DROO, DSCR, DSOU, DCOS, DCHR, DOBJ)
- [x] Lane encoding (`u16 count` + `u8 lane` + `u32 LE lane`) with worked example
- [x] ⚠️ The two surprises: DROO lane-1 is the disk number, but DSCR/DSOU/DCOS/DCHR lane-1 is the **owning room id**; DROO offsets are zero on single-disk releases and the real offset lives in `LECF/LOFF` in `.001`
- [x] MAXS layout — named u16 LE fields and what each means
- [x] End-to-end resolve walkthrough: script id → DSCR entry → LOFF[room] → absolute offset → SCRP block
- [x] Verification recipe (MI1 numbers: 178/199 scripts resolve, 21 unused)

#### Bonuses

- **Lane-encoding spike came first.** Instead of writing the parser to documented field widths and debugging it later, the scratch script tried every plausible layout against real MI1 and validated by counting LFLF/ROOM/SCRP tag hits at the resolved offsets. Cost: 20 minutes; benefit: the parser locked in correct on the first commit and surfaced the "first lane is room id, not disk" surprise that the long-circulating notes obscure.
- **Halt as a first-class state.** Instead of letting `UnknownOpcodeError` escape the dispatcher, the VM catches it (and any handler-thrown error) at the boundary and freezes into a `HaltInfo` snapshot. The inspector reads `vm.haltInfo` and renders a red banner with bytecode context — no try/catch sprawl in the UI.
- **Self-describing trace entries.** Each handler calls `vm.annotate("setVar 0x49 = 0")` so the trace ring renders human-readable mnemonics without a separate disassembler. The annotation slots into the just-dispatched trace entry; the next dispatch resets it.
- **Step-cap on `runUntilAllYield`.** A 100k-step cap converts the most common bug class in a fresh dispatcher — tight loops with no yield — into a clean halt with full diagnostics instead of a hung tab.
- **End-to-end boot test against real bytes.** `opcodes/index.test.ts` runs the verbatim first 22 bytes of MI1 boot through the dispatcher and asserts the four setVar mnemonics + halt on 0x2c. Pins the whole vertical stack (param decode, var bank, opcode dispatch, halt) with a single assertion that breaks loudly if any layer regresses.
- **Halted-slot badge in the UI.** The slot table flags the slot the VM halted in with a red **HALTED** chip. The underlying `slot.status` stays `running` (the halt is on the VM, not the slot) — the badge makes the otherwise-confusing "running but not running" state legible.
- **Hex addressing across all VM panels.** Trace, halt panel, slot pc column, and globals grid all use `0x` hex — addresses match across panels so cross-referencing a variable write in the trace against the globals grid is a one-look exercise.
- **Inspector survives parse failures.** If index-file / LOFF parse throws, the inspector renders the error in place and the rest of the player UI (room viewer, costumes, charsets, block-tree dumps) keeps working.

#### Notable design choices made during implementation

- **Lane-1 semantics differ by directory family.** DROO's first lane is the disk number (0 = absent, 1 = present in MI1). DSCR/DSOU/DCOS/DCHR's first lane is the **owning room id** — the script (or sound, costume, charset) physically lives inside that room's LFLF, and its offset is relative to that room's ROOM block. The single-disk MI1 release stores 0 in every DROO offset slot; the LOFF block inside `.001` is the source of truth for room positions.
- **Locals live on the slot, not in the central var bank.** A slot's locals are invocation-scoped — when the slot dies they're gone, and parallel running scripts must not share them. Carrying them on `ScriptSlot.locals` makes that automatic; the param decoder takes the active slot as a parameter when dereferencing.
- **Param-mode decoding is per-handler, not centralized.** A single centralized "decode all params" function forces every opcode family into a uniform shape, but v5 opcodes don't have one. `setVar`'s first param is always a raw destination ref word (no mode bit); comparison opcodes treat bit 7 as "param 2 is var or immediate"; `inc`/`dec` use bit 7 to select the *operation*, not the param mode. Each handler reads what it needs.
- **Var-ref encoding.** Bit 15 set → local var, low byte is the index (locals are 8-bit indexed in v5). Bit 14 set → bit-var, bits 0..13 are the index. Bit 13 set → indexed/array reference (throws as unimplemented — defer until the boot script demands it). Otherwise → global var, bits 0..13 are the index. Verified against the leading setVars in MI1 boot.
- **Halt captures opcode-at-error, not pc-at-error.** The trace entry records the PC of the *opcode byte* (before advance), and `HaltInfo.pc` does the same. The bytecode-context strip places the offending byte at `contextOpcodeOffset`, so the UI can highlight it without re-deriving from PC.
- **MAXS sizes are a floor, not a cap.** `bootGame` does `Math.max(index.maxs.numVariables, 800)` so the var bank is always at least 800 even if MAXS reports smaller — defensive against future games or corrupt indices.
- **Engine-var seeding is on-demand.** We don't pre-populate all 800 globals — we add a seed entry only when the boot script's reads make it necessary. Keeps the globals grid honest: every non-zero value either came from a script write we can read in the trace, or from a single named seed call we can find with grep.
- **`runUntilAllYield` resumes nothing.** It doesn't flip yielded slots back to running first — the inspector's "Run tick" button does that. Separation keeps `runUntilAllYield` as a pure "drain runnable slots" primitive that the Phase 6 main loop will call once per frame.
- **Inspector uses replaceChildren, not partial updates.** Every Step / Run / Boot click rebuilds the whole inspector section. Cheap (a few hundred DOM nodes), stays in sync with VM state by construction. The only cross-render state is the `globalsShown` / `bitsShown` counters held in the inspector closure.

#### Open issues / known limitations

- **Only a seed opcode set.** By design — Phase 5 is "skeleton, fail loudly". Real boot continuation needs at minimum cursorCommand (0x2C), stringOps (0x27), startScript (0x42/0xC2), loadRoom, expression evaluator, doSentence, walkActor, … the long tail. Phase 6 grows this set in opcode-the-boot-script-demands-next order.
- **Indexed / array var references throw.** Bit 13 of the reference word selects an indexed deref in v5 (used for arrays). We throw `ParamError` for now. Add when the boot script first uses it.
- **No real `delay` tick clock.** The 0x2E delay opcode treats its 3-byte tick count as ignored and yields once. Real timing lands when the main loop in Phase 6 paces the engine at ~60 Hz.
- **No effectful opcodes.** The VM mutates variables and slots only. Anything that would change the room, palette, actor state, sound, or input — i.e. anything visible on screen — is unimplemented. Halts cleanly when encountered.
- **MAXS u16 slots beyond the named five are unnamed.** `maxs.raw` exposes all 9 u16 LE values from MI1's MAXS but we only put names on the slots we know (numVariables, numBitVariables, numLocalObjects, numCharsets, numVerbs). The remaining four vary by reverse-engineering source; we'll name them as code starts reading them.
- **MI2 not yet verified through boot.** The engine should be the same — same block layout, same opcode set — but we've only run MI1 boot bytes through the VM end-to-end. MI2 verification lives with Phase 10's "MI2 + polish" work, or earlier if it falls out naturally.
- **Inspector "Run tick" is a single drain.** Each click runs one engine tick. There's no continuous-run mode driven by requestAnimationFrame because nothing time-varying is on screen yet. The main loop in Phase 6 will own that.
- **LSCR / OBCD / VERB scripts are not loaded.** `loadGlobalScript` only resolves SCRP. Phase 6 needs local scripts (loaded on room entry) and Phase 7 needs object verb scripts.

---

### Phase 4 — Text *(2026-05-26)*

Decodes SCUMM v5 `CHAR` (bitmap font) blocks at both 1 and 2 bits per
pixel and renders arbitrary strings to indexed pixel buffers. The
player UI gains an LFLF-scoped charset inspector with header
diagnostics, a CLUT-tinted color-map view, a clickable glyph grid,
and a live text-rendering field (string input + ink-color picker)
that uses the currently-selected room's CLUT. 191 tests across 20
files; new `docs/SCUMM-V5-CHAR.md` format reference.

#### Original task checklist (all complete)

**Charset decoder — `src/engine/graphics/charset.ts`**

- [x] `walkCharsets(file)` — iterate `LECF > LFLF > CHAR` blocks in source order
- [x] `parseCharHeader(payload)` — size, magic, 15-byte color map, bpp (1 or 2), fontHeight, numChars, glyph offset table
- [x] `glyphPayloadOffset(header, charCode)` — resolves the **+21 anchor** convention (offsets are payload-relative to byte 21, not byte 0; value 0 is "no glyph" sentinel)
- [x] `decodeGlyph(payload, absOffset, bpp)` — 4-byte per-glyph header (width u8, height u8, xOffset i8, yOffset i8) + bit-packed pixel stream (row-major, MSB-first within each byte, **no per-row padding**)

**Text renderer — `src/engine/graphics/text.ts`**

- [x] `measureText` — bounding box for a string, honoring per-glyph advance + xOffset extension
- [x] `renderText(payload, header, text, colorMap)` — column-major emit of glyph stamps; `\n` newline support; zero-value pixels stay `CHARSET_TRANSPARENT`; non-zero glyph values route through caller-provided color map to CLUT indices

**Format reference — `docs/SCUMM-V5-CHAR.md`**

- [x] Block tree position, mental model (color map as palette routing for actor talk colors), payload layout field-by-field, ⚠️ +21 anchor convention with the "anchor probe" verification trick, 1-bpp and 2-bpp packing rules with a worked example, 15-byte color-map slot semantics (slot 0 always transparent, slots 1..2^bpp − 1 active), text layout semantics, 8-step "decode-to-pixels" walkthrough, 8-entry pitfalls cheat sheet

**Player UI — charset inspector — `src/shell/player/player.ts`**

- [x] LFLF-scoped charsets section, slotted in below costumes; same prev/next nav-per-LFLF pattern
- [x] Header summary: `N bpp · fontHeight=H · K populated / M slots · magic=0x0363 · payload N B`
- [x] Color map swatch grid: 15 cells with CLUT indices, tinted with the real game color from the current room's CLUT; "active" slots (1..2^bpp − 1) get an accent border
- [x] Glyph grid: every populated glyph rendered at 3× scale through the charset's color map, with the printable char or `\xNN` as a label, click to expand
- [x] Glyph detail panel: hex peek of the per-glyph header (4 bytes highlighted) + bitmap body, 6× preview, advance/offset metadata
- [x] Text-rendering widget: free-form text input (defaults to `GUYBRUSH THREEPWOOD`), ink-color number input that overrides color-map slot 1 live, 2× rendered canvas updating on every keystroke

**Tests**

- [x] `charset.test.ts` (16) — `walkCharsets`, `parseCharHeader` (1-bpp, 2-bpp, malformed headers, oversized numChars), `glyphPayloadOffset` (+21 anchor, sentinel, out-of-range), `decodeGlyph` (MSB-first row-major, signed offsets, 2-bpp straddle, zero-dim glyphs, bitstream truncation)
- [x] `text.test.ts` (12) — `measureText` (empty / single / multi-char / newline / missing glyph), `renderText` (ink color, transparency, side-by-side layout, per-glyph xOffset, newline stacking, 2-bpp color routing, colorMap-too-short error)

#### Bonuses

- **Anchor-probe scratch script** — `scratch/inspect-charsets.ts` automatically probes five plausible offset anchors (absolute, +21, +23, +25, +29) for the first non-zero glyph-offset entry and reports which one decodes as a sensible glyph header. The +21 finding came from this in a single pass.
- **CLUT-tinted color-map swatches** — instead of showing raw CLUT indices as numbers, each cell of the color map renders with the actual game color from the currently-selected room's CLUT. The font's "intent" reads at a glance — slot 1 is whatever shade Guybrush's talk color picks, slot 2/3 the outline/fill ramp for 2-bpp fonts.
- **ASCII-print scratch** — `scratch/print-glyphs.ts` decodes a range of characters via the engine's own decoder and prints them as terminal-readable ASCII glyphs. Used to verify all 5 MI1 charsets + the MI2 charsets at 1- and 2-bpp before claiming the decoder correct.
- **`yOffset` honored throughout** — MI1 charset #4 (2-bpp, big credits font) uses `yOff = 1` on every glyph to drop them below the cursor's baseline. Our renderer honors this without special-casing.

#### Notable design choices made during implementation

- **+21 anchor for glyph offsets** — the long-circulating-notes-style "offset is from start of payload" reading produces glyph offsets pointing into the offset table itself. Adding 21 (the byte position of the `bpp` field, which is also the start of the "logical charset metadata" block) lands every offset at a valid glyph header. Verified empirically via the anchor-probe scratch on all 5 MI1 charsets.
- **MSB-first row-major, no per-row padding** — bits flow continuously across row boundaries within a glyph. A 7×7 1-bpp glyph fits in 49 bits = 7 bytes minus 7 trailing bits, NOT 7 bytes per row × 7 rows. Our `decodeGlyph` reads bit-by-bit so the bpp=2 straddle case is handled naturally.
- **Slot 0 is always transparent** in the color map, regardless of what `colorMap[0]` contains. Mirrors the COST convention; lets the same charset render in any color without re-encoding.
- **Same decoder works for MI1 and MI2.** The 2-byte offset shift that MI2 COST blocks need does NOT apply to MI2 CHAR blocks — both games parse identically. Verified visually.
- **Color map filler is real** — slots 4..15 for both 1-bpp and 2-bpp charsets contain a sequential `0x04, 0x05, … 0x0f` filler pattern across every charset we inspected. Almost certainly the encoder's default fill; the UI marks them as inactive (muted) so they're visibly distinct from the slots actually used.
- **Newline = `fontHeight` advance, no inter-line gap.** Simplest possible vertical layout; word-wrap and text-box geometry are downstream concerns deferred to dialog UI.
- **Diagnostic UI is permanent.** Glyph grid + color-map view + text input stay in the player even when scripts eventually drive the renderer.

#### Open issues / known limitations

- **No dialog escape codes.** Strings containing `0xFF`-prefixed sequences (wait, sound, variable substitution, runtime color change) attempt to look up character `0xFF` in the glyph table rather than treating them as control codes. VM concern; lands alongside the bytecode interpreter.
- **No word wrap / text-box layout.** The renderer draws a single-line stream split on `\n` only. Speech-bubble positioning above an actor's head, multi-line wrapping, and alignment are downstream.
- **No actor-bound talk colors.** Color comes from the player UI's ink input. A real script picks a color per actor and the engine passes it to the renderer.
- **Empty `numChars = 0` charsets rejected.** Defensive — we throw rather than silently producing an empty inspector. Hasn't surfaced in real data.
- **Magic `0x0363` not validated.** Every MI1/MI2 charset has it; we parse and surface it but don't reject unknown magic values.

---

### Phase 3 — Costumes *(2026-05-26)*

Decodes SCUMM v5 costumes end-to-end — sub-palette, image tables,
RLE-encoded frame pictures — plus the z-plane occlusion masks that
back actor compositing. The player UI gains a hierarchical resource
browser (rooms with LFLF-scoped costumes nested below), a
comprehensive costume inspector (header diagnostics, palette
swatches, color-keyed hex dump, limb-table chip grid, per-frame
preview canvas through the active room's CLUT), per-z-plane overlay
toggles, and a live actor compositor with click + drag positioning.
163 tests across 18 files. Two new format references in `docs/`.

#### Original task checklist (all complete)

**Costume decoders — `src/engine/graphics/costume.ts`**

- [x] `walkCostumes(file)` — iterates `LECF > LFLF > COST` in source order, indexed by LFLF position
- [x] `parseCostumeHeader(payload)` — `numAnim`, format byte (mirror + 16/32-color), sub-palette, `animCmdOffset` (= `frameOffs`), 16 `limbOffsets` (= `imageTableOffs`), `animOffsets`
- [x] `decodeLimbTables(payload, header)` — group limbs by shared offset, decode u16 LE pointer arrays, flag suspicious entries

**Frame decoder — `src/engine/graphics/costume-frame.ts`**

- [x] 12-byte image header parse: `width u8`, unknown u8, `height u8`, unknown u8, `x i16`, `y i16` ◀ frame pointer lands here, `xinc i16`, `yinc i16`
- [x] `decodeCostumeFrame(payload, framePtr)` — column-major emit; 16-color RLE with `length == 0 → next byte is the real length` extended-length escape
- [x] Costume palette index 0 → `COSTUME_FRAME_TRANSPARENT` (`0xFF`) sentinel

**Z-plane decoder — `src/engine/graphics/zplane.ts`**

- [x] `parseRmihPlaneCount(payload)` — u16 LE plane count from RMIH
- [x] `decodeZPlanes(file, roomBlock, w, h)` — walks `RMIM > IM00` for ZP## blocks
- [x] `decodeZPlane(payload, w, h)` — packbits-style RLE (high bit = run, clear = literal), MSB-first bit layout within emitted byte, offset-0 sentinel for implicit all-zero strips
- [x] `zplaneBit(plane, x, y)` — O(1) accessor with out-of-bounds = 0

**Actor compositor — `src/engine/graphics/composite.ts`**

- [x] `compositeActor({ framebuffer, fbW, fbH, frame, costPalette, actorX, actorY, actorZ, zPlanes })` — maps costume indices through CLUT, edge-clips, applies the "any plane index > actorZ hides" occlusion rule

**Player UI — `src/shell/player/`**

- [x] Hierarchical resource browsing: room nav drives the costume list (LFLF-scoped); navigating rooms updates the costumes underneath
- [x] Costume header diagnostics — format, palette, offsets, payload size
- [x] Color-keyed payload hex dump (`numAnim` / `format` / `palette` / `animCmdOffset` / `limbOffsets` / `animOffsets` each in a distinct tint)
- [x] Limb-table chip grid; trailing junk + "unused sentinel" groups handled cleanly
- [x] Frame chip click → hex peek + 3-candidate header-layout viewer + decoded preview canvas (real CLUT) + "Place on current room" button
- [x] Z-plane overlay canvas stacked over the room canvas with per-plane toggle buttons
- [x] Actor placement: defaults adapt to current room dimensions (200-tall vs 144-tall); x / y / z number inputs
- [x] Click + drag the room canvas to reposition the actor; smooth re-composite without DOM rebuild

**Format references — `docs/`**

- [x] `SCUMM-V5-COST.md` — block layout, mental model (slots/limbs/anims, three indirections), the +6 pointer convention, 16- and 32-color RLE with the length-zero escape, column-major emit, the feet-anchor convention with worked Guybrush example, MI2's 2-byte offset shift, end-to-end decode walkthrough, 10-entry pitfalls cheat sheet
- [x] `SCUMM-V5-ZPLANE.md` — RMIH, header-inclusive offsets, the offset-0 sentinel, packbits RLE with a worked strip decode, MSB-first bit order, the "any plane > actorZ" rule, explanation of overlapping pixels across planes and why a declared plane can be entirely empty (MI1 LFLF #6 ZP02), 8-entry pitfalls cheat sheet

**Tests**

- [x] `costume.test.ts` (13) — `walkCostumes`, header (16/32-color, mirror, truncation), `decodeLimbTables` (grouping, suspicious flagging, empty)
- [x] `costume-frame.test.ts` (10) — flat fills, signed displacements, column-major straddling, transparency, extended-length escape (including > 16), `xinc/yinc`, zero-dim and truncated-RLE errors
- [x] `zplane.test.ts` (13) — RMIH parse, MSB-first bit layout, literal + run sequencing, multi-strip, offset-0 sentinel, error paths, bit accessor
- [x] `composite.test.ts` (10) — opaque pass-through, transparency, redirX/Y, edge clipping (all 4 sides), multi-plane occlusion, dimension errors

#### Bonuses

- **LFLF-scoped resource browsing.** Realized mid-phase that "browse 119 flat costumes" doesn't match how the file is organised. Costumes (and any later resource types — scripts, charsets, sounds) now nest under the current room's LFLF.
- **Click + drag actor placement.** Initially just number-input fields; the user pointed out "drag" was implied so I wired up pointer events with a light-refresh path that re-composites onto the existing canvas without rebuilding any DOM.
- **Real-CLUT frame previews.** Before this, frames previewed with a rainbow palette that made every sprite look like Christmas. Routing through the active room's CLUT shows actual game colors at a glance.
- **3-candidate header-layout viewer.** For any candidate frame pointer, shows what width/height/redir would read as under three offset-into-header conventions. Made the +6 discovery a single-look exercise.
- **Smart "Place on current room" defaults.** Adapts `(x, y)` to the current room's dimensions so the default lands on-screen for both 200-tall outdoor and 144-tall interior rooms.
- **`scratch/` debug scripts** (gitignored) — five small scripts for inspecting real game data through the engine's own decoders. The workflow was: write a hypothesis, dump real bytes against it, iterate. Kept around for the next phase.

#### Notable design choices made during implementation

- **Anim-record decoding deferred to the VM phase.** The variable-length anim command stream is what the runtime uses to play animations frame-by-frame; for "render one static frame" we pick limb + frame directly.
- **Frame pointer at +6 into the image header.** The natural "pointer at struct start" reading produces `width = 0xFFFC`. The format keeps the pointer at the `y` field, likely a side effect of the original engine doing a single dword load on `(x, y)`.
- **RLE `length == 0` is an extended-length escape, not "run of 16".** With "run of 16", consumed byte count exceeded the available region by 8 bytes on Guybrush's idle frame, spilling garbage into the rightmost columns. With the escape rule, the count lands exactly on the next frame's header.
- **Costume color 0 = transparent** regardless of `palette[0]`'s value. Sentinel emit lets the compositor skip cleanly.
- **Z-plane offset-0 sentinel for all-zero strips.** Saves bytes for sparse masks; would crash a naive "subtract 8 → negative offset" decode.
- **Z-plane MSB-first within each emitted byte.** Visually verified by overlaying decoded masks on real MI1 room geometry.
- **Z-plane rule: "any plane index > actorZ hides".** Plane indices run 1..N. `actorZ = 0` (default) is occluded by everything; raising `actorZ` pulls the actor forward past planes one at a time.
- **Compositor reads `costPalette[idx]` → `roomCLUT[clutIdx]` inline.** Keeps frame data palette-agnostic; the same costume renders correctly in any room's CLUT.
- **LFLF index, not DROO id.** Rooms and costumes are indexed by their position in the LECF tree; the UI shows both "Room N of M" and "LFLF #X".
- **Drag uses a light-refresh path.** Re-composites onto the existing canvas (no DOM rebuild) so the canvas element stays alive through the drag and pointer events route to the same captured target. Full refresh (which rebuilds the section, in turn syncing x/y/z input field values) fires once on pointerup.

#### Open issues / known limitations

- **MI2's 2-byte offset shift not yet patched.** Documented in `docs/SCUMM-V5-COST.md` §6; MI2 costumes will decode garbage until applied.
- **32-color mode (format byte 0x59) not implemented.** Every MI1/MI2 costume in our sample is 16-color. Format documented but no decoder path.
- **Mirror flag (format bit 7) parsed but not acted on.** No costume in our sample has it set.
- **Anim record stream not decoded.** VM concern. Picking limb + frame happens directly in the UI; no animation playback exists.
- **No DROO interpretation.** Script-driven `setRoom` / `setCostume` calls would need DROO resolution.
- **No actor scaling.** The SCAL block (per-y scaling that shrinks actors walking "away" from the camera) is not consulted; actors render at native resolution at all room positions.

---

### Phase 2 — First pixels *(2026-05-26)*

Decodes the palette and background bitmap of any selectable room in
MI1 / MI2 and renders it on a Canvas2D at native resolution with
TRNS-aware transparency (transparent regions show through to a CSS
checkerboard so object placeholders are visually obvious). The block
tree from Phase 1 stays visible below; a new per-strip method bar +
histogram chip list expose SMAP decoder behavior at a glance. 116 tests
across 14 files.

#### Original task checklist (all complete)

**Block payload access — `src/engine/resources/tree.ts`**

- [x] `ResourceFile = { bytes, tree }` — single value carried by every Phase 2 decoder
- [x] `payloadOf(file, block)` — `subarray` of the block's body
- [x] `findChild` / `findChildren` / `findDescendant` — navigate by tag
- [x] `parseResourceFile` now returns `ResourceFile`

**Room navigation — `src/engine/graphics/room.ts`**

- [x] `walkRooms(file)` iterates `LECF > LFLF > ROOM` in source order, indexed by LFLF position
- [x] `decodeRoom(file, roomBlock)` composes RMHD + CLUT + SMAP + TRNS into a `DecodedRoom`

**Leaf decoders — `src/engine/graphics/`**

- [x] `rmhd.ts` — three 16-bit LE fields (`width`, `height`, `numObjects`)
- [x] `clut.ts` — 768-byte RGB palette in 0..255 (no bit-scaling needed; values are stored DAC-shifted)
- [x] `smap.ts` — full dispatcher across `0x01`, `0x0E..0x12`, `0x18..0x1C`, `0x22..0x26`, `0x2C..0x30`, `0x40..0x44`, `0x54..0x58`, `0x68..0x6C`, `0x7C..0x80`; uncompressed + Method 1 (V/H, opaque + transparent) + Method 2 (H, opaque + transparent + aliases)
- [x] `trns.ts` — 16-bit LE transparent palette index *(bonus — see below)*

**Renderer — `src/engine/render/`**

- [x] `Renderer` interface: `setPalette`, `setTransparentIndex`, `present`, `dispose`
- [x] `Canvas2DRenderer` — composes indexed + palette → `ImageData`, honours transparent index (alpha=0)
- [x] `MemoryRenderer` — records latest palette/framebuffer/transparent for tests; `rgbaSnapshot()` helper
- [x] `indexedToRgba` — pure helper, transparent index → alpha=0, rest opaque

**Player screen integration — `src/shell/player/`**

- [x] Room viewer section above the block tree
- [x] Prev / next room selector with `Room N of M · LFLF #X` label
- [x] Canvas at native room dimensions, CSS-scaled 2× with `image-rendering: pixelated`
- [x] CSS checkerboard background reveals transparent (TRNS) pixels
- [x] Per-strip method bar (color-coded by family) aligned with the canvas
- [x] Histogram chip list summarizing the codes used by this room
- [x] Loading + decode-error states inline

**Tests**

- [x] `tree.test.ts` — 11 tests on payloadOf / findChild / findChildren / findDescendant
- [x] `rmhd.test.ts` — 5 tests
- [x] `clut.test.ts` — 4 tests
- [x] `trns.test.ts` — 3 tests
- [x] `smap.test.ts` — 32 tests: dispatch, uncompressed, **full Method 1 grammar coverage**, **full Method 2 grammar coverage** (each delta, RLE + clamp, aliases, transparent variants), strip-method diagnostic helper
- [x] `indexed-to-rgba.test.ts` — 5 tests including transparency
- [x] `memory.test.ts` — 6 tests including transparency round-trip
- [x] `room.test.ts` — 4 tests on `walkRooms` (LFLF iteration, skipped LFLFs, missing LECF, etc.)

#### Bonuses

- **TRNS / transparency support** — added when room viewing surfaced
  "purple bars" that turned out to be object placeholders. Renderer
  interface grew `setTransparentIndex`, indexed-to-RGBA learned to emit
  RGBA(0,0,0,0) for the configured index, CSS checkerboard backdrop on
  the canvas exposes those regions visually.
- **Per-strip method diagnostic UI** — `getSmapStripMethods` helper
  plus a color-coded cell bar aligned with the canvas and a histogram
  chip list. Made every subsequent SMAP debugging round much faster.
- **`docs/SCUMM-V5-SMAP.md`** — a self-contained format reference
  covering layout, bit-stream conventions, full method dispatch, both
  compression algorithms with prose explanations, and the two specific
  corrections we needed to make over the long-circulating notes.

#### Notable design choices made during implementation

- **`ResourceFile` flows through everything.** Decoders take
  `(file, block)` and slice on demand; no copy, no re-decryption, and
  no "did you pass the right payload?" bug class.
- **Engine code stays DOM-free.** Only the shell touches
  `FileSystemDirectoryHandle` / `File`; engine layer consumes
  `Uint8Array` / `ResourceFile`.
- **SMAP offsets are header-inclusive.** The decoder gets the payload
  and subtracts 8 inside `readStripOffsets`. Symptom of getting this
  wrong is wildly varying compression codes (255, 0, 247…) and was
  the first debugging milestone.
- **Method 2 delta sign is inverted from the circulating notes.** The
  working dispatch is `color -= (4 - d)`. Verified empirically against
  MI1 / MI2 strips; opposite sign produces unmistakable color-cycling
  artifacts in gradient regions.
- **Method 2 paletteBits subtract for `0x54..0x58` is `0x50`, not
  `0x51`.** The notes' value yields pb=3..7 which conflicts with every
  other range. Symptom: localized garbage on codes 87 / 88 only.
- **Canvas2DRenderer clears before each present.** Transparent pixels
  in the new frame must expose the CSS checkerboard, not blend with
  the prior frame.
- **Room indexing by LFLF position, not game id.** DROO decoding is
  deferred until scripts actually call `setRoom`. The UI shows both
  "Room N of M" and "LFLF #X" so the cross-reference is explicit.

#### Open issues / known limitations

- **No actor / object compositing yet.** Areas marked transparent by
  TRNS show through to the checkerboard. They'll be filled by OBIM
  sprites in Phase 3+.
- **No DROO interpretation.** Rooms indexed by LFLF position; room IDs
  used inside scripts are not yet resolved.
- **No palette cycling / fades.** The CYCL block is not decoded.
- **MI2 cutscene rooms render as solid colors.** That's correct —
  rooms 103 (all black) and 108 (all purple) really do ship as 40
  identical-color strips for fade/transition effects.

---

### Phase 1 — Resource catalog *(2026-05-25)*

Parses `MONKEY.000` + `MONKEY.001` (and MI2 equivalents) end to end:
File System Access permission re-grant, slurp + byte-XOR-decrypt with
key `0x69`, recursive walk of the SCUMM v5 block tree, indented per-line
tree dump in the player screen with a tag-by-tag description from a
single-source-of-truth catalog. 46 tests across 6 files.

#### Original task checklist (all complete)

**Permission re-grant**

- [x] `src/shell/storage/permission.ts` — `ensureReadPermission(handle)` queries+requests `'read'` mode
- [x] Wired into the library's Play button (re-grant before navigating)
- [x] Denial path: navigate to `{ kind: 'library', flash: '…retry.' }` and render an inline flash banner

**XOR layer — `src/engine/resources/xor.ts`**

- [x] Pure `xorDecrypt(data, key)`, returns a new buffer
- [x] `SCUMM_V5_XOR_KEY = 0x69` constant with comment noting other v5 releases may differ
- [x] 6 tests: empty input, identity at key=0, round-trip, per-byte XOR, no mutation, key constant value

**Block parser — `src/engine/resources/block.ts`**

- [x] `Block { tag, offset, size, children? }` with `children` set iff the tag is a known container
- [x] `parseBlocks(data, baseOffset = 0)` — recursive walker
- [x] BE 32-bit size, size includes the 8-byte header
- [x] `isContainerTag(tag)` — closed set + `^IM[0-9A-F]{2}$` regex for image containers
- [x] `BlockParseError` with byte offset on zero-size, overshoot, truncated header
- [x] 15 tests: leaf, sequence, nested, deeply nested, unknown→leaf, empty container, error paths, `baseOffset`

**File adapter — `src/engine/resources/file.ts`**

- [x] `parseResourceFile(encrypted, xorKey)` — composes `xorDecrypt` + `parseBlocks`
- [x] No DOM types in the engine layer — shell does `FileSystemDirectoryHandle` → `File` → `Uint8Array`
- [x] No standalone tests; covered transitively by xor + block tests

**Player screen rewrite — `src/shell/player/player.ts`**

- [x] Back button + header (game name, gameId, source dir)
- [x] Loading state while files are read + parsed
- [x] Two sections (Index, Resources) with stats (block count, top-level count, file size)
- [x] Indented per-line tree, monospace, color-coded (tag accent, meta muted, description italic)
- [x] Case-insensitive filename match in `findFile` (handles uppercase/lowercase game files)
- [x] Error state with file/parse error message

**Tests**

- [x] Phase 1 added 27 tests (xor: 6, block: 15, catalog: 6). Total: 46 across 6 files.

#### Bonus: block-description catalog

Added during browser review when you flagged "would be SUPER NICE to know
what each block means". Single source of truth at
`src/engine/resources/catalog.ts`, used inline by the player UI.

- [x] `describeBlock(tag)` covers every block currently emitted by the parser, plus `IM[0-9A-F]{2}` and `ZP[0-9A-F]{2}` patterns
- [x] Test asserts every container tag in the parser has a catalog entry (parser/catalog stay in sync)

#### Notable design choices made during implementation

- **`children !== undefined` distinguishes containers from leaves**,
  even for empty containers (which get `children: []`). Cleaner than
  using a separate `isContainer` field that could drift from `children`.
- **Per-line `<div>`s, not `<pre>`** in the tree view, so the
  description can render in a distinct muted/italic style. With ~2-3k
  blocks in MI1's `.001` this is still well under 100 ms to paint.
- **Catalog as data, not docs.** Descriptions live in TS alongside the
  parser. The UI is the primary surface; if a separate Markdown
  reference is wanted later, we can generate it from the catalog.
- **`flash` state on the library Screen**, added so permission denial
  has somewhere to land that isn't an `alert()`.

---

### Phase 0 — Scaffold *(2026-05-25)*

Runnable empty app: Vite + TypeScript + Vitest scaffold, library /
install / player-placeholder screens with a state-machine shell, game
detection, IndexedDB persistence of directory handles, browser-support
gating, 15 passing tests across 3 files. `npm run dev` serves the
library; `npm test` watches.

#### Original task checklist (all complete)

**Project setup**

- [x] `npm init`, add `.gitignore`
- [x] Install dev deps: `vite`, `typescript`, `vitest`, `@types/node`, `fake-indexeddb`, `@types/wicg-file-system-access`
- [x] `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`)
- [x] `vite.config.ts`
- [x] `vitest.config.ts` (`environment: 'node'`)
- [x] `index.html` + `src/main.ts`
- [x] npm scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `test:run`
- [x] `npm run dev` boots and serves the library screen

**Test harness**

- [x] Trivial Vitest sanity test (`src/sanity.test.ts`)
- [x] `npm test` runs in watch mode, green

**Shell skeleton**

- [x] Screen state machine in `src/shell/app.ts` (`library` | `install` | `player`)
- [x] Directory structure per ARCHITECTURE.md §8

**Library screen — `src/shell/library/`**

- [x] Lists installed games from IndexedDB, with empty-state copy
- [x] "Install game…" button → install screen
- [x] Per-game row: name, gameId, Play button (navigates to player placeholder), Remove button
- [x] Remove deletes the IndexedDB record only — user's files are untouched

**Install flow — `src/shell/install/`**

- [x] Triggers `window.showDirectoryPicker({ mode: 'read' })` on button click
- [x] Game detection in `detect.ts` (pure, filename-based, case-insensitive)
- [x] On success: persist `{ id, displayName, gameId, directoryHandle, installedAt }` to IndexedDB, return to library
- [x] On unknown: error message with retry/cancel
- [x] User cancel (AbortError) is silent

**IndexedDB layer — `src/shell/storage/`**

- [x] `games` object store with CRUD wrappers (`listGames`, `addGame`, `removeGame`, `getGame`)
- [x] Each operation opens + closes its own DB connection (simple, no shared state)
- [x] *(Deferred to launch time)* Permission re-grant flow before passing the handle to the engine — left as a TODO comment for Phase 2 when there's actually something to launch

**Browser support**

- [x] `checkBrowserSupport()` detects missing `showDirectoryPicker` and `indexedDB`
- [x] Renders an "Unsupported browser" page instead of crashing

**Tests for Phase 0**

- [x] `detect.test.ts` — 8 tests: positive MI1, positive MI2, case-insensitive, missing file, empty, unrelated, extra files, MI1/MI2 disambiguation
- [x] `games.test.ts` — 6 tests: empty store, add+list, round-trip by id, remove, unknown id, multiple games independent. Uses `fake-indexeddb/auto`, resets the DB between tests.
- [x] `sanity.test.ts` — 1 test: arithmetic sanity check

#### Notable design choices made during implementation

- **Detection takes `string[]`, not a directory handle.** Pure function,
  trivially testable in Node. The directory-walking adapter lives in
  shell-only `install.ts`, which the test suite doesn't touch.
- **No shared DB connection.** Every storage call opens, transacts, and
  closes its own `IDBDatabase`. Simpler than connection pooling, fine for
  the access pattern (one user action at a time). Revisit if it ever
  matters.
- **Permission re-grant deferred.** Stored a TODO for when the player
  screen actually needs to open the files (Phase 2). Phase 0's player is
  a placeholder, so there's nothing to authorize yet.
- **`@types/wicg-file-system-access`** was needed — TypeScript's built-in
  `lib.dom.d.ts` covers `FileSystemDirectoryHandle` and `entries()`, but
  not `Window.showDirectoryPicker`.
