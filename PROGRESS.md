# GrogVM — Progress

Lean tracker. Two buckets:

- **Current** — what's in flight and what's open right now; also the **lab
  notebook**: capture each finding as it happens, trim it only once it's
  written into the right `pages/docs/` file. The full pipeline:
  [KNOWLEDGE](pages/docs/agent/knowledge.md).
- **Next** — the work ahead, as one-liners. Broken into tasks only when we start.

---

## Current — natural play through MI1

Playing MI1 from boot and fixing each blocker engine-faithfully (committed on
`main`). **Unit suite green + tsc clean**, plus a data-gated, from-boot
integration playthrough (`npm run test:integration`, ~1.6s). **Parts I and II are
FINISHED; Part III plays from boot well into "Under Monkey Island" — through the
cannibal village, the monkey, the idol, the idol-for-picker and picker-for-key
trades, and the "beat LeChuck" talk that trades the navigation leaflet for the
navigator's head.** The beat-by-beat sequence IS the test
(`integration/mi1/walkthrough.test.ts`, in run order); Part-III room ids +
mechanics live in `game.ts` (`monkeyBeach`/`monkeyMap`/`fort`/`riverFork`/
`catapult`/`pond`/`crack`/`northBeach`/`cannibalVillage`/`cannibalHut`/`monkey`/
`monkeyClearing`/`idolChamber`), not here. The remaining content — the catacombs,
LeChuck's ghost ship, the seltzer trade, and the lift that ends Part III — is fully
probed and mapped below (**Part III endgame map**, 2026-06-14); writing the beats +
the new `game.ts` room ids is now mechanical.

**Working principle (agreed 2026-06-02):** engine-faithful, no hacks/shortcuts —
confirm the real mechanism first (**never consult ScummVM source, in any form**),
verify the actual outcome not the bookkeeping, surface every
deferral/approximation here, never bury one. The full contract:
[COLLABORATION](pages/docs/agent/collaboration.md) +
[VERIFICATION](pages/docs/agent/verification.md).

**The regression net — MI1 full walkthrough** (`integration/mi1/walkthrough.test.ts`,
started 2026-06-04). Design (one seeded VM from boot, beats, the frontier) →
[HARNESS §6](pages/docs/engine/harness.md); testkit pieces → [AGENTS "The harness"](AGENTS.md);
the *printing-sentence-blocks-the-next* finding → [INPUT §5](pages/docs/scumm/input.md).
Suite conventions: beats carry **zero `driveTicks`** — each action waits on `waitReady`,
then asserts via named condition-waiters (`waitPickedUp` / `waitGlobal` / `waitPlayable`;
a raw `driveUntil` only for bespoke predicates). Named `<Part> · <Room> — <what it
proves>`, file order = run order; per-game ids/vars in `game.ts` (`ROOMS`/`VERBS`/`VARS`).
A clean fast-forward save (`saves/MI1-walkthrough-frontier.websave.json`, gitignored,
written by the ALWAYS-LAST `frontier` beat and regenerated each green run) sits at the furthest
clean state (currently room 25; see NEXT below).

**The overhead map (rooms 2–6) is WALKABLE** (ego a small figure, costume 3 walking / costume 4 the
boat), not a node hub: edge connectors cross screens (global #34); locations are entered by walking
onto their marker.

**Dev caveat (still live):** the engine RNG is a test-only seam, NOT serialized in saves
([HARNESS §4](pages/docs/engine/harness.md)), so a frontier-restore drive diverges from the full
from-boot run (catapult-fire end-position, Herman's arrival timing, etc. shift) — develop against
the save for speed, but the from-boot run is the real check. Keep RNG-touchy beats robust: dynamic
stop-conditions and condition-waiters, not exact intermediate asserts (the duel grind and monkey
feed were hardened this way 2026-06-13 when the village walk-speed fix shifted the stream).

### Part III endgame map — catacombs → ghost ship → seltzer → the lift (probed 2026-06-14)

The frontier sits in the cannibal village (room 25) holding the Monkey-Head key (#269) and the
navigator's head (#293); idol, picker, leaflet all given away. Everything from here to the end of
Part III is mapped from the bytecode below (disassembler + `scratch/p3-allrooms.ts` +
`scratch/p3-room-dump.ts`; **never ScummVM source**). Ids are object/script/bit/global numbers;
verbs are `look=8 open=2 pickUp=9 talk=10 give=4 push=5 pull=6 use=7`. The maze and the ghost crew
ride the engine RNG seam, so the from-boot run (`npm run test:integration`) stays the real check —
beats here must follow VM state (`g266`, owner/bit flips), not exact intermediate positions.

> **Corrects the old step-8 note.** The ear is **#767 in room 69 (the idol chamber)**, *not* a
> close-up "room 65"; room 65 is the catacombs antechamber. The maze is **room 39** (procedural). The
> gateway is the **Giant Monkey Head #133 in the clearing (room 12)** — the same head whose gate the
> monkey held for the idol chamber — not a "Great Stone Head #284". Giving the root is **automatic**
> (village heartbeat), not a Give verb. The "talk to Bob → lift" beat happens **on the ghost ship
> (room 70)**, reached by *returning* there after the seltzer is made — not in the village.

**A. Into the catacombs (clearing 12 → idol chamber 69 → antechamber 65 → maze 39 → cavern 70).**
- The catacombs gateway is the **Giant Monkey Head `#133`** in the clearing (room **12**). Its
  verb-11/8: if the monkey holds the gate (`#142` state 1) → idol chamber (room 69, via `startObject
  155 script=11`); **else if the mouth is open (`#151` state 1) → `loadRoomWithEgo room=65`** (the
  catacombs); else nothing. (`#133` has no Use verb, so the key can't be used on it directly.)
- **Open the mouth:** in the idol chamber (room **69**) Use the Monkey-Head key `#269` on the giant
  ear `#767` (verb 7; partner check `isEqual L0 val=269`) → **global #94**: ego climbs into the ear,
  the mouth-open animation plays, `putActorInRoom room=12 x=876`. (`#765` "head" rejects the key —
  it goes in the *ear*.)
- Then in room 12, walk to `#133` again → room **65** (antechamber: `#754` head = climb back up to
  12 via L201; `#755` "la caverna" = on into the maze). Room-65 ENCD falls ego in (L202) when
  `g101==12`, sets `g274=1`, `g265=0`.
- `#755` (verb 90/255): if `bit#383` set → straight to the cavern (`loadRoomWithEgo room=70`); else
  → **room 39, the maze**.
- **The maze (room 39) is procedural** (ENCD reseeds `g264` via `getRandomNumber`), but
  **deterministically solvable by following `g266`**: room-39 L204 sets `g266` = the correct
  direction-cave object for the current screen (one of `#495 #496 #497 #498 #521`, all named "la
  caverna"); the navigator's head's hint lives in `g274` (0=left 1=right 2=forward 3=back) and
  **holding the head `#293` disables the "confusion" scripts (L207/L206) and keeps the hint
  (L212)**. L205 resolves a step: walking `g266` advances a step counter `g265`; **when `g265 > 6`
  → `loadRoomWithEgo room=70`** (the ghost-ship cavern); wrong moves reshuffle / bounce to room 65.
  *Test approach:* loop `walkTo(objectPoint(g266)); waitReady` until `currentRoom===70`.

**B. Board the ghost ship — the necklace makes ego invisible (cavern 70 → decks 77/71/72/73/74/75).**
- At the cavern (room **70**) the ghost ship `#769/#770/#771` and a deck ghost `#784` (class 32,
  untouchable). **First** make ego invisible:
  - **Talk** to the navigator's head `#293` (verb 10 → **global #140**, a dialog tree): beg
    (`"Posso avere quella collana…"` then plead — the head relents after the beg-counter `g286 > 4`)
    **or** threaten; both converge on the handover (`drawObject 929`, `actorSetClass obj=294
    classes=[6]` → the necklace `#294` becomes wearable). The head + necklace `#294` were already
    pocketed by the leaflet-trade cutscene (global #104); the talk is what makes `#294` *wearable*.
  - **Wear** the necklace: Use `#294` (verb 7) → **global #141** → **`bit#357 = 1`** (invisible to
    ghosts), `#294` renamed "su Guybrush". `#294`'s verb refuses where there are no ghosts ("Non ne
    ho bisogno qui") and when hands are full — so wear it **at the cavern (room 70)**, not earlier.
    `bit#453` (underground) only changes the flavor line, not the invisibility.
- **Board:** `#769` "la nave fantasma" verb 11 → cutscene (`startScript 111` = stand-up; `175` =
  no-op) → `loadRoomWithEgo room=77` (the main deck). The ghost-detection gate is **global #78**
  (reads `bit#357`): not wearing → `startScript 72` (caught) and ejected back to room 70; wearing →
  pass.
- **Deck (room 77) connectivity:** `#838` porta → cabin **72**; `#840` "la porta che cigola"
  (the squeaky door) → cell/brig **71**; `#841` portello → crew quarters **73**; `#855` caverna →
  back to room **70**. Ambient ghosts: dog `#842`, drunk ghost `#843`.

**B1. Cabin (room 72) — compass on the spinning key.** ENCD installs a sentence override
(`g33=202`) and draws the key as actor 5 + an atmospheric (non-lethal) ghost (actor 9). Use the
magnetic compass `#732` on the key `#799` (verb 7) — local **#202** hard-checks the pair `{732,799}`
in either order → magnet cutscene → `pickupObject obj=799` (the key enters inventory). Bare pickup is
refused ("E' una grande chiave fantasma."). No bit set — assert `getObjectOwner(799)==ego`.

**B2. Feather → tickle a sleeping ghost → jug o' grog (galley 75 / crew quarters 73).** Take the
ghost feather `#820` (verb 9, no gate; in room 75). In the crew quarters (room 73) Use the feather
`#820` on the **ticklish** sleeper `#804` (verb 7 — `#803` "Non soffre il solletico") → local **#200**
flips the grog `#802` touchable (clears its class-32 untouchable bit, `setState 802 state=1`). Take
the grog `#802` (verb 9 → global #183 → `pickupObject 802`).

**B3. Locked hatch → bilge → grog in the rat dish → cooking grease (galley 75 → bilge 74).** The
locked hatch `#824` (verb 2) gates on the held item being **class 6** (`ifClassOfIs val=g7
classes=[134]` = class 6) → generic unlock (global #25) → `setState 824 state=1` → `loadRoomWithEgo
room=74`. **The cabin key `#799` is the intended hatch key (a class-6 "key") — CONFIRM by driving.**
In the bilge (room 74): pour the grog `#802` into the rat dish `#807` (verb 4 *or* 7; partner check
`L0==802`, gated `bit#316==0`) → local **#201**: the big rat `#810` gets drunk, the chase guard
(L203) stops, **`bit#316 = 1`**. Then take the cooking grease: jar `#806` verb 9 → `pickupObject
815` — the item that lands in inventory is the **glob `#815` "la noce di grasso"** (gated
`getObjectOwner(815)!=ego`), not the jar.

**B4. Grease the squeaky door → ghost tools → crate → voodoo root (deck 77 → cell 71 → galley 75).**
The squeaky door `#840` (room 77): opening it (verb 2) when it still **has class 6** runs the squeak
cutscene (L200–L206) that wakes the deck ghost and re-arms the ambient scripts (and sets `bit#317`);
**greasing** it — Use the grease glob `#815` on `#840` → `actorSetClass obj=840 classes=[6]`
(clears class 6) + rename "la porta" — flips its verb-2 onto the **silent** branch → `loadRoomWithEgo
room=71`. (`#840` has *no* Use verb of its own; the grease interaction lives on `#815`.) In the
cell/brig (room 71, past the asleep guard `#787`) take the ghost tools `#788` (verb 9 → `pickupObject
788`, no gate). Back in the galley (room 75) Use the tools `#788` on the glowing crate `#821` (verb 7;
partner `L0==788`) → global #25 → `setState 821 state=1` (open); then take the voodoo root `#823`
(verb 8, gated crate `state==1` **and** `owner(823)==world`) → `pickupObject 823`.

**C. Out of the catacombs → village → the seltzer is made automatically (room 70 → 65 → 25).** Leave
the ship (room 77 `#855` → cavern 70) and take `#768` "la caverna" (verb 11; gated **owning `#823`**
or `bit#383`) → **global #170** (the "una lunga camminata…" cutscene) → `loadRoomWithEgo obj=290
room=25` (village). **No Give verb:** the village heartbeat (room-25 local **#200** @114–131) sees
`owner(#823)==ego && bit#383==0` → **global #106**, which renames the root `#823` →
"la bottiglia di selz magico", `actorSetClass obj=823 classes=[6,146]`, **`bit#383 = 1`**; room-25
**L210** then walks ego off and `putActorInRoom room=6` (the overhead map) at x=126,y=64.

**D. The lift back — ends Part III (village → cavern 70 → Part IV at Mêlée).** With `bit#383` set, the
village jungle exit `#290` (verb 11) now → **global #171** ("dopo aver corso a tutta velocità…") →
`loadRoomWithEgo room=70` (a shortcut straight back to the cavern). Room-70 ENCD now (`bit#383` set)
skips making the ship boardable (`notEqualZero bit#383 -> 74`) — instead the **ghost crew** path runs:
they greet ego as "Bob", the decrepit ghost explains LeChuck went to Mêlée to marry Elaine, and the
crew offer a ride (room-70 locals **#205/#206**, `bit#452` = Bob also boards). That ends at **global
#131** — the Part III→IV transition: unloads Part-III resources, `bit#453=1`, `loadRoom 95` (the
**"Parte Quattro / Il Finale"** title card), then `putActorInRoom room=83 x=80 y=121` (ego back on the
Mêlée docks). **Part III's walkthrough block ends here**; Part IV "Il Finale" (wedding-crash room 78,
LeChuck room 45, showdown room 59) is the next frontier.

**Gating bits/vars (assert these, not strings):** `bit#357` necklace worn = invisible (global #141);
`bit#383` root → magic seltzer (global #106; also gates the cave exit `#768`, the village→ship shortcut
`#290`, and room-70's lift-vs-board branch); `bit#426` head held-out/reassembled (gates head talk vs
put-back, and room-65/70 ENCD); `bit#316` rats fed; `bit#436` crew-dialog state (gates the lift / the
Part-IV line); `bit#452` Bob joins; `bit#453` underground/Part-IV; object states `#151` mouth open /
`#142` gate held / `#821` crate open / `#824` hatch open; `g266` correct maze direction, `g274` head
hint, `g265` maze step counter; class 6 = key/wearable, class 32 (bit 31) = untouchable.

**New `game.ts` room ids to add:** `monkeyHead`/catacombs gateway lives on the existing
`monkeyClearing` (12) `#133` + `idolChamber` (69) ear `#767`; new rooms `catacombsAntechamber` (65),
`catacombsMaze` (39), `ghostCavern` (70), `ghostDeck` (77), `ghostBrig` (71), `ghostCabin` (72),
`ghostCrewQuarters` (73), `ghostBilge` (74), `ghostGalley` (75); plus on `cannibalVillage` (25) the
head `#293` talk + necklace `#294`.

> **CONFIRM BY DRIVING (restore a near-ship save and step through — the from-boot run is the real
> check).** (1) Re-entering the idol chamber (69) for the ear needs the monkey holding the gate
> (`#142==1`) — verify it's still held on return, or how 69 is re-entered with the key. (2) The
> mouth-open flag `#151` — confirm the key-on-ear path (global #94/callees) sets it (that's what
> flips `#133` → room 65). (3) The cabin key `#799` is class 6 so it opens the hatch `#824` — confirm
> (else find the real hatch key). (4) Global #78's ghost-detection flow (where it runs; the caught
> path `startScript 72`) vs the `#769` board cutscene. (5) What *starts* the room-70 lift dialog
> (#205/#206) on the post-seltzer return, and its answer-verb ids. (6) That following `g266` through
> the maze (room 39) advances `g265` to the cavern.

> **Cannibal-village bug, still open (reported in-browser 2026-06-13).** The 3 cannibals sometimes
> all render as "Lemonhead" (one mask) instead of three distinct masks — intermittent, a
> costume-decode/limb issue on actors 3/4/5 (costume 9) in room 25. Not yet investigated; a
> real-pixel (in-browser) issue, so the headless net (which renders nothing) doesn't catch it.
> (The room-25 walk-speed crawl reported the same day is FIXED — commit `0bd87c9`.)

**Pending in-browser checks** (fixes shipped + folded into docs, look not yet confirmed):

- The fixed intro entry — room 38 used to flash ego top-right at full scale before the
  entry walk rescaled him; `enterRoom` now resolves box + scale on room load (ego at
  scale 215, box 5 from the first frame; headless repro: `scratch/lookout-entry-scale.ts`).

### Open bug-report saves (reported, not yet fixed)

- (none. Dev save at the forest fork: `saves/MI1-forest-fork.websave.json`,
  gitignored, regenerated by `scratch/forest-fork-save.ts`.)

### Tier-2 divergence checklist

Silent, self-flagged approximations — the tier scheme is defined in
[VERIFICATION](pages/docs/agent/verification.md). Hand-curated — comment phrasing
drifts, so no grep refreshes this list; the heuristic sweep for NEW flags is
`git grep -niE "best-effort|for now|not yet|no [a-z]+ yet|approximat" -- src/ ':!*test*'`
(checked 2026-06-10: every hit is tracked here or is a platform-side best-effort
catch in `savegames.ts`).

Priority H/M/L = likelihood of biting current/near play × severity.

- [ ] **M — dialog/string escape codes still deferred**
  (`decodeScummString` / `expandSubstitution`, `opcodes/index.ts:~2128`):
  sound `0xFF09`, mid-string colour `0xFF0E` (consumed, emit nothing; both 0
  uses in MI1). Mid-string colour surfaces as missing inline colour in
  dialogue. *Done / non-gaps:* `0x04` int, `0x05` verb-name, `0x06`
  object/actor-name, `0x07` string-resource all expand; **keep-text `0xFF02` is
  handled** in the talk path (`decodeScummStringPages` sets keepText →
  `addSystemText` accumulates it) — only static `decodeScummString` strips it,
  correctly; actor-name `0xFF0A` only matters in dialogue text.
- [ ] **L — actor downscaling drops different pixels than the original**
  (`graphics/composite.ts` `compositeActor`). MITIGATED 2026-06-12 — the shipped
  phase-tuned nearest-neighbour and *why* it's an approximation are in
  [COSTUMES "Scaled drawing"](pages/docs/engine/costumes.md); the faithful
  per-scale drop pattern is still unrecovered. **Constraints any real fix must
  hold:** eyes survive at every scale that matters (dock 210, dialogue 241, jail
  207 — scan eye regions PER LIMB, not bounding-box thirds; a stand is a head+body
  limb stack and the independently-rounded seams are where the adjacent drops
  live); and a *walking* actor's drawn size stays stable frame-to-frame (a
  count-based size wobbles ±1 → ego visibly "struts"). **Refuted / reverted —
  don't re-try:** single-window bitrev8 (every oracle sample has ADJACENT drops,
  impossible for bit-reversal); a per-limb seeded bitrev scale-table (better
  static oracle fit, but its count-based sizes strut while walking — built then
  reverted 2026-06-13). **Oracle-extraction tooling lives in `scratch/`**
  (`pattern-batch.ts` registers reference screenshots onto our bg render,
  diff-masks ego, recovers the kept rows/cols via monotone DP). Structural
  findings from it: drop counts track (256−s)/256 per axis, and the pattern is
  deterministic per (scale, source index) — NOT position/content dependent. (NB
  the original's resting sizes run slightly larger than ours at the same spots —
  cliff 20×46 vs our 19×44 — a possible entry-position / slot-rounding gap to
  check alongside.) **Next discriminating data:** DOSBox captures, or same-pose
  screenshots at many scales with debugger-read scale values. Tuned on Guybrush's
  costume only.
- [ ] **M — walk facing picks the dominant axis by raw pixel deltas, not
  movement factors** (`walk.ts` `stepWalk` / `facingLookahead`): on
  near-diagonal legs the original rests facing the SLOW axis' direction
  (observed: cliff-path entry walk's final leg dx=+11/dy=−9 rests N in the
  original, E in ours — `scratch/screens/38-cliff.png`). Likely rule: facing
  from deltaX/deltaY FACTORS (speed-weighted), so the slow vertical axis
  dominates legs it spends more time on. Affects every walk's rest facing;
  validate against the original on several walks before changing — the
  current lookahead rule was itself tuned against observed walks.
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~114`,
  the stored SO_CLIPPED bound).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
- [ ] **L — right-margin clamp for positioned left prints is a guess**
  (`screen.ts` `paintDialogText`, the non-center clamp citing room 51): the recipe
  close-up's bottom lines (left at x=160, w=218/190) clamp to x=102/130 and their tails
  vanish on the parchment's dark edge. Observe the original's layout for these exact
  lines (room 84) before changing anything.
- [ ] **M — blast-text (a=254) lifetime: `restoreCharsetBg` approximated by
  cutscene-end / room-change / overwrite / camera scroll, not real screen
  redraws** (`vm.ts eraseTransientSystemText` triggers). Only about a=254:
  the narrator channel (a=255) drains faithfully with the talk timer since
  2026-06-10 — see [CHAR §"The message channels"](pages/docs/scumm/char.md).
  Faithful for the known cases (treasure-map close-up room 63 prints the
  dance steps then waits for a *click* → text must persist; room 64's
  "Passano ore" clears when the dig cutscene pans the camera back). SCUMM's
  real eraser is `restoreCharsetBg` (the background under the blasted text is
  redrawn) — we approximate it with those triggers. **CONCRETE FAILING CASE
  (deferred, user-reported in-browser): room 36's "no animals harmed"
  disclaimer renders WRONG.** Three coupled problems, all diagnosed:
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
    (verified — lingers over the scene after the box is gone). A vm.test.ts case
    pins the current endCutscene-clear for a=254, so the faithful fix (clear on
    real redraws incl. object setState) must re-verify the room-63/64 banners
    in-browser.
  • **Render off:** colours (EN "IMPORTANT NOTICE" green vs our magenta) and font
    weight differ — a charset/CLUT-mapping issue on the `charsetSet=1` + colour
    2/3/8 path. NOT audio (no sound op gates the disclaimer span; confirmed).
  Fixing this is the deferred `restoreCharsetBg` refactor + a charset/colour pass;
  needs in-browser pixel iteration.
- [ ] **L — flashlight gfx not modelled** (`opcodes/index.ts:~589`, dark-room
  strip extent). Cosmetic; only the flashlight rooms.
- [ ] **L — global arithmetic doesn't wrap at int16** (`Variables` is
  `Int32Array`, `value|0`). SCUMM globals are int16, so arithmetic past ±32767
  wraps in the original; ours saturates to 32-bit. Rare in MI1, and int16-clamping
  risks engine counters/timers — audit before touching.
- [ ] **? — `actorOps` subop `0x0f` treated as no-arg no-op "for now"**
  (`opcodes/index.ts:~1845`; seen in MI1 boot after setCostume, not in the
  wiki). Assess whether it affects behaviour or is genuinely inert.
- [ ] **L — slot exhaustion silently skips EXCD / ENCD / the inventory script**
  (`vm.ts:682/711/1613`): with all 25 script slots busy, a room's exit/entry
  script or the inventory refresh just doesn't run — the same silent shape as
  the EXCD ordering bug. MI1 play stays far below 25 live slots.
- [ ] **L — restored music slot is a heuristic** (`sound/backend.ts:93`): on
  save restore, the looping active sound is assumed to be the music slot.
  Related output gap: a restored save resumes inaudibly until the game next
  starts a sound (the snapshot stores ids, not renditions).
- [ ] **L — single CD transport not modeled** (`platform/audio/`): real
  redbook hardware plays one track at a time, so a CD start would cut any
  playing CD sound; our backend would mix them. No observable MI1 consumer —
  every script seen stops its CD sound explicitly before starting the next
  (#152 both exits, L203's own stop). Revisit if a scene surfaces an overlap.
- Already tracked elsewhere (cross-ref, not duplicated here): `screenEffect`
  animation + `VAR_CURRENT_LIGHTS` darkening (Rendering backlog),
  `saveRestoreVerbs` subset (Watch-for), audio / `resourceRoutines` (Out of
  scope).

**Watch for** (recurring failure modes in newly-reached content):

- Unimplemented opcodes → an unknown-opcode halt freezes the *whole* VM. The
  2026-06-09 oracle sweep closed every MI1 decoder/handler gap (0 boundary
  mismatches AND zero no-handler gaps across all 721 scripts), and the corpus
  net (`integration/mi1/disasm.test.ts`) enforces it; `getActorScale` (0x3B) /
  `getAnimCounter` (0x22) don't appear in MI1 and stay unregistered (no
  consumer to verify against). **Live caveat: `drawBox` pixels NOT yet
  verified in-browser** — operand sizing is oracle-proven, but no save sits
  near the credits/#155 to check the visual fill.
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

**Rendering**

- **Screen-shake waveform is an approximation** — SCUMM's shake table is
  engine-internal (not in the bytecode), so only the on/off state is
  faithful; the renderer's vertical jolt is hand-rolled. Tune in-browser.
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
  change when a scene surfaces it. (The two scene symptoms noted earlier — the
  room-33 cliff N/S facing flip-flop and the room-38 entry head-loss transient —
  were re-verified in-browser 2026-06-10: both fine.)
  See [COSTUME-ANIM](pages/docs/scumm/costume-anim.md).

**Stubbed opcodes (cosmetic / peripheral)**

- **Section B (0 MI1 uses) is LOUD-HALT, not silent** (2026-06-09): an
  unreached path / MI2 that hits one is caught immediately. `roomOps` saveLoad
  (0x09) / saveString (0x0D) / loadString (0x0E); `cursorCommand` cursor-image
  subops 0x0A/0x0B/0x0C (setCursorImage / setCursorHotspot / initCursor — needs
  the charset-glyph cursor decoder); `matrixOp` setBoxScale (0x02/0x03);
  `soundKludge` (0x4C, registered with a named throw). Implement on first
  halt. (`createBoxMatrix` 0x04 stays a correct no-op — mask rebuilt on
  setBoxFlags.)

**Engine internals / tech debt**

From the 2026-06-09 architectural review (its "Secondary findings"); none block
play — maintainability/quality, not bugs. File:line refs are point-in-time.

- **Savestate reaches directly into `Vm` private fields**
  (`savestate.ts:224-439` reads/writes `vars.globals`, `objectStates`, slot
  internals). Consistent with the "trust internal callers" convention and
  covered by round-trip tests, but every Vm state refactor is silently
  load-bearing for saves, with only the global `SAVE_VERSION` as the tripwire.
- **`createSession` cannot be seeded.** `bootGame` takes an injected `random`
  (boot.ts:72) and the integration harness uses it, but session.ts:447/:466
  hardcode `undefined` — so browser sessions and the `restore()` / `reboot()`
  paths are permanently `Math.random`. Deliberate per the jsdoc, but the
  session API forecloses determinism rather than defaulting away from it.
- **Costume frames are decoded fresh every frame, per limb, per actor**
  (`composite.ts` → `decodeCostumeFrame` allocates a new buffer each call).
  Fine at 320×200 with a few actors; the one place "clarity over performance"
  has a plausibly visible cost (GC churn in long cutscenes). A note, not a fix.
- **Sync resource resolution inside the tick** (`vm.getCostume` parses on miss,
  blocking the frame). Harmless at MI1's 4.8MB-fully-in-RAM scale; contradicts
  the documented lazy model.
- **`graphics/composite.ts` vs `render/compositor.ts`** — the split is clean
  (actor blit vs. frame assembly) but the near-identical names invite confusion.

### Out of scope (their own phases)

- **Resource-heap management** — `resourceRoutines` stay no-ops (resources load
  lazily; there's no managed heap to model).

---

## Shipped — audio output, first cut (`WebAudioBackend`, 2026-06-12)

SBL PCM + CD-track playback behind the `AudioBackend` seam, verified in-browser
(commits `b6642ca` + the `8880e9b` session-clock fix). Design, behaviour, and
the always-muted/virtual-clock model → [AUDIO](pages/docs/engine/audio.md);
format facts → [SOUND §2/§4](pages/docs/scumm/sound.md). The detailed plan and
its closure live in git (this section's history). Open remainders: OPL2
synthesis for the 15 ADL-only effects (Next), single-CD-transport exclusivity
and restored-save audio resumption (Tier-2 list above).

## Next

Three items ahead, one of which — keep playing MI1 — is the Current section
above. We no longer track by phase number; the numbered-phase roadmap (and
each finished task's closure record) is history — git keeps it.

- **Audio: OPL2 synthesis** for the 15 ADL-only effects (first cut shipped
  above — SBL + CD play; an AudioWorklet OPL2 + the ADL MIDI event stream).
- **MI2** — full support for the v5-but-slightly-different edge cases. Sanity
  so far (2026-06-09): boots and runs 3000+ ticks with no halt; its 199 SOUN
  blocks are all `SOU ` containers (no CD triggers) and parse cleanly via the
  SBL/MIDI path. Known unimplemented one: MI2 `COST` payloads need their
  first 2 bytes skipped before parsing (every payload-relative offset is 2
  bytes too small otherwise) — the costume decoder doesn't yet apply this
  shift.
