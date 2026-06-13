---
title: Documentation
description: How GrogVM is built, plus the reverse-engineering notes behind it — the SCUMM v5 engine and its file formats (resources, opcodes, graphics, costumes, timing).
---

# Documentation

Three parts: notes on how GrogVM is built, the reverse-engineered SCUMM v5
reference it is built against, and the method the work is done by.

> **Status** — in active development. *The Secret of Monkey Island* plays
> from boot through the end of Part II — verbs, inventory, dialogue,
> cutscenes, saves, digital sound effects and CD-audio music — and every
> resource in its files is browsable in the explorer. Still ahead: Part III
> onward, OPL2 synthesis for the few AdLib-only effects, Monkey Island 2,
> and a few visual effects.

## Engine notes

How GrogVM itself is built. Start with Architecture — the map of the
whole project; each doc links into the format reference below where it
leans on it.

- [Architecture — Layers & Seams](engine/architecture.md)
- [Engine Session — Game Loop & Runtime](engine/session.md)
- [Room Transitions — Entering & Leaving](engine/room-transitions.md)
- [Camera — Follow, Pan & the Viewport](engine/camera.md)
- [Pathfinding — Box-Graph Routing](engine/pathfinding.md)
- [Costume Loading & Decoding](engine/costumes.md)
- [Audio Timing — the `AudioBackend` Seam](engine/audio.md)
- [Game Identity & Variant Detection](engine/game-identity.md)
- [Test Harness & Integration Playthroughs](engine/harness.md)

## SCUMM v5 reference

How the original SCUMM v5 engine and its file formats work, reverse-engineered
from real game data.

**Resources & the VM**

- [Index File (`MONKEY.000`)](scumm/index-file.md)
- [Boot & System Variables](scumm/boot.md)
- [Opcode Dispatch & Bytecode Conventions](scumm/opcodes.md)
- [Per-Opcode Encoding Reference](scumm/opcode-reference.md)

**Rooms & graphics**

- [Rooms (`ROOM`)](scumm/room.md)
- [Background Bitmaps (`SMAP`)](scumm/smap.md)
- [Z-Plane Masks (`ZP##`)](scumm/zplane.md)
- [Room Lighting](scumm/lighting.md)
- [Room Objects (`OBCD` + `OBIM`)](scumm/objects.md)
- [Walk Boxes (`BOXD` + `BOXM`)](scumm/walk-boxes.md)

**Actors, costumes & text**

- [Costumes (`COST`)](scumm/cost.md)
- [Costume Animation](scumm/costume-anim.md)
- [Bitmap Fonts (`CHAR`)](scumm/char.md)

**Interaction, flow & timing**

- [Input, Verbs & Sentences](scumm/input.md)
- [Cutscenes, Freezing & Override](scumm/cutscenes.md)
- [Screen Effects](scumm/screen-effect.md)
- [Timing — Jiffy vs. Frame](scumm/timing.md)
- [Sound (`SOUN`) & Sound-Gated Waits](scumm/sound.md)

## How the work gets done

GrogVM is built in collaboration with an AI agent. These pages document the
method — and double as the agent's own briefing.

- [How We Collaborate — The Working Contract](agent/collaboration.md)
- [Where Knowledge Lives — Lab Notebook → Docs](agent/knowledge.md)
- [Verification — Behaviour, Not Bookkeeping](agent/verification.md)
