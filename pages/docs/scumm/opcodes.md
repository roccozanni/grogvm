# SCUMM v5 — Opcode Dispatch + Bytecode Conventions

This document covers the SCUMM v5 bytecode interpreter at the
infrastructure level: opcode encoding, parameter-mode bits,
variable-reference scope, the expression mini-VM, conditional branch
semantics, and the assorted gotchas. The per-opcode reference (what
every byte from `0x00..0xFF` *does*) lives at the source URL below;
this document focuses on the parts that *aren't* per-opcode — the
dispatch infrastructure every opcode plugs into.

## Sources

- **Per-opcode encoding table: [opcode-reference.md](opcode-reference.md)**
  — every opcode's operand layout + semantics, transcribed from the
  ScummVM wiki (<https://wiki.scummvm.org/index.php?title=SCUMM/V5_opcodes>).
  Consult it before decoding/implementing an opcode; the parameter
  conventions (`p8`, `p16`, `v16`, etc.) are defined there.
- Cross-checked against MI1's boot bytecode (`SCRP` script #1)
  opcode-by-opcode. Several conventions easily misread on a first
  pass — surfacing as runaway loops or out-of-range variable
  writes — are called out in §3 and §4 below.

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

**A leading "result" or read-var operand does not consume a
mode-bit slot.** For opcodes shaped `result value…` (the `getActor*`
family, `getInventoryCount`, `getDist`, the comparisons, `setVar`,
…), the result/var is a raw word and the *first value* parameter is
mode-index 1 (bit `0x80`), the second is index 2 (bit `0x40`). Off-
by-one here silently misreads a byte parameter as a word (or vice
versa) and desynchronises the whole stream.

### Non-orthogonal families — a high bit can pick a *different* opcode

Several families overload one of the "param-mode" bits as an **opcode
selector**, so two genuinely different instructions share the same low
five bits. The mode bits then live in the *remaining* high bits. The
ones that bite:

| Low 5 | Selector | Opcodes |
|-------|----------|---------|
| `0x0D` | bit `0x20` | `walkActorToActor` (`0x0D`) vs `putActorInRoom` (`0x2D`) |
| `0x16` | bits `0x60` | `getRandomNumber` (`0x16`) / `walkActorToObject` (`0x36`) / `getActorMoving` (`0x56`) |
| `0x03` | bits `0x60` | `getActorRoom`/`Y`/`X`/`Facing` (`0x03`/`0x23`/`0x43`/`0x63`) |
| `0x05` | bit `0x20` | `drawObject` (`0x05`) vs `pickupObject` (`0x25`) |
| `0x09` | bit `0x20` | `faceActor` (`0x09`) vs `setOwnerOf` (`0x29`) |
| `0x11` | bits `0x60` | `animateActor` (`0x11`) / `getInventoryCount` (`0x31`) / `getActorCostume` (`0x71`) |
| `0x15` | bit `0x20` | `actorFromPos` (`0x15`) vs `findObject` (`0x35`) |
| `0x17` | bit `0x20` | `and`/`or` (`0x17`/`0x57`) vs `startObject` (`0x37`/`0x77`/…) |
| `0x12` | bit `0x20` | `panCameraTo` (`0x12`) vs `setCameraAt` (`0x32`) |
| `0x0E` | bit `0x20` | `putActorAtObject` (`0x0E`) vs `delay` (`0x2E`) |

The practical rule: **never register all eight high-bit variants of a
family at one handler.** Decode each byte against the per-opcode
reference and real bytecode. A blanket registration that swallows a
selector bit is a classic source of "the boot script runs fine until it
suddenly halts on a stray byte."

### Direct-word immediates are signed int16

When a parameter is an immediate (direct) word rather than a var-ref,
its two bytes are a **signed** little-endian int16 — the same encoding
as a branch delta (§3), not an unsigned u16. `0xFFFF` is `−1`,
`0xFFFE` is `−2`. Reading direct words unsigned silently breaks every
signed comparison and arithmetic op that takes a negative literal:

- MI1's duel loop carries a loss sentinel `isGreater L0 [65534]` — that
  immediate is `−2`; read as `65534` the compare is always "won", so a
  swordfight could never be lost.
- `move g181 = −1` appears ~20× in MI1; read unsigned the slot holds
  `65535` and every later compare against it diverges.

A wrong unsigned read is the kind of *logic* bug that surfaces as a
*render* symptom — a lost duel exchange flung an actor off-screen
before the cause (the signed sentinel) was found.

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

**Beware**: some outdated reverse-engineering notes have `0x8000`
and `0x4000` swapped (claiming `0x8000` = local, `0x4000` = bit).
Implementing the swapped convention causes `actorOps` and similar
opcodes to write into the wrong scope and silently corrupt slot
locals — visible in MI1's boot when `actorOps actor=1,
setName("Guybrush")` writes a local index of 0x80 (= 128) which is
out of range for the 25-slot local table.

### Indexed (array) references

When bit `0x2000` is set, the reference describes an *indexed*
deref into an array variable. The first word is the base ref, and
a **second** word follows that supplies the offset (either as an
immediate or as another var-ref via its own `0x2000` bit). The
final resolved index = `(base & ~0x2000) + offset`.

MI1 uses indexed refs sparingly, but the boot script's verb-table
setup at `setVar 0x800f` does hit this path; an implementation that
treats `0x2000` as a halt-trigger fails partway through the boot
prefix.

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

The boot script's case-switch in script #12 (routing on `var[0]`)
and the verb-table-setup loop in script #177 (`while i < N`) both
rely on this convention. An implementation that jumps when the
relation is *true* instead of false will run script #177 as an
infinite loop and never exit the setup. The equality opcodes
(`isEqual`, `isNotEqual`) follow the same "unless" rule and are
easier to get right; the four inequalities (`isLess`, `isGreater`,
`isLessEqual`, `isGreaterEqual`) are the ones that tend to read as
"jump-when-named-condition-holds" on first pass.

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
| `0x06`        | execute opcode and push VAR(0) (rare; not used by MI1 boot)|
| `0xFF`        | terminator                                                |

The mini-VM's stack is local to one `0xAC` invocation; there's no
cross-call retention. At the terminator the single remaining stack
value is written to the destination var.

A key gotcha: bit 7 of the subop byte selects "operand is a
var-ref" — so push-immediate is encoded `0x01 lo hi` and push-var
is `0x81 lo hi`. Treating push-var as a separate subop number
breaks every var-substitution in the MI1 boot.

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

**A subop's leading result operand consumes no mask bit either** — the
§1 rule applies inside multi-subop opcodes. `stringOps getStringChar`
(`0x27` subop `0x04`) is shaped `result = string[id][idx]`: the result
is a raw destination word, so `id` takes mask `0x80` (param-index 1)
and `idx` takes `0x40` (param-index 2). Counting the result as the
first masked param shifts both operands one bit-position off and reads
the wrong string/index. MI1's insult-defense matcher is
`getStringChar res, id=37 (direct byte), idx (var)` — the off-by-one
read an absent string instead of the comeback table, so no defense ever
matched. Player-attack duels hid it (their wins come from a skill roll,
not this lookup); only the Sword Master's defend-only duel — unwinnable
even fully armed — exposed it.

`actorOps` is the heaviest of these — 24 sub-actions covering
setCostume, setWalkSpeed, talk frames, init, elevation, palette
remap, talk color, name (NUL-terminated string), width, scale,
ignore-boxes / follow-boxes, anim speed, shadow mode, etc.

`verbOps`, `roomOps`, and `cursorCommand` are similar but smaller.

**`drawObject` (`0x05`) reads exactly ONE subop byte** — *not* a
`0xFF`-terminated list. Switch on `sub & 0x1f`: `1` = `SO_AT` (reads
`x,y`), `2` = `SO_IMAGE` (reads a state), anything else = a bare draw.
(The bare-animation form happens to use subop `0xFF`, which masks to a
no-arg draw — which is why a wrong "loop until `0xFF`" parser survived
room-28's animations but mis-read the `drawObject … at x,y` + `setState`
sequence in close-up rooms: after the AT coords it kept going and
consumed the following `setState` opcode as a bogus subop.)

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
transitioning rooms — don't have a numeric script id. The engine
attaches a string label (e.g. `ENCD-10`, `EXCD-10`) so they show
meaningfully in traces.

**Runaway-loop guard.** A step-cap on `runUntilAllYield` (~100k
opcodes) converts the most common bug class — a tight loop with
no `breakHere` — into a clean diagnostic halt instead of a hung
browser tab.

**`chainScript` (`0x42` / `0xC2`)** kills the running slot and starts
the named script **in its place**, carrying the dying slot's
freeze-resistance. Implement it as `slot.kill()` then `startScriptById`:
killing first frees the slot so the chained script reuses it (lowest
free index), and the now-dead current slot makes dispatch fall through to
the fresh one. Background-animation loops chain themselves to re-loop
(MI1 room-28's pirate fixtures, the move/sentence path), so a missing
handler doesn't just drop one script — the unknown-opcode halt freezes
the *whole* VM the instant anything chains.

**`startScript` runs the new script *nested*, not deferred.** SCUMM runs
the started script immediately — to its first `breakHere`/stop —
**before the caller's next opcode**, then returns to the caller (the
child's slot stays alive and resumes normally on later ticks if it
yielded). It is NOT queued behind the caller. This is
load-bearing: scripts assume a script they start has already run by their
next statement. E.g. the room-28 pirate dialog (`#220`) does `startScript
32; <fill reply menu>` and relies on `#32` (clear the reply slots + set the
reply-Y base `g229`) running *first*; queuing `#32` let `#220` fill the
replies first and `#32` then wiped them — an intermittent black/empty answer
bar whose outcome depended on slot-allocation order. The same applies to the
cutscene start/end hooks (CUTSCENES §2): `#18`'s `freezeScripts 127` and
`#19`'s `freezeScripts 0` must execute in issue-order. The `startScript`
handler allocates the slot then runs the child nested; `chainScript` above
is the in-place variant.

**Starting script 0 is a silent no-op.** `startScript 0` / `chainScript 0` do
nothing — id 0 must *not* be resolved as a global, since DSCR slot 0 is an
unused entry (room 0) and resolving it would halt. The proof is in the game's
own bytecode: this is reachable in normal play. With a "Dai"/"Usa" verb armed
and an object held, the hover poller `#23`, when the cursor is over an **actor**
(id < 12), starts a per-actor handler via the indexed table `g396[actorId]`
(= `VAR(396 + actorId)`) — in `#23`'s bytecode this is a
`startScript g396[L0]`. An actor with no special give/use script has
a `0` there, so `#23` issues `startScript 0`; since the game does this on an
ordinary hover, id 0 has to be a no-op rather than a halt. The guard is
at the resolution boundary: id resolution returns nothing for id ≤ 0, and
the `startScript`/`chainScript` handlers then skip the nested run. Repro:
give the pot to a pirate in room 51 → "Ah, quello sarà perfetto come
elmetto!". Before the guard this halted with
`Cannot load global script #0: unused entry (room = 0)`.

**`startObject` (0x37/0x77/0xB7/0xF7) runs nested too** — the same
mechanism, so a started object-verb script finishes (to its first
`breakHere`/stop) before the caller's next opcode. This is load-bearing for
the **inventory icons**: the inventory script (`#9`) loops the owner's items
doing `startObject item 91; L4 = g376`, where each item's **verb-91** sets
`g376` to the object whose sprite that slot should draw. Deferred, the loop
read a stale `g376` for every slot and every item drew one identical icon;
nested, each slot reads its own freshly-set `g376`.

**`startObject` args map straight onto the verb body's locals** `L0, L1, …` —
there is **no** implicit `[verb, object]` prepend. This is visible in the
bytecode: the sentence script `#2` runs a verb as
`startObject obj=L1 script=4 [L2]` (give) or the general `startObject obj=L1
script=L0 [L2,L0]`, and the verb bodies read those positions directly — object
`566` verb-7 tests `L0 == 574` (the second object in "Usa carne con pentola"),
and the money routine object `488` verb-250 does `g195 += L0` (`g195` = pieces
of eight) then `setOwnerOf(488, ego)`. We briefly prepended `[verb, obj]`, which
shifted the real args up two slots: the Fettucini-cannon reward
`startObject 488 250 [478]` then read `L0 = 250` instead of `478`, so verb-250
added the wrong amount and never re-owned `488` — the player got no money.

## 7. Script id ranges

| Range       | Scope                    | Resolved via                            |
|-------------|--------------------------|------------------------------------------|
| `1..199`    | Global script            | `DSCR` directory + `LOFF`                 |
| `200..255`  | Local script (room-bound)| Current room's `LSCR` table              |

The `startScript` family of opcodes (`0x0A`, `0x2A`, …, `0xEA`)
must route ids ≥ 200 through the current room's LSCR table and
fall back to the global DSCR resolver for lower ids. A lookup that
finds nothing should halt with a diagnostic — silently no-oping
a missing script masks bytecode corruption.

The opcode byte carries two additional flags on the high bits:
**recursive** (bit `0x40`) suppresses the "already-running" check
that otherwise prevents the same script id from running in two
slots at once; **freeze-resistant** (bit `0x20`) marks the new
slot so `freezeScripts` won't pause it. The new slot is otherwise
the lowest free one.

## 8. Halt as a first-class state

When the dispatcher encounters an unknown opcode or a handler
throws (e.g., divide-by-zero in the expression VM), it converts
the error into a **`HaltInfo`** snapshot on the VM rather than
propagating: which slot, which script, the offending opcode's PC,
the byte itself, 16 bytes of bytecode context centered on the PC,
and a tail of the trace ring. Subsequent `step()` calls are no-
ops; `reset()` clears the halt.

Treating halts as state rather than exceptions keeps the rest of
the engine free of try/catch sprawl, and gives debug UIs a
canonical place to read failure details from. It also doubles as a
demand-driven growth signal: implementing only the opcodes the
bytecode actually halts on (rather than the full 256-entry table
up front) keeps the implementation honest about what's been
verified against real data.

## 9. The opcode trace ring

Every dispatched opcode appends to a small circular trace buffer
with `(slotIndex, scriptId, pc, opcode, mnemonic)`. Handlers call
a per-opcode `annotate("setVar 0x49 = 0")`-style hook to add a
human-readable mnemonic; without it, trace entries show just the
raw opcode byte.

The trace is a debug surface — tail of it goes into the halt
snapshot, the inspector renders it as a scrolling panel — not a
save-state mechanism. It clears on engine reset.

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
outside `[1200, 1250]` — a CD-presence copy-protection check. A
value inside that range satisfies the check without a real CD.

Pre-populating *every* system variable up front isn't a great
idea: it hides which globals scripts actually read, and obscures
the diagnostic value of "this global is non-zero, so either a
script wrote it or the engine seeded it." Seeding only the
variables the boot prefix actually reads keeps that signal
intact.
