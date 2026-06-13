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
integration playthrough (`npm run test:integration`). **Parts I AND II play
end-to-end from boot — the three trials, the crew and the Sea Monkey, then the
whole Journey: the ship rooms looted, the navigation broth cooked, and the
cannon shot onto Monkey Island's beach. Part III's whole surface now plays from
boot: the beach opening, the Fort loot, the catapult shot, the dam flood, the
Pond's rope, the Crack's oars, and the row around the coast to the north beach**
(see Frontier below).

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
clean state — currently on Monkey Island's north beach (room 132), rowed there around the coast;
Part III's whole surface plays from boot.

**Frontier: Parts I and II are FINISHED, and Part III plays from boot through the dam flood —
after the cannon launch, ego gets up off the beach (the g32=201 wakeup), pockets a banana and
reads the assembly notice (room 20), walks into the jungle onto the walkable overhead map (room 2
→ screen 3), and enters the Fort (room 80) by walking the map figure onto the fortezza marker. In
the Fort: rope + spyglass taken, the spyglass opened into the lens (class bit 1), the rusty cannon
pushed (it spills the gunpowder + cannonball), Herman Toothrot sent off, gunpowder + cannonball
pocketed. Then across the map to the River Fork (room 15): take the flint (#169, reads the note
under it), climb the footholds to the catapult (room 16), aim it (g242→4, pull twice), climb to
the firing ledge (room 11) and push the pre-seated rock (#116) — it knocks the bananas onto the
beach (bit#530); climb back down and blow the dam (gunpowder + a flint/cannonball spark → global
#44): the river floods and washes ego onto the overhead map (room 4). Then down to the Pond
(room 40) for the second rope (#561, reachable now the flood filled the pond), and into the Crack
(room 18): tie the Fort rope to the branch (#248) and the Pond rope to the trunk (#249), climbing
down each stage to the oars (#245) at the bottom. Finally back to the south beach, oars on the
rowboat (#263) → row out as the boat (costume 4) and circumnavigate the map's water clockwise
(screen 2 → 5 → 6), landing at "la spiaggia" on the north beach (room 132).** Part-III room ids +
mechanics live in `game.ts`
(`monkeyBeach`/`monkeyMap`/`fort`/`riverFork`/`catapult`/`pond`/`crack`/`northBeach`), not here.
The overhead map (rooms 2–6) is WALKABLE (ego a small figure, costume 3 walking / costume 4 the
boat), not a node hub: edge connectors cross screens (global #34); locations are entered by
walking onto their marker.
**Engine fix this session (shipped, committed `742f1cb`):** the boat-crossing softlock — a
relative screen-crossing lands the boat just off a screen edge, and `findBoxAtOrNearest` /
`clampPointToBoxes` ranked the nearest walkbox by BOUNDING RECT, so a slanted land box whose bbox
dipped 2px lower than the adjacent water box won and stranded ego as the walking figure on land.
Now they rank by true EDGE distance (SCUMM `adjustXYToBeInBox`, via `closestPointInBox` moved into
`pathfinding/boxes.ts`); synthetic guard in `boxes.test.ts`. Found via a user repro save and the
edge-vs-bbox divergence at the room 2↔5 crossing.
Dev caveat (cost a session-internal debug cycle): the engine RNG is NOT serialized in the
frontier save, so a frontier-restore drive diverges from the full from-boot run (the catapult-fire
end-position, Herman's arrival timing, etc. shift) — develop against the save for speed, but the
from-boot run (`npm run test:integration`, ~1.6s) is the real check; make RNG-touchy beats robust
(e.g. the catapult down-climb retries the exit rather than asserting an exact intermediate box).

> **NEXT SESSION — Part III proper ("Under Monkey Island"), beyond the north beach (132).** Ego is
> ashore on the north shore with the rowboat. **Route into the village (verified by driving
> 2026-06-13):** north beach (132, backs room 1) → jungle exit #16 → overhead-map **screen 6**
> (room 6) → marker **#72 "il villaggio"** → cannibal village (**room 25**). The arc from there:
> capture/hut/escape, the wandering monkey, the totem/Giant Monkey Head idol, the navigator's head
> (#293), and getting under the monkey head (close-up room 69 / "la zona disboscata" room 12).
> Restore the frontier save to start on the north beach (room 132); same loop — disassemble first,
> drive headless, assert mechanics. NB the frontier save's RNG caveat above — the from-boot run is
> the real check.
>
> **Banana economy (re-derived from bytecode + headless drive 2026-06-13 — CORRECTS an earlier
> wrong note).** The five the monkey wants are: **#265** (the single beach banana, pocketed in the
> Part III opening beat) + **#266/#267** (the catapult-dropped beach cluster) + **#282/#283** (the
> cannibal-village pair). The dropped cluster **#270** has a plain `Pick up` (verb 9) that hands over
> BOTH #266 and #267 and clears the cluster — **no picker needed** (the earlier "#270 needs the
> picker" claim was wrong). It MUST be taken on the south beach BEFORE rowing away (no convenient
> return to room 20 afterward), so the walkthrough now does — **shipped this session:** new beat
> `⚙️ South beach — pick up the catapult-dropped banana cluster`, + `beachBananaA`/`beachBananaB`
> (#266/#267) ids in `game.ts`. The village pair #282/#283 are pocketed by taking the bowl bananas
> (#291 `Pick up`), which also TRIGGERS the cannibal capture (#202). The banana-picker (#314) lives
> in the hut (room 27) and acts on #266/#267/#282/#283 as an ALTERNATE harvest route; its required
> consumer is still unpinned (the five don't need it).
>
> **Village capture/hut recon (2026-06-13, not yet beaten into beats).** Grabbing the bowl bananas
> (#291) starts capture script #202; the confrontation fires as ego walks back RIGHT toward the
> cannibals (it parks on a `g2`/camera-X > 270 wait until then — NOT a softlock). The cannibals
> demand something to "offer the Great Monkey" (the idol) and the menu loops until given. **The hut
> is room 27** (door #285 in room 25, locked "chiusa a chiave"); inside: #310 skull, #309 loose
> board (escape, verb 11), #314 banana-picker, #305 note, #313 window. OPEN THREAD: what actually
> throws ego INTO room 27 is unresolved (menu loops, door stays locked) — still digging.

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
