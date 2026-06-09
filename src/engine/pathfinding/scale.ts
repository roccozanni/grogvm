/**
 * Actor perspective scaling: SCAL slots (linear gradients scale1@y1 → scale2@y2)
 * selected by the per-box scale field. See pages/docs/scumm/walk-boxes.md.
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
 * Scale (1..255) for an actor at row `y`. `boxScale` is the u16 box field:
 * 0x8000 = SCAL-slot reference, else direct fixed scale. Returns `null` when
 * the box specifies no scaling, so the caller leaves the actor's scale alone.
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
