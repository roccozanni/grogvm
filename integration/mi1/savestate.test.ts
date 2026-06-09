/**
 * Save-state round-trip against the REAL game — the boot→drive→persist→restore
 * →tick coverage the synthetic `src/engine/vm/savestate.test.ts` can't provide.
 * The synthetic suite proves every persisted field round-trips through JSON;
 * this proves the same machinery reproduces a rich, live state assembled by the
 * actual bytecode (real scripts, actors, dialog, verbs at the first interactive
 * room) — byte-for-byte — and that the restored VM keeps running.
 *
 * Data-gated, so it self-skips on a fresh checkout.
 */
import { describe, expect, it } from 'vitest';
import { snapshotVm, restoreVm, type SaveState } from '../../src/engine/vm/savestate';
import { VAR_EGO } from '../../src/engine/vm/vars';
import { driveToRoom } from '../../src/testkit/scummv5';
import { boot, hasGame, ROOMS } from './game';

const LOOKOUT = ROOMS.meleeLookout.id; // 33 — the first interactive room

/** Boot MI1 and drive the intro into the first interactive room, settled. */
function bootToLookout() {
  const vm = boot();
  expect(driveToRoom(vm, LOOKOUT, { maxTicks: 60000 })).toBe(true);
  for (let i = 0; i < 24; i++) vm.tick(); // settle actors/verbs/dialog
  return vm;
}

describe.skipIf(!hasGame())('save-state — real MI1 round-trip', () => {
  it('snapshot → restore into a fresh boot reproduces the live state exactly', () => {
    const vm = bootToLookout();
    expect(vm.haltInfo).toBeNull();

    const snap = snapshotVm(vm, { game: 'MI1' });
    const json = JSON.stringify(snap);

    const vm2 = boot();
    restoreVm(vm2, JSON.parse(json) as SaveState);

    // The restored VM re-serializes byte-for-byte identically.
    expect(JSON.stringify(snapshotVm(vm2, { game: 'MI1' }))).toBe(json);
    // And key observable state matches.
    expect(vm2.currentRoom).toBe(LOOKOUT);
    expect(vm2.loadedRoom?.id).toBe(LOOKOUT);
    expect(vm2.haltInfo).toBeNull();
    const ego = vm2.vars.readGlobal(VAR_EGO);
    expect(vm2.actors.get(ego).room).toBe(LOOKOUT);
    expect(vm2.actors.get(ego).x).toBe(vm.actors.get(ego).x);
  });

  it('a restored VM keeps ticking without halting', () => {
    const vm = bootToLookout();
    const vm2 = boot();
    restoreVm(vm2, JSON.parse(JSON.stringify(snapshotVm(vm))) as SaveState);
    for (let i = 0; i < 120; i++) vm2.tick();
    expect(vm2.haltInfo).toBeNull();
    expect(vm2.currentRoom).toBe(LOOKOUT);
  });
});
