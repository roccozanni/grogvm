/**
 * The camera viewport: SCUMM displays a fixed-width window into a room that
 * may be wider, scrolled horizontally by the camera. This is the single
 * source of truth for "which slice is on screen", shared by the frame
 * compositor (session), the overlay renderer (play-area), and input mapping —
 * so the pixels, the cursor, and the clicks all agree.
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
