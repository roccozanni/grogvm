---
title: Engine Notes
description: How GrogVM itself is built — the as-built architecture and the runtime subsystems that hang off it (the game loop, room transitions, camera, pathfinding, costume loading, audio timing, game identity, and the test harness).
---

# Engine Notes

How GrogVM itself is built — the as-built architecture and the runtime
subsystems that hang off it (the game loop, room transitions, camera,
pathfinding, costume loading, audio timing, game identity, and the test
harness). Start with Architecture, the map of the whole project; each of the
others goes deep on a single subsystem and links into the [SCUMM v5
reference](../scumm/index.md) where it leans on the file formats.

- [Architecture — Layers & Seams](architecture.md)
- [Engine Session — Game Loop & Runtime](session.md)
- [Room Transitions — Entering & Leaving](room-transitions.md)
- [Camera — Follow, Pan & the Viewport](camera.md)
- [Pathfinding — Box-Graph Routing](pathfinding.md)
- [Costume Loading & Decoding](costumes.md)
- [Audio Timing — the `AudioBackend` Seam](audio.md)
- [Game Identity & Variant Detection](game-identity.md)
- [Test Harness & Integration Playthroughs](harness.md)
