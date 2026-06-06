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

`00`/`A0` stopObjectCode · `01` putActor · `02` startMusic · `03` getActorRoom ·
`05` drawObject · `06` getActorElevation · `07` setState · `08` isNotEqual ·
`09` faceActor · `0A` startScript · `0B` getVerbEntryPoint · `0C` resourceRoutines ·
`0D` walkActorToActor · `0E` putActorAtObject · `0F` getObjectState · `10` getObjectOwner ·
`11` animateActor · `12` panCameraTo · `13` actorOps · `14` print · `15` actorFromPos ·
`16` getRandomNumber · `17` and · `18` jumpRelative · `19` doSentence · `1A` move ·
`1B` multiply · `1C` startSound · `1D` ifClassOfIs · `1E` walkActorTo · `1F` isActorInBox ·
`20` stopMusic · `22` getAnimCounter · `23` getActorY · `24` loadRoomWithEgo ·
`25` pickupObject · `26` setVarRange · `27` stringOps · `28` equalZero · `29` setOwnerOf ·
`2B` delayVariable · `2C` cursorCommand · `2D` putActorInRoom · `2E` delay · `30` matrixOp ·
`31` getInventoryCount · `32` setCameraAt · `33` roomOps · `34` getDist · `35` findObject ·
`36` walkActorToObject · `37` startObject · `38` lessOrEqual · `3A` subtract · `3B` getActorScale ·
`3C` stopSound · `3D` findInventory · `3F` drawBox · `40` cutScene · `42` chainScript ·
`43` getActorX · `44` isLess · `46` increment · `48` isEqual · `4C` soundKludge ·
`52` actorFollowCamera · `54` setObjectName · `56` getActorMoving · `57` or · `58` override ·
`5A` add · `5B` divide · `5D` actorSetClass · `60` freezeScripts · `62` stopScript ·
`63` getActorFacing · `66` getClosestObjActor · `67` getStringWidth · `68` getScriptRunning ·
`6B` debug · `6C` getActorWidth · `6E` stopObjectScript · `70` lights · `71` getActorCostume ·
`72` loadRoom · `78` isGreater · `7A` verbOps · `7B` getActorWalkBox · `7C` isSoundRunning ·
`80` breakHere · `98` systemOps · `A7` dummy · `A8` notEqualZero · `AB` saveRestoreVerbs ·
`AC` expression · `AE` wait · `C0` endCutScene · `C6` decrement · `CC` pseudoRoom · `D8` printEgo

(`04` isGreaterEqual. High-bit variants of an opcode are param-mode
variants of the same base instruction — dispatch is per full byte.)

## Encodings (selected — the ones we decode/implement)

### Flow / variables
- **stopObjectCode** `$A0`/`$00` — `opcode`. Marks script dead. `$A0` in LSCR/SCRP; `$00` in ENCD/EXCD/VERB.
- **breakHere** `$80` — `opcode`. Deschedule; resume next instruction next timeslot.
- **jumpRelative** `$18` — `opcode target[16]`. `PC += target` (signed, from after the instruction).
- **move** `$1A` — `opcode result value[p16]`. `result := value`.
- **add** `$5A` / **subtract** `$3A` / **multiply** `$1B` / **divide** `$5B` / **and** `$17` / **or** `$57` — `opcode result value[p16]`.
- **increment** `$46` / **decrement** `$C6` — `opcode result`.
- **setVarRange** `$26` — `opcode result number[8] values[8]...` (or `values[16]...` if opcode high bit set). Sets `number` consecutive vars from `result`.
- **isEqual** `$48` / **isNotEqual** `$08` / **isLess** `$44` / **isGreater** `$78` / **isGreaterEqual** `$04` / **lessOrEqual** `$38` — `opcode var value[p16] target[16]`. `unless (value OP var) goto target`. NB operand order: `value OP var`.
- **equalZero** `$28` / **notEqualZero** `$A8` — `opcode var target[16]`. `unless (var ==/!= 0) goto target`.
- **expression** `$AC` — `opcode result subopcode... $FF`. Stack VM: `$01 value[p16]` push; `$02..$05` add/sub/mul/div; `$06 nested-opcode` run an instruction and push its VAR_RESULT.

### Scripts
- **startScript** `$0A` — `opcode script[p8] args[v16]...`. Bit 6 = recursive, bit 5 = freeze-resistant.
- **startObject** `$37` — `opcode object[p16] script[p8] args[v16]...`. Runs the object's (OBCD) script.
- **chainScript** `$42` — `opcode script[p8] args[v16]...`. Replace current script in-thread.
- **stopScript** `$62` `opcode script[p8]` · **stopObjectScript** `$6E` `opcode script[p16]`.
- **freezeScripts** `$60` — `opcode flag[p8]`. `>= $80` also freezes freeze-resistant; `0` unfreezes. Cumulative.
- **getScriptRunning** `$68` — `opcode result script[p8]`.
- **doSentence** `$19` — `opcode verb[p8] objectA[p16] objectB[p16]`. If `verb == $FE`, stop the sentence script / clear status.
- **cutScene** `$40` `opcode args[v16]...` · **endCutScene** `$C0` `opcode`.
- **override** `$58` — `opcode sub-opcode`: `$00` end override; `$01 $18 target[16]` begin (followed by a jumpRelative; ESC jumps by target).
- **wait** `$AE` — `opcode sub-opcode`: `$01 actor[p8]` wait-for-actor; `$02` wait-for-message (VAR[3]); `$03` wait-for-camera; `$04` wait-for-sentence. Breaks + resumes at this instruction until satisfied.
- **delay** `$2E` `opcode param[24]` (24-bit LE! 1/60s units) · **delayVariable** `$2B` `opcode var`.

### Objects
- **setState** `$07` — `opcode object[p16] state[p8]`.
- **getObjectState** `$0F` `opcode result object[p16]` · **getObjectOwner** `$10` `opcode result object[p16]`.
- **setOwnerOf** `$29` — `opcode object[p16] owner[p8]`.
- **drawObject** `$05` — `opcode object[p16] sub-opcode`: `$01 xpos[p16] ypos[p16]` draw-at; `$02 state[p16]` set-state; `$FF` draw.
- **setObjectName** `$54` — `opcode object[p16] name[c]... $00`.
- **pickupObject** `$25` — `opcode object[p16] room[p8]`. Adds object to Ego's inventory.
- **findObject** `$35` — `opcode result x[p8] y[p8]`. First touchable object at coords (excl. bottom/right edges).
- **findInventory** `$3D` — `opcode result owner[p8] index[p8]`.
- **getInventoryCount** `$31` — `opcode result actor[p8]`.
- **getVerbEntryPoint** `$0B` — `opcode result object[p16] verb[p16]`. Returns the
  object's script entry for `verb`, **or its `0xFF` default-verb entry** when the
  exact verb has none (SCUMM matches `entry || 0xFF`). This fallback is the opener
  for edge exits: a plain walk-to (verb 11) on an exit whose only verb is `0xFF`
  reads truthy here → sentence #2 runs it → `loadRoom` (the room-78 "can't exit").
- **getClosestObjActor** `$66` — `opcode result actor[p16]`. (≤255 units.)
- **getDist** `$34` — `opcode result objA[p16] objB[p16]`.
- **ifClassOfIs** `$1D` — `opcode value[p16] args[v16]... target[16]`. `unless (value's class ∈ args) goto target`.
- **actorSetClass** `$5D` — `opcode object[p16] classes[v16]...`. Object inherits all given classes; **a class of `0` clears all class data**. (No jump. The high bit `$80` of a class value = set; without = clear — derived from MI1 usage toggling class 32 / `0x80|32`.)

### Actors
- **putActor** `$01` `opcode actor[p8] x[p16] y[p16]` · **putActorInRoom** `$2D` `opcode actor[p8] room[p8]` · **putActorAtObject** `$0E` `opcode actor[p8] object[p16]`.
- **walkActorTo** `$1E` `opcode actor[p8] x[p16] y[p16]` · **walkActorToActor** `$0D` `opcode walker[p8] walkee[p8] distance[8]` · **walkActorToObject** `$36` `opcode actor[p8] object[p16]`.
- **animateActor** `$11` `opcode actor[p8] anim[p8]` · **faceActor** `$09` `opcode actor[p8] object[p16]`.
- **actorOps** `$13` — `opcode actor[p8] sub-opcode... $FF`. Subops: `$01` costume, `$02 xspeed yspeed` step-dist, `$03` sound, `$04` walk-frame, `$05 start end` talk-frames, `$06` stand-frame, `$08` default/init, `$09 elevation[p16]`, `$0A` anim-default, `$0B index val` palette, `$0C` talk-color, `$0D name[c]...$00`, `$0E` init-frame, `$10` width, `$11 xscale yscale`, `$12` never-zclip, `$13 zplane` always-zclip, `$14` ignore-boxes, `$15` follow-boxes, `$16` anim-speed, `$17` shadow.
- **getActorX** `$43` / **getActorY** `$23` — `opcode result actor[p16]`. **getActorRoom** `$03`, **getActorElevation** `$06`, **getActorMoving** `$56`, **getActorFacing** `$63`, **getActorScale** `$3B`, **getActorWidth** `$6C`, **getActorWalkBox** `$7B`, **getActorCostume** `$71`, **getAnimCounter** `$22` — `opcode result actor[p8]`.
- **actorFromPos** `$15` `opcode result x[p16] y[p16]` · **isActorInBox** `$1F` `opcode actor[p8] box[p8] target[16]`.

### Camera / room
- **setCameraAt** `$32` `opcode x[p16]` · **panCameraTo** `$12` `opcode x[p16]` · **actorFollowCamera** `$52` `opcode actor[p8]`.
- **loadRoom** `$72` `opcode room[p8]` · **loadRoomWithEgo** `$24` `opcode object[p16] room[p8] x[16] y[16]`.
- **roomOps** `$33` — `opcode sub-opcode`. Subops incl. `$01 minX maxX` scroll, `$03 b h` screen, `$04` palette, `$05/$06` shake on/off, `$0A effect[p16]` fade, `$10 colindex delay` cycle-speed (see source for full list).
- **lights** `$70` — `opcode arg1[p8] arg2[8] arg3[8]`.
- **pseudoRoom** `$CC` — `opcode val[8] res[8]... $00`. For each `res` with the high bit set, aliases room id `res` → physical room `val`, keyed by the **raw** id (the high bit is kept, *not* masked to `res & $7F`) since the game references these ids verbatim (`VAR_ROOM` holds them). MI1: 201–220 → 58 (forest maze), 130–132 → 1.

### Verbs / cursor / text
- **verbOps** `$7A` — `opcode verbID[p8] sub-opcode... $FF`. Subops: `$01 object[p16]` image, `$02 name[c]...$00`, `$03` color, `$04` hicolor, `$05 left top` at, `$06` on, `$07` off, `$08` delete, `$09` new, `$10` dimcolor, `$11` dim, `$12 key`, `$13` center, `$14 stringID[p16]` name-str, `$16 object[p16] room[p8]` assign-object, `$17` back-color.
- **cursorCommand** `$2C` — `opcode sub-opcode`. `$01/$02` cursor on/off, `$03/$04` userput on/off, `$05/$06` cursor soft on/off, `$07/$08` userput soft on/off, `$0A cursornum charletter` image, `$0B index x y` hotspot, `$0C cursor` set, `$0D charset` charset-set, `$0E colors[v16]...` charset-colors.
- **print** `$14` — `opcode actor[p8] sub-opcode`: `$00 xpos ypos` at, `$01 color`, `$02 right` clipped, `$03 w h` erase, `$04` center, `$06` left, `$07` overhead, `$0F string[c]...$FF` text.
- **printEgo** `$D8` — like print, actor = Ego implicitly.
- **getStringWidth** `$67` `opcode result strptr[p8]` · **setObjectName** `$54` (above).
- **stringOps** `$27` — `opcode sub-opcode`: `$01 id string[c]...$00` load, `$02 dst src` copy, `$03 id index char[c]` write-char, `$04 result id index` read-char, `$05 id size` new.
- **saveRestoreVerbs** `$AB` — `opcode sub-opcode`: `$01/$02/$03 start end mode` save/restore/delete verbs.

### Sound / system
- **startMusic** `$02` `opcode music[p8]` · **stopMusic** `$20` `opcode` · **startSound** `$1C` `opcode sound[p8]` · **stopSound** `$3C` `opcode sound[p8]` · **isSoundRunning** `$7C` `opcode result sound[p8]` · **soundKludge** `$4C` `opcode items[v16]...`.
- **resourceRoutines** `$0C` — `opcode sub-opcode`: `$01..$10` load/nuke/lock/unlock (script/sound/costume/room), `$11` clear-heap, `$12` load-charset, `$13` nuke-charset, `$14 room object[p16]` load-object.
- **systemOps** `$98` — `opcode sub-opcode`: `$01` restart, `$02` pause, `$03` quit.
- **matrixOp** `$30` — `opcode sub-opcode`: `$01 box val` box-flags, `$02/$03 box val` box-scale, `$04` create-box-matrix.
- **getRandomNumber** `$16` `opcode result seed[p8]` · **drawBox** `$3F` `opcode left top auxopcode[8] right bottom color[p8]` · **debug** `$6B` `opcode param[p16]` · **dummy** `$A7` `opcode`.

## v3/v4 differences worth remembering

- `$0F` is `ifState` (v3-4) but `getObjectState` (v5); `$2F` `ifNotState` is v3-4 only.
- `$25` is `pickupObject` (v5) but `drawObject` (v3-4).
- `$22` is `getAnimCounter` (v5) but `saveLoadGame` (v3-4).
- `$A7` is a dummy (v5) but `saveLoadVars` (v3-4).
- actorOps subop numbers differ in v3/v4.
