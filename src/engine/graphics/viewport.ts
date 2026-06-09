/**
 * Camera viewport — the single source of truth for "which room slice is on
 * screen", shared by the frame compositor, overlay renderer, and input
 * mapping so pixels, cursor, and clicks all agree.
 */

/** The on-screen viewport width in native pixels (the SCUMM screen is 320 wide). */
export const VIEWPORT_W = 320;

/**
 * Left edge of the camera viewport, in room pixels, given the camera centre
 * `cameraX` and the room width. Clamped so the viewport never runs past either
 * room edge; collapses to 0 for rooms no wider than the viewport.
 */
export function viewportLeft(cameraX: number, roomWidth: number, viewportW: number = VIEWPORT_W): number {
  const maxLeft = Math.max(0, roomWidth - viewportW);
  const left = Math.round(cameraX) - Math.floor(viewportW / 2);
  return Math.max(0, Math.min(left, maxLeft));
}
