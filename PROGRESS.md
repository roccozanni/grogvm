# GrogVM — Progress

Lean tracker. Two buckets:

- **Current** — what's in flight and what's open right now; also the **lab
  notebook**: capture each finding as it happens, trim it only once it's
  written into the right `pages/docs/` file. The full pipeline:
  [KNOWLEDGE](pages/docs/agent/knowledge.md).
- **Next** — the work ahead, as one-liners. Broken into tasks only when we start.

---

## Process — how we work

**Working principle (agreed 2026-06-02):** engine-faithful, no hacks/shortcuts —
confirm the real mechanism first (**never consult ScummVM source, in any form**),
verify the actual outcome not the bookkeeping, surface every
deferral/approximation in this tracker, never bury one. The full contract:
[COLLABORATION](pages/docs/agent/collaboration.md) +
[VERIFICATION](pages/docs/agent/verification.md).

**Regression net — after any engine change, run `npm run test:integration`
(~2.5s).** The MI1 from-boot walkthrough (`integration/mi1/walkthrough.test.ts`)
drives the game start-to-credits; a green run is the regression check. If it
fails, re-run with `npm run test:integration:save`: the same playthrough, but it
writes a savepoint at every beat for fast replay / targeted debugging of the
failing beat. Per-game room ids + mechanics live in `game.ts`
(`ROOMS`/`VERBS`/`VARS`); suite design → [HARNESS §6](pages/docs/engine/harness.md)
+ [CLAUDE.md "The harness"](CLAUDE.md).

---

## Current — MI1 complete; polish + open items

**MI1 PLAYS FROM BOOT TO THE CREDITS — Parts I–IV are all FINISHED** (committed
on `main`). **Unit suite green + tsc clean**, plus a data-required, from-boot
integration playthrough that drives MI1 start-to-credits. What's left is polish
(in-browser look passes + the open bugs below) and the next game — see **Next**.

**The overhead map (rooms 2–6) is WALKABLE** (ego a small figure, costume 3 walking / costume 4 the
boat), not a node hub: edge connectors cross screens (global #34); locations are entered by walking
onto their marker.

### Open in-browser visual glitches

In-browser visual glitches: real-pixel issues, so the headless net (which draws
nothing) doesn't catch them; none block play. Only the Part III off-map ego is
still open (pending a repro). Recently-fixed glitches are trimmed from here once
their finding is written into the docs; git keeps the closure records.

- **Part III, Monkey Island multi-room map: ego positioned off-map.** While
  navigating the big multi-room island map, ego is sometimes positioned off the
  map and then takes a while to walk back on-screen. Same family as the (fixed)
  Part I off-map pirate-spawn: actor placement on a multi-room / overhead map.
  *Investigated 2026-06-17:* the screen-to-screen crossing is global #34, which
  `putActor`s ego at a RELATIVE offset (currentX+dx, currentY+dy) into the next
  screen — so an edge hit at an awkward y can land off-box. The `putActor` clamp
  (the stair/pirate fix) now snaps that landing onto the nearest box, so it
  should at least be on-map. But the specific intermittent "off-screen, walks
  back" case did NOT reproduce on the seeded walkthrough path (every crossing
  there already landed on-box; the clamp was a no-op). LEFT OPEN pending a repro
  trigger — likely a crossing where ego hits the edge far from the dest screen's
  path, where even the clamped nearest box sits away from the camera. Next:
  capture an in-browser save mid-symptom, or sweep crossing entry-y values to
  find an off-box landing.

### Open bug-report saves (reported, not yet fixed)

- (none. Dev save at the forest fork: `saves/MI1-forest-fork.websave.json`,
  gitignored.)

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
  reverted 2026-06-13). **Structural findings** from comparing the original's
  shrunk sprites against ours: drop counts track (256−s)/256 per axis, and the pattern is
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
  original, E in ours). Likely rule: facing
  from deltaX/deltaY FACTORS (speed-weighted), so the slow vertical axis
  dominates legs it spends more time on. Affects every walk's rest facing;
  validate against the original on several walks before changing — the
  current lookahead rule was itself tuned against observed walks.
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~114`,
  the stored SO_CLIPPED bound).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
- [ ] **L — head-talk (room 86) dialog-option text renders the wrong colour**
  (reported in-browser 2026-06-14, visual only — mechanics fine). The navigator-head
  conversation close-up now renders its options (the 200-tall close-up verb-paint fix,
  this session: `paintVerbBand` draws verbs over a full-height room). But the option
  lines paint dark red/magenta instead of a readable colour — the hovered/armed line
  correctly highlights yellow (hicolor 14), so the base colour (verbOps `color=2`) is
  mis-mapped through room 86's CLUT. Same family as the room-36 disclaimer colour gap;
  needs a charset/CLUT-colour pass + in-browser pixel iteration. Does NOT block the beg
  (the conversation is fully drivable).
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
- [ ] **L — restored music slot is a heuristic** (`sound/backend.ts:153`): on
  save restore, the looping active sound is assumed to be the music slot.
  (The related output gap — a restored save stayed inaudible until the game
  next started a sound — is FIXED 2026-06-16: `AudioBackend.restore` now takes
  a rendition resolver and the Web Audio backend rebuilds its voices on load,
  looping music from the top and one-shots from their saved offset. See
  [audio.md](pages/docs/engine/audio.md).)
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
(CLAUDE.md).

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

## Next

MI1 now plays start-to-credits from boot, so the "keep playing MI1" track is
DONE — what's left is polish and the next game. We no longer track by phase
number; the numbered-phase roadmap (and each finished task's closure record) is
history — git keeps it.

- **MI1 in-browser finale pass** — the headless net proves Part IV *plays*, never
  that it *renders* (it draws zero pixels). Eyeball the finale in the browser
  from the beat saves (`npm run test:integration:save`): the ghost-spray
  animation, the church/wedding, the "POW"/"BIFF" punch montage (global #133,
  room 85) and its camera framing, and the LeChuck-explosion credits. Fold any
  visual gap into the Tier-2 / rendering lists above.
- **Audio: OPL2 synthesis** for the 15 ADL-only effects (first cut shipped
  above — SBL + CD play; an AudioWorklet OPL2 + the ADL MIDI event stream).
- **MI2** — full support for the v5-but-slightly-different edge cases. Sanity
  so far (2026-06-09): boots and runs 3000+ ticks with no halt; its 199 SOUN
  blocks are all `SOU ` containers (no CD triggers) and parse cleanly via the
  SBL/MIDI path. Known unimplemented one: MI2 `COST` payloads need their
  first 2 bytes skipped before parsing (every payload-relative offset is 2
  bytes too small otherwise) — the costume decoder doesn't yet apply this
  shift.
