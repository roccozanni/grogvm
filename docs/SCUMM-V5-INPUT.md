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

## Sources

- ScummVM's `checkExecVerbs` / `runInputScript` (the engine side of the
  click dispatch) for the contract; MI1 bytecode (`scripts #2`, `#4`,
  `#9`, `#23`) for everything the game does with it. Variable indices
  are the canonical v5 system-var table plus MI1's game globals.

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
engine-maintained. (See [SCUMM-V5-CUTSCENES.md](SCUMM-V5-CUTSCENES.md)
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
embedded `0xFF NN` sequence in the verb name expands at draw time to the
name of the active verb, object A, the preposition, and object B. So the
sentence line is not special engine text; it is an ordinary verb whose
name the scripts keep rewriting.

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
