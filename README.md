# GrogVM

A from-scratch TypeScript reimplementation of SCUMM v5 running natively
in the browser. Target: playable *The Secret of Monkey Island* (CD VGA)
and *Monkey Island 2: LeChuck's Revenge* (DOS).

Built as a side project for the fun of cracking SCUMM open and the
satisfaction of seeing real game data render on screen. Clarity is
prioritised over performance, and the player UI deliberately exposes
every decoder's intermediate state so the engine is also an inspection
tool.

## Status

**Phase 5 complete** — the VM skeleton runs SCUMM v5 bytecode at the
structural level. Phase 6 (enough opcodes to walk) is next. No
real-time clock, no actors moving, no audio yet. See
[PROGRESS.md](PROGRESS.md) for the full phased roadmap.

What works right now:

- "Installing" an MI1 or MI2 directory via the File System Access API
  (the directory handle is persisted in IndexedDB; the game files
  themselves are never copied).
- A complete tag-by-tag block-tree dump of `MONKEY.000` (index) and
  `MONKEY.001` (resources), with a one-line description of every block
  type that GrogVM understands.
- A room viewer that cycles through every room and decodes its 320×N
  background to Canvas2D at native resolution, with a per-strip SMAP
  compression-method diagnostic bar.
- A costume inspector with header diagnostics, palette swatches,
  per-frame preview through the room's CLUT, z-plane overlay toggles,
  and a live actor compositor you can drag onto the room.
- A charset inspector with the same LFLF-scoped navigation: header,
  CLUT-tinted color-map view, clickable glyph grid, and a live
  text-rendering field that uses the current room's CLUT.
- A VM inspector that loads global script #1 (boot), dispatches
  opcodes one at a time or one tick at a time, and surfaces a halt
  panel with bytecode-context hex highlighting the moment it hits an
  opcode GrogVM hasn't implemented. Slots table, hex-addressed
  globals grid, packed bit-vars grid, and a self-describing trace
  ring round out the diagnostic surface.

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

272 tests across 28 files at last count. The engine layer is fully
testable in Node (no DOM, no browser globals); decoders are exercised
against handcrafted byte fixtures, with the renderer providing an
in-memory implementation for assertion.

## Where to read more

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the overall design,
  layering, and the guiding principles the codebase tries to follow.
- **[PROGRESS.md](PROGRESS.md)** — what's done, what's planned for the
  active phase, and the one-line summary of every future phase.
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

Personal learning project. No license, no warranty, no intent to ship
a competing product. You will need to obtain MI1 / MI2 legally
yourself; no LucasArts assets are bundled or distributed.
