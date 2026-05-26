# webscumm

A from-scratch TypeScript reimplementation of SCUMM v5 running natively
in the browser. Target: playable *The Secret of Monkey Island* (CD VGA)
and *Monkey Island 2: LeChuck's Revenge* (DOS).

Built as a side project for the fun of cracking SCUMM open and the
satisfaction of seeing real game data render on screen. Clarity is
prioritised over performance, and the player UI deliberately exposes
every decoder's intermediate state so the engine is also an inspection
tool.

## Status

**Phase 2 complete** — room backgrounds decode and render end-to-end
for both target games. No actors, no scripting, no audio yet. See
[PROGRESS.md](PROGRESS.md) for the full phased roadmap.

What works right now:

- "Installing" an MI1 or MI2 directory via the File System Access API
  (the directory handle is persisted in IndexedDB; the game files
  themselves are never copied).
- A complete tag-by-tag block-tree dump of `MONKEY.000` (index) and
  `MONKEY.001` (resources), with a one-line description of every block
  type that webscumm understands.
- A room viewer that cycles through every room in the resource file
  and decodes its 320×N background to Canvas2D at native resolution.
  Includes a per-strip compression-method diagnostic bar — invaluable
  for debugging, and now a permanent learning aid.

## Running

```bash
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

116 tests across 14 files at last count. The engine layer is fully
testable in Node (no DOM, no browser globals); decoders are exercised
against handcrafted byte fixtures, with the renderer providing an
in-memory implementation for assertion.

## Where to read more

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the overall design,
  layering, and the guiding principles the codebase tries to follow.
- **[PROGRESS.md](PROGRESS.md)** — what's done, what's planned for the
  active phase, and the one-line summary of every future phase.
- **[docs/SCUMM-V5-SMAP.md](docs/SCUMM-V5-SMAP.md)** — self-contained
  reference for the SMAP background-bitmap format, including the two
  specific corrections this project needed to make over the
  long-circulating reverse-engineering notes.

## License & legality

Personal learning project. No license, no warranty, no intent to ship
a competing product. You will need to obtain MI1 / MI2 legally
yourself; no LucasArts assets are bundled or distributed.
