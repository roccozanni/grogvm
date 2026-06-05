---
title: Documentation
---

# Documentation

Two halves: a reverse-engineered reference for the SCUMM v5 engine and its file
formats, and notes on how GrogVM is built on top of it.

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
- [Costume Loading & Decoding](engine/costumes.md)
- [Pathfinding (Box-Graph Routing)](engine/pathfinding.md)
- [ScummVM C++ Source — Exposure Audit](scummvm-cpp-exposure-audit.md)
