/**
 * SCUMM v5 costume animation playback (anim records + per-limb command
 * stream). Format reference: pages/docs/scumm/costume-anim.md.
 */

import type { CostumeHeader } from './costume';

const LIMB_COUNT = 16;
const DISABLED_LIMB_MARKER = 0xffff;
const LENGTH_NOLOOP_FLAG = 0x80;
const LENGTH_VALUE_MASK = 0x7f;

// Anim-cmd stream command bytes (not picture indices).
const CMD_LO = 0x71;
const CMD_HI = 0x7c;
const CMD_STOP = 0x79; //  → set this limb's "stopped" bit (freeze, don't draw)
const CMD_UNSTOP = 0x7a; // → clear the "stopped" bit (resume drawing)
const isAnimCmd = (b: number): boolean => b >= CMD_LO && b <= CMD_HI;

/**
 * Every offset value stored in a COST block is measured from an origin
 * 6 bytes before our payload, so it is read at `payload[value - 6]`.
 * See pages/docs/scumm/costume-anim.md §"The −6 offset base".
 */
export const COSTUME_OFFSET_ADJUST = -6;

/** One limb's playback slot. */
export interface LimbPlayback {
  /** True when this limb has any anim data right now. */
  readonly active: boolean;
  /** Byte offset into the costume's anim-cmd array where the loop starts. */
  readonly start: number;
  /** Byte length of the loop window (inclusive). 1 = single static byte. */
  readonly length: number;
  /** When true, playback stops on the last byte instead of looping. */
  readonly noLoop: boolean;
  /** Per-tick position 0..length-1. */
  readonly cursor: number;
  /** True when noLoop=true and we've reached the last byte. */
  readonly finished: boolean;
}

/**
 * Per-actor animation state — populated by `startAnim` (when a script
 * triggers an anim), advanced by `stepAnim` (per engine tick), read by
 * the compositor via `currentLimbFrame`.
 */
export interface AnimState {
  /** Which anim id is currently playing (script-assigned). 0 = none. */
  readonly animId: number;
  /** One slot per limb, indexed 0..15. Inactive limbs read frame 0. */
  readonly limbs: ReadonlyArray<LimbPlayback>;
  /**
   * Per-limb "stopped" bits (bit `i` = limb `i`); a stopped limb does NOT
   * draw. Set by cmd `0x79`, cleared by `0x7A`, and persists across
   * `startAnim` calls — how the walk freezes the head limb.
   */
  readonly stopped: number;
}

const INACTIVE_LIMB: LimbPlayback = {
  active: false,
  start: 0,
  length: 0,
  noLoop: false,
  cursor: 0,
  finished: false,
};

export function createAnimState(_header: CostumeHeader): AnimState {
  return {
    animId: 0,
    limbs: makeInactiveLimbs(),
    stopped: 0,
  };
}

/**
 * A limb's current cursor as a positional frame index (no payload
 * access here); 0 for inactive limbs — the v5 "init pose" convention.
 */
export function currentLimbFrame(state: AnimState, limbIdx: number): number {
  const limb = state.limbs[limbIdx];
  if (!limb || !limb.active) return 0;
  return limb.cursor;
}

/**
 * The anim-cmd byte at a limb's current playback position; 0 when the
 * limb is inactive or the cursor lands outside the payload.
 */
export function currentAnimCmd(
  state: AnimState,
  limbIdx: number,
  payload: Uint8Array,
): number {
  const limb = state.limbs[limbIdx];
  if (!limb || !limb.active) return 0;
  const pos = limb.start + limb.cursor;
  if (pos < 0 || pos >= payload.length) return 0;
  return payload[pos]!;
}

/**
 * The picture index a limb draws this tick, or -1 for "draw nothing"
 * (inactive, stopped, or all-command window). Command bytes (0x71-0x7C)
 * aren't pictures — skip past them so an active limb never blanks.
 */
export function currentLimbPicture(
  state: AnimState,
  limbIdx: number,
  payload: Uint8Array,
): number {
  const limb = state.limbs[limbIdx];
  if (!limb || !limb.active) return -1;
  if ((state.stopped >> limbIdx) & 1) return -1; // stopped → don't draw
  const len = Math.max(1, limb.length);
  for (let k = 0; k < len; k++) {
    const pos = limb.start + ((limb.cursor + k) % len);
    if (pos < 0 || pos >= payload.length) continue;
    const b = payload[pos]!;
    if (!isAnimCmd(b)) return b;
  }
  return -1;
}

/**
 * Start an anim: decode the record at `header.animOffsets[animId]` and
 * update ONLY the limbs its mask names — unmasked limbs keep playing
 * (talk drives the head while the body holds its pose). Record layout:
 * pages/docs/scumm/costume-anim.md §"Animation records".
 */
export function startAnim(
  state: AnimState,
  animId: number,
  header: CostumeHeader,
  payload: Uint8Array,
): AnimState {
  if (animId < 0 || animId >= header.animOffsets.length) {
    return { ...state, animId };
  }
  const animOffset = header.animOffsets[animId]!;
  if (animOffset === 0 || animOffset === DISABLED_LIMB_MARKER) {
    return { ...state, animId };
  }
  const recordStart = animOffset + COSTUME_OFFSET_ADJUST;
  if (recordStart < 0 || recordStart + 2 > payload.length) {
    return { ...state, animId };
  }

  // Copy current limbs/stopped; only the masked limbs are updated.
  const limbs: LimbPlayback[] = state.limbs.map((l) => l);
  let stopped = state.stopped;
  const cmdBase = header.animCmdOffset + COSTUME_OFFSET_ADJUST;

  let r = recordStart;
  let mask = payload[r]! | (payload[r + 1]! << 8);
  r += 2;
  // A full anim start applies every limb the mask names; partial usemask
  // updates aren't modelled.
  let i = 0;
  while ((mask & 0xffff) !== 0 && i < LIMB_COUNT) {
    if (mask & 0x8000) {
      if (r + 2 > payload.length) break;
      const j = payload[r]! | (payload[r + 1]! << 8);
      r += 2;
      if (j === DISABLED_LIMB_MARKER) {
        limbs[i] = INACTIVE_LIMB; // no extra byte follows
      } else {
        if (r >= payload.length) break;
        const extra = payload[r]!;
        r += 1;
        const cmdOff = cmdBase + j;
        const cmd = cmdOff >= 0 && cmdOff < payload.length ? payload[cmdOff]! : -1;
        if (cmd === CMD_UNSTOP) {
          stopped &= ~(1 << i);
        } else if (cmd === CMD_STOP) {
          stopped |= 1 << i;
        } else {
          const start = cmdBase + j;
          const length = (extra & LENGTH_VALUE_MASK) + 1;
          const noLoop = (extra & LENGTH_NOLOOP_FLAG) !== 0;
          limbs[i] =
            start >= 0 && start < payload.length
              ? { active: true, start, length, noLoop, cursor: 0, finished: false }
              : INACTIVE_LIMB;
        }
      }
    }
    i++;
    mask = (mask << 1) & 0xffff;
  }

  return { animId, limbs, stopped };
}

/**
 * Advance every active, non-stopped limb one tick: loop on end, or stick
 * on the last byte for no-loop anims. Returns a new state object.
 */
export function stepAnim(state: AnimState): AnimState {
  let anyAdvancing = false;
  for (let i = 0; i < state.limbs.length; i++) {
    const l = state.limbs[i]!;
    if (l.active && l.length > 1 && !((state.stopped >> i) & 1)) {
      anyAdvancing = true;
      break;
    }
  }
  if (!anyAdvancing) return state;

  const limbs: LimbPlayback[] = [];
  for (let i = 0; i < state.limbs.length; i++) {
    const limb = state.limbs[i]!;
    // Stopped or static limbs hold their frame.
    if (!limb.active || limb.length <= 1 || (state.stopped >> i) & 1) {
      limbs.push(limb.active && limb.length <= 1 ? { ...limb, finished: limb.noLoop } : limb);
      continue;
    }
    let next = limb.cursor + 1;
    let finished = false;
    if (next >= limb.length) {
      if (limb.noLoop) {
        next = limb.length - 1;
        finished = true;
      } else {
        next = 0;
      }
    }
    limbs.push({ ...limb, cursor: next, finished });
  }
  return { animId: state.animId, limbs, stopped: state.stopped };
}

function makeInactiveLimbs(): LimbPlayback[] {
  const out: LimbPlayback[] = [];
  for (let i = 0; i < LIMB_COUNT; i++) out.push(INACTIVE_LIMB);
  return out;
}
