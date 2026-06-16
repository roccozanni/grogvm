---
name: disgrogate
description: Statically disassemble a SCUMM v5 script from the grogvm game data
  into decoded opcodes. Use to decode bytecode for a global, room-local, ENCD, or
  EXCD script, or to SCAN every script for an opcode/term. The static counterpart
  to spyglass (which traces what actually executed).
---

# disgrogate, static script disassembler

`npm run disgrogate -- --game=<dir> <arg> [room] [grep=<term>]`

- `--game=<dir>` (REQUIRED, no default): the v5 game-data dir, e.g. `games/MI1-IT-CD-DOS-VGA`.
- forms for `<arg>`:
  - `<globalId>`: a global script (e.g. `1`).
  - `L<id> <room>`: a room-local script (ids >= 200 are room-local, not global).
  - `ENCD <room>` / `EXCD <room>`: a room's entry / exit script.
  - `SCAN grep=<term>`: sweep every script, printing only lines containing the term.
- `grep=<term>` (optional): filter printed lines to those containing the term.

Examples:
- `npm run disgrogate -- --game=games/MI1-IT-CD-DOS-VGA 1`
- `npm run disgrogate -- --game=games/MI1-IT-CD-DOS-VGA ENCD 33`
- `npm run disgrogate -- --game=games/MI1-IT-CD-DOS-VGA SCAN grep=lights`

## Reading the output (caveats)
- `SCAN` sweeps GLOBAL scripts only; query room-local ids as `L<id> <room>`.
- A run ending `(misaligned)` hit a byte it could not decode and stopped: treat
  everything after as a lead, not proof.
- `override BEGIN (then jump N)` prints the RAW jump delta (engine lands at `pc + N`);
  do not resolve N against the script start.

Deeper opcode semantics live in CLAUDE.md, "Disassembler & opcodes".
