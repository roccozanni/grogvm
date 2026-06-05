---
title: GrogVM
description: A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one behind The Secret of Monkey Island and Monkey Island 2 — running in the browser, with no server and no emulator.
---

# GrogVM

A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one that
ran *The Secret of Monkey Island* and *Monkey Island 2: LeChuck's Revenge* —
running in the browser, with no server and no emulator. Games are never bundled or 
distributed — you point GrogVM at your own copy on disk, and it stays in your browser.

## Why

*The Secret of Monkey Island* is one of the first
things I remember about PC gaming, the first graphic adventure I ever played. I
have an extremely vivid memory of being at a friend's place in the mid-90s, watching him play as 
this weird pirate sprinting across Mêlée Island with a mug of grog — the stuff so 
corrosive it eats straight through the metal — pouring it from mug to mug all the way to the prison, 
before the grog eats through and there's nothing left to melt the lock. 

I'm perfectly aware that others did the heavy lifting already to let 
people like me keep playing the game more than 30 years later, and I could have 
simply played it one more time on ScummVM, like I have countless times already. But this 
time that didn't feel "enough".

Even though I'm in a particularly lucky position to have plenty of time available
to spend on side projects, I'd never have embarked on something like this if it weren't
for AI. Even just learning ScummVM is a monumental task on its own, and I'm more into
"doing stuff" than "reading about stuff". So I decided I'd try rebuilding the engine 
that ran it all, and see how the magic actually worked. I've been working in tech for more 
than 20 years, but I have no experience in the gaming industry, so my role here is to use 
what I've learned over the years to steer the work in a direction I believe in, while AI 
(Claude Opus 4.8) handles the bit-flipping.

This is an educational project; it has literally no goal other than learning and having 
fun while doing it. It will very likely never run any game other than 
*The Secret of Monkey Island* and *Monkey Island 2: LeChuck's Revenge*. I am 
immensely grateful to the people who have spent countless hours building ScummVM and
sharing their code and findings while doing so. This is not an attempt to undermine
their outstanding work in any way.

## Discover GrogVM

> **Status:** in active development. GrogVM already plays the opening of *The
> Secret of Monkey Island* — walking, verbs, inventory, dialogue, and cutscenes
> — and decodes every resource type for inspection. Audio and the rest of the
> game are still in progress; see the [documentation](/docs/) for the full
> picture.

- **[Library](/library/)** — install a game you own from a local folder, then
  play it or explore its resources. (Everything starts here — you pick a game
  first.)
- **[Documentation](/docs/)** — the reverse-engineering notes behind the engine:
  resource formats, opcodes, graphics, timing, and more.
