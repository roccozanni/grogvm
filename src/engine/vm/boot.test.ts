import { describe, expect, it } from 'vitest';
import { seedEngineVariables } from './boot';
import { LIGHTMODE_DEFAULT } from './lighting';
import { SEED_OPCODES } from './opcodes';
import { VAR_CURRENT_LIGHTS } from './vars';
import { Vm } from './vm';

function bareVm(): Vm {
  return new Vm({ numVariables: 800, numBitVariables: 2048, handlers: SEED_OPCODES });
}

describe('boot — engine variable seeding', () => {
  it('seeds VAR_CURRENT_LIGHTS to the lit default so rooms are not dark', () => {
    const vm = bareVm();
    // Pre-condition: an unseeded var bank reads 0 — which scripts treat
    // as "dark" (MI1 #2 → "troppo buio" for Look-at).
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS)).toBe(0);
    seedEngineVariables(vm, 'MI1');
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS)).toBe(LIGHTMODE_DEFAULT);
    // LIGHTMODE_DEFAULT must have the room-lights-on bit (4) set.
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS) & 4).toBe(4);
  });

  it('seeds the lit default for MI2 too (all v4–v5 games)', () => {
    const vm = bareVm();
    seedEngineVariables(vm, 'MI2');
    expect(vm.vars.readGlobal(VAR_CURRENT_LIGHTS)).toBe(LIGHTMODE_DEFAULT);
  });

  it('seeds MI1 copy-protection var 74 (CD track-2 size) to 1225, MI2 leaves it 0', () => {
    const mi1 = bareVm();
    seedEngineVariables(mi1, 'MI1');
    expect(mi1.vars.readGlobal(0x4a)).toBe(1225);
    const mi2 = bareVm();
    seedEngineVariables(mi2, 'MI2');
    expect(mi2.vars.readGlobal(0x4a)).toBe(0);
  });
});
