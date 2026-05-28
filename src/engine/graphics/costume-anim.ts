/**
 * SCUMM v5 costume animation record decoder — **stub** for Phase 6.
 *
 * The full per-limb anim record format remains under empirical
 * investigation. Section 3.6 of `docs/SCUMM-V5-COST.md` documents
 * the *intended* layout (u16 LE limb-mask + 3 bytes per limb), but
 * decoding real MI1 records (e.g. costume #0 / Guybrush) against
 * that spec produces inconsistent byte-count totals: 1-limb anims
 * land 1 byte longer than predicted, while multi-limb anims match.
 * Until we can drive an actor through a script-issued animation and
 * compare on-screen poses against a reference, we don't have a
 * reliable ground-truth signal for "this decoder is right".
 *
 * For now this module exposes a deliberate **stub**: `currentLimbFrame`
 * returns frame 0 for every limb. The compositor uses this to render
 * actors in a static "init pose" — adequate for the Phase 6 milestone
 * of "Guybrush composited in his starting position" but no animation
 * playback.
 *
 * When we revisit this:
 *
 *   1. Drive a real boot-script `walkActor` through dispatch.
 *   2. Step the actor's per-limb animation tick on the main loop.
 *   3. Cross-reference the resulting limb-frame sequence against
 *      descumm output for the same anim, OR against a screenshot of
 *      MI1 running in another v5 interpreter for visual diffing.
 *   4. Update this stub with the verified record layout and unstub
 *      `step` to advance frame indices per limb.
 */

import type { CostumeHeader } from './costume';

export interface AnimState {
  /** Which anim id is currently playing (script-assigned). */
  readonly animId: number;
  /** Per-limb current frame index into that limb's image table. */
  readonly perLimbFrame: ReadonlyArray<number>;
  /** Per-limb tick counter so each limb can advance at its own pace. */
  readonly perLimbTick: ReadonlyArray<number>;
}

export function createAnimState(header: CostumeHeader): AnimState {
  const limbCount = header.limbOffsets.length;
  return {
    animId: 0,
    perLimbFrame: new Array(limbCount).fill(0),
    perLimbTick: new Array(limbCount).fill(0),
  };
}

/**
 * Phase 6 stub: every limb sits on its image-table entry 0 ("init
 * pose"). When the real decoder lands this becomes
 * `state.perLimbFrame[limbIdx]`.
 */
export function currentLimbFrame(state: AnimState, limbIdx: number): number {
  const v = state.perLimbFrame[limbIdx];
  return v ?? 0;
}

/**
 * Phase 6 stub: animation does not advance. When the real decoder
 * lands this consults the per-limb command stream from the costume
 * payload and advances `perLimbFrame` / `perLimbTick`.
 */
export function stepAnim(state: AnimState): AnimState {
  return state;
}

/**
 * Phase 6 stub: starting a new anim resets per-limb frames to 0.
 * The real version would read the anim record's per-limb start
 * indices into `perLimbFrame`.
 */
export function startAnim(state: AnimState, animId: number): AnimState {
  return {
    animId,
    perLimbFrame: state.perLimbFrame.map(() => 0),
    perLimbTick: state.perLimbTick.map(() => 0),
  };
}
