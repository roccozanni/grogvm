---
title: Documentation
description: Reverse-engineering notes behind GrogVM — the SCUMM v5 engine and its file formats (resources, opcodes, graphics, costumes, timing), plus how GrogVM is built on top.
---

# Documentation

Two halves: a reverse-engineered reference for the SCUMM v5 engine and its file
formats, and notes on how GrogVM is built on top of it.

## Project status

GrogVM is in active development. Where it stands today:

- **Playable** — *The Secret of Monkey Island* runs from the intro through the
  game's opening: Mêlée Island lookout, the SCUMM Bar, the kitchen, and the
  Fettucini circus. Walking with box-graph pathfinding, the verb and inventory
  UI, one- and two-object commands ("Use X with Y", "Give X to Y"), dialogue
  trees, cutscenes, room lighting, and z-plane occlusion all work.
- **Decoded & inspectable** — every major resource type: rooms and backgrounds,
  costumes and animation, charset fonts, objects, walk boxes, and the bytecode
  itself, each viewable live in the explorer.
- **Persists** — full snapshot/restore of the live VM to a versioned save.
- **In progress** — audio is still silent (iMUSE/AdLib next); MI2 boots but has
  v5 edge cases to resolve; and the rest of the MI1 walkthrough plus a few
  rendering effects (palette cycling, screen-transition animation, smooth camera
  pan) are still being built.

Backed by a synthetic unit-test suite and a from-boot integration playthrough.

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

## Engine notes

How GrogVM itself is built on top of the reference above.

- [Engine Session — Game Loop & Runtime](engine/session.md)
- [Game Identity & Variant Detection](engine/game-identity.md)
- [Costume Loading & Decoding](engine/costumes.md)
- [Pathfinding (Box-Graph Routing)](engine/pathfinding.md)
- [Test Harness & Integration Playthroughs](engine/harness.md)
