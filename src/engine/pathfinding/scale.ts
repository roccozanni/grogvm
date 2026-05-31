/**
 * Actor perspective scaling from the room's `SCAL` block + per-box scale field.
 *
 * SCUMM scales actors by floor depth so they shrink walking away. The `SCAL`
 * block holds up to 4 slots, each a linear gradient `(scale1@y1 → scale2@y2)`.
 * A walk box's `scale` field (u16, see boxes.ts) selects how an actor standing
 * in it is scaled:
 *   - `0`                  → no per-box scaling (leave the actor's scale).
 *   - `& 0x8000` set       → SCAL slot reference; slot index = `scale & 0x7FFF`
 *                            (0-based), interpolated by the actor's y.
 *   - otherwise            → a direct fixed scale (1..255).
 *
 * Derived empirically from MI1 room 33 (the Mêlée cliff/dock): boxes 1–7 use
 * slot 0 = `32@y76 → 210@y131` (small at the clifftop, full at the dock).
 */

export interface ScaleSlot {
  readonly scale1: number;
  readonly y1: number;
  readonly scale2: number;
  readonly y2: number;
}

function u16(p: Uint8Array, o: number): number {
  return p[o]! | (p[o + 1]! << 8);
}

/** Parse a `SCAL` payload into its scale slots (4 × `scale1,y1,scale2,y2`). */
export function parseScal(payload: Uint8Array): ScaleSlot[] {
  const slots: ScaleSlot[] = [];
  for (let i = 0; i + 8 <= payload.length; i += 8) {
    slots.push({ scale1: u16(payload, i), y1: u16(payload, i + 2), scale2: u16(payload, i + 4), y2: u16(payload, i + 6) });
  }
  return slots;
}

const clampScale = (s: number): number => Math.max(1, Math.min(255, Math.round(s)));

function interpolate(slot: ScaleSlot, y: number): number {
  if (slot.y1 === slot.y2) return clampScale(slot.scale1);
  const s = slot.scale1 + ((slot.scale2 - slot.scale1) * (y - slot.y1)) / (slot.y2 - slot.y1);
  return clampScale(s);
}

/**
 * Resolve the scale (1..255) for an actor at row `y` standing in a box with
 * the given `boxScale` field, against the room's SCAL `slots`. Returns `null`
 * when the box specifies no scaling (so the caller leaves the actor's scale
 * untouched — e.g. a script-pinned static actor).
 */
export function resolveScale(
  boxScale: number,
  slots: readonly ScaleSlot[],
  y: number,
): number | null {
  if (boxScale === 0) return null;
  if (boxScale & 0x8000) {
    const slot = slots[boxScale & 0x7fff];
    // Unpopulated / all-zero slot → treat as "no scaling".
    if (!slot || (slot.scale1 === 0 && slot.y1 === 0 && slot.scale2 === 0 && slot.y2 === 0)) {
      return null;
    }
    return interpolate(slot, y);
  }
  return clampScale(boxScale); // direct fixed scale
}
