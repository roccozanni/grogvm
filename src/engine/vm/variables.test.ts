import { describe, expect, it } from 'vitest';
import { Variables } from './variables';

const vars = () =>
  new Variables({ numVariables: 800, numBitVariables: 2048, numRoomVariables: 16 });

describe('Variables — globals', () => {
  it('reads zero before any write', () => {
    expect(vars().readGlobal(0)).toBe(0);
    expect(vars().readGlobal(799)).toBe(0);
  });

  it('round-trips values', () => {
    const v = vars();
    v.writeGlobal(0, 42);
    v.writeGlobal(799, -1);
    expect(v.readGlobal(0)).toBe(42);
    expect(v.readGlobal(799)).toBe(-1);
  });

  it('stores negative values (signed)', () => {
    const v = vars();
    v.writeGlobal(7, -12345);
    expect(v.readGlobal(7)).toBe(-12345);
  });

  it('truncates writes to 32-bit signed int', () => {
    const v = vars();
    v.writeGlobal(0, 2 ** 33 + 7);
    expect(v.readGlobal(0)).toBe(7);
  });

  it('returns 0 and records OOB access for out-of-range reads', () => {
    const v = vars();
    expect(v.readGlobal(-1)).toBe(0);
    expect(v.readGlobal(800)).toBe(0);
    expect(v.oobAccesses.size).toBe(2);
    expect(v.oobAccesses.get('global:read:-1')?.count).toBe(1);
    expect(v.oobAccesses.get('global:read:800')?.count).toBe(1);
  });

  it('silently no-ops OOB writes and counts them', () => {
    const v = vars();
    v.writeGlobal(1000, 42);
    v.writeGlobal(1000, 43);
    expect(v.oobAccesses.get('global:write:1000')?.count).toBe(2);
    // No state change to the in-bounds part of the bank
    expect(v.readGlobal(0)).toBe(0);
  });
});

describe('Variables — bit-vars', () => {
  it('reads 0 before any write', () => {
    const v = vars();
    for (const i of [0, 7, 8, 100, 2047]) {
      expect(v.readBit(i)).toBe(0);
    }
  });

  it('round-trips individual bits', () => {
    const v = vars();
    v.writeBit(0, 1);
    v.writeBit(7, 1);
    v.writeBit(8, 1);
    v.writeBit(2047, 1);
    expect(v.readBit(0)).toBe(1);
    expect(v.readBit(7)).toBe(1);
    expect(v.readBit(8)).toBe(1);
    expect(v.readBit(2047)).toBe(1);
    expect(v.readBit(1)).toBe(0);
    expect(v.readBit(2046)).toBe(0);
  });

  it('packs bits into the same byte without bleed-over', () => {
    const v = vars();
    for (let i = 0; i < 8; i++) v.writeBit(i, (i & 1) as 0 | 1);
    for (let i = 0; i < 8; i++) expect(v.readBit(i)).toBe((i & 1) as 0 | 1);
  });

  it('treats truthy/falsy values like booleans', () => {
    const v = vars();
    v.writeBit(0, true);
    v.writeBit(1, false);
    expect(v.readBit(0)).toBe(1);
    expect(v.readBit(1)).toBe(0);
  });

  it('absorbs OOB bit access into oobAccesses without throwing', () => {
    const v = vars();
    expect(v.readBit(2048)).toBe(0);
    v.writeBit(-1, 1);
    expect(v.oobAccesses.get('bit:read:2048')?.count).toBe(1);
    expect(v.oobAccesses.get('bit:write:-1')?.count).toBe(1);
  });
});

describe('Variables — room-vars', () => {
  it('round-trips room values', () => {
    const v = vars();
    v.writeRoom(0, 7);
    v.writeRoom(15, -99);
    expect(v.readRoom(0)).toBe(7);
    expect(v.readRoom(15)).toBe(-99);
  });

  it('absorbs OOB room-var access into oobAccesses without throwing', () => {
    const v = vars();
    expect(v.readRoom(16)).toBe(0);
    expect(v.oobAccesses.get('room:read:16')?.count).toBe(1);
  });
});
