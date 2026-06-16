---
name: spyglass
description: Trace which SCUMM scripts/opcodes actually execute as a grogvm save
  plays forward. Use to see what *ran* (a dynamic execution trace over N jiffies,
  from a save or a fresh boot), the runtime counterpart to disgrogate's static
  disassembly. Answers "what executed", not "what could run".
---

# spyglass, runtime execution tracer

`npm run spyglass -- --game=<dir> <save> [ticks] [flags]`

- `--game=<dir>` (REQUIRED, no default): the v5 game-data dir, e.g. `games/MI1-IT-CD-DOS-VGA`.
- `<save>`: a save slot name (resolves to `saves/<name>.websave.json`) or a path.
  Pass `fresh` to trace from a bare boot (e.g. the title sequence).
- `[ticks]`: jiffies to drive before stopping (default 200; stops early on halt).
- flags:
  - `--script=<id,id,...>`: keep only runs of these script ids.
  - `--compact`: list scripts + opcode counts, not full opcode detail.
  - `--idle`: keep idle frames (default drops frames that ran nothing).
  - `--seed=<n>`: RNG seed for a deterministic boot (default 1).

Example: `npm run spyglass -- --game=games/MI1-IT-CD-DOS-VGA MI1-Italiano-quicksave 60`

## Reading the output
A killed script's terminating `stopObjectCode` surfaces under a trailing `#0` run.
For the full read of the trace and how it pairs with disgrogate, see CLAUDE.md,
"Trace what actually runs".
