---
title: Documentation
---

# Documentation

Reverse-engineering notes behind the engine — the file formats, bytecode, and
behavior GrogVM reimplements.

## SCUMM v5 reference

Reverse-engineered notes on the SCUMM v5 engine and its file formats.

- [Index File (`MONKEY.000`) and LOFF](scumm/index-file.md)
- [Boot and System Variables](scumm/boot.md)
- [Opcode Dispatch + Bytecode Conventions](scumm/opcodes.md)
- [Per-Opcode Encoding Reference](scumm/opcode-reference.md)
- [`ROOM` Block](scumm/room.md)
- [SMAP — Background Bitmap Format](scumm/smap.md)
- [ZP## — Z-Plane Masks](scumm/zplane.md)
- [Room Objects (`OBCD` + `OBIM`)](scumm/objects.md)
- [Room Lighting](scumm/lighting.md)
- [COST — Costume Format](scumm/cost.md)
- [Costume animation records](scumm/costume-anim.md)
- [CHAR — Character Set (Bitmap Font) Format](scumm/char.md)
- [Walk Boxes (`BOXD` + `BOXM`)](scumm/walk-boxes.md)
- [Input, Verbs, and Sentences](scumm/input.md)
- [Cutscenes, Freezing, and Override](scumm/cutscenes.md)
- [Screen effects (`roomOps screenEffect`)](scumm/screen-effect.md)
- [Timing — the jiffy / frame split](scumm/timing.md)

## Engine notes

How GrogVM itself is built.

- [Pathfinding — SCUMM Box-Graph Routing (BOXM)](pathfinding.md)
- [EngineSession — the app ↔ engine seam](engine-session.md)
- [ScummVM C++ Source — Direct Exposure Audit](scummvm-cpp-exposure-audit.md)
