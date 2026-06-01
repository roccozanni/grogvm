# webscumm — Progress

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
committed on `main`). **779 tests green, tsc clean.** The intro → room 33 →
SCUMM Bar (room 28) → pirate-conversation close-up is playable end-to-end.

**Recent fixes (room 28 important-looking pirates):**

1. **Garbage box → pirates render.** Costume 24 is MI1's first **32-color
   costume** (`format == 0x59`); `decodeCostumeFrame` hardcoded the 16-color
   RLE split. Added a `paletteSize` (16 | 32) param from the costume header so
   the 32-color split (5 bits colour / 3 bits length) is used; threaded through
   the compositor + explorer. Migrated to [COST §5](docs/SCUMM-V5-COST.md).
2. **Hover/sentence name.** The shell's `recomputeHover` preferred any actor
   under the cursor, so the pirates (drawn by actor 3, hotspot = object 322)
   read as the nameless "obj #3". Switched to **object-first** hit-test
   (faithful `findObject` precedence; actor only as fallback). *(Pirates name
   confirmed live.)*
3. **Nameless walk-hotspot overlay.** Object #320 (the bar floor connector) is
   a real object with only a walk-to verb (#11) and no OBNA — `findObject`
   returns it (it's not Untouchable), so it's a legitimate click-to-walk target,
   UI-identical to bare floor in the original (just "Vai", no highlight; MI1 has
   no hover cursor). The shell's hover overlay (crosshair colour **and** box,
   now driven by one decision) lights only over a *named* target, so #320 reads
   as floor instead of an interactable thing. The raw id is still in the Input
   debug panel on click, and the click still routes through the engine.

**Note — obj #320 verb-bar "Esamina" highlight is faithful, not a bug.** MI1's
#23 poller resolves the hovered object's default verb and recolours it in the
bar (left-click hint, via the game's own `verbOps`). obj #320's default verb is
8 (Examine), so Examine highlights — `g182=8` over #320 vs `g182=10` over empty
floor; `g107` (armed) stays 11 throughout. Open *option* (user's call): shell-
side override to also suppress this highlight for nameless objects so #320 reads
as fully inert floor, at the cost of a small divergence from the engine.

**Open — intermittent dialog start glitch (next, not yet diagnosed).** When the
pirate conversation begins it *sometimes* breaks: the first dialog line renders
**all black** and the verb bar stays black (replies don't activate); other times
the same line renders **yellow** and everything works. Non-deterministic — not
pinned to a fixed action sequence, and the user believes it predates the issue-3
work. Smells like a race/ordering between the dialog-start (colour/charset setup
+ `saveRestoreVerbs` archiving the action verbs) and the reply-verb creation, or
an uninitialised talk colour on some paths. Investigate the conversation-start
sequence (verb archiving, talk colour, reply-verb wiring).

**Open — pirate close-up mirrors on conversation (track; recheck).** Earlier the
close-up showed actor 3 (cost24) horizontally flipped. User now reports
animations + composition "all fine" after the issue-3 work, so this may be
resolved (or not re-hit). Hypothesis if it recurs: the dialog refaces actor 3
toward ego (West) and the compositor's mirror rule flips the front-view art;
cost24 only defines S/init art, so a front-view costume shouldn't mirror on a
W/E reface. Re-verify before acting. See [COSTUME-ANIM](docs/SCUMM-V5-COSTUME-ANIM.md).

**Fixed — issue #3 (pirate animation + actor layering)** *(user-confirmed)*. Two
connected bugs, both rooted in the `animateActor` opcode model:
- The operand is a **chore number** (1=init, 2=walk, 3=stand…; record = chore*4
  + dir); **244–255 are direction/stop pseudo-anims** (`dir = anim & 3`), and a
  set/turn-dir pseudo-anim *re-points the running chore* to the new facing
  rather than switching it. Our old `cmd = anim/4` reading put specials at 8–19
  and no-opped 244–255 (the game's most-used direction commands).
- The init chore (chore 1) now starts when a costume is set — the actor's
  default animation. cost24's init chore (record 6, facing S) is the 3-pirate
  drink loop; `animateActor 3 250` (set-dir-S) keeps it running. No-op visual
  for single-frame-init costumes; only the 13 multi-frame ones start animating.
- Actor draw order is now by **y-position** (tiebreak id), fixing the close-up
  layering (Guybrush front, pirates behind the table). Semantics →
  [COSTUME-ANIM](docs/SCUMM-V5-COSTUME-ANIM.md).

**Next:** finish the SCUMM Bar dialogs, gather inventory items, and reach a
**use-with** puzzle so the two open input items below get exercised with a real
save.

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

- **Two-object "Use X with Y" end-to-end** — single-object proven; confirm a
  full A+B commit + the `g110` preposition step in a room with a use-with-able
  object. [INPUT §5](docs/SCUMM-V5-INPUT.md).
- **Inventory scroll arrows** (verbs 208/209) for >8 items — needs a full
  inventory to exercise.

**Rendering**

- **Compositor honours `VAR_CURRENT_LIGHTS`** — darken a night room via the
  lights flag, not only a dark palette (may be subtle; night rooms already ship
  dark palettes — check it's visible first). [LIGHTING §4](docs/SCUMM-V5-LIGHTING.md).
- **`screenEffect` transition animation** — state is modelled; the
  dissolve/scroll/instant *animation* is deferred (intro is all instant cuts).
  [SCREEN-EFFECT](docs/SCUMM-V5-SCREEN-EFFECT.md).
- **Smooth `panCameraTo`** — snaps today; no intro-reachable scene uses it, so
  the pan rate has no validation target. Wire it when a scene surfaces.

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
