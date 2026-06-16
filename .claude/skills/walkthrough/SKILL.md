---
name: walkthrough
description: Run the grogvm MI1 integration playthroughs (the from-boot walkthrough
  regression net) and produce per-beat checkpoint saves. Use to run the real-game
  playthrough tests, point the suite at custom game data, or dump checkpoint saves
  to eyeball/bisect a visual regression. Separate from the fast default `npm test`.
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
- Defaults to `games/MI1-IT-CD-DOS-VGA` (the IT build, which also carries the saves).
- Override with the `GROG_GAME_DIR` env var to point at your own copy, e.g.
  `GROG_GAME_DIR=/path/to/data npm run test:integration`.
- Never commit the copyrighted bytes.

## Notes
- The walkthrough is ONE VM from boot with a seeded RNG, so beat timing is
  position-deterministic: changing one beat's tick cost cascades downstream. After
  a change, re-run the whole suite, not just the touched beat.
- Numeric ids only: IT and EN share bytecode, so never assert a localized string.

The walkthrough facts (room/object/verb ids, mechanics) live in
`integration/mi1/game.ts`; see CLAUDE.md for the harness overview.
