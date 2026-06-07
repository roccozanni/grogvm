/**
 * Routing for the multi-page static build (ARCHITECTURE.md §7, §11 Q11).
 *
 * Page identity is the PATH — `/library/`, `/explore/`, `/play/` are real
 * built HTML entries (see vite.config.ts), so refresh + deep-link work with
 * no server. The only per-client parameter, the install id, rides in the QUERY
 * STRING (`?game=<install-uuid>`): the static host ignores it, the page reads
 * it here. It's the per-install UUID, not the engine gameId, because two
 * language variants share a gameId (`MI1`) but are distinct installs. Game
 * deep-links resolve only on the browser profile that installed that game — an
 * accepted property of a local-files app.
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

/** Read the `?room=` parameter (a room id) from a query string. Null when absent/non-numeric. */
export function roomParam(search: string): number | null {
  const value = new URLSearchParams(search).get('room');
  if (!value) return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

/** The current page's `?room=` (reads `location.search`). */
export function currentRoomParam(): number | null {
  return roomParam(typeof location === 'undefined' ? '' : location.search);
}

/** A query string with `room` set, preserving the other params (e.g. `game`). */
export function searchWithRoom(search: string, roomId: number): string {
  const params = new URLSearchParams(search);
  params.set('room', String(roomId));
  return `?${params.toString()}`;
}

/** The library screen — where Explore/Play return to (you install/select there first). */
export const libraryHref = '/library/';

export function playHref(installId: string): string {
  return `/play/?game=${encodeURIComponent(installId)}`;
}

export function exploreHref(installId: string): string {
  return `/explore/?game=${encodeURIComponent(installId)}`;
}
