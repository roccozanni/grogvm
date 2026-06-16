---
title: Documentation
description: How GrogVM is built, plus the reverse-engineering notes behind it — the SCUMM v5 engine and its file formats (resources, opcodes, graphics, costumes, timing).
---

# Documentation

Three parts: notes on how GrogVM is built, the reverse-engineered SCUMM v5
reference it is built against, and the method the work is done by.

> **Status** — in active development. *The Secret of Monkey Island* plays
> from boot all the way to the end credits in the browser — all four parts —
> with verbs, inventory, dialogue, cutscenes, saves, digital sound effects and
> CD-audio music, and every resource in its files is browsable in the explorer.
> Still ahead: OPL2 synthesis for the few AdLib-only effects, Monkey Island 2,
> and visual polish.

## [Engine notes](engine/index.md)

How GrogVM itself is built — the as-built architecture and the runtime
subsystems that hang off it (the game loop, room transitions, camera,
pathfinding, costume loading, audio timing, game identity, and the test
harness).

## [SCUMM v5 reference](scumm/index.md)

How the original SCUMM v5 engine and its file formats work, reverse-engineered
from real game data — resources and the VM, rooms and graphics, actors and
text, and the rules of interaction, flow, and timing.

## [How the work gets done](agent/index.md)

GrogVM is built by a human and an AI agent in tight, reviewed loops; these
pages document that working method — and double as the agent's own briefing.
