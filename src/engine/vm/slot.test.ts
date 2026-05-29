import { describe, expect, it } from 'vitest';
import { ScriptSlot, ScriptSlotError } from './slot';

const bytes = (...vals: number[]) => new Uint8Array(vals);

describe('ScriptSlot', () => {
  it('starts dead', () => {
    const s = new ScriptSlot(0);
    expect(s.status).toBe('dead');
    expect(s.scriptId).toBe(0);
    expect(s.pc).toBe(0);
  });

  it('start() loads bytecode, args, and transitions to running', () => {
    const s = new ScriptSlot(3);
    s.start({
      scriptId: 42,
      bytecode: bytes(0x80, 0x00),
      args: [7, -3, 100],
      room: 10,
    });
    expect(s.status).toBe('running');
    expect(s.scriptId).toBe(42);
    expect(s.bytecode).toHaveLength(2);
    expect(s.pc).toBe(0);
    expect(s.room).toBe(10);
    expect(s.locals[0]).toBe(7);
    expect(s.locals[1]).toBe(-3);
    expect(s.locals[2]).toBe(100);
    expect(s.locals[3]).toBe(0);
  });

  it('start() accepts an optional label for synthetic scripts (ENCD/EXCD/verb)', () => {
    const s = new ScriptSlot(0);
    s.start({ scriptId: 0, bytecode: bytes(0xa0), label: 'ENCD-10', room: 10 });
    expect(s.label).toBe('ENCD-10');
    s.kill();
    expect(s.label).toBe('');
  });

  it('start() defaults label to empty string when not passed', () => {
    const s = new ScriptSlot(0);
    s.start({ scriptId: 42, bytecode: bytes(0xa0) });
    expect(s.label).toBe('');
  });

  it('start() refuses to overwrite a non-dead slot', () => {
    const s = new ScriptSlot(0);
    s.start({ scriptId: 1, bytecode: bytes(0x00) });
    expect(() =>
      s.start({ scriptId: 2, bytecode: bytes(0x00) }),
    ).toThrow(ScriptSlotError);
  });

  it('yield_() flips running → yielded; resume() flips back', () => {
    const s = new ScriptSlot(0);
    s.start({ scriptId: 1, bytecode: bytes(0x80) });
    s.yield_();
    expect(s.status).toBe('yielded');
    s.resume();
    expect(s.status).toBe('running');
  });

  it('resume() is a no-op on running and dead slots', () => {
    const s = new ScriptSlot(0);
    s.resume();
    expect(s.status).toBe('dead');
    s.start({ scriptId: 1, bytecode: bytes(0x00) });
    s.resume();
    expect(s.status).toBe('running');
  });

  it('freeze() bumps a cumulative count; unfreeze() clears it; dead is untouched', () => {
    const s = new ScriptSlot(0);
    s.freeze();
    expect(s.status).toBe('dead');
    expect(s.freezeCount).toBe(0); // dead slots don't freeze
    s.start({ scriptId: 1, bytecode: bytes(0x00) });
    // status stays 'running'; freezing is tracked separately and is
    // cumulative.
    s.freeze();
    s.freeze();
    expect(s.status).toBe('running');
    expect(s.freezeCount).toBe(2);
    expect(s.runnable).toBe(false);
    s.unfreeze();
    expect(s.runnable).toBe(false); // still frozen once
    s.unfreeze();
    expect(s.freezeCount).toBe(0);
    expect(s.runnable).toBe(true);
  });

  it('kill() wipes the slot back to dead', () => {
    const s = new ScriptSlot(0);
    s.start({
      scriptId: 5,
      bytecode: bytes(0x80, 0x00),
      args: [1, 2, 3],
      room: 9,
    });
    s.pc = 1;
    s.kill();
    expect(s.status).toBe('dead');
    expect(s.scriptId).toBe(0);
    expect(s.pc).toBe(0);
    expect(s.room).toBe(0);
    expect(s.bytecode).toHaveLength(0);
    expect(s.locals[0]).toBe(0);
  });

  it('locals are isolated across slots', () => {
    const a = new ScriptSlot(0);
    const b = new ScriptSlot(1);
    a.start({ scriptId: 1, bytecode: bytes(0), args: [11, 22] });
    b.start({ scriptId: 2, bytecode: bytes(0), args: [99, 100] });
    expect(a.locals[0]).toBe(11);
    expect(b.locals[0]).toBe(99);
    a.locals[5] = 555;
    expect(b.locals[5]).toBe(0);
  });

  it('yield_() on a dead slot throws', () => {
    const s = new ScriptSlot(0);
    expect(() => s.yield_()).toThrow(ScriptSlotError);
  });
});
