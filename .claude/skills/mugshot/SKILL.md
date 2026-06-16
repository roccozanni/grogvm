---
name: mugshot
description: Render a frame of the running grogvm game to a PNG. Use to eyeball
  rendering, capture a visual state (the title, or a save advanced by N ticks), or
  produce a screenshot to compare a visual change. Boots, optionally restores a
  save, drives N ticks, then writes the PNG.
---

# mugshot, frame-to-PNG screenshotter

`npm run mugshot -- --game=<dir> <save> [ticks] [options]`

- `--game=<dir>` (REQUIRED, no default): the v5 game-data dir, e.g. `games/<mi1-build>`.
- `<save>`: a save slot name (resolves to `saves/<name>.websave.json`) or a path.
  Pass `fresh` to boot without restoring (e.g. the title screen).
- `[ticks]`: game ticks to advance before capturing (default 0).
- options:
  - `--out=<path>`: output PNG (default `scratch/mugshot.png`, gitignored).
  - `--scale=<n>`: nearest-neighbour upscale (default 3).
  - `--seed=<n>`: RNG seed for a deterministic boot (default 1).

Examples:
- `npm run mugshot -- --game=games/<mi1-build> fresh 200 --out=scratch/title.png`
- `npm run mugshot -- --game=games/<mi1-build> MI1-Italiano-quicksave 60`

It renders the full screen through the real compose pipeline. For the wider
"render a VM to PNG" surface (`writeScreenshot` / `screenshot`), see CLAUDE.md.
