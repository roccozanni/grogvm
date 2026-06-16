---
title: How
description: "How GrogVM was actually built: three weeks and hundreds of commits reverse-engineering SCUMM v5, the struggles and dead ends, the bug-by-bug march through The Secret of Monkey Island, and the parts still unsolved."
---

# How GrogVM was built

The [Why](/why/) is a love letter. This is the how: three weeks of arguing
with an AI about the cleverness of a virtual machine from 1990.

I started on **May 25th, 2026** with an empty project and a `Play` button that
did nothing. Three weeks and **hundreds of commits** later, *The Secret of Monkey
Island* plays from the boot screen to the end credits in a Chromium browser tab,
with no app backend and no emulator underneath. About **35,000 lines** of
TypeScript for the engine, another **6,000** for the harness that plays the game
to prove it still works.

It was never a straight line. There were plenty of reverts, one
struggle I still haven't won, and a lot of days that were nothing but fixing bugs. One 
bug per room, found by actually playing.

## Day zero was about trust

You don't start a SCUMM engine by drawing anything. Especially if you don't know 
what the heck you're doing. So first you ask the AI if it's even possible. Half 
of the answer mentions stuff you've never heard about (WTH are jiffies, z-planes or CLUTs?)
but you have to trust the process, there's no other way. The only thing I know is
that after 20 years writing software I developed a strong sense of smell for
bullshit, hacks and workarounds. I'll have to trust my nose. I asked the agent to craft
a high-level building plan based on our discussions, and this is how it looked:

```
- Phase 1 — Resource catalog: Walk the block tree, dump everything.
- Phase 2 — First pixels: Decode palette + room 1 background to Canvas2D.
- Phase 3 — Costumes: Decode and draw an actor frame, with Z-plane masking.
- Phase 4 — Text: Decode `CHAR` glyphs, render dialog.
- Phase 5 — VM skeleton: Script slots, variables, opcode dispatch, boot script.
- Phase 6 — Enough opcodes to walk: Reach the SCUMM Bar.
- Phase 7 — Verb UI + input: Click-to-walk, look-at, pick-up.
- Phase 8 — Save states.
- Phase 9 — Audio: iMUSE + AdLib first; MT-32 and CD redbook later.
- Phase 10 — MI2 + polish.
```

LOL: I had no idea what I was getting into.

## Day one was a dump

The game's data files are a tree of nested binary blocks, and before you can render a single pixel you have
to walk that tree and say "this is a room, this is a script, this is a costume."
So the first real commit was exactly that: a block-tree dump. No graphics, no
sound, just proof I could read the format the way the original engine did.

The next day: first pixels. A room background, decoded from the game's own
compressed bitmap format and painted onto a `<canvas>`. That's the moment it
stopped being a parsing exercise. When I saw the first room on screen I almost cried.

From there it went layer by layer: the costume format and the actor
compositor, the bitmap font and its renderer, then the VM itself: a bytecode
interpreter for SCUMM's ~100 opcodes. Only *then* could the thing boot itself:
load the first room, place the actors, and start running the game's own scripts.

## Teaching Guybrush to walk nearly broke me

If one struggle captures the project's early days, it's the walk animation.

Drawing a static sprite is one thing. Getting Guybrush to *walk* 
(legs cycling, body holding, head pointing the right way, mirrored when he turns
west) meant decoding the costume *animation* format, and I got it wrong
over and over. I wired up a walk trigger, it flickered and showed two heads, 
I tried to fix the flicker, reverted both changes, and committed a note 
that just said *"document the reverted walk."*

The real bug was a **6-byte misalignment.** Every offset stored in the costume
data is relative to a base pointer six bytes earlier than where my decoder
thought the payload began. Once I figured out that the record, the command
stream, *and* the limb image table all had to be read at `payload[value − 6]`,
the double head resolved into one cycling body with the head held still, exactly
as the original does it. That single `−6` is the difference between a pirate and
a weird puppet.

I stopped trusting "looks right" after that. The fix only shipped once I'd checked it
headlessly across the intro's nine-actor scenes *and* with my own eyes.

## Playing the game *was* the test

Here's the part I didn't expect. Once the first room was playable, the fastest
way to find bugs was to *keep playing*, and the fastest way to keep them fixed
was to teach the agent to play too.

So the real spine of this project is the tooling that comes with it, mainly in 
the form of a harness enabling the agent to drive the engine headlessly and a single 
integration test that **boots the game and plays it**, beat by beat, the way a person would: walk
here, look at that, use this with that, pick the right insult in a swordfight.
It runs headless in seconds. Every time I pushed the playthrough one room
further I hit a new wall: an unimplemented opcode, an actor drawn behind
scenery it should be in front of, a door that wouldn't open. That wall
became the next commit.

While I initially played the game, reported the issues and then asked the
agent to write the corresponding beats in the walkthrough, at some point the flow
started running in the opposite direction. I'd give the agent rough gameplay 
instructions for the next 2-3 beats, and the agent would figure it out with a 
process like the following:

- Map the resources (rooms, objects, actors, scripts) involved in that particular
part of the game.
- Drive the engine headlessly using the mapped resources and the gameplay
instructions to validate the flow.
- When a blocker is encountered, analyze the root cause and fix the underlying
engine issue, then keep driving.
- Write the finalized beats.

An invaluable piece of the puzzle was the ability to save the VM state at the end
of each beat, allowing both me and the agent to pick up the game from any particular 
point we covered up to that moment. I'd import the save in the browser to eyeball
the rooms and identify the visual issues the agent wouldn't notice, and I'd share
saves back with the agent whenever I was stuck in a situation that wasn't covered
by the walkthrough.

With this in place, whole days read like a march through the game's geography:

- The SCUMM Bar door freeze: five semantic fixes just to get into one room.
- The Fettucini brothers' cannon gag: money handling, a brother drawn behind a
  haystack, talk text running off-screen, and Guybrush shrunk to a single dot
  in mid-flight. Four separate bugs in one joke.
- The insult swordfighting, ground out menu by menu until the harness could
  *beat the Sword Master.*
- The whole thievery trial: pick the petal, drug the dogs, trade Otis the cake,
  file out, grab the idol, get caught, end up in the sea, recover it.

By the end the harness walks all four parts from boot to credits, and the game
has been completed in a Chromium browser too. When those signals are green, the
game is playable end to end; the remaining rough edges are visual and audio
fidelity, not the core flow. That was the whole point.

## The eyes that won't stay on

Not everything got solved, and that's worth sharing.

VGA mode 13h stretched 320×200 to fill a 4:3 monitor, so the original's pixels
were taller than they were wide and the art was drawn *assuming* that. That part
I fixed: present at 4:3, and the proportions snap back to how they looked in
1990.

But when an actor walks toward or away from the camera, the engine scales the
sprite down, and it has to decide *which rows and columns of pixels to drop.*
Drop the wrong ones and Guybrush loses his eyes. I've spent a genuinely absurd
amount of effort here: extracting reference screenshots from the real game as an
"oracle," building diff masks gated on costume colors, running optimization over
a grid of sampling phases to minimize the frames where his eyes disappear. I got
it close. I tried a bit-reversal scale table that matched the static reference
shots better, and reverted it, because it made him visibly strut while walking.

So the honest status is: the faithful per-scale pattern is still unrecovered. I'd
need frame-accurate captures from ScummVM/DOSBox to crack it properly, and I haven't.

## The fire that can't crackle

Sound came in two phases. First a silent timing seam: the engine needs to
*know* how long a sound lasts even when nothing plays, because some scripts wait
on it. Then real output: digitized PCM effects and the CD-audio music, wired so the
music seeks to the right spot from the VM's own virtual clock. (That clock had
its own bug: leaking a fraction of every frame and running ~1–3% slow, which
I only realized when I could *hear* the music re-seeking every once in a while.)

What's *not* there is the AdLib/OPL2 FM synthesis: about 15 effects that exist
only as FM instrument data. I parked it. A deterministic FM synth reproduces a
lot, but it can't fake the broadband crackle of the lookout fire without proper
hardware captures to match against, and I'd rather have silence than a wrong
sound.

## The method, since it's an AI-built project

I'm not from the games industry, and I didn't hand-write these 35,000
lines. Claude (Opus 4.7, then 4.8, then Fable 5, then Opus 4.8 again) did the 
bit-flipping while I steered. A few things made that work over three weeks 
instead of collapsing into spaghetti:

- **Phases and a living tracker.** Work moved in phases, and a single
  `PROGRESS.md` held the current frontier. At each session's end, findings
  migrated out of the tracker into permanent [docs](/docs/) and the tracker got
  pruned back to "what's next." It never became a graveyard.
- **Docs as the AI's memory.** The reverse-engineering notes aren't an
  afterthought; they're how the next session remembers what the last one
  learned about SCUMM. I spent an **insane** amount of time working with the agent
  to rewrite, restructure and polish the documentation as we progressed
  through the game.
- **Tooling, Tooling and more Tooling.** The ability for the agent to autonomously 
  drive, observe and troubleshoot is the most important pillar. A rich set of tools
  has been built along the way, by routinely analyzing the one-off probes the agent
  was writing in `scratch/` looking for recurring patterns, and promoting the findings
  to first-class citizens. This led to the creation of a headless harness (`testkit`),
  a disassembler (`disgrogate`), a tracer (`spyglass`), a screenshot generator (`mugshot`),
  and countless helpers for resource extraction and inspection.
- **No hacks.** Except in the very first few days when we prioritized getting
  *something* on screen to look at (also due to the absence of tooling), the choice 
  was to model what the real engine actually does rather than special-case 
  the symptom. The few times I shipped a hack, I labeled it loudly and came back to remove it.

It reached the end credits on June 14th. And it was **AWESOME**.

Now go [install a copy you are allowed to use](/library/) and watch the magic
work.
