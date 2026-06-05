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
 *   [00 00 00]           // optional 3-byte prefix (extended form only)
 *   u8 limbMask
 *   for each set bit in limbMask (MSB → LSB):
 *     u16 LE frameIndex  // offset into the anim cmds array
 *     if frameIndex != 0xFFFF:
 *       u8 lengthAndFlags  // bit 7 = no-loop, bits 0..6 = (length - 1)
 *     else:
 *       (no length byte — the disabled-limb marker is 2 bytes total)
 *
 * The mask is ONE byte in MI1 costumes (a u16 mask mis-aligns the
 * modifiers — verified against #2, #111, and Guybrush #1). The
 * walk/stand/turn anims prepend a 3-byte all-zero header before the
 * mask byte; see `startAnim` for the discriminator and
 * pages/docs/scumm/costume-anim.md for the evidence.
 *
 * # Limb numbering
 *
 * bit 7 of the mask → limb 0, bit 6 → limb 1, … bit 0 → limb 7. We
 * iterate the bits MSB → LSB so the per-bit modifier bytes are read in
 * the order the costume encodes them.
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

// Anim-cmd stream command bytes (not picture indices).
const CMD_LO = 0x71;
const CMD_HI = 0x7c;
const CMD_STOP = 0x79; //  → set this limb's "stopped" bit (freeze, don't draw)
const CMD_UNSTOP = 0x7a; // → clear the "stopped" bit (resume drawing)
const isAnimCmd = (b: number): boolean => b >= CMD_LO && b <= CMD_HI;

/**
 * v5 base correction. ScummVM reads every stored costume offset relative
 * to `_baseptr`; our `payload` array begins **6 bytes past** `_baseptr`
 * (we parse numAnim/format at payload[0]/[1]; the v5 layout has them at
 * `_baseptr[6]`/`[7]`). So every stored offset VALUE — the anim record,
 * the cmd stream, the limb image table — is read at `payload[value - 6]`.
 * (Frame pointers are decoded via `decodeCostumeFrame`, whose own −6 is
 * this same correction, so they need no extra adjustment.)
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
   * Per-limb "stopped" bitmask (bit `i` = limb `i`). A stopped limb does
   * NOT draw. Set by the `0x79` cmd, cleared by `0x7A`; persists across
   * `startAnim` calls — this is how the walk freezes the head limb (the
   * body sprite carries the head) while stand/talk resume it.
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
 * Resolve the picture index a limb should draw this tick — or -1 for
 * "draw nothing". Returns -1 when the limb is inactive, **stopped**, or
 * its whole window is command bytes. Command bytes (`0x71-0x7C`: sound /
 * loop / stop markers) are not drawable pictures, so we advance past
 * them (wrapping within the loop window) to the next real picture — an
 * active limb never blanks for a tick.
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
 * Start a new anim on an actor. Decodes the anim record at
 * `header.animOffsets[animId]` per the v5 algorithm:
 *
 *   u16 LE mask           — processed MSB-first; limb `i` = bit `15-i`
 *   per set bit:
 *     u16 LE frameIndex j — index into the anim-cmd stream
 *     if j != 0xFFFF: u8 extra  — low 7 bits = length, bit 7 = no-loop
 *
 * `animCmds[j]` decides the limb's fate: `0x7A` un-stops it, `0x79`
 * stops it (a persistent per-limb bit — neither sets playback), and
 * anything else starts playback over `cmds[j .. j+(extra&0x7f)]`.
 *
 * Limbs NOT named by the mask are left untouched (so talk can drive the
 * head while the body holds its pose). All stored offsets are read with
 * the `COSTUME_OFFSET_ADJUST` (−6) base correction.
 *
 * A `0`/`0xFFFF` entry in animOffsets is the "anim not defined"
 * sentinel — we keep the current limb state.
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
  // A full anim start applies every limb the mask names (ScummVM passes
  // usemask = all-ones); partial usemask updates aren't modelled.
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
 * Advance every active, non-stopped limb one tick. Loop-on-end for
 * default anims, sticky-on-last-byte for no-loop anims. Returns a new
 * state object (the old one stays unchanged).
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
