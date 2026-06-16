# NOTICE

GrogVM is an independent, browser-based implementation of the SCUMM engine,
written from scratch to play classic LucasArts graphic adventure data on the
web.

## Game assets

GrogVM ships **no game data**. The engine plays games from data files you supply
yourself from a lawful copy. Users are responsible for complying with the terms
that apply to their copy. None of the original artwork, music, dialogue,
scripts, or other game content is included in this repository or distributed
with it.

The classic VGA CD version GrogVM currently targets is included inside some
installs of *The Secret of Monkey Island: Special Edition*, still sold on
[GOG](https://www.gog.com/en/game/the_secret_of_monkey_island_special_edition) and
[Steam](https://store.steampowered.com/app/32360/The_Secret_of_Monkey_Island_Special_Edition/)
(switch to classic mode with F10). Digital-storefront terms can vary; GrogVM
does not bypass DRM or provide game assets. See [`pages/legal.md`](pages/legal.md)
for the full details.

## No piracy

GrogVM has a strict no-piracy policy and exists for games you are allowed to use.
Nothing here is intended to help anyone obtain a game illegally, and
"abandonware" is not a legal category — a game being out of print does not make
copying it lawful. There is no support for, or endorsement of, pirated or
otherwise unauthorised copies.

## How the format was reconstructed

The SCUMM file formats and bytecode are not officially documented. GrogVM's
understanding of them was rebuilt from publicly available reverse-engineering
resources, and every format claim was verified against real game data from
*The Secret of Monkey Island*. The engine is an independent implementation of
that format — not a port of any existing codebase.

The project ships its own extensive documentation of the format under
[`pages/docs/scumm/`](pages/docs/scumm/), written as part of this reconstruction.
Where that documentation draws on external sources, it credits them inline. Any
page that adapts external text, tables, or diagrams should carry source and
license notes directly on the page.

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

GrogVM is licensed under the **GNU General Public License v3.0 or later** (see
[`LICENSE`](LICENSE)). This keeps the project copyleft — free to use, study,
modify, and share, with the same freedoms preserved for everyone downstream.

## Trademarks

*Monkey Island*, *The Secret of Monkey Island*, *SCUMM*, and *LucasArts* are
trademarks of their respective owners. GrogVM is an unofficial, non-commercial
fan project and is not affiliated with, endorsed by, or sponsored by Disney,
LucasArts, or any rights holder. References to these names describe what the
software is compatible with.

## Rights holders

GrogVM hosts and distributes no game assets. If you represent a rights holder and
have a concern, please get in touch at **rocco.zanni@gmail.com** — messages are
read and answered promptly.
