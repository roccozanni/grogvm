![A pixel-art mug of glowing green grog beside a terminal prompt reading GrogVM](src/site/grogvm.svg)

A from-scratch TypeScript reimplementation of the SCUMM v5 engine, currently
focused on the classic CD VGA version of *The Secret of Monkey Island*, running
natively in the browser. No bundled game data, no app backend: point GrogVM at
compatible files from your own lawful copy, and the game data stays on your
machine.

Clarity is prioritised over performance, and the player deliberately
exposes every decoder's intermediate state, so the engine doubles as an
inspection tool: every room, costume, script and sound in the game files
is browsable.

It's a love letter to *Monkey Island*, LucasArts and Ron Gilbert, written in
collaboration with AI coding agents while the human stays in the loop as
architect, tester, and taste filter. Every binary format is checked against real
game bytes, and every engine decision is disassembled and verified against the
original rather than guessed. The full story is in [pages/why.md](pages/why.md).

## Status

In active development. *The Secret of Monkey Island* classic CD VGA is playable
from boot to credits in a Chromium-based desktop browser, backed by a regression
walkthrough that covers the full game. Verbs, inventory, dialogue, cutscenes,
saves, and room rendering are in place. Visual polish and a few AdLib-only audio
effects are still in progress. *Monkey Island 2* is planned, but the current
build does not support it yet.
[PROGRESS.md](PROGRESS.md) is the live tracker — what's in flight,
what's done, and what's next.

## Running

```bash
git clone https://github.com/roccozanni/grogvm
cd grogvm
npm install
npm run dev
```

Open <http://localhost:5173> in a Chromium-based browser (Chrome, Edge,
Arc). Brave users need `brave://flags/#file-system-access-api` set to
**Enabled** — the per-site Shields toggle does not cover this API.

From the library screen, click **Install game…** and select a directory that
contains `MONKEY.000` + `MONKEY.001` from a compatible *The Secret of Monkey
Island* install. *Monkey Island 2* data is detected as a future target but is
intentionally not accepted yet. The browser asks you to re-grant read permission
each session — a security requirement of the File System Access API, not
something the app can persist.

## Tests

```bash
npm test           # watch mode
npm run test:run   # one-shot
npm run typecheck  # tsc --noEmit
npm run build      # full typecheck + production bundle
```

The engine core is fully testable in Node — no DOM, no browser globals.
Decoders are pinned by handcrafted byte fixtures, and a single seeded VM
is driven through MI1's own walkthrough from boot as a regression net
(`npm run test:integration`, needs the game files installed locally).

## Documentation

Everything deeper lives in [`pages/docs/`](pages/docs/index.md), in two
halves:

- **Engine notes** — how GrogVM itself is built, starting with the
  [architecture](pages/docs/engine/architecture.md): the layers, the
  seams, and the principles behind them.
- **SCUMM v5 reference** — self-contained write-ups of every binary
  format GrogVM has cracked open: rooms, backgrounds, costumes, fonts,
  occlusion masks, the index file, the full opcode set. Each documents
  the corrections GrogVM needed to make over the long-circulating
  reverse-engineering notes.

The same pages ship as the project site at <https://grogvm.dev>.

## License & legality

GrogVM is free software, licensed under the **GNU General Public
License, version 3 or later** — see [LICENSE](LICENSE). It comes with
no warranty, to the extent permitted by law.

GrogVM bundles and distributes no LucasArts assets — you are responsible for
using files from a lawful copy and complying with any terms that apply to that
copy. The project has a strict no-piracy policy ("abandonware" is not a legal
category). This is a personal learning project with no intent to ship a
competing product. Some *The Secret of Monkey Island: Special Edition* installs
include compatible classic VGA data files, but digital-storefront terms can
vary. Full details — where to get the game, the no-piracy policy, trademarks,
and a rights-holder contact — are on the [legal page](pages/legal.md) (live at
<https://grogvm.dev/legal/>).

*Monkey Island*, *SCUMM*, and *LucasArts* are trademarks of their
respective owners. GrogVM is an unofficial, non-commercial fan project
and is not affiliated with, endorsed by, or sponsored by Disney,
LucasArts, or any rights holder.
