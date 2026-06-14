---
title: SCUMM v5 Reference
description: How the original SCUMM v5 engine and its file formats work, reverse-engineered from real game data — resources and the VM, rooms and graphics, actors and text, and the rules of interaction, flow, and timing.
---

# SCUMM v5 Reference

How the original SCUMM v5 engine and its file formats work, reverse-engineered
from real game data — resources and the VM, rooms and graphics, actors and
text, and the rules of interaction, flow, and timing.

## Resources & the VM

- [Index File (`MONKEY.000`)](index-file.md)
- [Resource File (`MONKEY.001`)](resource-file.md)
- [Boot & System Variables](boot.md)
- [Opcode Dispatch & Bytecode Conventions](opcodes.md)
- [Per-Opcode Encoding Reference](opcode-reference.md)

## Rooms & graphics

- [Rooms (`ROOM`)](room.md)
- [Background Bitmaps (`SMAP`)](smap.md)
- [Z-Plane Masks (`ZP##`)](zplane.md)
- [Room Lighting](lighting.md)
- [Room Objects (`OBCD` + `OBIM`)](objects.md)
- [Walk Boxes (`BOXD` + `BOXM`)](walk-boxes.md)

## Actors, costumes & text

- [Costumes (`COST`)](cost.md)
- [Costume Animation](costume-anim.md)
- [Bitmap Fonts (`CHAR`)](char.md)

## Interaction, flow & timing

- [Input, Verbs & Sentences](input.md)
- [Cutscenes, Freezing & Override](cutscenes.md)
- [Screen Effects](screen-effect.md)
- [Timing — Jiffy vs. Frame](timing.md)
- [Sound (`SOUN`) & Sound-Gated Waits](sound.md)
