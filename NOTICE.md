# NOTICE

GrogVM is an independent, browser-based implementation of the SCUMM engine,
written from scratch to play the classic LucasArts graphic adventures on the web.

## Game assets

GrogVM ships **no game data**. The engine plays games from data files you supply
yourself, from a copy you legally own. None of the original artwork, music,
dialogue, scripts, or other game content is included in this repository or
distributed with it.

## How the format was reconstructed

The SCUMM file formats and bytecode are not officially documented. GrogVM's
understanding of them was rebuilt from publicly available reverse-engineering
resources, and every format claim was verified against real game data from
*The Secret of Monkey Island*. The engine is an independent implementation of
that format — not a port of any existing codebase.

The project ships its own extensive documentation of the format under
[`pages/docs/scumm/`](pages/docs/scumm/), written as part of this reconstruction.
Where that documentation draws on external sources, it credits them inline.

## Credits and gratitude

GrogVM stands on decades of work by others:

- **LucasArts** and **Ron Gilbert**, for *The Secret of Monkey Island* and the
  SCUMM system it runs on — the reason this project exists.
- **The ScummVM project** and its volunteers, whose two-plus decades of
  preservation work made these games legible to everyone who came after,
  this project included. GrogVM is a separate engine built alongside ScummVM,
  not derived from it; it is released under a compatible copyleft license in
  the same spirit.
- The authors of the public SCUMM format write-ups and wiki documentation that
  this reconstruction learned from, credited in the format docs.

## License

GrogVM is licensed under the **GNU General Public License v3.0** (see
[`LICENSE`](LICENSE)). This keeps the project copyleft — free to use, study,
modify, and share, with the same freedoms preserved for everyone downstream.

## Trademarks

*Monkey Island*, *The Secret of Monkey Island*, *SCUMM*, and *LucasArts* are
trademarks of their respective owners. GrogVM is an unofficial, non-commercial
fan project and is not affiliated with, endorsed by, or sponsored by Disney,
LucasArts, or any rights holder. References to these names describe what the
software is compatible with.
