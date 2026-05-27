import { describe, expect, it } from 'vitest';
import {
  ParamError,
  derefRead,
  isVarParam,
  readDestRef,
  readI16,
  readU16,
  readU8,
  readValue,
  readVarRef,
  writeRef,
} from './params';
import { ScriptSlot } from './slot';
import { Variables } from './variables';

function makeSlot(bytes: number[]): ScriptSlot {
  const s = new ScriptSlot(0);
  s.start({ scriptId: 1, bytecode: new Uint8Array(bytes) });
  return s;
}

function makeVars(): Variables {
  return new Variables({
    numVariables: 800,
    numBitVariables: 2048,
    numRoomVariables: 16,
  });
}

describe('isVarParam', () => {
  it('decodes param mode bits per param index', () => {
    expect(isVarParam(0x80, 1)).toBe(true);
    expect(isVarParam(0x80, 2)).toBe(false);
    expect(isVarParam(0x40, 2)).toBe(true);
    expect(isVarParam(0x20, 3)).toBe(true);
    expect(isVarParam(0xe0, 1)).toBe(true);
    expect(isVarParam(0xe0, 2)).toBe(true);
    expect(isVarParam(0xe0, 3)).toBe(true);
    expect(isVarParam(0x1f, 1)).toBe(false);
    expect(isVarParam(0x1f, 2)).toBe(false);
    expect(isVarParam(0x1f, 3)).toBe(false);
  });
});

describe('readU8 / readU16 / readI16', () => {
  it('reads bytes and advances PC', () => {
    const s = makeSlot([0xab, 0x34, 0x12, 0xff, 0xff]);
    expect(readU8(s)).toBe(0xab);
    expect(s.pc).toBe(1);
    expect(readU16(s)).toBe(0x1234);
    expect(s.pc).toBe(3);
    expect(readI16(s)).toBe(-1);
    expect(s.pc).toBe(5);
  });

  it('readI16 sign-extends the high bit', () => {
    const s = makeSlot([0x00, 0x80, 0xff, 0x7f]);
    expect(readI16(s)).toBe(-0x8000);
    expect(readI16(s)).toBe(0x7fff);
  });

  it('throws when reading past end of bytecode', () => {
    const s = makeSlot([0x01]);
    expect(() => readU16(s)).toThrow(ParamError);
  });
});

describe('var-ref dereference', () => {
  it('resolves global vars (top bits 0)', () => {
    const v = makeVars();
    v.writeGlobal(73, 999);
    const s = makeSlot([0x49, 0x00]); // ref = 0x0049 → global #73
    expect(readVarRef(s, v)).toBe(999);
  });

  it('resolves local vars (bit 15)', () => {
    const v = makeVars();
    const s = makeSlot([0x05, 0x80]); // ref = 0x8005 → local #5
    s.locals[5] = -42;
    expect(readVarRef(s, v)).toBe(-42);
  });

  it('resolves bit-vars (bit 14)', () => {
    const v = makeVars();
    v.writeBit(100, 1);
    const s = makeSlot([0x64, 0x40]); // ref = 0x4064 → bit #100
    expect(readVarRef(s, v)).toBe(1);
  });

  it('throws on indexed/array refs (bit 13)', () => {
    const v = makeVars();
    const s = makeSlot([0x00, 0x20]);
    expect(() => readVarRef(s, v)).toThrow(ParamError);
  });

  it('writeRef routes to the correct scope', () => {
    const v = makeVars();
    const s = makeSlot([]);
    writeRef(0x0007, 100, s, v);
    expect(v.readGlobal(7)).toBe(100);
    writeRef(0x8003, 25, s, v);
    expect(s.locals[3]).toBe(25);
    writeRef(0x4040, 1, s, v);
    expect(v.readBit(0x40)).toBe(1);
    writeRef(0x4040, 0, s, v);
    expect(v.readBit(0x40)).toBe(0);
  });
});

describe('readValue', () => {
  it('reads u16 immediate when mode bit is off', () => {
    const v = makeVars();
    const s = makeSlot([0x42, 0x00]);
    expect(readValue(s, v, false)).toBe(0x0042);
  });

  it('reads dereferenced var when mode bit is on', () => {
    const v = makeVars();
    v.writeGlobal(7, 555);
    const s = makeSlot([0x07, 0x00]);
    expect(readValue(s, v, true)).toBe(555);
  });
});

describe('readDestRef', () => {
  it('returns the raw ref word without dereferencing', () => {
    const s = makeSlot([0x49, 0x00, 0x34, 0x80]);
    expect(readDestRef(s)).toBe(0x0049);
    expect(readDestRef(s)).toBe(0x8034);
  });
});

describe('derefRead — boundary cases', () => {
  it('throws when local index exceeds locals length', () => {
    const v = makeVars();
    const s = new ScriptSlot(0);
    s.start({ scriptId: 1, bytecode: new Uint8Array(0) });
    // 25 locals, so index 99 (= 0x63) is out of range.
    expect(() => derefRead(0x8063, s, v)).toThrow(ParamError);
  });
});
