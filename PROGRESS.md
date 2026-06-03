# GrogVM — Progress

Lean tracker. Three buckets:

- **Current** — what's in flight and what's open right now. This is also the
  **lab notebook**: capture each concrete finding as it happens — root causes,
  exact opcode numbers, semantics, the *why* — because this is the source
  material the end-of-phase doc update is written from. Don't reconstruct doc
  prose from memory later; that's how bad claims get in. A finding stays here
  until it has been written into the right `docs/` file — only then trim it.
- **Next phases** — one-liners. Broken into tasks only when we start them.
- **Done** — one or two lines per concluded phase. The durable knowledge lives
  in `docs/` and the code; git has the blow-by-blow. When a phase concludes,
  first migrate its findings from Current into the right `docs/` file, *then*
  shrink the entry here to a line or two.

---

## Current — natural play through MI1

Playing MI1 from the start and fixing each blocker as it's hit (engine-faithful,
committed on `main`). **815 tests green, tsc clean.** The intro → room 33 →
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

### Open bug-report saves (reported, not yet fixed)

- **Map labels not cleared** *(save `bug-map-labels`)* — on the map screen,
  hovering a place shows a name label, but hovering OUT never clears it;
  hovering the same place repeatedly stacks several identical labels on screen.
  Lead: the hover-label draw isn't erased/redrawn on hover-exit (no clear of the
  previous label rect, or it's drawn additively each hover without dedup) —
  investigate the map-room hover/label render path. Verify across hover-in /
  hover-out by rendering actual frames, not label bookkeeping.
**Last worked on — Give-Pot crash (2026-06-03, cont.).** Fixed engine-faithfully
and **migrated to docs**. Also confirms the **verb-4 "Dai X a <actor>"** path
end-to-end (the documented next milestone — was untested for lack of a second
actor in scene):

- **Give Pot crash** *(save `bug-cant-give-pot`, room 51)* — `startScript 0` was
  resolved as a global and halted (`Cannot load global script #0: unused entry
  (room = 0)`). With "Dai" armed + pot held, the hover poller `#23`, when over
  an **actor** (id < 12), runs a per-actor handler via the indexed table
  `g396[actorId]` (= `VAR(396 + actorId)`); a pirate with no give-script has `0`
  there → `startScript 0`. Index slot 0 is an unused DSCR entry (room 0), so
  resolving it as a global would halt — but the game issues `startScript 0` on an
  ordinary hover, so id 0 must be a **silent no-op**. `startScriptById` now
  returns `null` for id ≤ 0; the `startScript`/`chainScript` handlers skip the
  nested run. Verified: hover no longer halts, and committing the give yields the
  real gag — *"Ah, quello sarà perfetto come elmetto!"* (`scratch/repro-give-pot.ts`).
  [OPCODES §6](docs/SCUMM-V5-OPCODES.md). Guards: two `index.test.ts` no-op cases.

- **Fettucini cannon money not awarded** *(same room 51 scene, follow-on)* — after
  the give → cannon-launch → close-up dialog, the act pays "478 pezzi da otto",
  but no money arrived and obj 488 (the money inventory icon) never reached the
  inventory. Cause: the **`startObject` opcode's args were prepended with
  `[verb, obj]`** before becoming the verb body's locals. The game's bytecode
  (`scratch/dis.ts`) shows args map straight onto `L0, L1, …`: sentence `#2` runs
  verbs as `startObject obj script [secondObj, verb]`, and obj 488 verb-250 (the
  money routine) does `g195 += L0` (`g195` = pieces of eight) then
  `setOwnerOf(488, ego)`. With the prepend, `startObject 488 250 [478]` gave
  `L0 = 250`, so it added the wrong amount and never re-owned 488. Fixed
  `startVerbScript` to pass args directly. Verified: invoking the routine from
  the save now sets owner→ego, name→"pezzi da otto", and adds 488 to inventory
  (g195 −238 → +478 → 240, correct for that save). [OPCODES §6](docs/SCUMM-V5-OPCODES.md).
  **User-confirmed in-browser** (full give → cannon → close-up-dialog → money flow).

- **Room 51 (circus tent) compositing — three issues.** (1) **Left Fettucini
  brother behind the haystack** — `actorOps init` (SO_DEFAULT) didn't reset
  `forceClip`; the brothers, init'd with no zclip op, inherited `forceClip=1`
  from a prior slot user and drew behind ZP01's haystack crate. Init now clears
  it. Verified by render (`scratch/crop51.ts`); committed `f26816f`.
  [ZPLANE §forceClip](docs/SCUMM-V5-ZPLANE.md). (2) **Guybrush vanishes when shot
  from the cannon** — the flight actor (11, costume 40) is `ignoreBoxes;
  neverZclip`; airborne at y≈48 our `findBoxAtOrNearest` snapped it to box 7
  (mask 1) and the tent pole (ZP01) masked it. `resolveClipPlane` now sends an
  `ignoreBoxes` actor to the front (off the box grid → retained init box, mask 0);
  `alwaysZclip` still wins. This is the exact case the ZPLANE "faithfulness caveat"
  predicted. Deterministic compositor test added. (3) **Talk text off the right
  edge** — `print a=3 at 240,64 "--penseremo…"` is actor talk with explicit `at`;
  the renderer left-aligned it and (unlike the no-`at` talk path) didn't clamp, so
  it overran the viewport. `paintDialog` now clamps left-aligned talk to the
  viewport too. *(text **user-confirmed**; cannon z-clip user-confirmed visible.)*
  (4) **Cannon-flight Guybrush rendered as a dot** *(save `bug-guybrush-scale`)* —
  with the z-clip fixed he was visible but tiny. The flight actor (11) is
  `ignoreBoxes; scale 255,255`, but `rescaleActorForPosition` recomputed scale
  from the box `SCAL` slot by y on every placement, ignoring `ignoreBoxes`: at the
  arc peak (y≈36) the slot interpolates to **1** (a dot). An off-grid actor is now
  exempt from box scaling (early-return on `ignoreBoxes`), keeping its script-set
  scale. Confirmed via `scratch/probe-scale.ts` (flight y→scale: 36→1, 105→108).
  Regression test added. [WALK-BOXES §6](docs/SCUMM-V5-WALK-BOXES.md).
  **Awaits in-browser confirmation.**

**Earlier — two more bug-report saves (2026-06-03, cont.).** Both fixed
engine-faithfully and **migrated to docs**:

- **`setObjectName` ($54/$D4)** implemented — examining the chicken halted on the
  unregistered opcode (commit `35d5a7d`). [OBJECTS §5](docs/SCUMM-V5-OBJECTS.md).
- **Actor scale recomputed at placement**, not only while walking — a standing ego
  rendered full-size for one frame after a room change (commit `7c2ab70`).
  [WALK-BOXES §6](docs/SCUMM-V5-WALK-BOXES.md).

**Earlier same day — three bug-report saves (2026-06-03).** All fixed engine-
faithfully, each verified against actual behaviour (rendered pixels / driven
flow / ScummVM debugger). Root causes:

- **Room 78 "can't exit"** — three layered causes, all needed: (1) CDHD
  `walkX/walkY` were read **unsigned**, so the left exit's walk-to x=−25 became
  65511 and the ego marched off-screen (`object/loader.ts`, now `i16`);
  (2) the off-screen-but-in-box walk point was unreachable on the rasterized
  `[0,width)` mask, so the ego stopped 25px short of the 16px proximity gate —
  `startWalk` now extends the path's final segment to a target inside a visible
  box (`actor/walk.ts`); (3) **the actual opener:** `getVerbEntryPoint` only
  matched the exact verb, missing SCUMM's **verb 0xFF default fallback**. The
  exit carries verb 0xFF (loadRoom); clicking commits walk-to verb 11; sentence
  #2 does `getVerbEntryPoint(exit,11)` and must read truthy (via 0xFF) to take
  the run-the-verb branch → `startObject(exit,11)` → 0xFF fallback → loadRoom.
  Cracked via the user's ScummVM debugger (`g107=11` in both engines, #2 at the
  has-verb offset) — pure verb-selection ruled out, divergence was in #2's
  `getVerbEntryPoint` branch. *(SCUMM `getVerbEntrypoint` matches `entry ||
  0xFF`.)*
- **Room 30 compositing (Guybrush behind stairs)** — z-plane masking was
  cumulative ("any plane > actorZ"); SCUMM masks an actor by the **single plane
  at its clip level**. The two models agree only when planes nest ZP01⊇ZP02 (or
  ZP02 empty); room 30 has ZP02⊇ZP01 (ZP01=barrels, ZP02 adds the railing), so a
  floor actor (clip 1) was masked by ZP02 and drawn behind the stairs. Now
  single-plane (`graphics/composite.ts`, `render/compositor.ts`, doc updated).
- **Voodoo-lady room (29) black rectangle** — `getActorWalkBox` was a stub
  returning 0, so room 29's reveal script #200 looped `while (box < 5)` forever
  and never cleared the black entry-cover object (383). Now returns the real
  box id. *(Initial right-edge-strip theory was a red herring; the screenshot
  showed the cover was a centre object.)*

**Earlier — hang watchdog + Tier-2 divergence sweep** *(2026-06-02;
commit `20420a0`)*. The dialog-stuck bug was a *silent divergence from SCUMM*
(deferred room scripts), which is why it took hours to find. Two outcomes:

- **Hang watchdog** (`Vm.enableHangWatchdog`, opt-in; wired into the always-on
  debug panel). Fires when N consecutive clicks each produce **no progress** —
  no room change, no talk, no committed sentence, no walk. Fingerprints
  *progress-only* signals (monotonic `talkSeq`/`sentenceSeq` + room + walk
  targets), NOT the live-script set (a click always transiently spawns the
  verb-redraw #12) nor raw vars (music timer churns). Surfaces a console warning
  + panel banner naming the room + `VAR_VERB_SCRIPT`. Catches the *symptom* of
  any input-misroute / wait-on-a-var-that-never-changes hang, Tier-2 or Tier-3.
- **Tier-2 checklist** below — the self-flagged approximations harvested by
  grepping `for now|doesn't yet|best-effort|we don't yet|Math.random` etc.
  Work through it; each addressed item should either become faithful + leave a
  characterization test, or be explicitly re-tracked.

### Tier-2 divergence checklist

Silent, self-flagged approximations (run `git grep -nE "for now|doesn't yet|best-effort|we don't yet"`
to refresh). Tiering: **Tier 1** = loud (halts on unknown opcode — fine). **Tier 2**
= these (silent until a script ordering makes them observable, like the EXCD bug).
**Tier 3** = unknown unknowns (only ScummVM differential tracing finds them).

Priority H/M/L = likelihood of biting current/near play × severity.

- [ ] **H — `getRandomNumber` uses `Math.random()`** (`opcodes/index.ts:~900`).
  SCUMM uses a seeded LCG so save/replay is deterministic; ours isn't, so a
  reloaded save can diverge (and it violates our own determinism rule). Faithful:
  port the v5 LCG, seed in boot, snapshot the seed in save state.
- [ ] **M — dialog/string escape codes deferred** (`opcodes/index.ts:~2044`):
  keep-text `0xFF02`, var-name `0xFF06`, sound `0xFF09`, actor-name `0xFF0A`,
  mid-string colour `0xFF0E`. Surfaces as blank/wrong text or missing inline
  colour in dialogue-heavy content. (Also noted in Stubbed opcodes below.)
- [ ] **M — actor/object names not stored** (`opcodes/index.ts:~1763`
  `actorOps setActorName`; `~1980` string-resource object name). Look-at /
  sentence line shows a blank or `obj #N` placeholder for renamed entities.
- [ ] **M — verify cutscene Escape end-to-end + fix stale comment**
  (`opcodes/index.ts:~827` says "we don't yet wire input → escape", but
  `play.ts` now binds Escape → `abortCutscene`). Confirm the override path
  actually fast-forwards a skippable cutscene; update/delete the stale note.
- [ ] **L/M — `print` `clipped` line-wrap bound not modelled** (`vm.ts:~485`).
  Long lines may overflow / mis-wrap vs the original's clip-X wrapping.
- [ ] **L — camera scroll "snap both for now"** (`opcodes/index.ts:~410`) +
  smooth `panCameraTo` (Open backlog). Gradual scroll over frames; no current
  scene validates it.
- [ ] **L — flashlight gfx not modelled** (`opcodes/index.ts:~576`, dark-room
  strip extent). Cosmetic; only the flashlight rooms.
- [ ] **? — `actorOps` subop treated as no-arg no-op "for now"**
  (`opcodes/index.ts:~1781`). Identify the subop; assess whether it affects
  behaviour or is genuinely inert.
- Already tracked elsewhere (cross-ref, not duplicated here): box-graph routing
  (Pathfinding backlog), `screenEffect` animation + `VAR_CURRENT_LIGHTS`
  darkening (Rendering backlog), `saveRestoreVerbs` subset (Watch-for), audio /
  `resourceRoutines` (Out of scope — Phase 11).

**Earlier — room EXCD/ENCD run nested (dialog-stuck fix)** *(2026-06-02; commits
`afb48a8`, `692a0fc`; user-confirmed in-browser)*. The LOOM-ad pirate close-up
(room 82) hung — dialog answers highlighted but clicking did nothing — because
the room's EXCD/ENCD ran *deferred* instead of nested, so room 28's EXCD
clobbered conversation script #93's `VAR_VERB_SCRIPT = 14` back to 4 and clicks
misrouted to #4 (arms a verb, never commits a dialog pick). `enterRoom` now
`runScriptNested`s both, matching SCUMM `startScene`. **Migrated to**
[ROOM §6](docs/SCUMM-V5-ROOM.md). Guards: MI1-smoke pirate-conversation
regression + `vm.test.ts` "runs ENCD/EXCD NESTED" cases. (The bug's quicksave
had `g32=4` baked in — repaired the save's global to 14.)

**Earlier same day — two-object verbs + faithful sentence line** *(2026-06-02;
commits up to `1a5fee9`; all user-confirmed in-browser)*. Input/verbs round —
all faithful, committed, and **migrated to docs** (detail lives there now):

- **Two-object "Usa X con Y" / "Dai X a Y"** works end-to-end: verb → object A →
  `g110` preposition arms → object B routes to `g109` → `doSentence(v,A,B)` → #2.
  Confirmed against a room-41 kitchen quicksave (Use) + the pirates (Give).
  [INPUT §5](docs/SCUMM-V5-INPUT.md).
- **Sentence line is verb #100**, rebuilt each frame from `0xFF NN` substitution
  codes (`0x05` verb / `0x06` name via `readVar`; `0x07` string by **direct** id;
  preposition `g110` is a verb named "con"; separator = string res 49 `" "`). Now
  **rendered directly** — retired the shell `sentenceText` synthesis (the deferred
  render "Option 2" step). [INPUT §6](docs/SCUMM-V5-INPUT.md) has the code table.
- **`stopScript 0` self-stops** *(general opcode fix; was a no-op)*. #4's
  `if (L1==100) stopScript 0` guard makes a sentence-line click inert; arg 0 stops
  the *current* script. Also `pickInk` highlights only on a non-zero hicolor (so
  #100 doesn't flash). [INPUT §3/§6](docs/SCUMM-V5-INPUT.md).
- **`pickupObject` = own + state-1 draw (eraser patch) + Untouchable + inventory
  refresh.** The Untouchable class is what kills the taken item's room hit-area;
  the state-1 image erases the SMAP-baked item. [OBJECTS §5/§7](docs/SCUMM-V5-OBJECTS.md).
- **Held items are reachable**: `getDist` resolves a held item to its holder's
  position (dist 0), not as a missing room object (→ "Non riesco ad arrivarci").
  [OBJECTS §7a](docs/SCUMM-V5-OBJECTS.md).
- **Inventory click-commit + hover-arming** confirmed end-to-end via #4/#23.

*Earlier (same day):* project renamed webscumm → GrogVM; game dir →
`games/MI1-IT-CD-DOS-VGA`; lowercase identifiers (`grogvm`) throughout.

**Tabled:** the room-28 cook is sliced by the table z-plane while walking — a
grid-A* vs box-graph **pathfinding route** divergence, not a clip/z-plane bug.
[PATHFINDING §8](docs/PATHFINDING.md) + backlog below.

**Next:** the inventory click-commit AND two-object "Usa X con Y" are both
confirmed (above), with the faithful #100 sentence line. Next live target is a
held item whose verb has a *visible* effect (a real use-with puzzle solution),
and exercising **Give X to <actor>** (verb 4, the other two-object verb — needs
a second actor in the room). Then continue the SCUMM Bar dialogs.

**Watch for** (recurring failure modes in newly-reached content):

- Unimplemented opcodes → an unknown-opcode halt freezes the *whole* VM.
- Object states beyond the initial `DOBJ` seed (only initial owner/state/class
  is parsed). See [OBJECTS §7a](docs/SCUMM-V5-OBJECTS.md).
- `saveRestoreVerbs`: we render-skip archived verbs (a subset of SCUMM's
  per-verb `saveid` model); revisit if a scene re-creates a saved verb id.
  See [INPUT §6](docs/SCUMM-V5-INPUT.md).

**Tooling:** `scratch/dis.ts` (+ `SCAN grep=`) is the disassembler CLI — keep it
in sync with the executing opcode table (AGENTS.md).

### Open backlog

Deferred out of earlier phases; none block current play. Detail in the linked docs.

**Input / UI**

- **Two-object "Use X with Y" end-to-end** — *done* (see Current); A+B commit +
  `g110` preposition + faithful #100 sentence line all confirmed. Remaining:
  **Give X to <actor>** (verb 4) — same machinery, untested for lack of a second
  actor in-scene. [INPUT §5](docs/SCUMM-V5-INPUT.md).
- **Inventory scroll arrows** (verbs 208/209) for >8 items — needs a full
  inventory to exercise.

**Rendering**

- **Unify the render surface (Option 2 — the faithful end-state for the UI).**
  Today the room is one canvas (engine compositor) and the verb/inventory bar is
  a second, shell-painted canvas; input was bridged by feeding screen coords
  (Option 1, done). The faithful design is one 320×200 surface — room slice
  (rows 0–143) + verb panel (144–199) — composited by the engine with 1:1 coords,
  and the sentence line as engine verb #100 assembled from `0xFF NN` substitution
  codes. Eliminates the coordinate seam entirely. Take it on when a *render-side*
  reason appears (verb #100 codes, mid-string dialogue colours `0x0E`, the
  copy-protection wheel) — not speculatively. Option 1 is a clean subset of it.
- **Compositor honours `VAR_CURRENT_LIGHTS`** — darken a night room via the
  lights flag, not only a dark palette (may be subtle; night rooms already ship
  dark palettes — check it's visible first). [LIGHTING §4](docs/SCUMM-V5-LIGHTING.md).
- **`screenEffect` transition animation** — state is modelled; the
  dissolve/scroll/instant *animation* is deferred (intro is all instant cuts).
  [SCREEN-EFFECT](docs/SCUMM-V5-SCREEN-EFFECT.md).
- **Smooth `panCameraTo`** — snaps today; no intro-reachable scene uses it, so
  the pan rate has no validation target. Wire it when a scene surfaces.

**Pathfinding**

- **Box-graph routing (vs our grid-A*-over-mask)** — the two pick different
  routes through the same geometry. Room 28's cook walks the bottom edge
  (y=140, a degenerate line box) and gets sliced by the table z-plane;
  ScummVM routes it higher where it clears the band. Clip + z-plane are
  faithful, only the route differs. Tabled. [PATHFINDING §8](docs/PATHFINDING.md).

**Stubbed opcodes (cosmetic / peripheral)**

- `roomOps`: `shakeOn`/`shakeOff`, `roomIntensity` / `setRGBRoomIntensity`,
  `saveString` / `loadString`.
- `cursorCommand` image subops (0x2C): `setCursorImage` / `setCursorHotspot` /
  `setCursor`.
- `matrixOp` (0x30): box connectivity flags / scale / create-box-matrix.
- Dialog escape codes still deferred: keep-text `0x02`, var-name `0x06`, sound
  `0x09`, actor name `0x0A`, mid-string colour `0x0E`.

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

## Next phases

One-liners; broken into tasks when we start them. See ARCHITECTURE.md §9.

- **Phase 11 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 12 — MI2 + polish.**

---

## Done

- **Phase 10 — Shell rebuild + EngineSession** *(2026-05-31)*. Rebuilt the shell
  around an `EngineSession` seam (engine owns the loop, clock injected →
  Node-testable) with a multi-page static build (`/`, `/explore`, `/play`); split
  the resource browser into a standalone Explorer and rebuilt the Player as a
  camera-driven canvas + always-on Debug panel; deleted both shell god-objects.
  See [ENGINE-SESSION](docs/ENGINE-SESSION.md) + ARCHITECTURE.md §4/§7.
  Engine composition + natural-play fixes landed alongside (sessions 8–11, all
  engine-faithful, user-confirmed): actor + box/`SCAL` scaling, ego box-mask
  z-occlusion, camera-follow ordering, and the SCUMM-Bar / pirate-dialog blocker
  fixes (chainScript, drawObject subop/state/eviction, room-change script stop,
  pseudo-room fallback, archived-verb render skip, DOBJ seeding + Untouchable
  class). Semantics in OPCODES / OBJECTS / ROOM / ZPLANE / CUTSCENES / INPUT.

- **Phase 9 — Save states** *(2026-05-31)*. Full live-VM snapshot/restore to a
  versioned JSON blob (typed arrays base64); bytecode/rooms/costumes reload from
  the game files. Per-game localStorage slots + file export/import; the real-MI1
  round-trip is byte-identical. Confirmed in-app.

- **Phase 8 — Polish** *(2026-05-31)*. Closed the gap from "runs without halting"
  to "behaves like the original" for the first rooms: z-plane occlusion,
  jiffy/frame pacing, the magenta UI palette + sentence-line-as-verb-#100,
  costume-anim head tracking. Remaining cosmetic stubs are in Open backlog above.

- **Phase 7 — Verb UI + input** *(2026-05-30)*. MI1 interactively playable boot →
  intro → first room via the original's own scripts (hover poller → verb-input
  script → sentence script; cutscenes; room lighting; inventory-as-verbs). See
  [INPUT](docs/SCUMM-V5-INPUT.md), [CUTSCENES](docs/SCUMM-V5-CUTSCENES.md),
  [BOOT](docs/SCUMM-V5-BOOT.md).

- **Phase 6 — Enough engine to walk** *(2026-05-28)*. 30+ opcodes, room/costume/
  object loaders, 13-slot actor table, pathfinding (A* over the walkable mask),
  frame compositor with z-planes, rAF main loop. Boot dispatches 3500+ opcodes
  into the title-screen idle. (Costume-anim decoder was still a known-bad spike
  here; solved in Phase 7 — see [COSTUME-ANIM](docs/SCUMM-V5-COSTUME-ANIM.md).)

- **Phase 5 — VM skeleton** *(2026-05-27)*. SCUMM v5 bytecode interpreter
  end-to-end at the structural level: index/LOFF/script loaders, var banks, 25
  cooperative slots, an opcode dispatch table (seed set), halt-as-first-class-state,
  and a VM inspector. See [INDEX](docs/SCUMM-V5-INDEX.md),
  [OPCODES](docs/SCUMM-V5-OPCODES.md).

- **Phase 4 — Text** *(2026-05-26)*. `CHAR` bitmap-font decoder at 1 and 2 bpp +
  a string → indexed-buffer renderer; charset inspector. See
  [CHAR](docs/SCUMM-V5-CHAR.md).

- **Phase 3 — Costumes** *(2026-05-26)*. Costume decode end-to-end (sub-palette,
  image tables, RLE frames) + z-plane occlusion masks + an actor compositor. See
  [COST](docs/SCUMM-V5-COST.md), [ZPLANE](docs/SCUMM-V5-ZPLANE.md).

- **Phase 2 — First pixels** *(2026-05-26)*. Room palette + background bitmap
  decode (full SMAP method dispatch) rendered on Canvas2D with TRNS transparency.
  See [SMAP](docs/SCUMM-V5-SMAP.md).

- **Phase 1 — Resource catalog** *(2026-05-25)*. Parse MONKEY.000/.001:
  XOR-decrypt (key 0x69), recursive block-tree walk, indented tree dump with a
  tag-description catalog.

- **Phase 0 — Scaffold** *(2026-05-25)*. Vite + TS + Vitest; library / install /
  player screens; game detection; IndexedDB handle persistence; browser-support
  gate.
