/**
 * Lightmode bit-flags packed into `VAR_CURRENT_LIGHTS` (g9); the engine
 * seeds a lit default at reset and the `lights` opcode overwrites it
 * per-room. See pages/docs/scumm/lighting.md.
 */

export const LIGHTMODE_ACTOR_USE_BASE_PALETTE = 1;
export const LIGHTMODE_ACTOR_USE_COLORS = 2;
export const LIGHTMODE_ROOM_LIGHTS_ON = 4;

/** Engine reset default for `VAR_CURRENT_LIGHTS` — room lit, actors palette-lit (= 7). */
export const LIGHTMODE_DEFAULT =
  LIGHTMODE_ACTOR_USE_BASE_PALETTE |
  LIGHTMODE_ACTOR_USE_COLORS |
  LIGHTMODE_ROOM_LIGHTS_ON;
