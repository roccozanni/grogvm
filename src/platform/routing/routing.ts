/**
 * Routing for the multi-page static build (ARCHITECTURE.md §7, §11 Q11).
 *
 * Page identity is the PATH — `/` (library), `/explore/`, `/play/` are real
 * built HTML entries (see vite.config.ts), so refresh + deep-link work with
 * no server. The only per-client parameter, the installed-game id, rides in
 * the QUERY STRING (`?game=MI1`): the static host ignores it, the page reads
 * it here. Game deep-links resolve only on the browser profile that installed
 * that game — an accepted property of a local-files app.
 *
 * Pure helpers (no DOM) so they're unit-testable in Node; `currentGameParam`
 * is the only one that touches `location`.
 */

/** Read the `?game=` parameter from a query string. Returns null when absent/empty. */
export function gameParam(search: string): string | null {
  const value = new URLSearchParams(search).get('game');
  return value && value.length > 0 ? value : null;
}

/** The current page's `?game=` (reads `location.search`). */
export function currentGameParam(): string | null {
  return gameParam(typeof location === 'undefined' ? '' : location.search);
}

export const homeHref = '/';

export function playHref(game: string): string {
  return `/play/?game=${encodeURIComponent(game)}`;
}

export function exploreHref(game: string): string {
  return `/explore/?game=${encodeURIComponent(game)}`;
}
