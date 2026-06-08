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
clean state — currently the Sword Master's clearing (room 61), swordfighting trial passed.

**Frontier: Part I's swordfighting trial COMPLETE — beats the Sword Master, 36/36 green from
boot.** Mêlée intro → SCUMM Bar (trials learned, g197) → kitchen (meat/pot, fish via the gull
bolt) → circus cannonball (478 pieces of eight) → town shops (treasure map, chicken, sword,
shovel) → forest maze (treasure dig + sword-master fork) → troll bridge (red herring) → Smirk's
basic lesson → the **swordfighting trial in 4 beats**: (1) park at a west-of-fork map spot, (2)
ONE beat grinds pirate duels lose-to-learn until ready (~30 duels; per-duel beats were too noisy),
(3) travel the map node 918 to her clearing (61), (4) duel Carla and win → trial passed (`bit#20`).
Helpers in `game.ts`: `grindOneDuel` (one provoked duel, lose-to-learn with menu paging),
`enoughForSwordMaster` (gate on the seeded needed-comeback set), `fightSwordMaster` (talk → intro
→ scroll-to-want defense; the travel via node 918 is a one-liner inlined in the beat),
`learnedInsults`/`learnedComebacks` (bit-array truth). (Step-by-step route + duel mechanics in the beat/helper comments.)
**Next: the thievery + treasure trials.**

*Insult mechanic (extracted ground-truth, `scratch/insult-map.ts` via the duel-loop #90
table-build → string #37):* pirate insults 1–15 are beaten by the **same-numbered**
comeback; the Sword Master's 16–33 reuse pirate comebacks (16+k→k). Two PERSISTENT bit
arrays hold learned state — `bit#140` insults you can throw (set in #83), `bit#222`
comebacks (set in #82); menus rebuilt each turn (#160/#161 → g308/g309). Per-duel tally
g262 losses / g263 wins vs threshold g351; a won duel bumps **g282** (cross-fight), and
the Sword Master fights once `g282 > 3` (room 61 #58). Data + duel-driving helpers in
`game.ts` (`INSULT_COMEBACK`, `INSULTS_LEARNED_BIT`, `COMEBACKS_LEARNED_BIT`,
`VARS.fightsWon`/`currentInsult`, `ROOMS.pirateDuel`; `provokeDuel`/`openDuel`/`tradeInsults`/`duelProgress`).

*How learning ACTUALLY works (verified `scratch/duel-learn-loop.ts`, `duel-pirates.ts`,
`check-g285.ts`):* pirate duels run in **full alternating mode `g285=3`** (confirmed live —
NOT the `g285=1` an early disasm read suggested). `#90`'s `g285==3` branch flips who attacks by
who **won the last exchange** (`#74` sets the turn var `g288`): keep winning ⇒ you keep
**attacking**, lose an exchange ⇒ you flip to **defending**. On YOUR attack you learn a
**comeback** (`#82`: `bit#222[g241=g240]`) when the pirate **counters the insult you threw** (a
skill roll `randomInt(10) ≤ g268`) — and that counter is also the exchange you LOSE, flipping you
to defense, where the pirate insults you (`#83`) and you learn a new **insult** (`bit#140[g240]`).
So it's *lose-to-learn*: throw a known insult → pirate counters → learn its comeback AND flip to
defense → get insulted → learn a new insult → throw that next. **The current `tradeInsults` WINS
every exchange, so it stays on attack and almost never gets insulted** (3 comebacks `{2,8,15}`); a
lose-to-learn picker reaches **11/16 comebacks + all 16 insults** in ~23 fights, meeting 4 pirates
(`Brutto Pirata`, `Lurido Sporco`, `Puzzolente`, `Assetato di Sangue`; skills 4–8).
Learning rate scales with the **pirate's skill `g268`**, and pirates vary by **name** —
`Brutto Pirata` (skill 4), `Lurido Sporco Pirata` (skill 7), randomly drawn from ids 2–7 by
`#114` (effectively <5 distinct). Stronger pirates counter more ⇒ teach more; the fixed `SEED`
makes the pirate/insult sequence reproducible, so the minimal grind is tunable. Caveat:
`duelProgress`'s `g308/g309` are the **menu-rebuild scratch, not learned totals** (they shrink
6→4 between reads) — read the `bit#140`/`bit#222` arrays directly for true learned counts.

**Engine fixes this session (all confirmed in-browser; full rationale in the code comments + commits):**
- **Signed v5 direct-word immediates** (`vm/params.ts`: `readVarOrWord` + `readValue` →
  `readI16`). v5 direct words are signed int16 (like jump offsets): `0xFFFE`=`-2`,
  `0xFFFF`=`-1`. Reading them unsigned broke every signed compare/arithmetic — the duel's
  loss sentinel `74 [65534]` made `isGreater L0 val=0` always "won" (you could never lose a
  swordfight), negative immediates like `move g181 = -1` (20× in MI1) compared as 65535, and
  it flung an actor off-screen on a lost exchange (a *logic* bug surfacing as a *render*
  symptom — the kind only real play catches). **Deferred gap:** globals are `Int32Array`
  (`value|0`), not int16 — arithmetic overflow past ±32767 won't wrap like SCUMM; rare in MI1,
  and int16-clamping risks engine counters/timers, so audit before touching.
- **`verbOps` setVerbNameStr (subop 0x14)** was a no-op → now copies the string buffer into
  the verb name (duel menus name options via `startScript 85/86 [id]` → buffer 32/33 then
  `verbOps … nameStr=`; nested `startScript` means the buffer is ready). Was showing stale lines.
- **`decodeScummString`: `FE 01` = newline** (0xFE is a 2nd escape introducer; a bare `0x01`
  stays a glyph). The verb-panel scroll arrows (verb 109/110) stack their 8×8 glyph tiles via
  `FE 01` row separators.
- **`print` to actor 253 = debug channel, suppressed** — every `a=253` is an English dev string
  (in this IT build), mostly gated by `bit#482`; real system/narrator text uses `a=255`.
- **Verb hit-test in the verb's own charset** (`play-area.ts verbAt`) — was the dialogue
  charset, so the arrow glyphs measured zero-width and clicks missed; now matches the render.

*These SCUMM-semantic findings (signed direct words, the `FE 01`/`0xFE` introducer, the
`a=253` debug channel, `verbOps` 0x14) are still candidates to fold into `pages/docs/scumm/`.*

**Next frontier — the Sword Master (Carla) duel.** Mapped end-to-end (`scratch/carla-drive.ts`,
`duel-disasm.ts` #116/#58/#139): map node **#918** → `loadRoomWithEgo room=61`; in room 61 you
**talk to Carla (#744 verb 10)**, whose verb script DISPATCHES between her duel (`#116`) and her
post-trials *story* conversation (`#139`, the "meet me at the docks" Part II setup — sets
`bit#89`, loads room 44). The **duel** path: `#116` (gated on `bit#20` clear = not yet fought)
→ `startScript 73 [1,58]` — the SAME `#73` orchestrator as map pirates but with `L1=58`, so `#73`
runs `#58` as its setup (which does `move g285 = 2`, pirate-attack mode) then `#90`. CONFIRMED
drivable (`scratch/carla-room62.ts`): talk → an intro cutscene plays in the close-up **room 62**,
then the actual fight runs in **room 44** with `g285=2`, `g284` advancing `0→1…`. It's
**best-of-5** (`g351=5`, since Carla is actor 5), she insults via 16–33 (→ comebacks 1–16); with
only comebacks `{2,8}` you lose 0–5. Her duel is `g285=2` (she attacks) ⇒ you can only DEFEND ⇒
you do NOT learn comebacks during it — you must arrive already knowing ~all of 1–16. So "enough"
≈ comebacks 1–16.

**Engine bug found + fixed driving Carla (NOT yet confirmed in-browser):** `stringOps
getStringChar` (0x27 subop 0x04) read its operands **one var/direct mask-position off**. The
result-pos consumes no mask, so the two operands take masks 0x80/0x40 (paramIndex 1,2), but the
impl used 2,3 (0x40/0x20). The insult matcher #87 is `getStringChar res=L3, id=37 (direct byte),
idx=L2 (var)` — read `string[37][insult*3+slot]` (the comeback table #90 builds). Off-by-one it
read `string[g549=0][64]` — an ABSENT string — so NO comeback ever matched a defense. Pirate
duels hid this (they're player-attack `g285=1`; wins come from #82's skill roll, not #87), but
Carla's duel is `g285=2` (you defend) so it was **unwinnable** — fully armed you lost 0–5.
Fixed `opcodes/index.ts` + `disasm.ts` (`scratch/dump87.ts` has the raw-byte proof); 340 VM
unit tests green; fully-armed Carla now scores wins (4–5, lost only to the menu-paging gap
below). **Confirm in-browser before commit.**

**Carla winnable end-to-end — CONFIRMED (`scratch/carla-win.ts`).** The defense menu is a 6-wide
sliding window over learned comebacks; scroll verb **110 = down** (toward higher ids), **109 = up**.
A bidirectional *scroll-to-want* routine (page until the needed comeback is visible, then pick its
slot) beats her **5–0** when armed with comebacks 1–16. Talking once with `g282>3` forced took the
duel branch; the fight runs in room 44 (`g285=2`), `bit#20` set on completion.

**Minimum grind MEASURED (`scratch/grind-sweep.ts`, deterministic seed): ~10 lose-to-learn duels.**
F=9 loses (8 comebacks), **F=10 wins 5–3** (9 comebacks `[1,2,3,5,8,9,11,12,14]`), F≥11 keeps
winning. The gate `g282>3` clears ~fight 9; one more duel gets enough comebacks. Robust duel driver
(`playToMap`): pick opener 127, lose-to-learn during the `g285=3` duel, exit any post-gate
conversation via its last option — loops until back on the map (handles the "Sei bravo abbastanza"
exchange cleanly).

**WIRED & GREEN (from boot).** `game.ts` now has the lose-to-learn grind and Carla fight; the
walkthrough grinds until `enoughForSwordMaster` then wins her duel (65/65). Key pieces:
- **Menu paging is the unlock.** Both the attack and defense duel menus show only 6 of the
  learned insults/comebacks at a time (scroll verbs 109=up / 110=down). A no-scroll picker can
  only ever throw the low-id insults, so it never learns the high comebacks (12,15,16) Carla
  needs. `duelScrollTo` pages to the target id; the attack picker scrolls to throw each
  still-missing TARGET insult, the defense picker scrolls to the winning comeback.
- **Targeted, not minimized.** We control the seed, so the grind targets the fixed comeback set
  (`TARGET_COMEBACKS` = 1..16) and the gate (`SWORD_MASTER_NEEDED`) is the specific subset Carla's
  seeded duel demands; on this seed the grind reaches 15/16 comebacks (only 9 is never taught by
  the pirate pool, and she doesn't need it) by ~duel 30, which is when the last needed one (12)
  lands. ~30 duels @ ~5ms each.
- **The getStringChar engine fix + all duel changes are UNCOMMITTED**, pending the user's
  in-browser check (they said: verify once the rewritten grind runs clean — it now does).

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
