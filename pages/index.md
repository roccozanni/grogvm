---
title: GrogVM
description: A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one behind The Secret of Monkey Island and Monkey Island 2 — running in the browser, with no server and no emulator.
---

# GrogVM

![A pixel-art mug of glowing green grog beside a terminal prompt reading GrogVM](/grogvm.svg)

A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one that
ran *The Secret of Monkey Island* and *Monkey Island 2: LeChuck's Revenge* —
running in the browser, with no server and no emulator. Games are never bundled or
distributed — you point GrogVM at your own copy on disk, and it stays in your browser.

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
> boot through the end of Part II — verbs, inventory, dialogue, cutscenes,
> saves, sound effects and CD-audio music — and every resource in its files is
> browsable in the explorer. Part III onward and the few AdLib-only audio
> effects are still in progress; see the
> [documentation](/docs/) for the full picture.

- **[Library](/library/)** — install a game you own from a local folder, then
  play it or explore its resources. (Everything starts here — you pick a game
  first.)
- **[Documentation](/docs/)** — the reverse-engineering notes behind the engine:
  resource formats, opcodes, graphics, timing, and more.
