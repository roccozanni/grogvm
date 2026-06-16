---
name: walkthrough
description: Run the grogvm MI1 integration playthroughs (the from-boot walkthrough
  regression net) and produce per-beat checkpoint saves. Use to run the real-game
  playthrough tests (against an MI1 build discovered under games/), or dump checkpoint
  saves to eyeball/bisect a visual regression. Separate from the fast default `npm test`.
---

# walkthrough, real-game playthrough suite

These drive the REAL game files and saved games, so they are kept OUT of the
default `npm test` (which stays fast, synthetic, and data-free). Each suite
self-skips when its data is absent, so a fresh checkout and CI stay green.

## Commands
- `npm run test:integration`: run the playthroughs (own vitest config).
- `npm run test:integration:verbose`: same, surfacing the `ctx.annotate(...)`
  progress notes (insults/comebacks/wins) that the default reporter hides.
- `npm run test:integration:save`: sets `BEAT_SAVES=1` and dumps a checkpoint to
  `saves/beats/<order>-<slug>.websave.json` after every green beat. Import one in
  the browser's saves panel to eyeball rendering or bisect a visual regression.

## Game data
- The suite discovers an installed MI1 build under `games/` automatically — no
  folder name baked in, no env var. Drop a build (e.g. `games/MI1-EN-CD-DOS-VGA`)
  there and it's found.
- When several MI1 builds are present it pins to the Italiano variant (by
  `MONKEY.000` hash) for a reproducible seeded run, else takes the first sorted.
- No `games/` data ⇒ the suite self-skips. Never commit the copyrighted bytes.

## Notes
- The walkthrough is ONE VM from boot with a seeded RNG, so beat timing is
  position-deterministic: changing one beat's tick cost cascades downstream. After
  a change, re-run the whole suite, not just the touched beat.
- Numeric ids only: IT and EN share bytecode, so never assert a localized string.

The walkthrough facts (room/object/verb ids, mechanics) live in
`integration/mi1/game.ts`; see CLAUDE.md for the harness overview.
