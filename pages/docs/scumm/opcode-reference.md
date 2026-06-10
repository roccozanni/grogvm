# SCUMM v5 — Per-Opcode Encoding Reference

Authoritative per-opcode encoding + semantics table for SCUMM v5,
transcribed from the ScummVM wiki. This is the companion to
[opcodes.md](opcodes.md) (which covers the *dispatch
infrastructure* — byte encoding, param-mode bits, var-ref scope, the
expression mini-VM, branch semantics). When implementing or decoding an
opcode, check the encoding here rather than guessing.

## Sources

- ScummVM Technical Reference — OpCodes, at <https://wiki.scummvm.org/index.php?title=SCUMM/V5_opcodes>
- Cross-check decoded bytecode against real MI1 when a
layout is ambiguous.

---

## Encoding notation

| Term | Description |
|------|-------------|
| `opcode` | The instruction's opcode byte, with param-mode bits set per the parameters. |
| `aux` | An aux opcode byte that stores only parameter bits (base usually `$01`). |
| `sub-opcode` | An aux byte selecting a specific function (e.g. `wait`'s "wait for actor"), also storing param bits. |
| `result` | A result pointer — a standard LE word var pointer (written to). |
| `var` | A variable pointer (read, not written); not affected by opcode param bits. |
| `value[8]` | 8-bit constant (byte). |
| `value[16]` | 16-bit constant (LE word). |
| `value[p8]` | 8-bit parameter — word LE if a pointer, byte if a constant (per param bit). |
| `value[p16]` | 16-bit parameter — always LE word, pointer or constant (per param bit). |
| `value[v16]` | Variable-length list of word params: a sequence of `aux[8] param[p16]` pairs; `aux` holds the param bit (always `$01` otherwise). A `$FF` byte terminates. |
| `value[o]` | Offset word for a parameter, encoded only if needed, at the indicated position. |
| `value[c]` | An ASCII character (strings are `$00`- or `$FF`-terminated per instruction). |
| `term...` | One or more terms. |

Opcodes are non-orthogonal — many exceptions to the param-bit rule.

## Opcode index (hex → mnemonic)

| Hex | Op | Hex | Op | Hex | Op |
|-----|----|-----|----|-----|----|
| `00` | stopObjectCode | `01` | putActor | `02` | startMusic |
| `03` | getActorRoom | `04` | isGreaterEqual | `05` | drawObject |
| `06` | getActorElevation | `07` | setState | `08` | isNotEqual |
| `09` | faceActor | `0A` | startScript | `0B` | getVerbEntryPoint |
| `0C` | resourceRoutines | `0D` | walkActorToActor | `0E` | putActorAtObject |
| `0F` | getObjectState | `10` | getObjectOwner | `11` | animateActor |
| `12` | panCameraTo | `13` | actorOps | `14` | print |
| `15` | actorFromPos | `16` | getRandomNumber | `17` | and |
| `18` | jumpRelative | `19` | doSentence | `1A` | move |
| `1B` | multiply | `1C` | startSound | `1D` | ifClassOfIs |
| `1E` | walkActorTo | `1F` | isActorInBox | `20` | stopMusic |
| `22` | getAnimCounter | `23` | getActorY | `24` | loadRoomWithEgo |
| `25` | pickupObject | `26` | setVarRange | `27` | stringOps |
| `28` | equalZero | `29` | setOwnerOf | `2B` | delayVariable |
| `2C` | cursorCommand | `2D` | putActorInRoom | `2E` | delay |
| `30` | matrixOp | `31` | getInventoryCount | `32` | setCameraAt |
| `33` | roomOps | `34` | getDist | `35` | findObject |
| `36` | walkActorToObject | `37` | startObject | `38` | lessOrEqual |
| `3A` | subtract | `3B` | getActorScale | `3C` | stopSound |
| `3D` | findInventory | `3F` | drawBox | `40` | cutScene |
| `42` | chainScript | `43` | getActorX | `44` | isLess |
| `46` | increment | `48` | isEqual | `4C` | soundKludge |
| `52` | actorFollowCamera | `54` | setObjectName | `56` | getActorMoving |
| `57` | or | `58` | override | `5A` | add |
| `5B` | divide | `5D` | actorSetClass | `60` | freezeScripts |
| `62` | stopScript | `63` | getActorFacing | `66` | getClosestObjActor |
| `67` | getStringWidth | `68` | getScriptRunning | `6B` | debug |
| `6C` | getActorWidth | `6E` | stopObjectScript | `70` | lights |
| `71` | getActorCostume | `72` | loadRoom | `78` | isGreater |
| `7A` | verbOps | `7B` | getActorWalkBox | `7C` | isSoundRunning |
| `80` | breakHere | `98` | systemOps | `A0` | stopObjectCode |
| `A7` | dummy | `A8` | notEqualZero | `AB` | saveRestoreVerbs |
| `AC` | expression | `AE` | wait | `C0` | endCutScene |
| `C6` | decrement | `CC` | pseudoRoom | `D8` | printEgo |

High-bit variants of an opcode are param-mode variants of the same base
instruction — dispatch is per full byte.

## Encodings (selected — the ones we decode/implement)

Every encoding begins with the opcode byte itself; the **Operands**
column lists what follows it in the byte stream.

### Flow / variables

| Opcode | Byte(s) | Operands | Notes |
|--------|---------|----------|-------|
| stopObjectCode | `$A0` / `$00` | — | marks script dead; `$A0` in LSCR/SCRP, `$00` in ENCD/EXCD/VERB |
| breakHere | `$80` | — | deschedule; resume next instruction next timeslot |
| jumpRelative | `$18` | `target[16]` | `PC += target` (signed, from after the instruction) |
| move | `$1A` | `result value[p16]` | `result := value` |
| add · subtract · multiply · divide · and · or | `$5A` `$3A` `$1B` `$5B` `$17` `$57` | `result value[p16]` | |
| increment · decrement | `$46` · `$C6` | `result` | |
| setVarRange | `$26` | `result number[8] values[8]...` | `values[16]...` if opcode high bit set; sets `number` consecutive vars from `result` |
| isEqual · isNotEqual · isLess · isGreater · isGreaterEqual · lessOrEqual | `$48` `$08` `$44` `$78` `$04` `$38` | `var value[p16] target[16]` | `unless (value OP var) goto target` — NB operand order: `value OP var` |
| equalZero · notEqualZero | `$28` · `$A8` | `var target[16]` | `unless (var ==/!= 0) goto target` |
| expression | `$AC` | `result subopcode... $FF` | stack VM: `$01 value[p16]` push; `$02..$05` add/sub/mul/div; `$06 nested-opcode` run an instruction and push its VAR_RESULT |

### Scripts

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| startScript | `$0A` | `script[p8] args[v16]...` | bit 6 = recursive, bit 5 = freeze-resistant |
| startObject | `$37` | `object[p16] script[p8] args[v16]...` | runs the object's (OBCD) script |
| chainScript | `$42` | `script[p8] args[v16]...` | replace current script in-thread |
| stopScript | `$62` | `script[p8]` | `stopScript 0` stops the *current* script — the sentence guard in MI1 script #4 ends itself this way |
| stopObjectScript | `$6E` | `script[p16]` | |
| freezeScripts | `$60` | `flag[p8]` | `>= $80` also freezes freeze-resistant; `0` unfreezes; cumulative |
| getScriptRunning | `$68` | `result script[p8]` | |
| doSentence | `$19` | `verb[p8] objectA[p16] objectB[p16]` | if `verb == $FE`: stop the sentence script / clear status — and in that form **no** objectA/objectB operands follow |
| cutScene | `$40` | `args[v16]...` | |
| endCutScene | `$C0` | — | |
| override | `$58` | `sub-opcode` | `$00` end override; `$01 $18 target[16]` begin (followed by a jumpRelative; ESC jumps by target) |
| wait | `$AE` | `sub-opcode` | `$01 actor[p8]` for-actor · `$02` for-message (VAR[3]) · `$03` for-camera · `$04` for-sentence; breaks + resumes at this instruction until satisfied |
| delay | `$2E` | `param[24]` | **24-bit LE!** 1/60s units |
| delayVariable | `$2B` | `var` | |

### Objects

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| setState | `$07` | `object[p16] state[p8]` | |
| getObjectState | `$0F` | `result object[p16]` | |
| getObjectOwner | `$10` | `result object[p16]` | |
| setOwnerOf | `$29` | `object[p16] owner[p8]` | |
| drawObject | `$05` | `object[p16] sub-opcode` | `$01 xpos[p16] ypos[p16]` draw-at · `$02 state[p16]` set-state · `$FF` draw — see eviction note below |
| setObjectName | `$54` | `object[p16] name[c]... $00` | |
| pickupObject | `$25` | `object[p16] room[p8]` | adds object to Ego's inventory |
| findObject | `$35` | `result x[p8] y[p8]` | first touchable object at coords (excl. bottom/right edges) |
| findInventory | `$3D` | `result owner[p8] index[p8]` | |
| getInventoryCount | `$31` | `result actor[p8]` | |
| getVerbEntryPoint | `$0B` | `result object[p16] verb[p16]` | falls back to the `$FF` default-verb entry — see note below |
| getClosestObjActor | `$66` | `result actor[p16]` | ≤255 units |
| getDist | `$34` | `result objA[p16] objB[p16]` | Chebyshev metric — see note below |
| ifClassOfIs | `$1D` | `value[p16] args[v16]... target[16]` | `unless (value's class ∈ args) goto target` |
| actorSetClass | `$5D` | `object[p16] classes[v16]...` | no jump; a class of `0` **clears all** class data; high bit `$80` of a value = set, without = clear (derived from MI1 toggling class 32 / `0x80\|32`); for both class opcodes classes are 1-based — class `N` is bit `N−1` of the mask |

**`drawObject` evicts same-box objects.** When a draw displaces another
object covering the same box (the eviction described in
[objects.md](objects.md)), the displaced object's state also reverts
to 0 — MI1 room 31's rat-hole loop (#207) re-picks among state-0 frames
and would spin forever otherwise.

**`getVerbEntryPoint` falls back to the default verb.** It returns the
object's script entry for `verb`, **or its `0xFF` default-verb entry**
when the exact verb has none (SCUMM matches `entry || 0xFF`). This
fallback is the opener for edge exits: a plain walk-to (verb 11) on an
exit whose only verb is `0xFF` reads truthy here → sentence #2 runs it →
`loadRoom` (the room-78 "can't exit").

**`getDist` clamps and saturates.** The metric is Chebyshev —
`max(|dx|,|dy|)` — and an unresolvable id yields `0xFF`. When an operand
is an object, its point is first clamped into actor-standable walkboxes
(`adjustXYToBeInBox`) before measuring; MI1 room 36's guard dogs depend
on that clamp.

### Actors

Actor id `0` is shorthand for Ego in every actor opcode, resolved
through `VAR_EGO` (global #1) — MI1's boot positions Guybrush with
`putActor 0 …`.

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| putActor | `$01` | `actor[p8] x[p16] y[p16]` | keeps the actor's existing room |
| putActorInRoom | `$2D` | `actor[p8] room[p8]` | does **not** load the room — see note below |
| putActorAtObject | `$0E` | `actor[p8] object[p16]` | falls back to (240,120) when the object can't be found |
| walkActorTo | `$1E` | `actor[p8] x[p16] y[p16]` | |
| walkActorToActor | `$0D` | `walker[p8] walkee[p8] distance[8]` | |
| walkActorToObject | `$36` | `actor[p8] object[p16]` | |
| animateActor | `$11` | `actor[p8] anim[p8]` | |
| faceActor | `$09` | `actor[p8] object[p16]` | |
| actorOps | `$13` | `actor[p8] sub-opcode... $FF` | subop table below |
| getActorX · getActorY | `$43` · `$23` | `result actor[p16]` | note the **p16** actor operand |
| getActorRoom · getActorElevation · getActorMoving · getActorFacing · getActorScale · getActorWidth · getActorWalkBox · getActorCostume · getAnimCounter | `$03` `$06` `$56` `$63` `$3B` `$6C` `$7B` `$71` `$22` | `result actor[p8]` | `getActorFacing` returns old-direction integers (`0`=W `1`=E `2`=S `3`=N), not an angle; scripts add 248 and feed the sum to `animateActor` (MI1 #35) |
| actorFromPos | `$15` | `result x[p16] y[p16]` | |
| isActorInBox | `$1F` | `actor[p8] box[p8] target[16]` | |

**Room placement and the camera.** `putActorInRoom` does **not** load
the room — a subsequent `actorFollowCamera` on an actor placed in
another room is what triggers the room switch (how MI1's boot enters
room 38).

**actorOps `$13` sub-opcodes** (`actor[p8]`, then subops until `$FF`):

| Subop | Meaning |
|-------|---------|
| `$00` | dummy (one p8 arg) |
| `$01` | costume |
| `$02 xspeed yspeed` | step distance |
| `$03` | sound — exactly **one** p8 arg; room 64's #200 encodes `03 3b ff`, the sound id then the terminator |
| `$04` | walk frame |
| `$05 start end` | talk frames |
| `$06` | stand frame |
| `$07` | (three p8 args) |
| `$08` | default/init — see note below |
| `$09 elevation[p16]` | elevation |
| `$0A` | anim default |
| `$0B index val` | palette remap |
| `$0C` | talk color |
| `$0D name[c]...$00` | actor name |
| `$0E` | init frame |
| `$0F` | no-arg no-op (hit by MI1's boot) |
| `$10` | width |
| `$11 xscale yscale` | scale |
| `$12` | never-zclip |
| `$13 zplane` | always-zclip |
| `$14` | ignore boxes |
| `$15` | follow boxes |
| `$16` | anim speed |
| `$17` | shadow mode |
| `$18 x[16] y[16]` | text offset (anchor for the actor's talk text) |

`$08` default/init resets ignore-boxes, scale, walkbox (to unassigned),
forceClip (to 0), and the chore frames, but does **not** reset facing —
only game-start init does. Room 60's teaching machine and room 51's
cannon rely on the facing surviving the reset.

### Camera / room

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| setCameraAt | `$32` | `x[p16]` | |
| panCameraTo | `$12` | `x[p16]` | |
| actorFollowCamera | `$52` | `actor[p8]` | |
| loadRoom | `$72` | `room[p8]` | |
| loadRoomWithEgo | `$24` | `object[p16] room[p8] x[16] y[16]` | `x == −1` means "no walk" — see note below |
| roomOps | `$33` | `sub-opcode` | subop table below |
| lights | `$70` | `arg1[p8] arg2[8] arg3[8]` | |
| pseudoRoom | `$CC` | `val[8] res[8]... $00` | for each `res` with the high bit set, aliases room id `res` → physical room `val`, keyed by the **raw** id (the high bit is kept, *not* masked to `res & $7F`) since the game references these ids verbatim (`VAR_ROOM` holds them); MI1: 201–220 → 58 (forest maze), 130–132 → 1 |

**`loadRoomWithEgo` sets `VAR_WALKTO_OBJ`** to the entry object, and the
value must survive the room change — room 58's maze ENCD branches on it
after a `breakHere`. Afterwards the camera re-snaps to Ego and follow
re-engages.

**roomOps `$33` sub-opcodes** (the wiki lists further ones):

| Subop | Meaning |
|-------|---------|
| `$01 minX maxX` | scroll bounds — floored at 160, half a screen |
| `$03 b h` | screen |
| `$04 r g b` | set-pal-color — after the three colour params a **second** subop byte follows, carrying the param mode of the slot argument |
| `$05` / `$06` | shake on / off |
| `$08 scale start end` | room intensity (three p8 args) |
| `$0A effect[p16]` | fade (screen effect) |
| `$0B r g b` | set-RGB-room-intensity — three words, then a second subop byte with `lo hi` |
| `$10 colindex delay` | cycle speed |

Intensity values above 255 *brighten*; intensity is always computed
against the room's load-time base palette (room 29's reveal, room 63's
map fade).

### Verbs / cursor / text

**verbOps `$7A`** — `verbID[p8] sub-opcode... $FF`:

| Subop | Meaning |
|-------|---------|
| `$01 object[p16]` | image |
| `$02 name[c]...$00` | name |
| `$03` | color |
| `$04` | hicolor |
| `$05 left top` | at |
| `$06` | on |
| `$07` | off |
| `$08` | delete |
| `$09` | new — creates the verb **off** (mode 0) and leaves name/x/y untouched |
| `$10` | dimcolor |
| `$11` | dim |
| `$12 key` | key |
| `$13` | center |
| `$14 stringID[p16]` | name from a string resource |
| `$16 object[p16] room[p8]` | assign object |
| `$17` | back-color |

A verb's charset is fixed at new-time; a later `$02` setName must not
re-capture the then-current charset (MI1's sentence-line verb #100
depends on this).

**cursorCommand `$2C`** — `sub-opcode`:

| Subop | Meaning |
|-------|---------|
| `$01` / `$02` | cursor on / off |
| `$03` / `$04` | userput on / off |
| `$05` / `$06` | cursor soft on / off |
| `$07` / `$08` | userput soft on / off |
| `$0A cursornum charletter` | cursor image |
| `$0B index x y` | hotspot |
| `$0C cursor` | set cursor |
| `$0D charset` | set charset |
| `$0E colors[v16]...` | charset colours — feeds the charset colour map; MI1 sets `[0, 6, 2]` |

Cursor and userput are nesting **counters**, not booleans: the hard
on/off forms set them to 1/0, the soft forms increment/decrement. After
every subop the values are mirrored into `VAR_CURSORSTATE` and
`VAR_USERPUT`.

**print `$14`** — `actor[p8] sub-opcode` (and **printEgo `$D8`** — the
same, actor = Ego implicitly):

| Subop | Meaning |
|-------|---------|
| `$00 xpos ypos` | at |
| `$01 color` | color |
| `$02 right` | clipped |
| `$03 w h` | erase |
| `$04` | center |
| `$06` | left |
| `$07` | overhead |
| `$08 voice[p16]` | say-voice (CD voice id) |
| `$0F string[c]...$FF` | text |

**String substitution codes** — printed strings embed `$FF`-introduced
control codes:

| Code | Size | Meaning |
|------|------|---------|
| `$01`–`$03` | 2 bytes | no argument — `$02` is keepText, `$03` the sentence-page split (see [CHAR §5](char.md)) |
| `$04` | 4 bytes | integer, read through a var |
| `$05` | 4 bytes | verb name, verb id read through a var |
| `$06` | 4 bytes | object/actor name, id read through a var |
| `$07` | 4 bytes | string resource — the argument is a **literal** string id, never a var-ref (MI1's sentence line embeds string `$49`, a literal space) |

The `$04`–`$07` assignments are bytecode-verified against MI1's sentence
line `#100` ([INPUT §6](input.md)); some transcriptions instead give
`$06` = var and `$08` = object/verb name, which that bytecode disproves.
The wiki lists further codes (`$09` sound, `$0A` actor name, `$0E`
colour) not yet pinned against bytecode here.

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| getStringWidth | `$67` | `result strptr[p8]` | |
| stringOps | `$27` | `sub-opcode` | `$01 id string[c]...$00` load · `$02 dst src` copy · `$03 id index char[c]` write-char · `$04 result id index` read-char · `$05 id size` new |
| saveRestoreVerbs | `$AB` | `sub-opcode` | `$01/$02/$03 start end mode` save / restore / delete verbs |

### Sound / system

| Opcode | Byte | Operands | Notes |
|--------|------|----------|-------|
| startMusic | `$02` | `music[p8]` | |
| stopMusic | `$20` | — | |
| startSound | `$1C` | `sound[p8]` | |
| stopSound | `$3C` | `sound[p8]` | |
| isSoundRunning | `$7C` | `result sound[p8]` | |
| soundKludge | `$4C` | `items[v16]...` | zero uses in MI1 |
| resourceRoutines | `$0C` | `sub-opcode` | `$01..$10` load/nuke/lock/unlock (script/sound/costume/room) · `$11` clear-heap · `$12` load-charset · `$13` nuke-charset · `$14 room object[p16]` load-object |
| systemOps | `$98` | `sub-opcode` | `$01` restart · `$02` pause · `$03` quit |
| matrixOp | `$30` | `sub-opcode` | `$01 box val` box-flags · `$02/$03 box val` box-scale (zero uses in MI1) · `$04` create-box-matrix |
| getRandomNumber | `$16` | `result seed[p8]` | result spans `[0, seed]` **inclusive** |
| drawBox | `$3F` | `left top auxopcode[8] right bottom color[p8]` | the fill persists on the virtual screen until the next room redraw |
| debug | `$6B` | `param[p16]` | |
| dummy | `$A7` | — | |
