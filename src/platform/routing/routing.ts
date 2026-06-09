/**
 * Routing for the multi-page static build (pages/docs/engine/architecture.md
 * §3). `?game=` carries the per-install UUID, not the engine gameId — two
 * language variants share a gameId but are distinct installs.
 */

export function gameParam(search: string): string | null {
  const value = new URLSearchParams(search).get('game');
  return value && value.length > 0 ? value : null;
}

export function currentGameParam(): string | null {
  return gameParam(typeof location === 'undefined' ? '' : location.search);
}

export function roomParam(search: string): number | null {
  const value = new URLSearchParams(search).get('room');
  if (!value) return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

export function currentRoomParam(): number | null {
  return roomParam(typeof location === 'undefined' ? '' : location.search);
}

export function searchWithRoom(search: string, roomId: number): string {
  const params = new URLSearchParams(search);
  params.set('room', String(roomId));
  return `?${params.toString()}`;
}

export const libraryHref = '/library/';

export function playHref(installId: string): string {
  return `/play/?game=${encodeURIComponent(installId)}`;
}

export function exploreHref(installId: string): string {
  return `/explore/?game=${encodeURIComponent(installId)}`;
}
