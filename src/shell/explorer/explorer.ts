/**
 * The resource Explorer screen — a session-free browser of a game's rooms,
 * costumes, charsets, and raw block tree (ARCHITECTURE.md §7, Q8). It creates
 * no `EngineSession` and no VM; it only parses the opened files.
 *
 * TEMPORARY (Phase 10): the implementation still lives in the legacy
 * `shell/player/player.ts` (`renderExplorer` = the resource browser with the
 * VM inspector gated off). This module re-exports it so the `/explore` page
 * has a stable import path. When the legacy player is dismantled in task 7,
 * the browser code relocates here and this stops being a re-export.
 */
export { renderExplorer } from '../player/player';
