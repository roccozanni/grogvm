# SCUMM v5 — Room Lighting

SCUMM v5 has a simple room-lighting model built around a single
variable, **`VAR_CURRENT_LIGHTS`** (g9). It is both a rendering hint
(how actors pick up the room palette, whether the room is drawn lit) and
a piece of game state scripts branch on (a dark room answers "Look at"
with "it's too dark to see").

---

## 1. The light-mode flags

`VAR_CURRENT_LIGHTS` is a bit field:

| Bit | Value | Name | Meaning |
|-----|-------|------|---------|
| 0 | 1 | `LIGHTMODE_ACTOR_USE_BASE_PALETTE` | actors use the room base palette |
| 1 | 2 | `LIGHTMODE_ACTOR_USE_COLORS` | actors pick up the room colours |
| 2 | 4 | `LIGHTMODE_ROOM_LIGHTS_ON` | the room is lit |

The bit that matters most for game logic is **`room_lights_on` (4)**.
When it is clear the room is "dark", and scripts treat it accordingly.
A fully-lit room is `base_palette | colors | room_lights_on` = **7**.

## 2. The reset default

The engine seeds `VAR_CURRENT_LIGHTS` to the lit value **at reset**, for
every v4–v5 game — not per room. This is the single most important fact
about the system and an easy one to miss: **rooms do not turn their own
lights on.** They are lit by default, and only the few genuinely dark
rooms turn the lights *off*.

If an engine forgets this seed, `VAR_CURRENT_LIGHTS` sits at 0 and
*every* room reads as dark. In MI1 the symptom is that examining any
object answers with the too-dark line ("Non si riesce, troppo buio")
instead of the real description, because the sentence script gates the
Look-at on `VAR_CURRENT_LIGHTS != 0`.

## 3. The `lights` opcode

**`lights` (`0x70`)** sets the lighting mode. Its operands are
`arg1[p8] arg2[8] arg3[8]`:

- When **`arg3 == 0`**, it assigns `VAR_CURRENT_LIGHTS = arg1` — this is
  how a dark room sets or clears its lit bits.
- When `arg3 != 0`, it is the **flashlight** variant: `arg2` is the
  flashlight's extent (a lit window that follows the cursor/actor through
  an otherwise dark room). `arg1`/`arg3` parameterise it.

A normally-lit room never calls `lights` at all — it relies entirely on
the reset default. So an engine that has implemented the reset seed can
treat the whole opcode as optional for most of the game; it only matters
once the player reaches a dark location.

## 4. Honouring the lights when rendering

The variable feeds two consumers:

- **Game logic** (the dark-room gate above) — driven entirely by the
  bit value; needs nothing from the renderer.
- **The compositor** — `room_lights_on` should darken the room when
  clear, and the actor-palette bits affect how sprites are tinted.

These are independent: a room can carry the correct dark `VAR_CURRENT_
LIGHTS` (so the logic is right) while the compositor still draws it at
full brightness (a purely visual gap). Night scenes that simply ship a
dark *palette* (mostly-black background, dark-blue sky) look correct
without the compositor honouring the variable at all — the darkness is
baked into the room's CLUT, not applied by the lighting code.

## 5. `roomIntensity` and the load-time base palette

Scripted palette darkening goes through the **`roomIntensity`** room-op
(`roomOps $33` sub-op `$08`, operands `scale start end`): it scales
palette entries `start..end` by `scale/255` (values above 255
brighten). The scale is always computed from the room's **load-time
base palette**, never from the current live values — so stepped fades
don't compound, and fading back to 255 restores exactly the colours the
room loaded with.

That base must be captured *after* any boot-time UI palette overrides
(`setPalColor`) have been applied. MI1's treasure-map close-up (room
63) is the proof: it blacks the screen out via `setPalColor(0,0,0)`,
then fades back in by stepping `roomIntensity 255,i,i` across the
palette — and the map's step-by-step text uses the UI ink, so a base
snapshot taken before the override fades that text back to the wrong
colour.
