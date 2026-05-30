# webscumm — Progress

Working tracker of what's done and what's next. The **active phase** is
broken into concrete tasks. **Future phases stay one-liners** until we
actually start them — speculative breakdowns rot.

When a phase is complete, summarize what was built under "Done" and
detail the next phase here.

---

## Status

**Phase 8 — Polish (active).** MI1 plays its full intro and is
interactively playable in the first room: the faithful
click → verb → sentence flow (hover poller → verb-input script →
sentence script), cutscenes that hide the UI and can be skipped
(Escape), correct room lighting, right-click default verb, and an
inventory rendered through the verb bar. A boot→gameplay opcode audit
found the start→play path faithful at the logic level (see the Phase 7
entry under Done).

Phase 8 is a focused polish pass before the original roadmap (save
states → audio → MI2) resumes: implement the **non-resource,
non-sound** opcodes still stubbed, and close the open known-bugs and
cosmetic gaps.

The durable engine/format knowledge that used to live here as session
notes now lives in `docs/` — in particular:

- [SCUMM-V5-INPUT.md](docs/SCUMM-V5-INPUT.md) — verbs, sentences, cursor/userput, the hover poller, inventory-as-verbs.
- [SCUMM-V5-CUTSCENES.md](docs/SCUMM-V5-CUTSCENES.md) — cutscene bracket, freezing, override/skip.
- [SCUMM-V5-LIGHTING.md](docs/SCUMM-V5-LIGHTING.md) — `VAR_CURRENT_LIGHTS`, the reset default, the `lights` opcode.
- [SCUMM-V5-BOOT.md](docs/SCUMM-V5-BOOT.md) — system-variable seeding, the credits→first-room transition.
- [SCUMM-V5-CHAR.md](docs/SCUMM-V5-CHAR.md) — charset-by-id resolution + the text fill/outline colour model.
- [SCUMM-V5-OPCODES.md](docs/SCUMM-V5-OPCODES.md) — non-orthogonal opcode families.

**Tooling:** `src/engine/vm/disasm.ts` is a tested SCUMM v5
disassembler (CLI front-end `scratch/dis.ts`, with a `SCAN` mode). Keep
it in sync with the executing opcode table — see AGENTS.md.

---

## Active phase — Phase 8: Polish (opcodes + known bugs)

### Goal

Close the gap between "runs without halting" and "behaves like the
original" for everything the start→gameplay path and the first rooms
touch: implement the remaining **non-resource, non-sound** opcodes that
are currently stubbed, and resolve the standing known-bugs and tabled
observations. Audio and resource-heap management are explicitly out of
scope (their own phases).

### Opcodes to implement (non-resource, non-sound)

The boot→room-33 audit (`scratch/audit-opcodes.ts`) found **no
gameplay-logic stubs**; the remaining stubs are cosmetic / peripheral.
Implement these faithfully:

- [~] **`roomOps` (0x33)** — DONE: `setPalColor` (mutates the live room
      CLUT the compositor reads) and `roomScroll` (camera min/max bounds,
      honoured by `setCameraTo`, cleared on room change). STILL STUBBED:
      `shakeOn`/`shakeOff`, `roomIntensity` / `setRGBRoomIntensity`,
      `screenEffect` (fade in/out), `saveString` / `loadString`.
- [ ] **`cursorCommand` image sub-ops (0x2C)** — `setCursorImage`
      (`0x0A`, charset-glyph cursor), `setCursorHotspot` (`0x0B`),
      `setCursor` (`0x0C`). Plus **`charsetColor` (`0x0E`)** — implement
      carefully; tie it to the credits-colour item below (a naive impl
      regresses the talk-text fill/outline model — see SCUMM-V5-CHAR §5).
- [ ] **`matrixOp` (0x30)** — box-flags / box-scale / create-box-matrix
      (walk-box connectivity).
- [x] **`systemOps` (0x98)** — restart / pause / quit recorded as
      `vm.systemRequest` (the shell decides; never kills the inspector);
      surfaced in the inspector Input panel when non-null.
- [x] **`pseudoRoom` (0xCC)** — alias map (`vm.pseudoRooms`, the
      `j>=0x80 → mapper[j&0x7F]=id` rule); `enterRoom` resolves a
      requested id through it to the physical room.

### Known bugs / tabled observations to close

- [ ] **Z-plane occlusion** — actors/objects composite in front of
      scenery that should occlude them (the lookout fire draws over the
      wall). Masks decode and the "any plane index > actorZ hides" rule
      is implemented; the compositing path picks the wrong plane. See
      [docs/SCUMM-V5-ZPLANE.md](docs/SCUMM-V5-ZPLANE.md).
- [ ] **Compositor honours `VAR_CURRENT_LIGHTS`** — a dark room (room 38
      night scene) should darken via the lights flag, not only via a
      dark palette. See [docs/SCUMM-V5-LIGHTING.md](docs/SCUMM-V5-LIGHTING.md) §4.
- [ ] **"Le tre prove" cutscene pacing** — the Three-Trials interstitial
      plays in under a second; the original holds for several. A timing
      bug in how a `delay` / `wait` / talk-timer gates the cutscene vs.
      the original ~60 Hz clock.
- [ ] **Credits fill colour (teal vs magenta)** — every credit line
      prints `SO_COLOR 3` → CLUT3 = teal in our data, but ScummVM shows
      magenta from the *same* files. Our colour→CLUT mapping is proven
      right (the copyright line's `color 5` → magenta renders correctly),
      so something remaps CLUT3 for the credits that we don't do. Resolve
      conclusively (find the remap) or confirm a release difference.
- [ ] **Sentence line in-canvas** — currently an HTML `<div>`; MI1 draws
      it on the strip at the top of the verb area (verb #100). Render it
      into the verb-bar canvas via the CHAR renderer and drop the div.
- [~] **Dialog escape codes** — DONE: substitutions `0x04` (int-var →
      decimal), `0x07` (string resource), `0x08` (object/verb name),
      threaded through `decodeScummString` / `decodeScummStringPages`.
      STILL DEFERRED: keep-text `0x02`, `0x06` var-name, `0x09` sound,
      `0x0A` actor name (actor names aren't modelled), mid-string colour
      `0x0E` (needs rich text).
- [ ] **Smooth `panCameraTo`** — currently snaps; should pan smoothly.
- [ ] **Inventory scroll arrows** (verbs 208/209) for >8 items.
- [ ] **Two-object "Use X with Y" end-to-end** — the faithful gather
      flow + the `g110` preposition step are in place and proven for
      single-object; confirm a full A+B commit in a room with a
      use-with-able object / inventory item (room 33's intro has none).
      See [docs/SCUMM-V5-INPUT.md](docs/SCUMM-V5-INPUT.md) §5.
- [x] **Costume animation decoder** — SOLVED with a v5 (ScummVM)
      reference (full trail + the correct algorithm in
      [docs/SCUMM-V5-COSTUME-ANIM.md](docs/SCUMM-V5-COSTUME-ANIM.md)
      §"SOLVED"). `startAnim` now uses the real model: a **−6 base
      correction** (`COSTUME_OFFSET_ADJUST` — our payload starts 6 bytes
      past ScummVM's `_baseptr`) on the record, cmd stream, AND limb
      table; a **u16 LE mask** (limb i = bit 15-i); `u16 frameIndex` +
      `u8 extra`; and the **`0x79`/`0x7A` stop/un-stop commands** that
      drive a **persistent per-limb `stopped` bitmask**. This explains
      every playtest bug: limb 0 is the whole Guybrush, limb 1 a separate
      head — the walk *stops* the head (body carries it), stand un-stops
      it, talk animates it. The **mirror flag** is implemented
      (`compositeActor`). Verified headlessly: walk = one cycling body,
      head stopped; intro composites with zero limb-skip errors. 646
      tests pass.

### Next step — visual-confirm the walk, then `mask=0xFF` talk anims

The live walk is wired and correct headlessly; it needs **visual
confirmation** (HMR) — especially the **mirror direction** (we flip when
facing West; if left/right read swapped, change `compositeActor`'s
condition to `facing === 'E'`). Watch: walk left/right (smooth single
body, no double head), stop (clean directional stand), walk up/down.

**Still open — `mask=0xFF` talk records.** With the corrected u16-mask +
−6 base, the talk anims (16–23) now decode (head lip-sync on limb 1) —
but `mask=0xFF` records elsewhere (e.g. costume-111 oddballs) may still
need scrutiny. Re-check talk in-game once the walk is confirmed.

**Separate item — the clouds.** The Mêlée-island clouds (room 38) slide
right-to-left = a **positional** animation (`xinc`/`yinc` frame
displacement, or a moving actor/object), **not** the record decoder.
Investigate independently (engine can do this headlessly). Tracked as
task #7.

### Out of scope (other phases)

- **Audio** — sound opcodes (`startSound`/`stopSound`/`isSoundRunning`/
  `startMusic`) stay silent stubs; `isSoundRunning → 0` lets sound-waits
  fall through.
- **Resource-heap management** — `resourceRoutines` load/lock/unlock/
  clearHeap stays a no-op: resources load lazily, there is no managed
  heap to model.
- **Save / restore** — a later phase (the original "Phase 8").

---

## Future phases

Kept intentionally undetailed. We'll break each into tasks when we start
it. Order and scope may shift as we learn the territory — see
ARCHITECTURE.md §9 for the original outline.

- **Phase 9 — Save states.**
- **Phase 10 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 11 — MI2 + polish.**

A revisit candidate for any phase: **fix the costume-anim decoder
against MI1 Guybrush** so actors actually animate as they walk.
See `docs/SCUMM-V5-COSTUME-ANIM.md`.

---

## Done

### Phase 7 — Verb UI + input *(2026-05-30)*

MI1 is interactively playable from boot through the intro into the first
room. The verb bar, sentence line, inventory, cursor, and
click → action flow all work against real MI1 data, via the original's
own scripts rather than engine shortcuts.

- **Faithful input flow** ([docs/SCUMM-V5-INPUT.md](docs/SCUMM-V5-INPUT.md)):
  the engine drives `VAR_CURSORSTATE` / `VAR_USERPUT` (cursor counters)
  so MI1's per-frame hover poller (#23) hit-tests the object under the
  cursor into the active-object globals; a click runs the verb-input
  script (#4) via `runInputScript`, which gathers objects — including
  the two-object preposition step — and commits `doSentence`; the
  sentence script (#2) executes. Right-click uses the hovered object's
  default verb. No engine-side click shortcut.
- **Cutscenes** ([docs/SCUMM-V5-CUTSCENES.md](docs/SCUMM-V5-CUTSCENES.md)):
  the `cutscene` / `endCutscene` bracket + `freezeScripts` + the #18/#19
  hook scripts hide and restore the cursor and verb bar
  (`saveRestoreVerbs`); Escape skips a cutscene via the override path
  (`abortCutscene`). Scene and verb clicks gate on user-input.
- **Room lighting** ([docs/SCUMM-V5-LIGHTING.md](docs/SCUMM-V5-LIGHTING.md)):
  `VAR_CURRENT_LIGHTS` seeded to the lit default at boot, plus the
  `lights` opcode; the dark-room "too dark to see" logic is now correct.
- **Text** ([docs/SCUMM-V5-CHAR.md](docs/SCUMM-V5-CHAR.md)): resolve
  `initCharset N` through the `DCHR` directory; talk text renders
  fill-in-ink / black-outline. Dialog word-wraps, centres per line, and
  pages on `\xff\x03`; speech and persistent system text are separate
  channels gated by the talk timer / `VAR_HAVE_MSG`.
- **Inventory** rendered through verb slots 200–207 via the inventory
  script; carried-item names preserved across rooms.
- **Tooling**: a first-class, tested SCUMM v5 disassembler
  (`src/engine/vm/disasm.ts`); a boot→gameplay opcode-stub audit (clean
  — no logic stubs); and MI1 end-to-end smoke tests.

Along the way: fixed a batch of non-orthogonal opcode-family
mis-registrations ([docs/SCUMM-V5-OPCODES.md](docs/SCUMM-V5-OPCODES.md)),
the room-33 walk-box rasterization (degenerate staircase boxes),
per-tick camera follow, and cracked the credits → first-room transition
([docs/SCUMM-V5-BOOT.md](docs/SCUMM-V5-BOOT.md)).


### Phase 6 — Enough engine to walk *(2026-05-28)*

End-to-end runnable boot through to the title-screen idle state. The
MI1 boot dispatches every opcode it tries (3500+ across 11 scripts),
settles into the title-screen tick loop, and the VM frame canvas
shows the rendered title room with a Play/Pause-driven main loop.

**What's live:**

- **VM**: 30+ new opcodes wired (cursorCommand, stringOps,
  resourceRoutines, startScript, roomOps, pseudoRoom, setState,
  drawObject, verbOps, actorOps, walkActorTo, walkActorToActor,
  putActor, animateActor, camera ops, print, getRandomNumber,
  loadRoom, systemOps, cutscene/endCutscene, freezeScripts,
  isScriptRunning, beginOverride, audio stubs, setVarRange, and the
  `0xAC` expression mini-VM). All comparison opcodes verified against
  the SCUMM v5 wiki's `unless (value OP var) goto target` form.
  Var-ref scope bits corrected (`0x8000` = bit-var, `0x4000` = local,
  `0x2000` = indexed-array via an extra word).
- **Resource subsystems**: room loader (LoadedRoom = bg + palette +
  TRNS + z-planes + ENCD/EXCD bytecode + LSCR table + objects + walk
  boxes + walkable mask), costume cache with lazy `vm.getCostume`,
  OBCD/OBIM parser (per-state image variants, OBNA names).
- **Actor table**: 13-slot fixed table on the VM. Every actor opcode
  reads/writes it. `__vm` console hook exposes the live state.
- **Walking**: `walkActorTo` runs the pathfinder against the room's
  walkable mask; `stepWalk` advances actors waypoint-by-waypoint
  each tick. Straight-line fall-back when no walk boxes are present.
- **Pathfinding**: BOXD parser, polygon-fill rasterizer, A* over the
  walkable mask with 8-connectivity + octile heuristic. Solves a
  typical 320×144 room in <50 ms.
- **Frame compositor**: room bg → queued objects → actors,
  sorted by actor id for stable layering. Z-planes honoured.
  TRNS-indexed transparency. Per-actor/object/limb skip diagnostics
  surfaced in the inspector.
- **Main loop**: rAF-driven Play/Pause with idle-detection
  auto-pause (fingerprint = slot states + walking positions +
  active anim cursors). Tick counter + Run-to-idle convenience
  button. ENCD/EXCD scripts dispatched as labelled synthetic slots.
- **Inspector additions**: VM frame canvas, actor table, walk-box
  overlay (toggle), tick counter, skip-reason lists.

**Known limitation: costume anim decoder.** The wiki-described
record layout works for synthetic fixtures + simple costumes but
doesn't match MI1 Guybrush's records — they produce out-of-range
`start` offsets. Implementation is defensive (bad records → limb
stays inactive, actor renders in init pose). Real visual
validation requires a v5 reference renderer; deferred. See
`docs/SCUMM-V5-COSTUME-ANIM.md` for the spike findings.

**Variables made lenient.** MI1 ships dead-code paths that write
past MAXS. OOB reads return 0, OOB writes are absorbed, every
access recorded on `vars.oobAccesses` for the inspector. Keeps the
engine progressing past unreachable branches without losing
visibility.

**Copy-protection seeded.** `bootGame` writes `var[0x4a] = 1225` to
satisfy MI1's CD audio-track-2 size check (script #176 quits if
outside `[1200, 1250]`).

**Tests: 414 across 39 files** (+103 since Phase 5). Typecheck
clean.

---

### Phase 5 — VM skeleton *(2026-05-27)*

Stands up a SCUMM v5 bytecode interpreter end-to-end at the *structural*
level: index-file parser (MAXS + lane-encoded DROO/DSCR/DSOU/DCOS/DCHR),
LOFF parser, script loader (global SCRPs only), 800-entry global var
bank + 2048 bit-vars + 16 room-vars + per-slot locals, 25 cooperative
script slots with a clean lifecycle, a 256-entry opcode dispatch table
with a seed set covering the assignment / arithmetic / comparison /
branch / yield / stop families, and a halt-as-first-class-state design
that captures the slot, PC, opcode, last 16 bytecode bytes, and tail of
the trace ring whenever the VM hits an opcode we haven't written. The
player UI gains a full VM inspector: Boot / Step / Run-tick / Reset
controls, a slot table that flags the halted slot with a red badge, a
hex-addressed globals grid, a compact bit-var grid, the trace ring, and
a halt panel with bytecode-context hex highlighting. 272 tests across
28 files; new `docs/SCUMM-V5-INDEX.md` covering the lane-encoding
surprise (the first lane is the **owning room id** for DSCR/DSOU/DCOS/
DCHR, *not* a disk number). Real MI1 boot script dispatches its first
four setVars cleanly and halts loudly on `0x2c` (cursorCommand) as
designed.

#### Original task checklist (all complete)

**Index parsing — `src/engine/resources/index-file.ts`**

- [x] `parseIndexFile(file)` — returns `{ maxs, rooms, scripts, sounds, costumes, charsets }`
- [x] `parseMaxs` — extracts named fields (numVariables, numBitVariables, numLocalObjects, numCharsets, numVerbs) and exposes the raw u16 LE array for unnamed slots
- [x] `parseLaneDirectory` — single decoder for the `count u16 LE` + `count × u8` + `count × u32 LE` shape shared by DROO/DSCR/DSOU/DCOS/DCHR
- [x] `IndexParseError` for missing blocks, size mismatches, truncated payloads

**LOFF parsing — `src/engine/resources/loff.ts`**

- [x] `parseLoff(file)` — returns a `Map<roomId, fileOffset>` populated from `LECF/LOFF`. Counts are u8, entries are `(room u8, offset u32 LE)`. Throws on missing LECF / LOFF or size mismatch.

**Spike — verified the index layout against real MI1**

- [x] `scratch/inspect-index.ts` — printed DSCR/DROO/MAXS under both interleaved and lane-encoded hypotheses, then validated by counting how many resolved offsets land on the expected tags in `.001`. Lane encoding wins decisively; the lane-1 byte resolves as the owning room id, not the disk number (under the disk hypothesis only 1 of 100 DROO rows looked real).

**Script loading — `src/engine/vm/scripts.ts`**

- [x] `loadGlobalScript(file, index, loff, scriptId)` — resolves `LOFF[index.scripts[id].room] + index.scripts[id].offset`, verifies the tag is `SCRP`, returns the bytecode payload + absolute file offset. Verified against real MI1: 178 / 199 scripts resolve, 21 are zero-room "unused" slots that throw `ScriptLoadError` exactly as expected.
- [x] Error paths: out-of-range id, unused entry (room=0), missing room in LOFF, resolved offset doesn't land on SCRP, invalid SCRP block size

**Variable bank — `src/engine/vm/variables.ts`**

- [x] `class Variables` — globals (Int32Array sized from MAXS or 800 floor), bit-buffer (packed Uint8Array sized from MAXS or 2048 floor), room-vars (Int32Array, 16 entries)
- [x] `readGlobal` / `writeGlobal` / `readBit` / `writeBit` / `readRoom` / `writeRoom` with bounds checks
- [x] `VariableError` on out-of-range indices

**Script slot — `src/engine/vm/slot.ts`**

- [x] `class ScriptSlot` — slotIndex, status (`dead`/`running`/`yielded`/`frozen`), scriptId, bytecode (Uint8Array), pc, room, locals (Int32Array(25))
- [x] State machine: `start(opts)` requires status=dead, populates locals[0..args-1] from args; `yield_()`, `resume()`, `freeze()`, `kill()`
- [x] `ScriptSlotError` on illegal transitions (start on non-dead, yield on dead)

**Parameter-mode decoder — `src/engine/vm/params.ts`**

- [x] `isVarParam(opcode, paramIndex)` — bit 7/6/5 of the opcode byte select param 1/2/3 mode
- [x] `readU8` / `readU16` / `readI16` from `slot.bytecode[slot.pc]`, advancing PC
- [x] `readValue(slot, vars, asVar)` — reads u16 immediate or dereferences a var-ref word
- [x] `readVarRef` (read + deref) and `readDestRef` (raw word, no deref) for write paths
- [x] `derefRead(ref, slot, vars)` / `writeRef(ref, value, slot, vars)` — handle the 16-bit reference encoding: bit 15 = local, bit 14 = bit-var, bit 13 = indexed (throws — deferred), else global
- [x] `ParamError` on out-of-range local indices and on indexed refs

**VM core — `src/engine/vm/vm.ts`**

- [x] `class Vm` — owns `Variables`, 25 `ScriptSlot`s, an opcode handler map, a 64-entry circular trace buffer, and a nullable `HaltInfo`
- [x] `startScript(opts)` — picks the lowest-index dead slot
- [x] `step()` — dispatches one opcode in the next runnable slot; round-robin across slots is implicit (next `running` slot in array order)
- [x] `runUntilAllYield(maxSteps=100k)` — drains all runnable slots; treats step-cap exhaustion as a runaway-loop halt
- [x] `halt` is a *state*, not an exception escape: `UnknownOpcodeError` and handler-thrown errors are caught at the dispatch boundary and converted to `haltInfo`. Subsequent `step()` is a no-op.
- [x] `annotate(mnemonic)` — handlers self-describe the trace entry they just produced
- [x] `reset()` — restores pre-Boot state (kills all slots, clears vars-by-instance reuse, clears trace, clears halt)
- [x] `UnknownOpcodeError` carries the opcode byte for clean error reporting

**Seed opcode set — `src/engine/vm/opcodes/index.ts`**

- [x] `0x00` / `0xA0` `stopObjectCode` — kill slot
- [x] `0x80` `breakHere` — yield slot
- [x] `0x18` `jumpRelative` — i16 displacement relative to byte-after-delta
- [x] `0x1A` / `0x9A` `setVar` — dest = raw ref word, source = u16 immediate or var-ref (bit-7 toggle)
- [x] `0x46` `inc` / `0xC6` `dec` — single var-ref param, ±1
- [x] `0x5A` / `0xDA` `addVar`, `0x3A` / `0xBA` `subVar`
- [x] Comparison + jump family (`0x48/C8` isEqual, `0x08/88` isNotEqual, `0x04/84` isGE, `0x44/C4` isLess, `0x78/F8` isGreater, `0x38/B8` isLE) — read var, read value-or-var, read i16 delta, jump if **not** condition (SCUMM "jump if false" convention)
- [x] `0x28` equalZero / `0xA8` notEqualZero — single-var test + conditional jump
- [x] `0x2E` `delay` — consumes 3-byte tick count, yields (stub; real tick accounting is Phase 6)

**Boot driver — `src/engine/vm/boot.ts`**

- [x] `bootGame(file, index, loff, gameId)` — builds a `Vm` sized from MAXS (with a `Math.max` floor), seeds the system vars we know the boot prefix needs (screen w/h, game id, charset), calls `loadGlobalScript(..., 1)`, starts it in a slot, returns `{ vm, bootScriptId, bytecodeLength }`
- [x] Engine-var seeding is on-demand: we populated only what the boot prefix touches (screen width, screen height, game id, charset id) and will grow the list as the boot script reveals more reads — keeps the var bank honest as a diagnostic

**VM inspector UI — `src/shell/player/vm-inspector.ts`**

- [x] Self-contained `<section>` that mounts above the index/resource block-tree dumps
- [x] Controls bar: **Boot**, **Step**, **Run tick**, **Reset**
- [x] Slot table — populated slots only by default; columns id, script, room, status (color-coded per state), pc, bytecode size, last opcode + mnemonic; red **HALTED** badge on the slot that halted the VM
- [x] Trace ring — newest at top, last 64 entries, with full `slot, script, pc, opcode, mnemonic` line
- [x] Globals grid — hex addresses (0x00..0x3f by default), non-zero values get an accent border + accent text, "show more" button extends by 64 at a time
- [x] Bit-var grid — 256 bits visible by default in a 32-wide grid, 1-bits highlighted in accent yellow; "show more" extends by 256
- [x] Halt panel — red banner with reason, slot/script/pc/opcode metadata, bytecode-context hex strip with the offending byte in red, and the last 16 trace entries

**Tests**

- [x] `index-file.test.ts` (10) — MAXS field extraction, lane-directory decoding, malformed-block error paths, end-to-end parse of a synthetic .000-shaped buffer
- [x] `loff.test.ts` (5) — round-trip room→offset map, count=0 edge, u32 high-bit unsigned read, missing-LECF and size-mismatch errors
- [x] `scripts.test.ts` (6) — DSCR room id + LOFF lookup, two-rooms-same-relative-offset disambiguation (the bug the spike revealed), unused entries, out-of-range ids, missing LOFF entry, wrong-tag landing
- [x] `variables.test.ts` (12) — round-trip per scope, bit packing, signed/unsigned correctness, out-of-range bounds
- [x] `slot.test.ts` (9) — state-machine transitions, args populate locals, restart-in-place rejected, locals isolated between slots
- [x] `params.test.ts` (13) — `isVarParam` per index, fixed-width readers, sign extension, var-ref dereference across globals/locals/bits, indexed throws, `writeRef` per scope
- [x] `vm.test.ts` (13) — slot allocation + exhaustion, dispatch advances PC, unknown opcode → halt, halt is sticky and stops further dispatch, trace ring wraps at 64, runaway-loop step-cap halt, `reset()` clears state
- [x] `opcodes/index.test.ts` (14) — flow opcodes, setVar variants (immediate / var-ref / local target), inc/dec/add/sub, conditional branch families (taken and not-taken paths), delay stub, **and an end-to-end test that runs the verbatim opening bytes of MI1 boot script and asserts it halts on 0x2c with the right trace mnemonics**

**Format reference — `docs/SCUMM-V5-INDEX.md`**

- [x] Top-level block tour of `.000` (RNAM, MAXS, DROO, DSCR, DSOU, DCOS, DCHR, DOBJ)
- [x] Lane encoding (`u16 count` + `u8 lane` + `u32 LE lane`) with worked example
- [x] ⚠️ The two surprises: DROO lane-1 is the disk number, but DSCR/DSOU/DCOS/DCHR lane-1 is the **owning room id**; DROO offsets are zero on single-disk releases and the real offset lives in `LECF/LOFF` in `.001`
- [x] MAXS layout — named u16 LE fields and what each means
- [x] End-to-end resolve walkthrough: script id → DSCR entry → LOFF[room] → absolute offset → SCRP block
- [x] Verification recipe (MI1 numbers: 178/199 scripts resolve, 21 unused)

#### Bonuses

- **Lane-encoding spike came first.** Instead of writing the parser to documented field widths and debugging it later, the scratch script tried every plausible layout against real MI1 and validated by counting LFLF/ROOM/SCRP tag hits at the resolved offsets. Cost: 20 minutes; benefit: the parser locked in correct on the first commit and surfaced the "first lane is room id, not disk" surprise that the long-circulating notes obscure.
- **Halt as a first-class state.** Instead of letting `UnknownOpcodeError` escape the dispatcher, the VM catches it (and any handler-thrown error) at the boundary and freezes into a `HaltInfo` snapshot. The inspector reads `vm.haltInfo` and renders a red banner with bytecode context — no try/catch sprawl in the UI.
- **Self-describing trace entries.** Each handler calls `vm.annotate("setVar 0x49 = 0")` so the trace ring renders human-readable mnemonics without a separate disassembler. The annotation slots into the just-dispatched trace entry; the next dispatch resets it.
- **Step-cap on `runUntilAllYield`.** A 100k-step cap converts the most common bug class in a fresh dispatcher — tight loops with no yield — into a clean halt with full diagnostics instead of a hung tab.
- **End-to-end boot test against real bytes.** `opcodes/index.test.ts` runs the verbatim first 22 bytes of MI1 boot through the dispatcher and asserts the four setVar mnemonics + halt on 0x2c. Pins the whole vertical stack (param decode, var bank, opcode dispatch, halt) with a single assertion that breaks loudly if any layer regresses.
- **Halted-slot badge in the UI.** The slot table flags the slot the VM halted in with a red **HALTED** chip. The underlying `slot.status` stays `running` (the halt is on the VM, not the slot) — the badge makes the otherwise-confusing "running but not running" state legible.
- **Hex addressing across all VM panels.** Trace, halt panel, slot pc column, and globals grid all use `0x` hex — addresses match across panels so cross-referencing a variable write in the trace against the globals grid is a one-look exercise.
- **Inspector survives parse failures.** If index-file / LOFF parse throws, the inspector renders the error in place and the rest of the player UI (room viewer, costumes, charsets, block-tree dumps) keeps working.

#### Notable design choices made during implementation

- **Lane-1 semantics differ by directory family.** DROO's first lane is the disk number (0 = absent, 1 = present in MI1). DSCR/DSOU/DCOS/DCHR's first lane is the **owning room id** — the script (or sound, costume, charset) physically lives inside that room's LFLF, and its offset is relative to that room's ROOM block. The single-disk MI1 release stores 0 in every DROO offset slot; the LOFF block inside `.001` is the source of truth for room positions.
- **Locals live on the slot, not in the central var bank.** A slot's locals are invocation-scoped — when the slot dies they're gone, and parallel running scripts must not share them. Carrying them on `ScriptSlot.locals` makes that automatic; the param decoder takes the active slot as a parameter when dereferencing.
- **Param-mode decoding is per-handler, not centralized.** A single centralized "decode all params" function forces every opcode family into a uniform shape, but v5 opcodes don't have one. `setVar`'s first param is always a raw destination ref word (no mode bit); comparison opcodes treat bit 7 as "param 2 is var or immediate"; `inc`/`dec` use bit 7 to select the *operation*, not the param mode. Each handler reads what it needs.
- **Var-ref encoding.** Bit 15 set → local var, low byte is the index (locals are 8-bit indexed in v5). Bit 14 set → bit-var, bits 0..13 are the index. Bit 13 set → indexed/array reference (throws as unimplemented — defer until the boot script demands it). Otherwise → global var, bits 0..13 are the index. Verified against the leading setVars in MI1 boot.
- **Halt captures opcode-at-error, not pc-at-error.** The trace entry records the PC of the *opcode byte* (before advance), and `HaltInfo.pc` does the same. The bytecode-context strip places the offending byte at `contextOpcodeOffset`, so the UI can highlight it without re-deriving from PC.
- **MAXS sizes are a floor, not a cap.** `bootGame` does `Math.max(index.maxs.numVariables, 800)` so the var bank is always at least 800 even if MAXS reports smaller — defensive against future games or corrupt indices.
- **Engine-var seeding is on-demand.** We don't pre-populate all 800 globals — we add a seed entry only when the boot script's reads make it necessary. Keeps the globals grid honest: every non-zero value either came from a script write we can read in the trace, or from a single named seed call we can find with grep.
- **`runUntilAllYield` resumes nothing.** It doesn't flip yielded slots back to running first — the inspector's "Run tick" button does that. Separation keeps `runUntilAllYield` as a pure "drain runnable slots" primitive that the Phase 6 main loop will call once per frame.
- **Inspector uses replaceChildren, not partial updates.** Every Step / Run / Boot click rebuilds the whole inspector section. Cheap (a few hundred DOM nodes), stays in sync with VM state by construction. The only cross-render state is the `globalsShown` / `bitsShown` counters held in the inspector closure.

#### Open issues / known limitations

- **Only a seed opcode set.** By design — Phase 5 is "skeleton, fail loudly". Real boot continuation needs at minimum cursorCommand (0x2C), stringOps (0x27), startScript (0x42/0xC2), loadRoom, expression evaluator, doSentence, walkActor, … the long tail. Phase 6 grows this set in opcode-the-boot-script-demands-next order.
- **Indexed / array var references throw.** Bit 13 of the reference word selects an indexed deref in v5 (used for arrays). We throw `ParamError` for now. Add when the boot script first uses it.
- **No real `delay` tick clock.** The 0x2E delay opcode treats its 3-byte tick count as ignored and yields once. Real timing lands when the main loop in Phase 6 paces the engine at ~60 Hz.
- **No effectful opcodes.** The VM mutates variables and slots only. Anything that would change the room, palette, actor state, sound, or input — i.e. anything visible on screen — is unimplemented. Halts cleanly when encountered.
- **MAXS u16 slots beyond the named five are unnamed.** `maxs.raw` exposes all 9 u16 LE values from MI1's MAXS but we only put names on the slots we know (numVariables, numBitVariables, numLocalObjects, numCharsets, numVerbs). The remaining four vary by reverse-engineering source; we'll name them as code starts reading them.
- **MI2 not yet verified through boot.** The engine should be the same — same block layout, same opcode set — but we've only run MI1 boot bytes through the VM end-to-end. MI2 verification lives with Phase 10's "MI2 + polish" work, or earlier if it falls out naturally.
- **Inspector "Run tick" is a single drain.** Each click runs one engine tick. There's no continuous-run mode driven by requestAnimationFrame because nothing time-varying is on screen yet. The main loop in Phase 6 will own that.
- **LSCR / OBCD / VERB scripts are not loaded.** `loadGlobalScript` only resolves SCRP. Phase 6 needs local scripts (loaded on room entry) and Phase 7 needs object verb scripts.

---

### Phase 4 — Text *(2026-05-26)*

Decodes SCUMM v5 `CHAR` (bitmap font) blocks at both 1 and 2 bits per
pixel and renders arbitrary strings to indexed pixel buffers. The
player UI gains an LFLF-scoped charset inspector with header
diagnostics, a CLUT-tinted color-map view, a clickable glyph grid,
and a live text-rendering field (string input + ink-color picker)
that uses the currently-selected room's CLUT. 191 tests across 20
files; new `docs/SCUMM-V5-CHAR.md` format reference.

#### Original task checklist (all complete)

**Charset decoder — `src/engine/graphics/charset.ts`**

- [x] `walkCharsets(file)` — iterate `LECF > LFLF > CHAR` blocks in source order
- [x] `parseCharHeader(payload)` — size, magic, 15-byte color map, bpp (1 or 2), fontHeight, numChars, glyph offset table
- [x] `glyphPayloadOffset(header, charCode)` — resolves the **+21 anchor** convention (offsets are payload-relative to byte 21, not byte 0; value 0 is "no glyph" sentinel)
- [x] `decodeGlyph(payload, absOffset, bpp)` — 4-byte per-glyph header (width u8, height u8, xOffset i8, yOffset i8) + bit-packed pixel stream (row-major, MSB-first within each byte, **no per-row padding**)

**Text renderer — `src/engine/graphics/text.ts`**

- [x] `measureText` — bounding box for a string, honoring per-glyph advance + xOffset extension
- [x] `renderText(payload, header, text, colorMap)` — column-major emit of glyph stamps; `\n` newline support; zero-value pixels stay `CHARSET_TRANSPARENT`; non-zero glyph values route through caller-provided color map to CLUT indices

**Format reference — `docs/SCUMM-V5-CHAR.md`**

- [x] Block tree position, mental model (color map as palette routing for actor talk colors), payload layout field-by-field, ⚠️ +21 anchor convention with the "anchor probe" verification trick, 1-bpp and 2-bpp packing rules with a worked example, 15-byte color-map slot semantics (slot 0 always transparent, slots 1..2^bpp − 1 active), text layout semantics, 8-step "decode-to-pixels" walkthrough, 8-entry pitfalls cheat sheet

**Player UI — charset inspector — `src/shell/player/player.ts`**

- [x] LFLF-scoped charsets section, slotted in below costumes; same prev/next nav-per-LFLF pattern
- [x] Header summary: `N bpp · fontHeight=H · K populated / M slots · magic=0x0363 · payload N B`
- [x] Color map swatch grid: 15 cells with CLUT indices, tinted with the real game color from the current room's CLUT; "active" slots (1..2^bpp − 1) get an accent border
- [x] Glyph grid: every populated glyph rendered at 3× scale through the charset's color map, with the printable char or `\xNN` as a label, click to expand
- [x] Glyph detail panel: hex peek of the per-glyph header (4 bytes highlighted) + bitmap body, 6× preview, advance/offset metadata
- [x] Text-rendering widget: free-form text input (defaults to `GUYBRUSH THREEPWOOD`), ink-color number input that overrides color-map slot 1 live, 2× rendered canvas updating on every keystroke

**Tests**

- [x] `charset.test.ts` (16) — `walkCharsets`, `parseCharHeader` (1-bpp, 2-bpp, malformed headers, oversized numChars), `glyphPayloadOffset` (+21 anchor, sentinel, out-of-range), `decodeGlyph` (MSB-first row-major, signed offsets, 2-bpp straddle, zero-dim glyphs, bitstream truncation)
- [x] `text.test.ts` (12) — `measureText` (empty / single / multi-char / newline / missing glyph), `renderText` (ink color, transparency, side-by-side layout, per-glyph xOffset, newline stacking, 2-bpp color routing, colorMap-too-short error)

#### Bonuses

- **Anchor-probe scratch script** — `scratch/inspect-charsets.ts` automatically probes five plausible offset anchors (absolute, +21, +23, +25, +29) for the first non-zero glyph-offset entry and reports which one decodes as a sensible glyph header. The +21 finding came from this in a single pass.
- **CLUT-tinted color-map swatches** — instead of showing raw CLUT indices as numbers, each cell of the color map renders with the actual game color from the currently-selected room's CLUT. The font's "intent" reads at a glance — slot 1 is whatever shade Guybrush's talk color picks, slot 2/3 the outline/fill ramp for 2-bpp fonts.
- **ASCII-print scratch** — `scratch/print-glyphs.ts` decodes a range of characters via the engine's own decoder and prints them as terminal-readable ASCII glyphs. Used to verify all 5 MI1 charsets + the MI2 charsets at 1- and 2-bpp before claiming the decoder correct.
- **`yOffset` honored throughout** — MI1 charset #4 (2-bpp, big credits font) uses `yOff = 1` on every glyph to drop them below the cursor's baseline. Our renderer honors this without special-casing.

#### Notable design choices made during implementation

- **+21 anchor for glyph offsets** — the long-circulating-notes-style "offset is from start of payload" reading produces glyph offsets pointing into the offset table itself. Adding 21 (the byte position of the `bpp` field, which is also the start of the "logical charset metadata" block) lands every offset at a valid glyph header. Verified empirically via the anchor-probe scratch on all 5 MI1 charsets.
- **MSB-first row-major, no per-row padding** — bits flow continuously across row boundaries within a glyph. A 7×7 1-bpp glyph fits in 49 bits = 7 bytes minus 7 trailing bits, NOT 7 bytes per row × 7 rows. Our `decodeGlyph` reads bit-by-bit so the bpp=2 straddle case is handled naturally.
- **Slot 0 is always transparent** in the color map, regardless of what `colorMap[0]` contains. Mirrors the COST convention; lets the same charset render in any color without re-encoding.
- **Same decoder works for MI1 and MI2.** The 2-byte offset shift that MI2 COST blocks need does NOT apply to MI2 CHAR blocks — both games parse identically. Verified visually.
- **Color map filler is real** — slots 4..15 for both 1-bpp and 2-bpp charsets contain a sequential `0x04, 0x05, … 0x0f` filler pattern across every charset we inspected. Almost certainly the encoder's default fill; the UI marks them as inactive (muted) so they're visibly distinct from the slots actually used.
- **Newline = `fontHeight` advance, no inter-line gap.** Simplest possible vertical layout; word-wrap and text-box geometry are downstream concerns deferred to dialog UI.
- **Diagnostic UI is permanent.** Glyph grid + color-map view + text input stay in the player even when scripts eventually drive the renderer.

#### Open issues / known limitations

- **No dialog escape codes.** Strings containing `0xFF`-prefixed sequences (wait, sound, variable substitution, runtime color change) attempt to look up character `0xFF` in the glyph table rather than treating them as control codes. VM concern; lands alongside the bytecode interpreter.
- **No word wrap / text-box layout.** The renderer draws a single-line stream split on `\n` only. Speech-bubble positioning above an actor's head, multi-line wrapping, and alignment are downstream.
- **No actor-bound talk colors.** Color comes from the player UI's ink input. A real script picks a color per actor and the engine passes it to the renderer.
- **Empty `numChars = 0` charsets rejected.** Defensive — we throw rather than silently producing an empty inspector. Hasn't surfaced in real data.
- **Magic `0x0363` not validated.** Every MI1/MI2 charset has it; we parse and surface it but don't reject unknown magic values.

---

### Phase 3 — Costumes *(2026-05-26)*

Decodes SCUMM v5 costumes end-to-end — sub-palette, image tables,
RLE-encoded frame pictures — plus the z-plane occlusion masks that
back actor compositing. The player UI gains a hierarchical resource
browser (rooms with LFLF-scoped costumes nested below), a
comprehensive costume inspector (header diagnostics, palette
swatches, color-keyed hex dump, limb-table chip grid, per-frame
preview canvas through the active room's CLUT), per-z-plane overlay
toggles, and a live actor compositor with click + drag positioning.
163 tests across 18 files. Two new format references in `docs/`.

#### Original task checklist (all complete)

**Costume decoders — `src/engine/graphics/costume.ts`**

- [x] `walkCostumes(file)` — iterates `LECF > LFLF > COST` in source order, indexed by LFLF position
- [x] `parseCostumeHeader(payload)` — `numAnim`, format byte (mirror + 16/32-color), sub-palette, `animCmdOffset` (= `frameOffs`), 16 `limbOffsets` (= `imageTableOffs`), `animOffsets`
- [x] `decodeLimbTables(payload, header)` — group limbs by shared offset, decode u16 LE pointer arrays, flag suspicious entries

**Frame decoder — `src/engine/graphics/costume-frame.ts`**

- [x] 12-byte image header parse: `width u8`, unknown u8, `height u8`, unknown u8, `x i16`, `y i16` ◀ frame pointer lands here, `xinc i16`, `yinc i16`
- [x] `decodeCostumeFrame(payload, framePtr)` — column-major emit; 16-color RLE with `length == 0 → next byte is the real length` extended-length escape
- [x] Costume palette index 0 → `COSTUME_FRAME_TRANSPARENT` (`0xFF`) sentinel

**Z-plane decoder — `src/engine/graphics/zplane.ts`**

- [x] `parseRmihPlaneCount(payload)` — u16 LE plane count from RMIH
- [x] `decodeZPlanes(file, roomBlock, w, h)` — walks `RMIM > IM00` for ZP## blocks
- [x] `decodeZPlane(payload, w, h)` — packbits-style RLE (high bit = run, clear = literal), MSB-first bit layout within emitted byte, offset-0 sentinel for implicit all-zero strips
- [x] `zplaneBit(plane, x, y)` — O(1) accessor with out-of-bounds = 0

**Actor compositor — `src/engine/graphics/composite.ts`**

- [x] `compositeActor({ framebuffer, fbW, fbH, frame, costPalette, actorX, actorY, actorZ, zPlanes })` — maps costume indices through CLUT, edge-clips, applies the "any plane index > actorZ hides" occlusion rule

**Player UI — `src/shell/player/`**

- [x] Hierarchical resource browsing: room nav drives the costume list (LFLF-scoped); navigating rooms updates the costumes underneath
- [x] Costume header diagnostics — format, palette, offsets, payload size
- [x] Color-keyed payload hex dump (`numAnim` / `format` / `palette` / `animCmdOffset` / `limbOffsets` / `animOffsets` each in a distinct tint)
- [x] Limb-table chip grid; trailing junk + "unused sentinel" groups handled cleanly
- [x] Frame chip click → hex peek + 3-candidate header-layout viewer + decoded preview canvas (real CLUT) + "Place on current room" button
- [x] Z-plane overlay canvas stacked over the room canvas with per-plane toggle buttons
- [x] Actor placement: defaults adapt to current room dimensions (200-tall vs 144-tall); x / y / z number inputs
- [x] Click + drag the room canvas to reposition the actor; smooth re-composite without DOM rebuild

**Format references — `docs/`**

- [x] `SCUMM-V5-COST.md` — block layout, mental model (slots/limbs/anims, three indirections), the +6 pointer convention, 16- and 32-color RLE with the length-zero escape, column-major emit, the feet-anchor convention with worked Guybrush example, MI2's 2-byte offset shift, end-to-end decode walkthrough, 10-entry pitfalls cheat sheet
- [x] `SCUMM-V5-ZPLANE.md` — RMIH, header-inclusive offsets, the offset-0 sentinel, packbits RLE with a worked strip decode, MSB-first bit order, the "any plane > actorZ" rule, explanation of overlapping pixels across planes and why a declared plane can be entirely empty (MI1 LFLF #6 ZP02), 8-entry pitfalls cheat sheet

**Tests**

- [x] `costume.test.ts` (13) — `walkCostumes`, header (16/32-color, mirror, truncation), `decodeLimbTables` (grouping, suspicious flagging, empty)
- [x] `costume-frame.test.ts` (10) — flat fills, signed displacements, column-major straddling, transparency, extended-length escape (including > 16), `xinc/yinc`, zero-dim and truncated-RLE errors
- [x] `zplane.test.ts` (13) — RMIH parse, MSB-first bit layout, literal + run sequencing, multi-strip, offset-0 sentinel, error paths, bit accessor
- [x] `composite.test.ts` (10) — opaque pass-through, transparency, redirX/Y, edge clipping (all 4 sides), multi-plane occlusion, dimension errors

#### Bonuses

- **LFLF-scoped resource browsing.** Realized mid-phase that "browse 119 flat costumes" doesn't match how the file is organised. Costumes (and any later resource types — scripts, charsets, sounds) now nest under the current room's LFLF.
- **Click + drag actor placement.** Initially just number-input fields; the user pointed out "drag" was implied so I wired up pointer events with a light-refresh path that re-composites onto the existing canvas without rebuilding any DOM.
- **Real-CLUT frame previews.** Before this, frames previewed with a rainbow palette that made every sprite look like Christmas. Routing through the active room's CLUT shows actual game colors at a glance.
- **3-candidate header-layout viewer.** For any candidate frame pointer, shows what width/height/redir would read as under three offset-into-header conventions. Made the +6 discovery a single-look exercise.
- **Smart "Place on current room" defaults.** Adapts `(x, y)` to the current room's dimensions so the default lands on-screen for both 200-tall outdoor and 144-tall interior rooms.
- **`scratch/` debug scripts** (gitignored) — five small scripts for inspecting real game data through the engine's own decoders. The workflow was: write a hypothesis, dump real bytes against it, iterate. Kept around for the next phase.

#### Notable design choices made during implementation

- **Anim-record decoding deferred to the VM phase.** The variable-length anim command stream is what the runtime uses to play animations frame-by-frame; for "render one static frame" we pick limb + frame directly.
- **Frame pointer at +6 into the image header.** The natural "pointer at struct start" reading produces `width = 0xFFFC`. The format keeps the pointer at the `y` field, likely a side effect of the original engine doing a single dword load on `(x, y)`.
- **RLE `length == 0` is an extended-length escape, not "run of 16".** With "run of 16", consumed byte count exceeded the available region by 8 bytes on Guybrush's idle frame, spilling garbage into the rightmost columns. With the escape rule, the count lands exactly on the next frame's header.
- **Costume color 0 = transparent** regardless of `palette[0]`'s value. Sentinel emit lets the compositor skip cleanly.
- **Z-plane offset-0 sentinel for all-zero strips.** Saves bytes for sparse masks; would crash a naive "subtract 8 → negative offset" decode.
- **Z-plane MSB-first within each emitted byte.** Visually verified by overlaying decoded masks on real MI1 room geometry.
- **Z-plane rule: "any plane index > actorZ hides".** Plane indices run 1..N. `actorZ = 0` (default) is occluded by everything; raising `actorZ` pulls the actor forward past planes one at a time.
- **Compositor reads `costPalette[idx]` → `roomCLUT[clutIdx]` inline.** Keeps frame data palette-agnostic; the same costume renders correctly in any room's CLUT.
- **LFLF index, not DROO id.** Rooms and costumes are indexed by their position in the LECF tree; the UI shows both "Room N of M" and "LFLF #X".
- **Drag uses a light-refresh path.** Re-composites onto the existing canvas (no DOM rebuild) so the canvas element stays alive through the drag and pointer events route to the same captured target. Full refresh (which rebuilds the section, in turn syncing x/y/z input field values) fires once on pointerup.

#### Open issues / known limitations

- **MI2's 2-byte offset shift not yet patched.** Documented in `docs/SCUMM-V5-COST.md` §6; MI2 costumes will decode garbage until applied.
- **32-color mode (format byte 0x59) not implemented.** Every MI1/MI2 costume in our sample is 16-color. Format documented but no decoder path.
- **Mirror flag (format bit 7) parsed but not acted on.** No costume in our sample has it set.
- **Anim record stream not decoded.** VM concern. Picking limb + frame happens directly in the UI; no animation playback exists.
- **No DROO interpretation.** Script-driven `setRoom` / `setCostume` calls would need DROO resolution.
- **No actor scaling.** The SCAL block (per-y scaling that shrinks actors walking "away" from the camera) is not consulted; actors render at native resolution at all room positions.

---

### Phase 2 — First pixels *(2026-05-26)*

Decodes the palette and background bitmap of any selectable room in
MI1 / MI2 and renders it on a Canvas2D at native resolution with
TRNS-aware transparency (transparent regions show through to a CSS
checkerboard so object placeholders are visually obvious). The block
tree from Phase 1 stays visible below; a new per-strip method bar +
histogram chip list expose SMAP decoder behavior at a glance. 116 tests
across 14 files.

#### Original task checklist (all complete)

**Block payload access — `src/engine/resources/tree.ts`**

- [x] `ResourceFile = { bytes, tree }` — single value carried by every Phase 2 decoder
- [x] `payloadOf(file, block)` — `subarray` of the block's body
- [x] `findChild` / `findChildren` / `findDescendant` — navigate by tag
- [x] `parseResourceFile` now returns `ResourceFile`

**Room navigation — `src/engine/graphics/room.ts`**

- [x] `walkRooms(file)` iterates `LECF > LFLF > ROOM` in source order, indexed by LFLF position
- [x] `decodeRoom(file, roomBlock)` composes RMHD + CLUT + SMAP + TRNS into a `DecodedRoom`

**Leaf decoders — `src/engine/graphics/`**

- [x] `rmhd.ts` — three 16-bit LE fields (`width`, `height`, `numObjects`)
- [x] `clut.ts` — 768-byte RGB palette in 0..255 (no bit-scaling needed; values are stored DAC-shifted)
- [x] `smap.ts` — full dispatcher across `0x01`, `0x0E..0x12`, `0x18..0x1C`, `0x22..0x26`, `0x2C..0x30`, `0x40..0x44`, `0x54..0x58`, `0x68..0x6C`, `0x7C..0x80`; uncompressed + Method 1 (V/H, opaque + transparent) + Method 2 (H, opaque + transparent + aliases)
- [x] `trns.ts` — 16-bit LE transparent palette index *(bonus — see below)*

**Renderer — `src/engine/render/`**

- [x] `Renderer` interface: `setPalette`, `setTransparentIndex`, `present`, `dispose`
- [x] `Canvas2DRenderer` — composes indexed + palette → `ImageData`, honours transparent index (alpha=0)
- [x] `MemoryRenderer` — records latest palette/framebuffer/transparent for tests; `rgbaSnapshot()` helper
- [x] `indexedToRgba` — pure helper, transparent index → alpha=0, rest opaque

**Player screen integration — `src/shell/player/`**

- [x] Room viewer section above the block tree
- [x] Prev / next room selector with `Room N of M · LFLF #X` label
- [x] Canvas at native room dimensions, CSS-scaled 2× with `image-rendering: pixelated`
- [x] CSS checkerboard background reveals transparent (TRNS) pixels
- [x] Per-strip method bar (color-coded by family) aligned with the canvas
- [x] Histogram chip list summarizing the codes used by this room
- [x] Loading + decode-error states inline

**Tests**

- [x] `tree.test.ts` — 11 tests on payloadOf / findChild / findChildren / findDescendant
- [x] `rmhd.test.ts` — 5 tests
- [x] `clut.test.ts` — 4 tests
- [x] `trns.test.ts` — 3 tests
- [x] `smap.test.ts` — 32 tests: dispatch, uncompressed, **full Method 1 grammar coverage**, **full Method 2 grammar coverage** (each delta, RLE + clamp, aliases, transparent variants), strip-method diagnostic helper
- [x] `indexed-to-rgba.test.ts` — 5 tests including transparency
- [x] `memory.test.ts` — 6 tests including transparency round-trip
- [x] `room.test.ts` — 4 tests on `walkRooms` (LFLF iteration, skipped LFLFs, missing LECF, etc.)

#### Bonuses

- **TRNS / transparency support** — added when room viewing surfaced
  "purple bars" that turned out to be object placeholders. Renderer
  interface grew `setTransparentIndex`, indexed-to-RGBA learned to emit
  RGBA(0,0,0,0) for the configured index, CSS checkerboard backdrop on
  the canvas exposes those regions visually.
- **Per-strip method diagnostic UI** — `getSmapStripMethods` helper
  plus a color-coded cell bar aligned with the canvas and a histogram
  chip list. Made every subsequent SMAP debugging round much faster.
- **`docs/SCUMM-V5-SMAP.md`** — a self-contained format reference
  covering layout, bit-stream conventions, full method dispatch, both
  compression algorithms with prose explanations, and the two specific
  corrections we needed to make over the long-circulating notes.

#### Notable design choices made during implementation

- **`ResourceFile` flows through everything.** Decoders take
  `(file, block)` and slice on demand; no copy, no re-decryption, and
  no "did you pass the right payload?" bug class.
- **Engine code stays DOM-free.** Only the shell touches
  `FileSystemDirectoryHandle` / `File`; engine layer consumes
  `Uint8Array` / `ResourceFile`.
- **SMAP offsets are header-inclusive.** The decoder gets the payload
  and subtracts 8 inside `readStripOffsets`. Symptom of getting this
  wrong is wildly varying compression codes (255, 0, 247…) and was
  the first debugging milestone.
- **Method 2 delta sign is inverted from the circulating notes.** The
  working dispatch is `color -= (4 - d)`. Verified empirically against
  MI1 / MI2 strips; opposite sign produces unmistakable color-cycling
  artifacts in gradient regions.
- **Method 2 paletteBits subtract for `0x54..0x58` is `0x50`, not
  `0x51`.** The notes' value yields pb=3..7 which conflicts with every
  other range. Symptom: localized garbage on codes 87 / 88 only.
- **Canvas2DRenderer clears before each present.** Transparent pixels
  in the new frame must expose the CSS checkerboard, not blend with
  the prior frame.
- **Room indexing by LFLF position, not game id.** DROO decoding is
  deferred until scripts actually call `setRoom`. The UI shows both
  "Room N of M" and "LFLF #X" so the cross-reference is explicit.

#### Open issues / known limitations

- **No actor / object compositing yet.** Areas marked transparent by
  TRNS show through to the checkerboard. They'll be filled by OBIM
  sprites in Phase 3+.
- **No DROO interpretation.** Rooms indexed by LFLF position; room IDs
  used inside scripts are not yet resolved.
- **No palette cycling / fades.** The CYCL block is not decoded.
- **MI2 cutscene rooms render as solid colors.** That's correct —
  rooms 103 (all black) and 108 (all purple) really do ship as 40
  identical-color strips for fade/transition effects.

---

### Phase 1 — Resource catalog *(2026-05-25)*

Parses `MONKEY.000` + `MONKEY.001` (and MI2 equivalents) end to end:
File System Access permission re-grant, slurp + byte-XOR-decrypt with
key `0x69`, recursive walk of the SCUMM v5 block tree, indented per-line
tree dump in the player screen with a tag-by-tag description from a
single-source-of-truth catalog. 46 tests across 6 files.

#### Original task checklist (all complete)

**Permission re-grant**

- [x] `src/shell/storage/permission.ts` — `ensureReadPermission(handle)` queries+requests `'read'` mode
- [x] Wired into the library's Play button (re-grant before navigating)
- [x] Denial path: navigate to `{ kind: 'library', flash: '…retry.' }` and render an inline flash banner

**XOR layer — `src/engine/resources/xor.ts`**

- [x] Pure `xorDecrypt(data, key)`, returns a new buffer
- [x] `SCUMM_V5_XOR_KEY = 0x69` constant with comment noting other v5 releases may differ
- [x] 6 tests: empty input, identity at key=0, round-trip, per-byte XOR, no mutation, key constant value

**Block parser — `src/engine/resources/block.ts`**

- [x] `Block { tag, offset, size, children? }` with `children` set iff the tag is a known container
- [x] `parseBlocks(data, baseOffset = 0)` — recursive walker
- [x] BE 32-bit size, size includes the 8-byte header
- [x] `isContainerTag(tag)` — closed set + `^IM[0-9A-F]{2}$` regex for image containers
- [x] `BlockParseError` with byte offset on zero-size, overshoot, truncated header
- [x] 15 tests: leaf, sequence, nested, deeply nested, unknown→leaf, empty container, error paths, `baseOffset`

**File adapter — `src/engine/resources/file.ts`**

- [x] `parseResourceFile(encrypted, xorKey)` — composes `xorDecrypt` + `parseBlocks`
- [x] No DOM types in the engine layer — shell does `FileSystemDirectoryHandle` → `File` → `Uint8Array`
- [x] No standalone tests; covered transitively by xor + block tests

**Player screen rewrite — `src/shell/player/player.ts`**

- [x] Back button + header (game name, gameId, source dir)
- [x] Loading state while files are read + parsed
- [x] Two sections (Index, Resources) with stats (block count, top-level count, file size)
- [x] Indented per-line tree, monospace, color-coded (tag accent, meta muted, description italic)
- [x] Case-insensitive filename match in `findFile` (handles uppercase/lowercase game files)
- [x] Error state with file/parse error message

**Tests**

- [x] Phase 1 added 27 tests (xor: 6, block: 15, catalog: 6). Total: 46 across 6 files.

#### Bonus: block-description catalog

Added during browser review when you flagged "would be SUPER NICE to know
what each block means". Single source of truth at
`src/engine/resources/catalog.ts`, used inline by the player UI.

- [x] `describeBlock(tag)` covers every block currently emitted by the parser, plus `IM[0-9A-F]{2}` and `ZP[0-9A-F]{2}` patterns
- [x] Test asserts every container tag in the parser has a catalog entry (parser/catalog stay in sync)

#### Notable design choices made during implementation

- **`children !== undefined` distinguishes containers from leaves**,
  even for empty containers (which get `children: []`). Cleaner than
  using a separate `isContainer` field that could drift from `children`.
- **Per-line `<div>`s, not `<pre>`** in the tree view, so the
  description can render in a distinct muted/italic style. With ~2-3k
  blocks in MI1's `.001` this is still well under 100 ms to paint.
- **Catalog as data, not docs.** Descriptions live in TS alongside the
  parser. The UI is the primary surface; if a separate Markdown
  reference is wanted later, we can generate it from the catalog.
- **`flash` state on the library Screen**, added so permission denial
  has somewhere to land that isn't an `alert()`.

---

### Phase 0 — Scaffold *(2026-05-25)*

Runnable empty app: Vite + TypeScript + Vitest scaffold, library /
install / player-placeholder screens with a state-machine shell, game
detection, IndexedDB persistence of directory handles, browser-support
gating, 15 passing tests across 3 files. `npm run dev` serves the
library; `npm test` watches.

#### Original task checklist (all complete)

**Project setup**

- [x] `npm init`, add `.gitignore`
- [x] Install dev deps: `vite`, `typescript`, `vitest`, `@types/node`, `fake-indexeddb`, `@types/wicg-file-system-access`
- [x] `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`)
- [x] `vite.config.ts`
- [x] `vitest.config.ts` (`environment: 'node'`)
- [x] `index.html` + `src/main.ts`
- [x] npm scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `test:run`
- [x] `npm run dev` boots and serves the library screen

**Test harness**

- [x] Trivial Vitest sanity test (`src/sanity.test.ts`)
- [x] `npm test` runs in watch mode, green

**Shell skeleton**

- [x] Screen state machine in `src/shell/app.ts` (`library` | `install` | `player`)
- [x] Directory structure per ARCHITECTURE.md §8

**Library screen — `src/shell/library/`**

- [x] Lists installed games from IndexedDB, with empty-state copy
- [x] "Install game…" button → install screen
- [x] Per-game row: name, gameId, Play button (navigates to player placeholder), Remove button
- [x] Remove deletes the IndexedDB record only — user's files are untouched

**Install flow — `src/shell/install/`**

- [x] Triggers `window.showDirectoryPicker({ mode: 'read' })` on button click
- [x] Game detection in `detect.ts` (pure, filename-based, case-insensitive)
- [x] On success: persist `{ id, displayName, gameId, directoryHandle, installedAt }` to IndexedDB, return to library
- [x] On unknown: error message with retry/cancel
- [x] User cancel (AbortError) is silent

**IndexedDB layer — `src/shell/storage/`**

- [x] `games` object store with CRUD wrappers (`listGames`, `addGame`, `removeGame`, `getGame`)
- [x] Each operation opens + closes its own DB connection (simple, no shared state)
- [x] *(Deferred to launch time)* Permission re-grant flow before passing the handle to the engine — left as a TODO comment for Phase 2 when there's actually something to launch

**Browser support**

- [x] `checkBrowserSupport()` detects missing `showDirectoryPicker` and `indexedDB`
- [x] Renders an "Unsupported browser" page instead of crashing

**Tests for Phase 0**

- [x] `detect.test.ts` — 8 tests: positive MI1, positive MI2, case-insensitive, missing file, empty, unrelated, extra files, MI1/MI2 disambiguation
- [x] `games.test.ts` — 6 tests: empty store, add+list, round-trip by id, remove, unknown id, multiple games independent. Uses `fake-indexeddb/auto`, resets the DB between tests.
- [x] `sanity.test.ts` — 1 test: arithmetic sanity check

#### Notable design choices made during implementation

- **Detection takes `string[]`, not a directory handle.** Pure function,
  trivially testable in Node. The directory-walking adapter lives in
  shell-only `install.ts`, which the test suite doesn't touch.
- **No shared DB connection.** Every storage call opens, transacts, and
  closes its own `IDBDatabase`. Simpler than connection pooling, fine for
  the access pattern (one user action at a time). Revisit if it ever
  matters.
- **Permission re-grant deferred.** Stored a TODO for when the player
  screen actually needs to open the files (Phase 2). Phase 0's player is
  a placeholder, so there's nothing to authorize yet.
- **`@types/wicg-file-system-access`** was needed — TypeScript's built-in
  `lib.dom.d.ts` covers `FileSystemDirectoryHandle` and `entries()`, but
  not `Window.showDirectoryPicker`.
