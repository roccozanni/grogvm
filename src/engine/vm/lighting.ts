/**
 * Room lighting — the bit-flags packed into `VAR_CURRENT_LIGHTS` (g9).
 *
 * `vars.ts` maps names to variable *indices*; this file holds the
 * *values* that go into one of them. The engine seeds g9 to a lit
 * default at reset (every v4–v5 game) and the `lights` opcode (0x70)
 * overwrites it per-room.
 *
 * Flag values are the documented SCUMM lightmode bits (derived, not
 * transcribed from engine source):
 *
 *   - `room_lights_on` (bit 2, value 4) — the room is lit. When clear,
 *     scripts treat the room as dark. MI1's sentence script #2 gates
 *     "Look at" on this: with g9 == 0 it answers "Non si riesce, troppo
 *     buio" instead of the real object description.
 *   - `actor_use_base_palette` (bit 0) / `actor_use_colors` (bit 1) —
 *     how actors pick up the room palette.
 *
 * Without the reset seed g9 stays 0 and *every* room reads as dark —
 * the `lights` opcode is never dispatched on MI1's credits→room-33
 * intro path, so the lit state can only come from this default.
 */

export const LIGHTMODE_ACTOR_USE_BASE_PALETTE = 1;
export const LIGHTMODE_ACTOR_USE_COLORS = 2;
export const LIGHTMODE_ROOM_LIGHTS_ON = 4;

/** Engine reset default for `VAR_CURRENT_LIGHTS` — room lit, actors palette-lit (= 7). */
export const LIGHTMODE_DEFAULT =
  LIGHTMODE_ACTOR_USE_BASE_PALETTE |
  LIGHTMODE_ACTOR_USE_COLORS |
  LIGHTMODE_ROOM_LIGHTS_ON;
