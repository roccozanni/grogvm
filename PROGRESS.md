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
committed on `main`). **785 tests green, tsc clean.** The intro → room 33 →
SCUMM Bar (room 28) → pirate-conversation close-up is playable end-to-end.

**Working principle (agreed 2026-06-02):** no hacks/shortcuts — every change is
the final, SCUMM-faithful solution. Confirm the real mechanism first (disassemble
the original, check ScummVM semantics) before editing; when engine-faithful and a
quick shell workaround disagree, faithful wins. Verify the actual outcome (render
real pixels for visual bugs; reproduce the real flow for behaviour) — not the
bookkeeping. Surface any deferral/approximation explicitly and track it here;
never bury a shortcut. If "faithful" needs a bigger refactor, raise the tradeoff
rather than silently taking either the heavy path or the shortcut.

**Last worked on — project rename + inventory/pickup fixes** *(2026-06-02;
commits up to `cb02b12`; pickup + hover-arming user-confirmed in-browser)*:

- **Project renamed** webscumm → GrogVM (root dir is lowercase `grogvm`); game
  dir `games/MI1` → `games/MI1-IT-CD-DOS-VGA`. Brand text = "GrogVM"; lowercase
  identifiers (npm name, IndexedDB name, `grogvm:save:*` localStorage prefixes,
  memory path) = "grogvm". Data-gated engine tests now point at the new game dir.
- **Picked-up item lingered on the counter** *(confirmed fixed)*. MI1 **bakes the
  pickable food into the room-background SMAP**; each food object's state-1 image
  is the patch that *erases* the baked-in item once taken (drawing obj 566 over
  the counter clears the meat). So pickup must **draw** the object, not drop it:
  `pickupObjectHandler` `objectDrawQueue.delete` → `.add` (= SCUMM
  `putState(obj,1)` + `markObjectRectAsDirty`). An earlier ownership "isHeld"
  draw-gate was the wrong model and was reverted. **→ migrate to
  [OBJECTS](docs/SCUMM-V5-OBJECTS.md): the bg-baked-item / eraser-patch technique.**
- **Picked-up item's hit area persisted** *(fixed)*. The visual fix above only did
  half of SCUMM's `o5_pickupObject`: it drew the state-1 patch but skipped
  **`putClass(obj, kObjectClassUntouchable, 1)`** (it was explicitly deferred).
  So the taken item vanished yet still hit-tested in the room — you could keep
  clicking the empty spot. `findObject`/`pickObject` already skip Untouchable
  (class 32 → bit 31); fix = set that class bit in `pickupObjectHandler` (the
  mechanics half the eraser-patch fix left open). **→ migrate to
  [OBJECTS](docs/SCUMM-V5-OBJECTS.md) alongside the eraser-patch note: full
  pickup = own + state-1 draw + Untouchable + inventory refresh.**
- **Inventory hover arms the verb via the engine** *(confirmed working)*. The
  hover poller **#23 already arms** the item default (saves active verb to
  **g394**, sets **g107 ← 8 Esamina**, object **g108**, restores g107 on
  hover-out over the band g45 ≥ 152 / g44 ≥ 160). It never fired because the
  **two-canvas split** fed it no screen-space coords. Fix = Option 1 (unify the
  *input* coordinate space): the verb-bar `pointermove` writes screen g44/g45 over
  an inventory slot, so #23 runs; the sentence line reads armed g107 via
  `armedVerb`. Shell-side default-verb guess reverted. **→ migrate to
  [INPUT](docs/SCUMM-V5-INPUT.md): inventory-hover arming + the coordinate seam.**
- **Sentence line** — ignore the inventory-slot verb (200–207) so the line shows
  the armed verb, not the slot's nameless "Vai".
- **Inventory click-commit** *(user-confirmed in-browser 2026-06-02)*: a single
  left-click on an inventory item **does run the armed verb** end-to-end —
  `handleVerbClick(200..207)` → #4 → `doSentence` → #2. The open item is closed.
- **Held items read as unreachable** *(fixed, real-data + unit confirmed)*. A verb
  on an inventory item (e.g. "Apri" the meat) aborted with **"Non riesco ad
  arrivarci"**: #2 gates every verb behind `getDist(ego, target)`, but
  `objActPos` (`opcodes/index.ts`) resolved a target **only** as a placed room
  object → a held item (not in `loadedRoom.objects`) → `null` → `0xFF` "far".
  SCUMM's `getObjectOrActorXY` has a **WIO_INVENTORY** case: a held object's
  position **is its holder's** position, so `getDist(ego, heldItem) =
  dist(ego,ego) = 0` → reachable → the verb runs. Fix = add that case to
  `objActPos` (owner is an actor in the current room → holder xy; owner ≥ the
  13-slot actor table, e.g. `OF_OWNER_ROOM`=15 → room branch). Held-by-actor-in-
  another-room → `0xFF` (matches `getObjectOrActorXY` returning −1). **→ migrate
  to [OBJECTS](docs/SCUMM-V5-OBJECTS.md) (whereIsObject / inventory reach) and/or
  the getDist note alongside the room-33 door walk-to-point fix.**
- **Two-object "Usa X con Y" — confirmed working + sentence line now faithful**
  *(real-data confirmed against a room-41 kitchen quicksave; rendered to pixels)*.
  The full A+B commit + `g110` preposition step works end-to-end through the real
  scripts: click Usa (7) → click meat (g108=566) → #4 arms preposition `g110`=130
  → hover/route object B into `g109` → commit `doSentence(7,566,574)` → #2 runs.
  **Two bugs found in the sentence line (verb #100) while verifying:** (1)
  `verbOps setName` decoded names *without* `vm`/`slot`, so `expandSubstitution`
  dropped every `0xFF NN` code; (2) the code→meaning map was wrong. Correct SCUMM
  v5: `0x04` int / `0x05` verb / `0x06` name = `readVar(num)`; `0x07` string =
  `num` **direct** string-resource id. MI1 #100 = `verb[g107] str[g49]
  name[g108] " " verb[g110] " " name[g109]`, where the preposition `g110`=130 is
  a *verb* whose name is "con", and `g49`'s separator is string res 49 = " "
  (g49's value is 0 — read it through the var and the space vanishes:
  "Usail pezzo"). The `@`(0x40) name-padding is already render-stripped
  ([text.ts](src/engine/graphics/text.ts)). **Shell now renders #100 directly**
  (retired the single-object `sentenceText` synthesis — the deferred render
  "Option 2" sentence-line step), so "Usa il pezzo di carne con la pentola con lo
  spezzatino" shows. **→ migrate to [INPUT §5/§6](docs/SCUMM-V5-INPUT.md): the
  substitution-code table + #100 is rendered, not synthesized.**

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
