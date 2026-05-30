/**
 * SCUMM v5 costume animation decoder.
 *
 * Each costume has a table of *anim definitions* (16 per "logical
 * anim", grouped by 4 cardinal directions × 4 logical anims). When a
 * script starts an anim on an actor (animateActor, walkActorTo's
 * implicit walk anim, …), the engine looks up the matching anim
 * definition, sets per-limb playback state, and the compositor reads
 * each limb's *current command-stream byte* to pick a frame index
 * from the limb's image table.
 *
 * # Anim definition layout
 *
 *   u16 LE limbMask
 *   for each set bit in limbMask:
 *     u16 LE start       // offset into the anim cmds array
 *     if start != 0xFFFF:
 *       u8 lengthAndFlags  // bit 7 = no-loop, bits 0..6 = end-offset
 *                          // (i.e. length = (end_offset + 1) bytes)
 *     else:
 *       (no length byte — the disabled-limb marker is 2 bytes total)
 *
 * # Limb numbering
 *
 * The wiki: "When one numbers the limbs from their corresponding bit
 * in the limb masks, they are then indexed in reverse order. This
 * means the first entry in the limb table is limb 15, then comes
 * limb 14, etc."
 *
 * We honour that: bit 0 of the mask → limb index 15, bit 15 → limb 0.
 * Iteration order through the per-bit data follows the same
 * convention so we read the bytes in the order the costume encodes
 * them.
 *
 * # Anim cmds
 *
 * `header.animCmdOffset` points at a flat byte array of frame
 * indices interleaved with a tiny command set (0x71-0x78 add sound,
 * 0x79 stop, 0x7A start, 0x7B hide, 0x7C skipFrame). Per-limb
 * playback walks a window of this array: starting at the limb's
 * `start` offset, advancing one byte per tick, looping back to
 * `start` after `length` bytes (unless the no-loop flag is set,
 * in which case it stops on the last byte).
 *
 * Currently we ignore the sound/skip commands — they don't affect
 * which picture composites — and just pick the first non-command
 * byte as the active frame index.
 */

import type { CostumeHeader } from './costume';

const LIMB_COUNT = 16;
const DISABLED_LIMB_MARKER = 0xffff;
const LENGTH_NOLOOP_FLAG = 0x80;
const LENGTH_VALUE_MASK = 0x7f;

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
  };
}

/**
 * Read the costume's anim-cmd byte for one limb at its current
 * cursor. Returns 0 for inactive limbs — the compositor uses that as
 * the limb's image-table entry index (which is the "init pose" frame
 * convention SCUMM v5 follows).
 */
export function currentLimbFrame(state: AnimState, limbIdx: number): number {
  const limb = state.limbs[limbIdx];
  if (!limb || !limb.active) return 0;
  // Without access to the costume payload here, return the cursor
  // itself as a positional index. The compositor combines this with
  // the limb's image table to find the frame ptr.
  return limb.cursor;
}

/**
 * Read the anim-cmd byte at a limb's current playback position from
 * the costume's anim-cmd array. Returns 0 if the limb is inactive or
 * the cursor would land outside the payload — the compositor uses 0
 * as the "no frame change" sentinel.
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
 * Start a new anim on an actor. Decodes the anim definition at
 * `header.animOffsets[animId]` and populates per-limb playback slots
 * from the mask + start/length pairs. A `0` or `0xFFFF` entry in
 * animOffsets is the "this anim isn't defined" sentinel — we return
 * an inactive state.
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
    // No definition for this anim — leave the limbs in their current
    // state. SCUMM scripts often trigger "stand" or "walk" anims that
    // aren't defined for a given costume; keeping the prior anim
    // running is the SCUMM-faithful behaviour.
    return { ...state, animId };
  }
  if (animOffset + 1 > payload.length) {
    return { ...state, animId, limbs: makeInactiveLimbs() };
  }

  // The record is `u8 mask` + per set bit `{u16 LE frameIndex, u8
  // lenFlags}`. The mask is ONE byte (verified against MI1 costumes #2,
  // #111, and Guybrush #1 — a u16 mask mis-aligns the modifiers); bit 7
  // = limb 0, bit 6 = limb 1, … bit 0 = limb 7 (MSB = limb 0). See
  // docs/SCUMM-V5-COSTUME-ANIM.md.
  const mask = payload[animOffset]!;
  // mask 0x00 (no limbs) and 0xFF leave the actor in its current/init
  // pose. 0xFF is a sentinel for the multi-limb / walk / talk record
  // form we don't decode yet (the record is far too short to host 8
  // modifiers) — activating it would draw garbage, so fall back to the
  // static pose instead. See the doc's "STILL OPEN" notes.
  if (mask === 0x00 || mask === 0xff) {
    return { ...state, animId, limbs: makeInactiveLimbs() };
  }

  let cursor = animOffset + 1;
  const limbs: LimbPlayback[] = makeInactiveLimbs() as LimbPlayback[];

  // Iterate bits MSB → LSB so we consume modifier bytes in encoded order.
  for (let bit = 7; bit >= 0; bit--) {
    if (!(mask & (1 << bit))) continue;
    if (cursor + 2 > payload.length) break;
    const frameIndex = payload[cursor]! | (payload[cursor + 1]! << 8);
    cursor += 2;
    const limbIdx = 7 - bit;
    if (frameIndex === DISABLED_LIMB_MARKER) {
      limbs[limbIdx] = INACTIVE_LIMB; // disabled — no length byte follows
      continue;
    }
    if (cursor + 1 > payload.length) break;
    const lenFlags = payload[cursor]!;
    cursor += 1;
    const noLoop = (lenFlags & LENGTH_NOLOOP_FLAG) !== 0;
    const length = (lenFlags & LENGTH_VALUE_MASK) + 1;
    // `frameIndex` indexes the frameOffs cmd array at animCmdOffset; the
    // limb's playback `start` is the absolute payload position of that
    // first cmd byte (currentAnimCmd reads payload[start + cursor]).
    const start = header.animCmdOffset + frameIndex;
    // Defensive: a start that runs past the payload means this record
    // doesn't fit the single-limb form (some costumes use a richer
    // encoding we don't decode yet). Leave the limb inactive rather
    // than read garbage.
    if (start < 0 || start + length > payload.length) {
      limbs[limbIdx] = INACTIVE_LIMB;
      continue;
    }
    limbs[limbIdx] = {
      active: true,
      start,
      length,
      noLoop,
      cursor: 0,
      finished: false,
    };
  }

  return { animId, limbs };
}

/**
 * Advance every active limb one tick. Loop-on-end for default anims,
 * sticky-on-last-byte for no-loop anims. Returns a new state object
 * (the old one stays unchanged so React-style state-diff tooling
 * stays happy).
 */
export function stepAnim(state: AnimState): AnimState {
  // Cheap short-circuit when nothing is playing.
  let anyActive = false;
  for (const limb of state.limbs) {
    if (limb.active) {
      anyActive = true;
      break;
    }
  }
  if (!anyActive) return state;

  const limbs: LimbPlayback[] = [];
  for (const limb of state.limbs) {
    if (!limb.active) {
      limbs.push(limb);
      continue;
    }
    if (limb.length <= 1) {
      // Single-byte loop or no-loop — nothing to advance.
      limbs.push({ ...limb, finished: limb.noLoop });
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
  return { animId: state.animId, limbs };
}

function makeInactiveLimbs(): LimbPlayback[] {
  const out: LimbPlayback[] = [];
  for (let i = 0; i < LIMB_COUNT; i++) out.push(INACTIVE_LIMB);
  return out;
}
