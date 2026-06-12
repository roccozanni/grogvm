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
integration playthrough (`npm run test:integration`). **Parts I AND II now play
end-to-end from boot — the three trials, the crew and the Sea Monkey, then the
whole Journey: the ship rooms looted, the navigation broth cooked, and the
cannon shot onto Monkey Island's beach: Part III opens ashore** (see Frontier
below).

**Working principle (agreed 2026-06-02):** no hacks/shortcuts — every change is
the final, SCUMM-faithful solution. Confirm the real mechanism first (disassemble
the original's scripts; observe the running original in-browser — **never consult
ScummVM source, in any form**) before editing; when engine-faithful and a
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
clean state — currently on Monkey Island's beach (room 20), Part II complete.

**Frontier: Parts I and II are FINISHED — after the crew/ship finale, the Journey plays through
from boot: the cabin loot (pen/ink/book), the Jolly Roger off the crow's nest, the hold
(gunpowder/rope/wine), the cereal-prize key, the cabinet chest (recipe + cinnamon), all eight
ingredients into the galley pot (the voyage cooks itself, g259 1→2), the flaming-mass fuse, and
the cannon launch onto Monkey Island's beach (room 20), playable.** Ship-room ids + mechanics live
in `game.ts` (`shipCabin`/`shipDeck`/`shipHold`/`shipGalley`/`crowsNest`/`monkeyBeach`), not here.

> **NEXT SESSION — Part III (Under Monkey Island).** Ashore at the beach (room 20): the bananas,
> the rowboat, the island map (room 11), the cannibals' village, Herman Toothrot. Restore the
> frontier save to start on the beach; same loop — disassemble first, drive headless, assert
> mechanics.

**`createBoxMatrix` is now a real runtime rebuild** (2026-06-11) — locked boxes drop out of
the graph and walks detour around fresh seals (the room-7 chest drag was the blocker; the
savestate gained a required `boxMatrixRebuilt` bool). Migrated to
[PATHFINDING §5](pages/docs/engine/pathfinding.md), incl. the empirically-derived neighbor
predicate and its 82/83-room hop-for-hop validation against the disk BOXMs.

**Recipe close-up (Look at #85) double fix** (2026-06-11, found via beat-save 075; not yet
in docs) — two root causes behind "text all black + VM hangs":

1. **Carried-object verb scripts survive room changes.** The Look handler runs
   `cutScene → loadRoom 84 → poll g194 → endCutScene` in ONE verb script; our
   `stopRoomLocalScripts` killed every `VERB-` slot on room change, so the script died at
   its own `loadRoom` and nothing was left to end the cutscene → world frozen forever
   (#18 froze at `freezeScripts 127`, #19's `freezeScripts 0` unreachable). Now a verb
   slot whose object is carried (owner ≠ 0 ∧ ≠ 15) is spared — its code lives in the
   inventory, not the departing room. Room-object verb slots still die (door transitions
   unchanged, walkthrough green).
2. **Per-line charset capture (like verbs' `charset_nr`).** Room 84's ENCD prints the
   parchment in charset 1 (8px pitch) then restores charset 2 before the frame composes;
   the renderer re-rendered every queued line in the *current* charset → tall glyphs on an
   8px pitch = illegible black smear. `ActiveDialog` now carries a required `charset`
   captured at print time (savestate field — old saves invalid by policy; beat saves
   regenerated) and `paintDialog` resolves per line, falling back to current for charset 0.

**Observed divergence candidate, needs the original**: the close-up's two bottom lines
("Far bollire…", "Servire…") are sticky-LEFT at x=160 per the bytecode; our right-margin
clamp pushes them to x=102/130 and their black tails land on the parchment's dark torn
edge (invisible ink). Check how the original lays these lines out before touching the
clamp (see Tier-2 below).

**Title → lookout music handoff + CD-trigger cue bytes** (2026-06-11/12): migrated to
[SOUND §2/§4](pages/docs/scumm/sound.md) — track 17 holds title + lookout segments,
trigger bytes 18-20 are a binary-MSF mid-track cue (#108). Disgrogate gotchas (ids ≥
200 are room-local; override prints the raw jump delta) → [AGENTS "The disassembler"](AGENTS.md).

**Session clock remainder leak fixed** (2026-06-12, found via audible CD seek-glitches):
migrated to [SESSION §2](pages/docs/engine/session.md) — VM ran ~1-3% slow against wall
time; the carry is capped at one interval so hidden-tab stalls drop their backlog.

**Entry facing fixed via the OBCD `actorDir` byte** (2026-06-12, found via the user's
reference-playthrough screenshot batch in `scratch/screens/`): `loadRoomWithEgo` placed
ego at the target object's walk point but never faced him — he kept his pre-transition
walk facing, so the bar doorway (#428) and cliff path read E where the original rests
front/north. Fix: face per the entry object's `cdhd.actorDir` + `applyStandPose`. The
byte's mapping is the pairwise OPPOSITE of the costume old-dir table (`ACTOR_DIR_FACING
= [E,W,N,S]`, vs costume `[W,E,S,N]`) — all four codes pinned by observed entries: bar
interior #315 (0)→E, jail #400 (1)→W, cliff steps #486 (2)→N, bar doorway #428 (3)→S.
Repro/verify: `scratch/entry-scales.ts` (drives the early route, logs each entry rest
state). REMAINING divergence at the cliff entry (room 38): its `loadRoomWithEgo` carries
an explicit walk (244,106); our walker's final leg (233,115)→(244,106), dx=+11/dy=−9,
sets facing E by the raw-pixel-dominance rule, while the original rests N — consistent
with facing weighted by movement FACTORS (slow vertical speed makes that leg N-dominant
in time). That's the walk-facing rule, affects all walks — needs its own validation
pass against the original before touching (tracked in Tier-2).

**Pending in-browser checks** (fixes shipped + folded into docs, look not yet confirmed):

- The fixed intro entry — room 38 used to flash ego top-right at full scale before the
  entry walk rescaled him; `enterRoom` now resolves box + scale on room load (ego at
  scale 215, box 5 from the first frame; headless repro: `scratch/lookout-entry-scale.ts`).

### Open bug-report saves (reported, not yet fixed)

- (none. Dev save at the forest fork: `saves/MI1-forest-fork.websave.json`,
  gitignored, regenerated by `scratch/forest-fork-save.ts`.)

### Tier-2 divergence checklist

Silent, self-flagged approximations. Hand-curated — comment phrasing drifts, so
no grep refreshes this list; the heuristic sweep for NEW flags is
`git grep -niE "best-effort|for now|not yet|no [a-z]+ yet|approximat" -- src/ ':!*test*'`
(checked 2026-06-10: every hit is tracked here or is a platform-side best-effort
catch in `savegames.ts`). Tiering: **Tier 1** = loud (halts on unknown opcode — fine). **Tier 2**
= these (silent until a script ordering makes them observable, like the EXCD bug).
**Tier 3** = unknown unknowns (only ScummVM differential tracing finds them).

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
  (`graphics/composite.ts` `compositeActor`). MITIGATED 2026-06-12, root gap
  still open. User-reported from the intro cliff-path cutscene (room 38, ego
  walks scale 215→252 then talks at 241): with the old centered (0.5)
  sampling phase Guybrush drew EYELESS on 1920 of the scene's 2244 face-ticks
  — including the entire lookout dialogue, where the talking face is an 11-px
  overlay limb whose eye row dropped. Shipped mitigation: sampling phases
  empirically tuned per axis (`PHASE_Y = 11/16`, `PHASE_X = 3/8`) via a 16×16
  grid (full limb-stack blits — frame-level analysis lies, the talk overlay
  redraws the face) under two hard constraints: every cutscene draw keeps an
  eye AND the room-33 dock resting pose (standing, fixed box scale 0xd2=210)
  keeps its eye both mirror senses (the first pick, PHASE_X=13/16, fixed the
  cutscene but blinded the dock); ranked by misses over the 39 distinct
  scales harvested from every room's boxes + scale slots. Probes:
  `scratch/lookout-eyes-fine2/3.ts` (sweeps), `lookout-eyes-series.ts`
  (per-setting strips), `lookout-town-scale.ts` (dock verify + box dump),
  `sbs-measure.ts` (screenshot measurer). Tuned on Guybrush's costume only.
  KNOWN RESIDUAL (user side-by-side vs ScummVM, 2026-06-12, room 33 dock):
  heights match exactly (both 39 rows — scale resolution is right) but the
  original reads visibly fuller from the same 14×39 budget (shirt one column
  wider, socks/buckles intact; head: face-front flesh right of the eye +
  fuller hair) because it drops DIFFERENT columns — "ego too thin".
  **FIRST ORACLE SAMPLE EXTRACTED (2026-06-12)** — method + data for the
  pattern recovery: `scratch/svm-pattern-extract.ts` aligns the screenshot
  sprite's per-column class signatures (hair/flesh/white, loose RGB
  classifier that survives color management) against the decoded source
  frame's via monotone DP → which source cols/rows the original kept. Dock
  standing-E, 17×47 → 14×39 at scale 0xd2=210: ORIGINAL dropped cols
  [0,1,13] (two near-empty left-margin cols — degenerate among 0..4, "two
  drops in the margin" is the robust claim — plus the dark-shade col beside
  the eye; cost 0.12/col, solid) vs OURS [3,9,14] (mid-head + face-front =
  the visible damage). ORIGINAL dropped rows [1,6,20,21,26,42,44,46]
  (noisier, cost 3.7; head rows {1,6} vs ours {1,7} is the usable part).
  Structural conclusion: the original's drops BUNCH in low-content margins —
  no evenly-spaced phase decimation can reproduce that — consistent with a
  fixed per-scale bit pattern, derivable from more oracle screenshots at
  other scales/poses (observed original behaviour — NOT ScummVM source).
  Same art + same 14×39 budget confirmed by the clean alignment: the
  divergence is 100% the drop pattern.
  **BATCH EXTRACTION + FIRST HYPOTHESIS FITS (2026-06-12 evening)** —
  `scratch/pattern-batch.ts` industrialises the extraction over the
  `scratch/screens/` side-by-side set: registers the reference half onto our
  bg render (5×6 px/game-px grid; two-stage camera search — the reference's
  camera can rest ~26px from ours, see 33-frombar), diff-masks ego
  (costume-color gated, flood from a feet seed, per-facing trim), quantizes
  cells in costume-color space, then histogram-seeded + 2D-refined monotone
  DP per axis; facing picked by grid agreement (also re-confirms entry
  facings). Controls pass: 35-street @255 = 24×47 zero drops; 28-bar rows
  perfect (its missing cols = real door occlusion). Solid samples (≈70%
  cell agreement): intro E@~213 rows {6,7,13,19,22,31,39} cols {2,15,18};
  frombar S@~212 rows {3,7,8,13,19,22,31,39}; cliff N@~250 rows {39};
  jail W@~220 rows {14,15,18,22,31,38,39} cols {16}. Tiny scales (75/81)
  still extract garbage — out of scope for now. FINDINGS: (1) drop counts
  track (256−s)/256 per axis — threshold-table model; (2) intro vs frombar
  (equal scale, different room positions/poses) share 6/7 row drops →
  pattern is deterministic per (scale, source index), not position/content
  dependent; (3) cliff's single drop nests in the 210-sets → monotone
  per-index thresholds; (4) **bitrev8 table REFUTED** (`scratch/
  pattern-fit.ts`): all solid samples have ADJACENT drops ({6,7},{7,8},
  {14,15}), impossible for bit-reversal where neighbours differ by 128;
  (5) jail's set resists every single-anchor model tried (0/top/feet/
  screen-y) — suspicion: per-LIMB pattern windows (stands are multi-limb
  stacks; drops near the limb boundary ~row 36 behave like a separate
  window: legs-local {2,3}@220 ⊃ {3}@250 IS monotone), compounded by ±10
  scale uncertainty per sample. ALSO: the original's resting scales/budgets
  run slightly larger than ours at the same spots (cliff drawn 20×46 vs our
  19×44; jail s-implied ~220 vs our 207) — entry-position or slot-rounding
  difference, investigate alongside.
  **BITREV8 SCALE-TABLE EXPERIMENT (user-proposed, 2026-06-12 late)** —
  `scratch/table-scaler-fit.ts`: per-LIMB table-driven scaler (keep i iff
  `t[(seed+i)&255] < s`, t = bit-reversed counter table), seed-rule family
  {0, 128, (256−n)/2, 128−n/2, n, screenPos} × s search, scored against the
  oracle drop sets on the same DP lens, vs the current phase renderer as
  baseline. KEY REVELATION from the stack dumps: the stand poses are
  head-limb (11×11) + body-limb stacks whose independently-rounded scaled
  placements create SEAM artifacts — that's where the oracle's "adjacent
  drops" live, so the earlier stack-level bitrev refutation only refutes
  single-window stride-1, not per-limb windows. RESULTS: cherry-picking the
  best seed per sample the table wins 4/5 (total err 42 vs phases 50), but
  any SINGLE seed rule totals 50–56 ≈ phases' 50 — underdetermined, not
  shipped. Eye check: seed rule `128 − n/2` keeps eyes at every spot that
  matters (dock 210, dialogue 241, jail 207); seeds 0/128/pos re-blind the
  dock. CONCLUSION: the table family is plausible (the seed likely depends
  on something unmodeled — per-limb screen pos, counter continuation across
  limbs, or scaled-size-derived) but current oracle data (limb seams + ±10
  scale uncertainty) cannot discriminate.
  **LOCKED-SCALE LADDER + SEEDED TABLE BUILD, THEN REVERTED (2026-06-13)** —
  the user supplied room-38 screenshots paired with debugger-read scale
  values (`scratch/screens/scale-*.png`, `scratch/ladder-fit.ts`): at locked
  scales the table beat the phases on every shot (seed-0 totals 38 vs 50).
  Constrained full 0..255 seed sweep (hard constraints: head-limb eye pixels
  — row 5, cols 3/4/6/7 both mirror senses — plus cutscene walk-frame eye
  cols): SEED_Y=11 beat seed 0 on rows (err 22) AND keeps eye rows down to
  scale 9; SEED_X=29 ties the unconstrained col best. PROVEN: no constant
  column seed can keep every eye column — the original's column rule must
  vary per limb/position. The seeded build shipped for eyeballing, looked
  better in many places, kept all tracked eyes (incl. room-33 rest, verified
  per-limb — NB an earlier dock "verification" passed on the MOUTH's 0xf0:
  scan eye regions per limb, not bounding-box thirds), BUT count-based drawn
  sizes fluctuate ±1 across walk frames → ego visibly "struts" while
  walking (round() is smooth across frames; the original doesn't strut →
  another constraint: the real algorithm's per-frame sizes must be stable
  while walking). User verdict: reverted to the tuned phases
  (PHASE_Y=11/16, PHASE_X=3/8). The table family + all sweep results stay
  the research track; next discriminating data = DOSBox captures, or
  same-pose screenshots at MANY scales with debugger values, or modeling
  per-limb/position-varying seeds with frame-size stability as a constraint.
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
