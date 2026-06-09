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
integration playthrough (`npm run test:integration`). **All of Part I now plays
end-to-end from boot** — intro, the three trials (insult-swordfighting, the
buried treasure, and the idol theft), then the Sheriff's catch, the underwater
escape, and the docks vow that opens Part II (see Frontier below).

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
clean state — currently the Mêlée docks (room 83), surfaced from the sea with the rescue vowed (bit#304).

**Frontier: Part I is COMPLETE — all three trials done (sword + treasure + idol), the Governor
kidnapped, and Guybrush has vowed to get a crew + ship to rescue her (bit#304). The whole from-boot
net is green.** The clean fast-forward save sits on the Mêlée docks (room 83), quest vowed. The full
Part-I arc (dogs → mansion gauntlet → Otis's cake/file → grab the idol → Sheriff catch → the sea →
recover the idol → auto-escape → the docks vow) is in the net; routes + mechanics live in the
walkthrough beats and `game.ts` helpers, not here.

> **NEXT SESSION — start Part II.** Guybrush needs a *ship* (Stan's used vessels) and a *crew*.
> Restore the frontier save to land on the docks, then extend the net beat by beat from boot the same
> way (one seeded VM; develop each beat by fast-forwarding the frontier save, then fold it in). First
> scouting step: from the docks, find the route to Stan's ship-yard and the crew (the Voodoo Lady /
> the SCUMM Bar pirates) — disassemble first, drive headless, assert mechanics not strings.

Two engine fixes made along this arc (kept here until folded into `pages/docs/`):

- **Rat-animation drawObject fix (confirmed in-browser).** Entering the prison (room 31) froze the VM:
  its three #207 loops animate a rat-hole by re-picking one of the hole's three same-box frames whose
  state is 0 and drawing it — but `drawObject` set each drawn frame to state 1 and never reverted the
  previous, so after one pass all three latched and the picker spun (100k-step guard). Fix
  (`opcodes/index.ts` `drawObjectHandler`): the same-box eviction now ALSO reverts the overdrawn
  object's state to 0 (erased = hidden), sustaining the loop. Unit-pinned in the opcode test file.
- **getDist box-clamp fix (confirmed in-browser).** "Give meat to dogs" aborted with "Non riesco ad
  arrivarci": the dogs' walk-to sits in a locked box, so ego clamps to a far box edge and the
  sentence-#2 proximity gate (`getDist >= 32`) failed. Fix: `getDistHandler` mirrors SCUMM's
  `getObjActToObjActDist` — it clamps an OBJECT's point into the box the ACTOR can reach
  (`clampPointToBoxes` over `effectiveBoxes`) before measuring. No-op for objects whose walk-to is
  already in a visible box.

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
  sound `0xFF09`, mid-string colour `0xFF0E` (consumed, emit nothing; both 0
  uses in MI1). Mid-string colour surfaces as missing inline colour in
  dialogue. *Done / non-gaps:* `0x04` int, `0x05` verb-name, `0x06`
  object/actor-name, `0x07` string-resource all expand; **keep-text `0xFF02` is
  handled** in the talk path (`decodeScummStringPages` sets keepText →
  `addSystemText` accumulates it) — only static `decodeScummString` strips it,
  correctly; actor-name `0xFF0A` only matters in dialogue text.
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
  The oracle diff (2026-06-09) surfaced the opcodes the disassembler decodes but
  the executing table had no handler for. **ALL such MI1 opcodes now closed
  (registered + unit-pinned):** standalone `multiply` 0x1B/0x9B & `divide`
  0x5B/0xDB (`makeMulDiv`); `loadRoomWithEgo` variants 0x64/0xE4; `drawBox`
  0x3F/0x7F/0xBF/0xFF (persistent screen rect-fill in `vm.drawnBoxes`); and
  `getActorWidth` 0x6C/0xEC (actor `_width`, set by actorOps SO_ACTOR_WIDTH,
  read by global #2's interaction-proximity gate). The oracle now reports 0
  boundary mismatches AND zero no-handler gaps across all 721 MI1 scripts —
  every decoded opcode has an executing handler and they agree on every
  boundary. `getActorScale` (0x3B) / `getAnimCounter` (0x22) don't appear in MI1
  at all — left unregistered (no consumer to verify against). **Caveat:
  `drawBox` pixels NOT yet verified in-browser** — operand sizing is
  oracle-proven, but no save sits near the credits/#155 to check the visual fill.
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

- **Section B (0 MI1 uses) now LOUD-HALT, not silent** (2026-06-09): an
  unreached path / MI2 that hits one is caught immediately. `roomOps` saveLoad
  (0x09) / saveString (0x0D) / loadString (0x0E); `cursorCommand` cursor-image
  subops 0x0A/0x0B/0x0C (setCursorImage / setCursorHotspot / initCursor — needs
  the charset-glyph cursor decoder); `matrixOp` setBoxScale (0x02/0x03);
  `soundKludge` (0x4C, now registered with a named throw). Implement on first
  halt. (`createBoxMatrix` 0x04 stays a correct no-op — mask rebuilt on
  setBoxFlags.)
- **DONE this session:** `roomIntensity` (0x08) + `setRGBRoomIntensity` (0x0B)
  scale the palette from the base CLUT (per-channel, clamped — room 29's
  Voodoo-Lady colour pulse); `shakeOn`/`shakeOff` (0x05/0x06) toggle
  `vm.shakeEnabled` and the renderer jolts the frame vertically (waveform is an
  approximation — engine-internal, tune in-browser).
- Dialog escape codes still deferred: sound `0x09`, mid-string colour `0x0E`
  (both 0 uses in MI1). **keep-text `0x02` is NOT a gap** — the print path
  (`decodeScummStringPages` → `addSystemText`) accumulates keepText lines and
  clears transient ones; only the static `decodeScummString` (verb/object
  names) strips it, correctly. actor-name `0x0A` similarly only matters in
  dialogue. (`0x04`–`0x07` expand — see the Tier-2 entry above.)

**Tooling**

- **Disassembler operand-size gaps — FIXED (2026-06-09, fix (a)).** Took the
  higher-leverage path: diffed the disassembler against the executing opcode
  table (`SEED_OPCODES`) as an oracle. The oracle runs each executing handler
  over a permissive mock VM and records the highest **byte index actually read**
  (immune to jumps, which only do pointer arithmetic) → the engine's true
  instruction boundary; comparing that to the disasm's per-instruction next-offset
  surfaces every *silent* mis-size the `aligned:false` flag can't (a mis-sized
  operand still decodes as plausible opcodes). Probe: `scratch/disasm-oracle-diff.ts`.
  The "~13% misaligned" figure was already stale — **0 hard `aligned:false` fails**
  across all 721 MI1 scripts; the survey found 3 *silent* boundary mismatches from
  2 genuine bugs, both now fixed in `disasm.ts` (unit-pinned):
  • **resourceRoutines (0x0C) subop sizing.** The old `lo <= 0x12` rule gave
    subop 0x11 (clearHeap, no arg) a phantom arg byte and denied 0x13
    (nukeCharset) its arg; 0x14 (loadFlObject) read its object as a word.
    Now mirrors the handler: 0x11 none, 0x14 two p8 args, every other one p8.
  • **stringOps loadString (0x27/1) — first fixed BACKWARDS, then corrected
    (commit 9a6c4f3).** The oracle showed disasm (escape-aware `cstr`, ends @445)
    vs engine (raw scan-to-NUL, ends @443) and I wrongly made the disasm match
    the engine (`rawstr`). The ENGINE was the buggy side: MI1 #154's
    copy-protection question embeds `0xFF 0x07` (string-var substitution) whose
    2-byte arg's 2nd byte is `0x00` — a raw scan stops at that inner NUL, ending
    2 bytes early and mis-decoding the next bytes as a phantom drawBox/putActor.
    The real game data proves @445 is right: the next loadStrings are the wheel
    locations (Antigua/Barbados/Jamaica/…). Corrected: engine `loadString` now
    uses `readScummString` (escape-aware), disasm reverted to `cstr`. **Lesson:
    the executing table is usually right but NOT axiomatic — ground against the
    game data, not bookkeeping that can share the same bug.** (`roomOps`
    saveString/loadString stay raw via `rawstr`/engine-raw — disk-I/O strings,
    no escapes, unexercised in MI1.)
  Also aligned `cstr`'s escape-length rule to the engine's `readScummString`
  (code ≥ 4 → +2 bytes, was `4..9` — under-read the 0x0A/0x0E name/colour codes;
  no MI1 message string exercised it, oracle still 0 after). After all three:
  **oracle = 0 mismatches across 721 scripts.** Downstream `referencedGlobalScripts`
  (room/extract.ts) and `disgrogate SCAN` are now trustworthy on the linear pass.
  Option (b) (decode from entry points, follow jumps) is unneeded for MI1.

  • **Discovered byproduct — engine opcode-coverage gaps (NOT disasm bugs; the
    disasm decodes them, the executing table had no handler → would halt if
    reached).** All now CLOSED (commits a15af0c, 14c00ef, 272fba0; see
    Watch-for): standalone `multiply`/`divide` (0x1B/0x9B/0x5B/0xDB),
    `loadRoomWithEgo` variants 0x64/0xE4, `drawBox` (0x3F family), and
    `getActorWidth` (0x6C — actor `_width` via actorOps SO_ACTOR_WIDTH, NOT
    costume frame-width). Oracle: 0 boundary mismatches AND zero no-handler gaps
    across 721 scripts. Note: walking the oracle *past* the newly-handled
    `drawBox` is what exposed the loadString backwards-fix above (it had been
    masked by drawBox halting the sweep).

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
