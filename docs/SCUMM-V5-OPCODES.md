# SCUMM v5 — Opcode Dispatch + Bytecode Conventions

This document covers what we learned implementing the SCUMM v5
bytecode interpreter end-to-end against MI1's boot script: opcode
encoding, parameter-mode bits, variable-reference scope, the
expression mini-VM, conditional branch semantics, and the assorted
gotchas. The per-opcode reference (what every byte from 0x00..0xFF
*does*) lives at the source URL below — this document covers the
parts that *aren't* per-opcode: the dispatch infrastructure that
every opcode plugs into.

## Sources

- ScummVM v5 opcodes reference (wiki), at
  <https://wiki.scummvm.org/index.php?title=SCUMM/V5_opcodes>.
  Per-opcode descriptions for the full 256-entry table, including
  the parameter conventions (`p8`, `p16`, `v16`, etc.) we follow
  throughout the dispatcher. Single best source for opcode-by-opcode
  details we don't repeat here.
- Cross-checked against MI1's real boot bytecode (`SCRP` script
  #1) opcode-by-opcode. Several conventions we initially misread
  surfaced as runaway loops or out-of-range variable writes, and
  those corrections are captured in §3 and §4 below.

## 1. Opcode byte encoding

Every opcode is a single byte:

```
  bit:  7   6   5   4   3   2   1   0
       ┌───┬───┬───┬───┬───┬───┬───┬───┐
       │ a │ b │ c │   opcode family   │
       └───┴───┴───┴───┴───┴───┴───┴───┘
```

- **Bits 0..4 — opcode family** (32 possible families).
- **Bits 5..7 — parameter mode flags** for the family's three
  parameter slots: bit 7 (`0x80`) selects var-ref-vs-immediate for
  parameter 1, bit 6 (`0x40`) for parameter 2, bit 5 (`0x20`) for
  parameter 3.

That means **one logical opcode like `setVar` is represented by
multiple byte values** — `0x1A` is `setVar` with all params
immediate, `0x9A` is `setVar` with param 1 as a var-ref, and so on.
Our dispatcher registers each byte separately, sometimes pointing
at a shared handler that reads `opcode & 0xE0` to decide what to
do.

**Don't over-generalize.** Not every opcode uses all three mode
bits. `setVar`'s first parameter is *always* a raw destination
var-ref word — bit 7 only affects the second parameter's mode. The
`inc` / `dec` family uses bit 7 to choose *which operation* rather
than as a param-mode flag (`0x46` = `inc`, `0xC6` = `dec`). Each
handler reads the mode bits it cares about; the param decoder
exposes `isVarParam(opcode, paramIndex)` to make the read explicit.

## 2. Variable-reference word

When a parameter is a var-ref (rather than an immediate), the next
two bytes form a u16 LE **reference word** whose top bits select
the variable's scope:

| Top bits          | Scope          | Index field             |
|-------------------|----------------|-------------------------|
| `0x8000` set      | **Bit-var**    | bits 0..14 (0..16383)   |
| `0x4000` set      | **Local var**  | bits 0..11 (0..4095)    |
| `0x2000` set      | **Indexed**    | bits 0..12 + extra word |
| (none set)        | **Global var** | bits 0..12 (0..8191)    |

**This is the convention that bit MI1's boot.** Phase 5 had it
backwards (we'd used `0x8000` for locals and `0x4000` for bit-vars,
matching one outdated note), which caused `actorOps` and similar
opcodes to write into the wrong scope and silently corrupt slot
locals. The MI1 boot's `actorOps actor=1, setName("Guybrush")`
revealed the bug: the bytecode encodes `actor.locals[ref & 0xFF]`
expecting `0x4000` to mean local, and our wrong reading hit a
local index of 0x80 (= 128) which is out of range for the 25-slot
local table.

### Indexed (array) references

When bit `0x2000` is set, the reference describes an *indexed*
deref into an array variable. The first word is the base ref, and
a **second** word follows that supplies the offset (either as an
immediate or as another var-ref via its own `0x2000` bit). The
final resolved index = `(base & ~0x2000) + offset`.

MI1 uses indexed refs sparingly — Phase 5 deferred them with a
loud halt, but the boot script's setup of the verb table at
`setVar 0x800f` actually hits this path, so we wired it in Phase 6.

### Variable-bank sizes

The runtime allocates `Variables` from MAXS at boot. Per MI1's
MAXS: 800 globals, 16 room-vars (one set per room), 2048 bit-vars.
Locals are 25 entries *per slot*. Sizes can vary; the engine
floor-clamps to those values via `Math.max(maxs.numVariables,
800)` so under-sized MAXS records don't break the boot prefix.

### Out-of-range access — lenient mode

MI1 ships several scripts that **write past MAXS** in dead-code
paths (script #12 writes to global #1542 in a branch the player
never reaches). The original SCUMM engine had no bounds checks;
ScummVM crashes via `checkRange`. Our `Variables` class splits the
difference: OOB reads return 0, OOB writes are silently absorbed,
and every access is recorded on `vars.oobAccesses` (a per-(scope,
index, kind) counter) so the inspector can surface them.

This keeps the engine progressing through unreachable code without
losing visibility into what was attempted.

## 3. Conditional branches — the gotcha

The six comparison opcodes (`isLess` `0x44`, `isGreater` `0x78`,
`isLessEqual` `0x38`, `isGreaterEqual` `0x04`, `isEqual` `0x48`,
`isNotEqual` `0x08`, plus their var-ref variants `0xC4`, `0xF8`,
`0xB8`, `0x84`, `0xC8`, `0x88`) read the same parameter shape:

1. `var` (raw u16 LE ref word, then dereferenced)
2. `value` (immediate or var-ref via bit 7)
3. `delta` (signed 16-bit branch offset)

The wiki gives the canonical form **`unless (value OP var) goto
target`**. So the byte stream is `var, value, delta`, and the jump
fires when the named condition is *false* — body runs when the
condition holds.

The boot script's case-switch in script #12 (which routes on
`var[0]`) and the verb-table-setup loop in script #177 (which
iterates while `i < N`) both rely on this convention. Phase 5
implemented the inequality forms backwards (jump-when-true instead
of jump-when-false), which manifested as a runaway loop in script
#177 — it never exited the setup loop. The correction was a
straight inversion of all four inequalities; the equality opcodes
were already right.

The `equalZero` (`0x28`) and `notEqualZero` (`0xA8`) opcodes are
simpler — they read a single `var` and a `delta` and jump when the
named condition is true (`equalZero` jumps when var == 0; the doc
inversion only affects the comparison family).

## 4. Expression mini-VM (`0xAC`)

`0xAC` runs a tiny stack-based mini-VM until it hits a terminator
byte (`0xFF`). The opcode is structured:

```
0xAC
u16 LE  dest_var_ref       — where the result lands
<subops, each a 1-byte selector + optional operands, until 0xFF>
0xFF
```

The subop byte uses the same encoding as a regular opcode — low 5
bits select the action, bit 7 is a param-mode flag for the push
operand:

| Subop (low 5) | Action                                                    |
|---------------|-----------------------------------------------------------|
| `0x01`        | push value (next 2 bytes: u16 immediate, or var-ref word if bit 7 set) |
| `0x02`        | add — push(pop() + pop())                                 |
| `0x03`        | sub — push(pop() - pop())                                 |
| `0x04`        | mul                                                       |
| `0x05`        | div — throws on divide-by-zero                            |
| `0x06`        | execute opcode and push VAR(0) (deferred — not in MI1 boot)|
| `0xFF`        | terminator                                                |

The mini-VM's stack is local to one `0xAC` invocation; there's no
cross-call retention. At the terminator the single remaining stack
value is written to the destination var via the regular `writeRef`
machinery.

A key surprise: bit 7 of the subop byte is what selects "operand
is a var-ref" — so push-immediate is encoded `0x01 lo hi` and
push-var is `0x81 lo hi`. Our initial implementation treated push-
var as a separate subop number, which made every var-substitution
in the MI1 boot evaluate to garbage.

## 5. Multi-subop opcodes

Many opcodes (cursorCommand `0x2C`, stringOps `0x27`,
resourceRoutines `0x0C`, roomOps `0x33`, actorOps `0x13`, verbOps
`0x7A`, …) read a u8 selector after the main opcode and dispatch
to one of N sub-handlers. The selector byte uses the same encoding
as a regular opcode: low 5 bits are the action, high 3 are param-
mode flags for that sub-handler's arguments.

So `cursorCommand initCharset` with an immediate charset id is
`0x2C 0x0D 0x03` (subop low 5 = 0x0D = initCharset, byte param =
0x03), and with a var-ref charset id it's `0x2C 0x8D 0xref_lo
0xref_hi`. Same convention as the parent opcode.

`actorOps` is the heaviest of these — 24 sub-actions covering
setCostume, setWalkSpeed, talk frames, init, elevation, palette
remap, talk color, name (NUL-terminated string), width, scale,
ignore-boxes / follow-boxes, anim speed, shadow mode, etc.

`verbOps`, `roomOps`, and `cursorCommand` are similar but smaller.
`drawObject` uses a subop *loop* (each subop in a sequence until
`0xFF`) — semantically more like `0xAC`'s mini-VM than a single
selector.

## 6. Script slots and the cooperative scheduler

The VM owns 25 script slots, each holding `(scriptId, bytecode,
pc, locals, status)`. Status transitions:

```
dead  ──start──▶  running  ──yield──▶  yielded  ──resume──▶  running
                     │                                              │
                     ├── kill ─▶  dead                              │
                     │                                              │
                     └── freeze ─▶ frozen  ◀──── resume ────────────┘
```

Cooperative: scripts run until they call `breakHere` (`0x80`) or
`stopObjectCode` (`0x00`/`0xA0`). The dispatcher rotates round-robin
through `running` slots one opcode at a time. The main loop drains
to "all slots yielded/dead" each tick, resumes all yielded slots,
and ticks again. There's no time-sliced preemption — long-running
opcodes (especially `0xAC` expression evaluation) run to
completion.

**Synthetic slots.** Some scripts the engine starts internally —
the room's `ENCD` (entry script) and `EXCD` (exit script) when
transitioning rooms — get a string `label` field so the inspector
can show them as `ENCD-10` or `EXCD-10` instead of the misleading
`script #0`. Verb scripts and sentence scripts will use the same
mechanism in Phase 7.

**Runaway-loop guard.** `runUntilAllYield(maxSteps=100_000)`
treats step-cap exhaustion as a halt — converts the most common
bug class (a tight loop with no `breakHere`) into a clean
diagnostic instead of a hung browser tab.

## 7. Script id ranges

| Range       | Scope                    | Resolved via                            |
|-------------|--------------------------|------------------------------------------|
| `1..199`    | Global script            | `DSCR` directory + `LOFF`                 |
| `200..255`  | Local script (room-bound)| Current room's `LSCR` table              |

The `startScript` family of opcodes (`0x0A`, `0x2A`, …, `0xEA`)
routes ids ≥ 200 through `vm.loadedRoom?.localScripts.get(id)` and
falls back to the global resolver for lower ids. If a script is
expected and not found, we halt with a clear diagnostic
(`local script #200 not present in current room 10`).

Recursive (bit `0x40` on the opcode) and freeze-resistant (bit
`0x20`) flags aren't honoured yet — every start picks the lowest
free slot regardless. Phase 7 needs both to interact correctly
with verb scripts and freezeScripts.

## 8. Halt as a first-class state

When the dispatcher encounters an unknown opcode or a handler
throws (e.g., divide-by-zero in the expression VM), it converts
the error into a **`HaltInfo`** snapshot on the VM rather than
propagating: which slot, which script, the offending opcode's PC,
the byte itself, 16 bytes of bytecode context centered on the PC,
and a tail of the trace ring. Subsequent `step()` calls are no-
ops; `reset()` clears the halt.

The inspector reads `vm.haltInfo` and renders a red banner with
the bytecode context — no `try/catch` sprawl in the UI. This was
the foundation of the demand-driven opcode-growth loop in Phase 5
and 6: a halt told us exactly what byte to implement next.

## 9. The opcode trace ring

Every dispatched opcode appends to a 64-entry circular trace
buffer with `(slotIndex, scriptId, pc, opcode, mnemonic)`.
Handlers call `vm.annotate("setVar 0x49 = 0")` to add the
human-readable mnemonic; without it, trace entries show just the
raw opcode.

The trace is what the inspector renders in the "Trace" panel and
what the halt panel embeds as "last 16 opcodes leading up to the
halt." It's a debug surface, not a save-state thing — gone after
`reset()`.

## 10. Engine-controlled variables (system vars)

A handful of globals are *engine state* the scripts read but don't
write — screen dimensions, game id, current room id, charset id,
copy-protection cookies. The boot driver seeds them before the
first opcode dispatches:

| Global | Name (per the wiki)            | Initial value         |
|--------|--------------------------------|------------------------|
| `4`    | `VAR_ROOM`                     | 0 (set by `loadRoom`)  |
| `17`   | `VAR_SCREEN_WIDTH`             | 320                    |
| `18`   | `VAR_SCREEN_HEIGHT`            | 200                    |
| `19`   | `VAR_GAME_ID`                  | 0 (MI1) / 1 (MI2)      |
| `21`   | `VAR_CHARSET`                  | 0 (script will set)    |
| `0x4a` | MI1 "track-b-size" (CD audio)  | 1225 (passes check)    |

The MI1 entry at global `0x4a` is the size of the original CD's
audio track 2 in sectors. Script #176 reads it and quits if it's
outside `[1200, 1250]`. We don't have the CD, so we seed a value
inside that range; the boot then progresses past the protection
check. Documented inline at the seed call site.

We deliberately *don't* pre-populate every system variable — the
philosophy is "let scripts halt on uninitialized reads, then add a
seed entry when an actual read forces it." Keeps the var bank
honest as a diagnostic: a non-zero global either came from a
script write we can see in the trace, or from one named seed we
can grep for.

## 11. Reference implementation

The dispatcher and every wired opcode live under
[`src/engine/vm/`](../src/engine/vm/):

- [`vm.ts`](../src/engine/vm/vm.ts) — `Vm` class, slot scheduling,
  halt machinery, trace ring, `enterRoom` (ENCD/EXCD dispatch).
- [`slot.ts`](../src/engine/vm/slot.ts) — `ScriptSlot` state
  machine + the synthetic-script `label` field.
- [`params.ts`](../src/engine/vm/params.ts) — `isVarParam`,
  `readVarRef`, `readDestRef`, `readVarOrByte`, `readVarOrWord`,
  `readWordVararg`, plus the scope-bit dereference logic.
- [`expression.ts`](../src/engine/vm/expression.ts) — the `0xAC`
  mini-VM evaluator.
- [`opcodes/index.ts`](../src/engine/vm/opcodes/index.ts) — every
  wired opcode handler. Family-grouped, with comments explaining
  each opcode's quirks where they differ from the wiki.
- [`scripts.ts`](../src/engine/vm/scripts.ts) — global script
  loading via DSCR + LOFF.
- [`boot.ts`](../src/engine/vm/boot.ts) — the system-var seeding
  + resolver wiring for global scripts, rooms, costumes.

Tests cover every handler family with both synthetic fixtures and
opcode-prefix slices of the real MI1 boot script. The trace ring,
runaway-loop guard, halt-as-first-class-state, OOB lenience, and
indexed/array refs all have dedicated test coverage.

## 12. The demand-driven growth loop

The Phase 5 and Phase 6 workflow that took us from "16 seed
opcodes" to "boot runs end-to-end" is worth describing because
it's the loop we'll keep using in Phase 7+:

1. `scratch/run-boot.ts` boots the VM against real MI1 data,
   drains slots to completion, and prints the halt point with the
   surrounding bytecode context.
2. Identify the offending opcode byte from the halt panel (or the
   scratch output).
3. Look up its meaning in the ScummVM wiki opcodes table.
4. Implement the handler in `opcodes/index.ts`, plus tests for the
   parameter shape and any branching.
5. Re-run the scratch driver. Halt moves further into the boot.
   Repeat.

This is fast because the halt is *informative*: it carries the
opcode byte, the PC, the slot, the script, and 16 bytes of context.
The cost of adding a new opcode is bounded — and the loud failure
mode keeps the engine honest about which opcodes are real vs
guessed.
