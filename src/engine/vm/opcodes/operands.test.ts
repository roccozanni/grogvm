import { describe, expect, it } from 'vitest';
import { ParamError } from '../params';
import { ScriptSlot } from '../slot';
import { Variables } from '../variables';
import { LiveReader, StaticReader, formatVarRef, renderBytes, scanScummString } from './operands';

function makeSlot(bytes: number[]): ScriptSlot {
  const s = new ScriptSlot(0);
  s.start({ scriptId: 1, bytecode: new Uint8Array(bytes) });
  return s;
}

function makeVars(): Variables {
  return new Variables({ numVariables: 800, numBitVariables: 2048, numRoomVariables: 16 });
}

function live(bytes: number[]): { r: LiveReader; slot: ScriptSlot; vars: Variables } {
  const slot = makeSlot(bytes);
  const vars = makeVars();
  return { r: new LiveReader(slot, vars), slot, vars };
}

describe('StaticReader', () => {
  it('reads immediates with known values and numeric labels', () => {
    const r = new StaticReader(new Uint8Array([7, 0x64, 0x00]), 0);
    expect(r.p8(0, 1)).toMatchObject({ value: 7, known: true, label: '7' });
    expect(r.p16(0, 1)).toMatchObject({ value: 100, known: true, label: '100' });
    expect(r.pc).toBe(3);
  });

  it('reads signed p16 immediates', () => {
    const r = new StaticReader(new Uint8Array([0xfe, 0xff]), 0);
    expect(r.p16(0, 1).value).toBe(-2);
  });

  it('labels var-mode params without dereferencing', () => {
    const r = new StaticReader(new Uint8Array([0x05, 0x40]), 0);
    const v = r.p8(0x80, 1);
    expect(v).toMatchObject({ known: false, label: 'L5' });
    expect(r.pc).toBe(2);
  });

  it('consumes the extra word of an indexed var-ref and renders the suffix', () => {
    // g5[5]: base ref with 0x2000, then an immediate offset word.
    const r = new StaticReader(new Uint8Array([0x05, 0x20, 0x05, 0x00]), 0);
    expect(r.variable().label).toBe('g5[5]');
    expect(r.pc).toBe(4);
  });

  it('decodes varargs to the 0xFF terminator', () => {
    const r = new StaticReader(new Uint8Array([0x00, 0x00, 0x01, 0x80, 0x02, 0x40, 0xff]), 0);
    const args = r.varargs();
    expect(args.map((a) => a.label)).toEqual(['256', 'L2']);
    expect(r.pc).toBe(7);
  });

  it('throws past end instead of yielding garbage', () => {
    const r = new StaticReader(new Uint8Array([0x01]), 0);
    expect(() => r.u16()).toThrow(ParamError);
  });
});

describe('LiveReader', () => {
  it('derefs var-mode params and reports the runtime value', () => {
    const { r } = live([0x05, 0x40, 0x2a]);
    const v = r.p8(0x80, 1);
    expect(v.known).toBe(true);
    expect(v.value).toBe(0); // L5 zeroed on start
    expect(r.u8()).toBe(0x2a);
  });

  it('variable() exposes both the deref value and the ref label', () => {
    const { r, vars } = live([0x07, 0x00]);
    vars.writeGlobal(7, 123);
    const v = r.variable();
    expect(v.value).toBe(123);
    expect(v.label).toBe('g7');
  });

  it('dest() resolves to a writeRef-able ref', () => {
    const { r } = live([0x09, 0x00]);
    expect(r.dest().ref).toBe(9);
  });

  it('scummString consumes escape args that contain 0x00', () => {
    // "A" + 0xFF 0x07 escape (code >= 4 → 2-byte arg, second byte 0x00) + "B" + NUL, then 0x2a.
    const { r } = live([0x41, 0xff, 0x07, 0x31, 0x00, 0x42, 0x00, 0x2a]);
    const s = r.scummString();
    expect(Array.from(s)).toEqual([0x41, 0xff, 0x07, 0x31, 0x00, 0x42]);
    expect(r.u8()).toBe(0x2a);
  });
});

describe('reader agreement', () => {
  // The structural invariant the unification exists for: both readers
  // consume identical byte counts for the same operand sequence.
  it('consumes the same byte count live and static across operand kinds', () => {
    const bytes = [
      0x07, // u8
      0x10, 0x27, // i16
      0x05, // p8 imm (mode 0)
      0x03, 0x40, // p8 var (mode 0x80)
      0x64, 0x00, // p16 imm
      0x05, 0x20, 0x02, 0x00, // variable, indexed g5[2]
      0x09, 0x00, // dest
      0x00, 0x01, 0x00, 0x80, 0x03, 0x40, 0xff, // varargs [256, L3]
      0x48, 0x69, 0xff, 0x07, 0x00, 0x00, 0x00, // scummString "Hi" + escape + NUL
    ];
    const drive = (r: LiveReader | StaticReader) => {
      r.u8();
      r.i16();
      r.p8(0x00, 1);
      r.p8(0x80, 1);
      r.p16(0x00, 1);
      r.variable();
      r.dest();
      r.varargs();
      r.scummString();
    };
    const slot = makeSlot(bytes);
    drive(new LiveReader(slot, makeVars()));
    const stat = new StaticReader(new Uint8Array(bytes), 0);
    drive(stat);
    expect(slot.pc).toBe(bytes.length);
    expect(stat.pc).toBe(bytes.length);
  });
});

describe('helpers', () => {
  it('formatVarRef decodes the scopes and the indexed suffix', () => {
    expect(formatVarRef(7)).toBe('g7');
    expect(formatVarRef(0x4000 | 3)).toBe('L3');
    expect(formatVarRef(0x8000 | 12)).toBe('bit#12');
    const queue = [5];
    expect(formatVarRef(0x2000 | 5, () => queue.shift()!)).toBe('g5[5]');
  });

  it('renderBytes escapes non-printables', () => {
    expect(renderBytes([0x48, 0x69, 0x01])).toBe('Hi\\x01');
  });

  it('scanScummString throws on a missing terminator', () => {
    expect(() => scanScummString(new Uint8Array([0x41]), 0)).toThrow(ParamError);
  });
});
