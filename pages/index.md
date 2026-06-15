---
title: GrogVM
description: A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one behind The Secret of Monkey Island and Monkey Island 2 — running in the browser, with no server and no emulator.
---

# GrogVM

![A pixel-art mug of glowing green grog beside a terminal prompt reading GrogVM](/grogvm.svg)

A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one that
ran *The Secret of Monkey Island* and *Monkey Island 2: LeChuck's Revenge* —
running in the browser, with no server and no emulator.

> **GrogVM ships no game data.** It is an engine, not the game: you point it at
> your own legally-owned copy of *The Secret of Monkey Island* on disk, and those
> files never leave your browser. Nothing here bundles or distributes any
> LucasArts content — see **[the game files & legality](/legal/)** for where to
> get the game and the full legal picture.

## Why

*The Secret of Monkey Island* is one of the first things I remember about PC
gaming, the first graphic adventure I ever played. I have an extremely vivid
memory of being at a friend's place in the mid-90s, watching him play as this
weird pirate sprinting across Mêlée Island with a mug of grog, the stuff so
corrosive it eats straight through the metal, pouring it from mug to mug all
the way to the prison before the grog eats through and there's nothing left to
melt Otis' cell lock. I was in shock, mind totally blown.

This time, replaying it one more time didn't feel "enough" — so I decided I'd
try rebuilding the engine that ran it all, to see how the magic actually
worked. This is my love letter to *Monkey Island*, LucasArts, and Ron Gilbert
— [read the full story](/why/).

## Discover GrogVM

> **Status:** in active development. *The Secret of Monkey Island* plays from
> boot all the way to the end credits — all four parts — with verbs, inventory,
> dialogue, cutscenes, saves, sound effects and CD-audio music, and every
> resource in its files is browsable in the explorer. A few AdLib-only audio
> effects and some visual polish are still in progress; see the
> [documentation](/docs/) for the full picture.

- **[Library](/library/)** — install a game you own from a local folder, then
  play it or explore its resources. (Everything starts here — you pick a game
  first.)
- **[Documentation](/docs/)** — the reverse-engineering notes behind the engine:
  resource formats, opcodes, graphics, timing, and more.
- **[Legal & game files](/legal/)** — what GrogVM does and doesn't ship, where to
  legally get *The Secret of Monkey Island*, and the no-piracy policy.
