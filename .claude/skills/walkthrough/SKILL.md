---
name: walkthrough
description: Run the grogvm MI1 integration playthroughs (the from-boot walkthrough
  regression net) and produce per-beat checkpoint saves. Use to run the real-game
  playthrough tests against every installed variant (or one chosen via
  GROGVM_GAME_SELECTOR), or dump checkpoint saves to eyeball/bisect a visual
  regression. Separate from the fast default `npm test`.
---

# walkthrough, real-game playthrough suite

These drive the REAL game files and saved games, so they are kept OUT of the
default `npm test` (which stays fast, synthetic, and data-free). The suite
**requires** installed game data: with no matching build it FAILS (it does not
skip). That's fine — CI runs only `npm test` + `npm run build`, never this.

## Commands
- `npm run test:integration`: run the playthroughs against EVERY installed
  variant of every game (own vitest config). This is the pre-commit "does this
  engine change keep all builds working?" sweep.
- `npm run test:integration:verbose`: same, surfacing the `ctx.annotate(...)`
  progress notes (insults/comebacks/wins) the default reporter hides.
- `npm run test:integration:save`: sets `GROGVM_SAVE_BEATS=1` and dumps a
  checkpoint to `saves/beats/<game>-<variant>/<order>-<slug>.websave.json` after
  every green beat. Import one in the browser's saves panel to eyeball rendering
  or bisect a visual regression.

## Game data & build selection
- Builds are discovered under `games/` and classified by content hash (see
  `integration/catalog.ts`) — no folder name baked in. Drop a build (e.g.
  `games/MI1-EN-CD-DOS-VGA`) there and it's found.
- `GROGVM_GAME_SELECTOR` narrows which discovered builds run (a filter, not a
  path):
  - unset → every installed variant of every game (the default);
  - else a case-insensitive **prefix** match on `{hash, variant, gameId, dir}` —
    `GROGVM_GAME_SELECTOR=EN`, `=ital`, `=mi2`, `=4dfb`.
- Scope to one game with a path filter: `npm run test:integration -- integration/mi1`.
- Example (one game, one variant):
  `GROGVM_GAME_SELECTOR=EN npm run test:integration -- integration/mi1`.
- No build matches (typo, or no data installed) ⇒ the suite FAILS with a message
  listing what's installed. Never commit the copyrighted bytes.

## Notes
- The walkthrough is ONE VM from boot with a seeded RNG, so beat timing is
  position-deterministic: changing one beat's tick cost cascades downstream. After
  a change, re-run the whole suite, not just the touched beat.
- Numeric ids only: IT and EN share bytecode, so never assert a localized string.

The walkthrough facts (room/object/verb ids, mechanics) live in
`integration/mi1/game.ts`; see CLAUDE.md for the harness overview.
