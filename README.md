# GrogVM

A from-scratch TypeScript reimplementation of SCUMM v5 running natively
in the browser. Target: playable *The Secret of Monkey Island* (CD VGA)
and *Monkey Island 2: LeChuck's Revenge* (DOS).

Built as a side project for the fun of cracking SCUMM open and the
satisfaction of seeing real game data render on screen. Clarity is
prioritised over performance, and the player UI deliberately exposes
every decoder's intermediate state so the engine is also an inspection
tool.

## How this was built

GrogVM was written with AI: the code is largely the work of Anthropic's
Claude (Opus 4.8), driven through Claude Code. That's stated plainly
because it should be — but it is the opposite of a model one-shotting a
heap of code. Every binary format here was reverse-engineered against
real game bytes and cross-checked behaviour-first; every engine decision
was steered to the SCUMM-faithful answer — disassembled and verified
against the original, not guessed. The architecture is deliberate: a
portable engine core held at arm's length from both the browser and the
test harness, a clock and an RNG injected so the whole loop is
deterministic and Node-testable, decoders pinned by handcrafted byte
fixtures, and a single seeded VM driven through the game's own solution
as a regression net. The model did the typing; the craft is in the
steering, the verification, and the design.

## Status

In active development: *The Secret of Monkey Island* is playable from
the intro through the game's opening act, and every resource type
decodes and is live-inspectable. Audio and the rest of the walkthrough
are in progress. [PROGRESS.md](PROGRESS.md) is the live tracker — what's
in flight, what's done, and what's next.

## Running

Source: <https://github.com/roccozanni/grogvm>

```bash
git clone https://github.com/roccozanni/grogvm
cd grogvm
npm install
npm run dev
```

Then open <http://localhost:5173> in a Chromium-based browser (Chrome,
Edge, Arc). Brave users need `brave://flags/#file-system-access-api`
set to **Enabled** — the per-site Shields toggle does not cover this
API.

Install a game from the library screen by clicking **Install game…**
and selecting a directory that contains either `MONKEY.000` +
`MONKEY.001` (MI1) or `MONKEY2.000` + `MONKEY2.001` (MI2). You'll need
to grant read permission again on each session — this is a browser
security requirement, not something the app can persist.

## Tests

```bash
npm test           # watch mode
npm run test:run   # one-shot
npm run typecheck  # tsc --noEmit
npm run build      # full typecheck + production bundle
```

The engine layer is fully testable in Node (no DOM, no browser
globals); decoders are exercised against handcrafted byte fixtures,
with the renderer providing an in-memory implementation for assertion.

## Where to read more

- **[pages/docs/engine/architecture.md](pages/docs/engine/architecture.md)**
  — the architecture: layers, seams, and the guiding principles.
- **[`pages/docs/`](pages/docs/index.md)** — self-contained references
  for every binary format GrogVM has cracked open:
  [SMAP](pages/docs/scumm/smap.md) (room backgrounds),
  [COST](pages/docs/scumm/cost.md) (costumes),
  [ZPLANE](pages/docs/scumm/zplane.md) (occlusion masks),
  [CHAR](pages/docs/scumm/char.md) (bitmap fonts),
  [INDEX](pages/docs/scumm/index-file.md) (`.000` directory layout + LOFF),
  plus engine notes under [`engine/`](pages/docs/engine/session.md).
  Each documents the corrections GrogVM needed to make over the
  long-circulating reverse-engineering notes.

## License & legality

GrogVM is free software, licensed under the **GNU General Public
License, version 3 or later** (GPL-3.0-or-later) — see
[LICENSE](LICENSE). It comes with no warranty, to the extent permitted
by law.

Portions of the engine logic were derived from
[ScummVM](https://www.scummvm.org/) (GPLv3); GrogVM is correspondingly
released under GPL-3.0-or-later. The
[ScummVM source-exposure audit](pages/docs/scummvm-cpp-exposure-audit.md)
documents that provenance in full, in the interest of transparency.

This is a personal learning project with no intent to ship a competing
product. GrogVM bundles and distributes no LucasArts assets — you must
obtain MI1 / MI2 legally yourself.
