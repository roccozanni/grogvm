---
title: GrogVM
description: A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one behind The Secret of Monkey Island and Monkey Island 2 — running in the browser, with no server and no emulator.
---

# GrogVM

A from-scratch TypeScript reimplementation of the SCUMM v5 engine — the one that
ran *The Secret of Monkey Island* and *Monkey Island 2: LeChuck's Revenge* —
running in the browser, with no server and no emulator.

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

Games are never bundled or distributed — you point GrogVM at your own copy on
disk, and it stays in your browser.

*Built with AI: largely implemented by Claude (Opus 4.8) under close human
steering — every binary format reverse-engineered against real game data, every
engine decision verified against the original's behaviour. Considered craft, not
a one-shot.*
