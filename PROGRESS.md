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
end-to-end from boot — through the three trials, the idol theft, the docks vow,
recruiting the crew (Otis, Carla, Meathook), buying the Sea Monkey from Stan,
and boarding: Part II opens aboard the ship** (see Frontier below).

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
clean state — currently aboard the Sea Monkey in the captain's cabin (room 7), crew + ship
secured, Part II just begun.

**Frontier: Part I is FINISHED and Part II has begun — the crew is recruited (Otis bit#76,
Carla bit#89, Meathook bit#88), the Sea Monkey bought (bit#51), and the boarding/departure plays
through to the captain's cabin (room 7), playable, all from boot.** The clean fast-forward save now
sits aboard the Sea Monkey. The crew/ship arc added 2026-06-10: grog mugs → Otis's lock-melt, the
Carla and Meathook recruits (Hook Isle zipline both ways), Stan's credit referral, the store
credit-interview + Sword-Master errand + safe-crack (the 4-digit combination lives in g221..g224 —
random per game, the beats read it from the vars), the walk-away/offer-ladder haggle to 5000, and
the dock boarding. Routes + mechanics live in the walkthrough beats and `game.ts`
(`crackSafe`/`buySeaMonkey`/`townToMap` helpers), not here.

> **NEXT SESSION — Part II proper (The Journey).** Aboard the Sea Monkey: the cabin (room 7), the
> hold/galley below decks, the voyage to Monkey Island (the navigation recipe). Restore the frontier
> save to start in the cabin; same loop — disassemble first, drive headless, assert mechanics.

**Lab notes 2026-06-10 (crew & ship session) — engine fixes shipped with unit tests:**
- **VAR_CAMERA_POS_X (g2) was never written.** Scripts poll it constantly (escape-watchers,
  walk-past-camera gates — Meathook's payoff #205 loops on `meathookX < g2 − 175`). Fixed:
  `moveCameraTo` mirrors every camera move into g2.
- **Camera-follow destination was the dead-zone edge, not the actor.** SCUMM v5's follow pans TO the
  actor's (clamped) x at 8 px/frame once it leaves the ±80 band, latched until it lands — Stan's #56
  waits for `g2 == 160` exactly with ego at x=94 (clamp floor). Fixed: `moveCameraFollow` arms
  `cameraDest` (so `wait forCamera` covers follow-pans too) and the pan stepper does the moving.
- **Stale ENCD/EXCD slices survived room changes.** A yielded previous-room ENCD resumed against the
  NEW room's locals (room 19's ENCD starting its #205 after the Part-II intro moved on to room 7 →
  halt). Fixed: `stopRoomLocalScripts` also kills `ENCD-`/`EXCD-` labelled slots — SCUMM's startScene
  kills everything room-scoped.
- **VAR_ENTRY/EXIT_SCRIPT hooks were never run.** MI1 boots #5/#6/#7 into g28/g29/g30; SCUMM brackets
  every room change with them (exit → EXCD → exit2, entry → ENCD → entry2). #7 records the
  left-room in g101 — entry scripts branch on it (Hook Isle's side-touchability, the Voodoo Lady's
  entrance choreography which now correctly closes the door behind you). Wired into `enterRoom`
  (`runHookScript`); #6 also re-runs the verb-bar scripts and clears pending sentences per entry.
- ~~**Open question (in-browser check):** the safe handle (#390) doesn't hover-resolve~~ —
  resolved 2026-06-11; see the *object hit-test was draw-ordered* lab note below.

**Lab note 2026-06-11 — stale inventory panel on owner changes (user-reported in-browser,
root-caused; fix awaiting in-browser confirmation).** The panel re-lays only when the inventory
script `#9` runs. `pickupObject` ran it (arg 1, snap to the end so the new item shows) but
`setOwnerOf` — the path every script-driven consumption takes (the pour `#69`, the mug
wad-ification `#68`, the troll taking the fish, Otis eating the mint) — never did, so a removed
item lingered in the visible slots until an arrow click chained `#9`. Not purely visual: the
slot→object table (`g133+`) is what a slot click commits through, so a stale slot clicks the
no-longer-owned object. Concrete fingerprint: the pre-fix frontier save carried `g118=3` (past
clamp) with the destroyed mugs 365/366 still in `g133`. Fixed: `setOwnerOf` runs the inventory
script with arg 0 — keep the current page, `#9` clamps — mirroring `pickupObject`'s arg-1 snap;
unit test + full walkthrough green, and the regenerated frontier save's table now matches the
live inventory exactly.

**Lab note 2026-06-11 — object hit-test was draw-ordered; SCUMM's is source-ordered with a
parent chain (user's in-browser overlay spotted it; fix awaiting in-browser confirmation).**
The Phase-7 `findObject` preferred drawn objects topmost-first, so the drawn safe (#389)
permanently shadowed the un-drawn handle (#390) nested inside its box — the safe-crack
`pushSentence` debt. The room data says otherwise: the handle is declared *before* the safe, with
CDHD `parent=2` — a **1-based source-order index** pointing at the safe — and flags bit 0x80 is
the **required parent state** (set → parent non-0/"open", clear → parent 0/"closed"). Corpus: 27
parent-gated objects across MI1, children always declared before containers, the r29/r37
nameless zone-parents DOBJ-untouchable so they can't swallow their children's hovers. The old
code also read flags 0x80 as "untouchable" — which would have made the Sea Monkey cabin's
"il baule" (flags 0x80, chained to "l'armadio") permanently dead in Part II. Fixed: `findObject`
scans source order first-hit-wins, draw-agnostic, gated by class-32 untouchability and the
recursive parent chain (OBJECTS §2/§7a). `crackSafe` now Push/Pulls the handle with real clicks —
**zero `pushSentence` left in the suite**. Unit witnesses + full walkthrough green; the
`saves/MI1-safe-crack.websave.json` dev save (gitignored) sits at the cracking window for the
in-browser hover check.

**Testkit debt — `pushSentence` shortcuts: retired 2026-06-11 (none left).** The walkthrough's
inventory gestures are now faithful clicks: the testkit resolves a carried target as a slot click in
the panel's *visible window*, scrolling with the arrow verbs first (INPUT §8 — `g118` row offset,
`g133..g140` slot table, arrows 208/209 chain `#9`). That one mechanism covered every flagged site —
the two-inventory combine (petal+meat, mug pours), the one-object verb on a carried item (cake open),
and the over-window slots (grog fill/lock-melt, chicken ziplines). The "give onto an actor-object
can't be clicked" finding of 2026-06-09 was **phantom**: the verification itself computed slot ids
past the visible window (the 9th item's "slot" is the scroll arrow — `verb:208/211` garbage), so the
give never armed object A. With correct slots, the hover poller resolves both the dogs (#467) and the
prisoner (#405) into object B per its class-5 give gate (INPUT §2, verb-aware filtering), and `useWith(give, item, objId)`
drives those gives for real. Pour-race note: the gesture must fit the mug's dying window (`#68`'s
hard `delay 300` before wad-ification), which is why the slot click consults the visible table
instead of blind-scrolling from the top. The last holdout — the safe-handle moves — fell with the
hit-test fix (the lab note above).

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
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~114`,
  the stored SO_CLIPPED bound).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
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
- Already tracked elsewhere (cross-ref, not duplicated here): line-following
  walker (Pathfinding backlog), `screenEffect` animation + `VAR_CURRENT_LIGHTS`
  darkening (Rendering backlog), `saveRestoreVerbs` subset (Watch-for), audio /
  `resourceRoutines` (Out of scope).

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

**Input / UI**

- (inventory scrolling + the slot-click gestures landed 2026-06-11 — the
  walkthrough's grog race exercises the arrows with a 13-item inventory; the
  safe handle followed via the source-order/parent-chain hit-test fix, so no
  `pushSentence` shortcut remains anywhere in the suite.)

**Rendering**

- **Testkit screenshots are room-scene only** — `testkit/screenshot.ts` /
  mugshot still compose via `composeFrame`; adopting `composeScreen` would
  make debug PNGs show dialog + verbs. Natural follow-up, take it when a
  probe needs text pixels in a PNG.
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

**Pathfinding**

- **Line-following walker (`calcMovementFactor`) — the faithful follow-up,
  deferred.** `stepWalk` steps X/Y independently; SCUMM moves along the line.
  Without this, thin diagonal connector boxes are fragile (actor drifts off) —
  the room-52 single-click bridge crossing is the live symptom (staged in the
  walkthrough). Touches every walk + the stepWalk unit tests (which encode the
  current independent-step behaviour) → re-verify intro/bar/kitchen + render.
  [PATHFINDING §9](pages/docs/engine/pathfinding.md). *(The walk-box-as-state
  half — tracking `_walkbox` instead of re-deriving it at draw time — is DONE.)*

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

- **Audio timing — DONE (2026-06-09).** `AudioBackend` seam +
  `SilentTimingBackend`; sound durations from the real resources (SBL VOC
  time-constant, MIDI tempo×ticks, CD-track audio headers read partially at
  load). Writeups: [engine/audio.md](pages/docs/engine/audio.md) +
  [scumm/sound.md](pages/docs/scumm/sound.md). Actual audio **OUTPUT**
  (`WebAudioBackend`) is its own later phase behind the same interface (see
  Next).
- **Resource-heap management** — `resourceRoutines` stay no-ops (resources load
  lazily; there's no managed heap to model).

---

## Next

Three items ahead, one of which — keep playing MI1 — is the Current section
above. We no longer track by phase number; the numbered-phase roadmap (and
each finished task's closure record) is history — git keeps it.

- **Audio OUTPUT** (`WebAudioBackend`) — actual synthesis (AdLib/MT-32 MIDI,
  SBL samples, CD redbook) behind the existing `AudioBackend` seam.
- **MI2** — full support for the v5-but-slightly-different edge cases. Sanity
  so far (2026-06-09): boots and runs 3000+ ticks with no halt; its 199 SOUN
  blocks are all `SOU ` containers (no CD triggers) and parse cleanly via the
  SBL/MIDI path. Known unimplemented one: MI2 `COST` payloads need their
  first 2 bytes skipped before parsing (every payload-relative offset is 2
  bytes too small otherwise) — the costume decoder doesn't yet apply this
  shift.
