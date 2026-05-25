# webscumm — Progress

Working tracker of what's done and what's next. The **active phase** is
broken into concrete tasks. **Future phases stay one-liners** until we
actually start them — speculative breakdowns rot.

When a phase is complete, summarize what was built under "Done" and
detail the next phase here.

---

## Status

**Phase 0 complete.** Ready to kick off Phase 1 (Resource catalog) when
you are.

---

## Next: Phase 1 — Resource catalog

*(Not detailed yet — will be broken into tasks when we start.)*

Sketch: parse `MONKEY.000`, walk the block tree, dump every block tag,
offset, and size to the console. Prove that the XOR decryption and
SCUMM v5 block format (4-byte BE size + 4-char tag + payload, recursive)
work end to end against a real MI1 file. No rendering, no VM — just
"we can read this file".

---

## Future phases

Kept intentionally undetailed. We'll break each into tasks when we start
it. Order and scope may shift as we learn the territory — see
ARCHITECTURE.md §9 for the original outline.

- **Phase 2 — First pixels.** Decode palette + room 1 background to Canvas2D.
- **Phase 3 — Costumes.** Decode and draw an actor frame, with Z-plane masking.
- **Phase 4 — Text.** Decode `CHAR` glyphs, render dialog.
- **Phase 5 — VM skeleton.** Script slots, variables, opcode dispatch, boot script.
- **Phase 6 — Enough opcodes to walk.** Reach the SCUMM Bar.
- **Phase 7 — Verb UI + input.** Click-to-walk, look-at, pick-up.
- **Phase 8 — Save states.**
- **Phase 9 — Audio.** iMUSE + AdLib first; MT-32 and CD redbook later.
- **Phase 10 — MI2 + polish.**

---

## Done

### Phase 0 — Scaffold *(2026-05-25)*

Runnable empty app: Vite + TypeScript + Vitest scaffold, library /
install / player-placeholder screens with a state-machine shell, game
detection, IndexedDB persistence of directory handles, browser-support
gating, 15 passing tests across 3 files. `npm run dev` serves the
library; `npm test` watches.

#### Original task checklist (all complete)

**Project setup**

- [x] `npm init`, add `.gitignore`
- [x] Install dev deps: `vite`, `typescript`, `vitest`, `@types/node`, `fake-indexeddb`, `@types/wicg-file-system-access`
- [x] `tsconfig.json` (strict, `noUncheckedIndexedAccess`, `moduleResolution: bundler`)
- [x] `vite.config.ts`
- [x] `vitest.config.ts` (`environment: 'node'`)
- [x] `index.html` + `src/main.ts`
- [x] npm scripts: `dev`, `build`, `preview`, `typecheck`, `test`, `test:run`
- [x] `npm run dev` boots and serves the library screen

**Test harness**

- [x] Trivial Vitest sanity test (`src/sanity.test.ts`)
- [x] `npm test` runs in watch mode, green

**Shell skeleton**

- [x] Screen state machine in `src/shell/app.ts` (`library` | `install` | `player`)
- [x] Directory structure per ARCHITECTURE.md §8

**Library screen — `src/shell/library/`**

- [x] Lists installed games from IndexedDB, with empty-state copy
- [x] "Install game…" button → install screen
- [x] Per-game row: name, gameId, Play button (navigates to player placeholder), Remove button
- [x] Remove deletes the IndexedDB record only — user's files are untouched

**Install flow — `src/shell/install/`**

- [x] Triggers `window.showDirectoryPicker({ mode: 'read' })` on button click
- [x] Game detection in `detect.ts` (pure, filename-based, case-insensitive)
- [x] On success: persist `{ id, displayName, gameId, directoryHandle, installedAt }` to IndexedDB, return to library
- [x] On unknown: error message with retry/cancel
- [x] User cancel (AbortError) is silent

**IndexedDB layer — `src/shell/storage/`**

- [x] `games` object store with CRUD wrappers (`listGames`, `addGame`, `removeGame`, `getGame`)
- [x] Each operation opens + closes its own DB connection (simple, no shared state)
- [x] *(Deferred to launch time)* Permission re-grant flow before passing the handle to the engine — left as a TODO comment for Phase 2 when there's actually something to launch

**Browser support**

- [x] `checkBrowserSupport()` detects missing `showDirectoryPicker` and `indexedDB`
- [x] Renders an "Unsupported browser" page instead of crashing

**Tests for Phase 0**

- [x] `detect.test.ts` — 8 tests: positive MI1, positive MI2, case-insensitive, missing file, empty, unrelated, extra files, MI1/MI2 disambiguation
- [x] `games.test.ts` — 6 tests: empty store, add+list, round-trip by id, remove, unknown id, multiple games independent. Uses `fake-indexeddb/auto`, resets the DB between tests.
- [x] `sanity.test.ts` — 1 test: arithmetic sanity check

#### Notable design choices made during implementation

- **Detection takes `string[]`, not a directory handle.** Pure function,
  trivially testable in Node. The directory-walking adapter lives in
  shell-only `install.ts`, which the test suite doesn't touch.
- **No shared DB connection.** Every storage call opens, transacts, and
  closes its own `IDBDatabase`. Simpler than connection pooling, fine for
  the access pattern (one user action at a time). Revisit if it ever
  matters.
- **Permission re-grant deferred.** Stored a TODO for when the player
  screen actually needs to open the files (Phase 2). Phase 0's player is
  a placeholder, so there's nothing to authorize yet.
- **`@types/wicg-file-system-access`** was needed — TypeScript's built-in
  `lib.dom.d.ts` covers `FileSystemDirectoryHandle` and `entries()`, but
  not `Window.showDirectoryPicker`.
