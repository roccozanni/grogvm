# SCUMM v5 — Input, Verbs, and Sentences

This document explains how a SCUMM v5 game turns a mouse click into an
action: the cursor/user-input state the engine maintains, the per-frame
hover poller, the verb-input script the engine runs on every click, the
"sentence" the game assembles from a verb plus one or two objects, and
the sentence script that finally carries it out. Inventory is part of
the same machinery — inventory items are verbs.

The surprising thing about this subsystem is how little of it the engine
does. The engine maintains a handful of state variables and runs three
game scripts at the right moments; **the game's own bytecode does the
verb arming, the object gathering, the preposition logic, and the
commit.** Everything below was derived by tracing MI1's scripts; the
script numbers (`#4`, `#23`, `#2`, …) and global indices (`g107`,
`g108`, …) are MI1-specific, but the *mechanism* is the v5 engine's.

---

## 1. Cursor and user-input state

Two engine variables gate all input:

- **`VAR_CURSORSTATE`** (g52) — whether the cursor is "live".
- **`VAR_USERPUT`** (g53) — whether the engine accepts user input.

Both are **counters, not booleans.** The `cursorCommand` opcode (`0x2C`)
adjusts them through eight sub-ops:

| Sub-op | Name | Effect |
|--------|------|--------|
| `0x01` | cursor on | `cursorState = 1` |
| `0x02` | cursor off | `cursorState = 0` |
| `0x03` | userput on | `userput = 1` |
| `0x04` | userput off | `userput = 0` |
| `0x05` | cursor soft on | `cursorState++` |
| `0x06` | cursor soft off | `cursorState--` |
| `0x07` | userput soft on | `userput++` |
| `0x08` | userput soft off | `userput--` |

The *soft* variants increment/decrement so that nesting works: if a
cutscene soft-turns-off the cursor and then soft-turns it back on, the
cursor only reappears if it was on to begin with. The hard on/off set
the absolute 1/0.

At the end of `cursorCommand` the engine publishes the live counters
into the variables (`VAR_CURSORSTATE = cursorState`,
`VAR_USERPUT = userput`) so a script polling them right after the opcode
sees the current value. `VAR_USERPUT` is what scripts (and the engine)
consult to decide whether a click should be honoured at all — a
cutscene drops it so clicks don't pass through to the room.

No script ever *writes* these variables directly; they are
engine-maintained. (See [cutscenes.md](cutscenes.md)
for how the cutscene start/end scripts drive them.)

## 2. The hover poller

While the cursor is live, the engine runs a per-frame **hover poller** —
in MI1 this is global script `#23`. It is a self-restarting loop
(`breakHere` then jump back to the top each frame) gated on the cursor
state:

```
unless (0 < VAR_CURSORSTATE) goto end     // do nothing while the cursor is dead
```

When it runs, it hit-tests whatever is under the cursor and records it:

1. It reads the virtual mouse position from **`VAR_VIRT_MOUSE_X` /
   `VAR_VIRT_MOUSE_Y`** (g20/g21), which the engine updates as the mouse
   moves.
2. It calls **`findObject(x, y)`** to find a room object at that point,
   and **`actorFromPos(x, y)`** to find an actor, applying class filters
   (e.g. skipping objects/actors the current verb can't apply to).
3. It writes the result into the game's **active-object globals** (see
   §4): the hovered object becomes object A, or object B if a second
   object is being gathered.
4. It also updates the on-screen hover highlight, the object's **default
   verb**, and the **sentence line** (§6).

The consequence that matters: **by the time the player clicks, the
object under the cursor is already stored in a game global.** The click
itself carries no object id — it doesn't need to.

## 3. The click dispatch (verb-input script)

On a click the engine runs the **verb-input script**, whose id is held
in **`VAR_VERB_SCRIPT`** (g32). It is started with three locals:

```
local0 = clickArea      // 1 = verb bar, 2 = scene, 3 = inventory, 4 = key
local1 = code
local2 = button
```

The engine decides `clickArea` and `code` in its `checkExecVerbs`
routine:

- **A verb was clicked** (the cursor is over a verb slot):
  `runInputScript(1, verbId, button)`.
- **The scene was clicked** (anywhere else in the room):
  `runInputScript(2, 0, button)` — **the object id is `0`.** The clicked
  object is *not* passed; the script reads it from the active-object
  global the hover poller already filled in.

`VAR_VERB_SCRIPT` defaults to a global handler at boot and is usually
overridden per-room by the room's entry script. In MI1 the default
handler is global `#4`.

**The sentence line is a clickable verb the script self-guards.** The
sentence line is itself verb `#100` (§6) and is "on", so `findObject`/
`findVerbAtPos` *do* return it — a click dispatches `runInputScript(1,
100, button)` just like any verb. `#4` handles it: `if (local1 == 100)
stopScript 0` (also the 200–207 / 208–209 inventory and scroll-arrow ids)
**before** the `g107 = local1` arming. So the sentence-line click is inert
by virtue of the script, not by the shell refusing to hit-test it.
`stopScript 0` means **stop the *current* script** (`o5_stopScript`:
`if (script == 0) stopObjectCode()`), the idiom scripts use to bail at a
guard — treat arg 0 as a no-op and `#4` falls through and arms "verb 100",
wiping the in-progress sentence.

## 4. Active verb / object — game globals

The verb-input script keeps the in-progress sentence in **game
globals**, not engine system variables. (This is worth stressing: an
engine reimplementing v5 should not hard-code these indices — they are
defined by the game's bytecode. MI1 uses:)

| Global | Meaning |
|--------|---------|
| `g107` | active verb (the armed command; the walk-to verb when nothing is armed) |
| `g108` | object A |
| `g109` | object B |
| `g110` | preposition / "awaiting second object" flag |
| `g181` | object currently under the cursor (hover) |
| `g182` | the hovered object's *default verb* |

A verb-bar click sets the active verb (`g107 = local1`) and clears the
object slots. A scene click does nothing to the verb; it relies on the
hover poller having set object A. When the active verb is a one-object
verb (Look at, Open, Pick up, …), object A is enough and the script
commits immediately. When it is a **two-object verb** the script arms
the preposition instead — see §5.

## 5. Sentences, prepositions, and the commit

A **sentence** is the tuple `(verb, objectA, objectB)`. The game commits
one with the **`doSentence`** opcode (`0x19`), which pushes it onto the
engine's sentence queue:

```
doSentence verb objectA objectB     // queue a sentence
doSentence 0xFE                      // clear the queue / stop the sentence script
```

Once per frame the engine runs the **sentence script** (its id is in
**`VAR_SENTENCE_SCRIPT`**, g33; MI1 = `#2`) if the queue is non-empty,
passing `(verb, objectA, objectB)` as its first three locals. The
sentence script is the **executor**: it walks the actor to the object,
faces it, runs the object's verb code, prints the response. It is *not*
where objects are gathered — by the time it runs, the sentence is
complete.

**A printing sentence blocks the next one.** A sentence whose verb code
prints a line (e.g. "Look at X" → `printEgo`) doesn't return control until
that message clears — the script blocks on the message. A *new* sentence
issued while the line is still up has no effect: the verb/scene click is
accepted but the command can't run. (Observed concretely: clicking a door
to walk through it while ego is mid-line paths ego all the way to the door
but the room change never fires until the line finishes.) The faithful
consequence for any driver/agent is to **wait for the current line to
clear** — `VAR_HAVE_MSG` (g3) drops / `activeDialog` goes null — before
issuing the next command, exactly as a player waits for ego to stop
talking.

### Two-object verbs ("Use X with Y", "Give X to Y")

In MI1 the two-object verbs are **Use** (verb 7) and **Give** (verb 4).
The verb-input script handles them like this:

1. Verb clicked → `g107 = 7`, object slots cleared.
2. First scene click → the hover poller has put the object in `g108`.
   The script sees a two-object verb with object A filled, so instead of
   committing it **arms the preposition flag** (`g110`) — often after
   asking a helper script whether object A even *takes* a second object
   (a class check). The sentence line now reads "Use X with…".
3. With the preposition armed, the hover poller routes the *next*
   hovered object into `g109` instead of `g108`.
4. Second scene click → both objects are present, so the script commits
   `doSentence(g107, g108, g109)`.

Because the "does this verb/object need a second object" decision lives
in the game's scripts (via class checks), an engine should **not**
hard-code a list of two-object verbs — running the verb-input script
faithfully gets it for free.

**Object B can be an actor.** "Give X to <actor>" targets an actor, not a
CDHD object — e.g. giving the pot to a Fettucini brother (actor 3) in room
51. Object A still comes from an inventory verb slot (inventory is verbs,
§7); object B is resolved by the **receiving room's** sentence handler
calling `actorFromPos(cursorX, cursorY)` (the virtual-mouse globals g20/g21)
and matching the actor id. So clicking an actor depends on `actorFromPos`,
which hit-tests the cursor against each actor's **sprite box**.

**Actor hit-testing needs the sprite box, render or not.** SCUMM's
`getActorFromPos` uses the actor's last-drawn gfx extent. The compositor
stamps a draw-bounds box each painted frame — but a headless driver (the
walkthrough) paints nothing, so the box must be derivable without a
framebuffer. A preparation pass resolves the drawable limbs + their unioned
sprite box from costume + anim + position alone; the **compositor consumes
it** (blit + bounds, one decode, one source of truth), and the hit-test
derives the same box on demand when nothing's been drawn. So `actorFromPos`
— and thus Talk-to / Give-to an actor — resolves identically with or
without a render.

### Dialog answers are verbs too

A conversation menu is built from live verbs (like inventory, §7): each
option is a verb whose `name` is the localized line, created by the
conversation script via `verbOps`. In MI1 the option's verb id is computed
**`120 + (optionIndex − 1)`** within the *current* menu (the script pushes
`120, optionIndex` and the engine forms the id), and the picked verb id
lands in **`g194`** for the script to branch on. The ids are **per-menu**:
the same id (esp. 120, the first option) recurs across the nodes of one
conversation, so a driver must pick options *in sequence*, letting each
menu dismiss (the options speak between picks) before the next — id alone
doesn't identify the node. To assert *what* was picked without hardcoding a
translation, read the chosen verb's own `name` (the testkit's
`pickDialogAnswer` returns it).

### The default verb (right-click)

The right mouse button performs the hovered object's **default verb**
rather than the armed one. The verb-input script detects `button == 2`
and arms `g107 = g182` (the default verb the hover poller recorded for
that object). For ordinary scenery the default verb is Look at, so
right-click examines; for a door it might be Open. There is no separate
"right-click = Look at" rule in the engine — it falls out of the default
verb the hover poller assigns per object.

## 6. The sentence line

The strip of text at the top of the verb area ("Walk to door", "Use
stick with…") is itself rendered through a **verb** — in MI1, verb
`#100`. The verb-input and hover scripts rebuild its name every frame
with `verbOps setName`, assembling it from **substitution codes**: an
embedded `0xFF NN` sequence in the verb name expands to the name of the
active verb, object A, the preposition, and object B. So the sentence line
is not special engine text; it is an ordinary verb whose name the scripts
keep rewriting — render it directly, don't synthesise a parallel string.

**The substitution-code table** (`convertMessageToString`; each code is
`0xFF NN` + a 2-byte little-endian argument; codes ≥ 0x04 are 4 bytes
total, 0x01–0x03 are 2):

| code | meaning | argument |
|------|---------|----------|
| `0x04` | integer value, decimal | var ref → `readVar(num)` |
| `0x05` | **verb name** | var ref → verb id |
| `0x06` | **object/actor name** | var ref → object id |
| `0x07` | **string resource** | **direct** id (`addStringToStack(num)`, *not* a var) |

**A verb can be named from the string buffer, not just an inline name.**
`verbOps setName` (`0x7A` subop `0x02`) takes the name *inline* in the
bytecode, but a separate sub-op (`0x14`) sets the verb name from the
current **string buffer** instead — it copies whatever a prior script
loaded there. MI1's duel menus use this: each option is named by
`startScript 85/86 [id]` (which fills string buffer 32/33 for that
insult/comeback) followed by the buffer-naming `verbOps`. Because
`startScript` runs **nested** (OPCODES §6), the buffer is already
populated when the name op reads it. A no-op implementation of the
buffer-naming sub-op leaves each option showing its stale previous name.

The 0x05/0x06/0x07 distinction is easy to get wrong: int/verb/name read
their id *through* a variable, but string takes the id **directly**. MI1's
`#100` is `verb[g107] str[g49] name[g108] " " verb[g110] " " name[g109]`,
i.e. *active-verb objectA prep objectB*. Two MI1-specific facts fall out:
the **preposition** `g110` is itself a *verb* whose name is "con" / "a"
(so it expands via the 0x05 verb path, not a literal), and the verb↔objectA
**separator** is string resource 49 = `" "` — `g49`'s *value* is 0, so
reading 0x07 through the var (instead of by direct id) drops the space and
yields "Usail pezzo". Object names splice in with their `@` padding, which
the renderer skips ([OBJECTS §5](objects.md)). Expansion needs the
live VM + slot; decode a verb name without them and every code is dropped
(blank line).

**`0x06` resolves actor-or-object, actor first** (SCUMM's
`getObjOrActorName`). A low id — within the actor table (`id ≤
actors.capacity`, the same rule `objActPos`/`faceActor` use) — is an
*actor*, resolved to its `setActorName` name; everything else is an object
(override → room OBNA → carried-item snapshot). The actor name is set by
`actorOps setActorName` (`0x0D`), stored on the actor, and persists across
rooms + saves — it must, because it's set once at room entry, not when the
sentence is built. MI1 room 51 names actors 3 & 4 "Fratelli Fettucini" in
its ENCD; "Dai la pentola a …" expands `name[g109]=3` through this actor
path. Skip storing the name and the target renders blank ("Dai la pentola a
").

**Archived verbs are not drawn.** During a conversation MI1 archives the
sentence line (`#100`) and the action verbs via `saveRestoreVerbs` (a
non-zero `saveid`) and creates the dialog replies as their own verbs.
SCUMM does not draw a verb carrying a non-zero saveid, so the verb-bar
render *and* hit-test must skip any verb currently in the saved-verb set
— otherwise the still-"on" sentence line `#100` (at
y=145) draws over the first reply verb (`#120`, also y=145). The
render-skip is the faithful low-risk subset of SCUMM's full per-verb
saveid model.

**Dialog replies are verbs, selected via the mouse-coord hit-test.** The
reply lines are created as verbs (MI1 `#120…#124`); the dialog driver
(global `#93`) parks in a `breakHere` loop polling **`g194`** and branches
on its value. During a conversation `VAR_VERB_SCRIPT` swaps to script
**`#14`**, which sets `g194` from a `findObject(VAR_VIRT_MOUSE_X/Y =
g20/g21)` hit-test against the dialog slot table on **clickArea 2** — *not*
from the clicked verb id. So selection needs live mouse coords (`g20/g21`,
which the shell writes on pointer move); a headless click that only sets a
verb id won't resolve.

**Building the reply menu is ordering-sensitive.** Each round, the dialog
script (room-28 `#220`/`#59`) does roughly: framework `startScript 17[5]`
(create the 9 reply slots), then `startScript 32` (reset: clear the slots +
set the reply-Y base `g229` + re-enable input), then fills the active
replies with `verbOps setName … on`. This *only* works because `startScript`
runs **nested** (OPCODES §6) — the framework/reset run before the fill. If
`startScript` were deferred, the fill ran first and the reset wiped it
(intermittent black/empty answer bar). Two related verb/dialog facts:
- **`SO_VERB_NEW` creates the slot `off` (curmode 0), and does not touch the
  name/position** — a later `SO_VERB_ON` makes it visible. Creating it `on`
  or blanking the name corrupts the reply slots mid-build.
- **Actor-talk ink is the speaker's *live* `talkColor`, read at render time**
  (SCUMM reads it every frame the line is up). A colour set by a helper the
  dialog `startScript`s right before the `print` (e.g. `#221` → `talkColor=14`
  for the pirates) therefore still tints the line. The shell flags such lines
  (`ActiveDialog.colorFromActor`) and resolves the ink live; system text /
  explicit `SO_COLOR` keep their print-time value.

## 7. Inventory is verbs

There is no separate inventory widget. MI1 lays the inventory out across
**verb slots 200–207** (a 4×2 grid), with **208/209** as the scroll
arrows. A dedicated **inventory script** (`VAR_INVENTORY_SCRIPT`, g34;
MI1 = `#9`) runs when the inventory changes: it walks the player's owned
objects with `findInventory` and assigns each to a slot.

Inventory membership is **ownership**: an object is in an actor's
inventory iff that actor owns it (`pickupObject` / `setOwnerOf`), and
`getInventoryCount` / `findInventory` enumerate by owner in pickup
order. Because slots are verbs, clicking an inventory item is just a
verb click (`clickArea = 1`) with the slot's verb id; the script maps
the slot back to the object.

Inventory items render as **object icons, not text**. The slots are
"image verbs": the script assigns each slot an object image (via
`verbOps` image sub-ops) drawn from a **global UI room** that holds the
slot-cell and arrow artwork, rather than a per-item icon. (In MI1 the UI
room is room 99; the occupied-cell artwork is a single generic object
reused for every filled slot.)

## 8. Putting it together

A complete "Look at the poster" in MI1, end to end:

1. The cursor is live (`VAR_CURSORSTATE > 0`), so `#23` runs each frame.
   The player moves over the poster; `#23` hit-tests it and stores it in
   `g108`, highlights it, and sets the sentence line to "Look at poster".
2. The player clicks the **Look at** verb → `runInputScript(1, 8, …)` →
   `#4` sets `g107 = 8`.
3. The player clicks the **poster** → `runInputScript(2, 0, …)` → `#4`
   sees a one-object verb with `g108` filled and commits
   `doSentence(8, poster, 0)`.
4. Next frame the engine runs the sentence script `#2`, which walks
   Guybrush over, faces the poster, and prints its description.

The same path, with the player armed with **Use** and clicking two
objects, produces a two-object sentence via the `g110` preposition step
in §5.

## 9. Keyboard shortcuts (Escape, dot)

Two engine-level keys the player uses during scripted moments:

- **Escape — abort the cutscene.** Skips a *skippable* cutscene (one that
  armed an `override`): the cutscene script jumps to its override target.
  Ends the whole scene.
- **`.` (dot) — skip the current line of speech.** The per-line analogue of
  Escape. It drains the current talk page: if the printed message has more
  sentence pages queued (split at `\xff\x03`, see §6 / char.md) it flips to
  the next page; otherwise it ends the message (clears `VAR_HAVE_MSG`, so a
  `wait-for-message` releases). One press = one page, mirroring the talk
  timer's natural drain — both share the same talk-advance step. A no-op
  when nothing is being said.

Both are routed the same way: the shell turns the keydown into an
engine-level key input, and the session dispatches Escape → abort cutscene,
`.` → skip text. They are distinct: Escape ends a scene, the dot ends a
single spoken line.
