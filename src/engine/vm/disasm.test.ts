import { describe, expect, it } from 'vitest';
import { disassemble, formatVarRef } from './disasm';

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

describe('disasm — formatVarRef', () => {
  it('decodes the four variable scopes', () => {
    expect(formatVarRef(7)).toBe('g7'); // global
    expect(formatVarRef(0x4000 | 3)).toBe('L3'); // local (bit 14)
    expect(formatVarRef(0x8000 | 12)).toBe('bit#12'); // bit-var (bit 15)
  });

  it('consumes an extra offset word for indexed (0x2000) refs', () => {
    // var[g5] — base g5, indexed by literal 5 carried in the next word.
    const queue = [5];
    expect(formatVarRef(0x2000 | 5, () => queue.shift()!)).toBe('g5[5]');
  });
});

describe('disasm — single instructions', () => {
  it('decodes move with an immediate', () => {
    const out = disassemble(bytes(0x1a, 0x07, 0x00, 0x64, 0x00));
    expect(out[0]).toMatchObject({ offset: 0, opcode: 0x1a, text: 'move g7 = 100', aligned: true });
  });

  it('decodes a var-source move (value mode-bit is index 1 = 0x80)', () => {
    const out = disassemble(bytes(0x9a, 0x05, 0x00, 0x02, 0x00));
    expect(out[0]!.text).toBe('move g5 = g2');
  });

  it('decodes jump with a signed delta', () => {
    expect(disassemble(bytes(0x18, 0x04, 0x00))[0]!.text).toBe('jump 4');
    expect(disassemble(bytes(0x18, 0xfb, 0xff))[0]!.text).toBe('jump -5');
  });

  it('decodes the lights opcode operands (arg1[p8] arg2[8] arg3[8])', () => {
    expect(disassemble(bytes(0x70, 7, 0, 0))[0]!.text).toBe('lights arg1=7 arg2=0 arg3=0');
    // var-ref arg1 via 0xF0
    expect(disassemble(bytes(0xf0, 0x32, 0x00, 72, 1))[0]!.text).toBe('lights arg1=g50 arg2=72 arg3=1');
  });

  it('reads the actor of getInventoryCount at mode-index 1 (result is raw)', () => {
    // 0xB1 = var-ref actor; must read a word, not a byte → stays aligned.
    const out = disassemble(bytes(0xb1, 0x00, 0x00, 0x01, 0x40, 0x00));
    expect(out[0]!.text).toBe('getInventoryCount res=g0 actor=L1');
    expect(out[1]!.text).toBe('stopObjectCode');
  });

  it('decodes roomOps setPalColor (r,g,b + var-ref slot) without desyncing', () => {
    // Room 63's blackout loop: setPalColor (0,0,0) → L0, then increment L0.
    // setPalColor reads 3 words + a second subop byte + the slot (var-ref
    // here, 0x84). Reading fewer operands desynced the rest of the script.
    const out = disassemble(bytes(
      0x33, 0x04, 0, 0, 0, 0, 0, 0, 0x84, 0x00, 0x40, // setPalColor (0,0,0) slot=L0
      0x46, 0x00, 0x40, // increment L0
    ));
    expect(out[0]!.text).toBe('roomOps setPalColor (0,0,0) slot=L0');
    expect(out[1]!.text).toBe('increment L0');
    expect(out[1]!.aligned).toBe(true);
  });

  it('decodes roomOps roomIntensity (not setRoomScale)', () => {
    // 0x68: scale immediate (255), start/end var-ref (L0).
    const out = disassemble(bytes(0x33, 0x68, 255, 0x00, 0x40, 0x00, 0x40));
    expect(out[0]!.text).toBe('roomOps roomIntensity 255,L0,L0');
  });

  it('decodes startScript with the recursive flag and a word arg list', () => {
    // startScript(recursive) 12 [256]
    const out = disassemble(bytes(0x4a, 12, 0x01, 0x00, 0x01, 0xff));
    expect(out[0]!.text).toBe('startScript(recursive) 12 [256]');
  });

  it('decodes print text, rendering escape codes', () => {
    // print actor 252, subop 0x0F (SO_TEXTSTRING) text "Hi" then the
    // 0x00 NUL that ends a SCUMM print string. (0xFF/0xFE are escape-code
    // prefixes WITHIN a string, not the terminator — a print's text ends
    // at NUL and the opcode ends with it.)
    const out = disassemble(bytes(0x14, 0xfc, 0x0f, 0x48, 0x69, 0x00));
    expect(out[0]!.text).toBe('print a=252 text="Hi"');
  });

  it('stops print text at the NUL, not at an in-string escape, so the next opcode decodes', () => {
    // Two prints back-to-back (no NUL-vs-0xFF confusion): the second must
    // decode as its own opcode, not be swallowed into the first's text.
    const out = disassemble(
      bytes(0x14, 0xfe, 0x0f, 0x41, 0x00, 0x14, 0xfe, 0x0f, 0x42, 0x00),
    );
    expect(out[0]!.text).toBe('print a=254 text="A"');
    expect(out[1]!.text).toBe('print a=254 text="B"');
  });

  it('sizes resourceRoutines subops like the executing table (0x11 none, 0x13 one, 0x14 two)', () => {
    // Each pairs the subop with a trailing breakHere (0x80); the sweep must
    // land on it. 0x11 clearHeap takes NO arg, 0x13 nukeCharset takes one,
    // 0x14 loadFlObject takes two var-or-byte args, every other subop one.
    const clearHeap = disassemble(bytes(0x0c, 0x11, 0x80));
    expect(clearHeap[0]!.text).toBe('resourceRoutines clearHeap');
    expect(clearHeap[1]!.text).toBe('breakHere');

    const loadScript = disassemble(bytes(0x0c, 0x01, 0x05, 0x80));
    expect(loadScript[0]!.text).toBe('resourceRoutines sub=0x1 5');
    expect(loadScript[1]!.text).toBe('breakHere');

    const nukeCharset = disassemble(bytes(0x0c, 0x13, 0x03, 0x80));
    expect(nukeCharset[0]!.text).toBe('resourceRoutines sub=0x13 3');
    expect(nukeCharset[1]!.text).toBe('breakHere');

    const loadFlObject = disassemble(bytes(0x0c, 0x14, 0x07, 0x02, 0x80));
    expect(loadFlObject[0]!.text).toBe('resourceRoutines loadFlObject obj=7 room=2');
    expect(loadFlObject[1]!.text).toBe('breakHere');
  });

  it('reads stringOps loadString escape-aware — an escape arg byte of 0x00 is NOT the terminator', () => {
    // `loadString id=48 "in \xff\x07!\x00?"` then breakHere. The string
    // embeds a 0xFF 0x07 (string-var substitution) whose 2-byte argument's
    // second byte is 0x00; a raw scan-to-NUL would stop there and mis-decode
    // the rest. The escape-aware reader skips the arg (displayed raw), finds
    // the real NUL after '?', and the breakHere decodes cleanly. This is
    // exactly MI1 #154's copy-protection question string (whose mis-read
    // produced a phantom drawBox/putActor).
    const out = disassemble(
      bytes(0x27, 0x01, 0x30, 0x69, 0x6e, 0x20, 0xff, 0x07, 0x21, 0x00, 0x3f, 0x00, 0x80),
    );
    expect(out[0]!.text).toBe('stringOps loadString id=48 "in \\xff\\x07!\\x00?"');
    expect(out[1]!.text).toBe('breakHere');
  });
});

describe('disasm — stream walking', () => {
  it('decodes a multi-instruction stream with correct offsets', () => {
    const out = disassemble(bytes(
      0x1a, 0x07, 0x00, 0x01, 0x00, // move g7 = 1  (5 bytes)
      0x18, 0x00, 0x00,             // jump 0       (3 bytes, at offset 5)
      0x00,                         // stopObjectCode (offset 8)
    ));
    expect(out.map((i) => i.offset)).toEqual([0, 5, 8]);
    expect(out.map((i) => i.text)).toEqual(['move g7 = 1', 'jump 0', 'stopObjectCode']);
    expect(out.every((i) => i.aligned)).toBe(true);
  });

  it('flags an unknown opcode as unaligned and stops the sweep', () => {
    // 0x2F is unused in v5 (v3-4 ifNotState); the byte after must not
    // be reached once the sweep gives up.
    const out = disassemble(bytes(0x00, 0x2f, 0x1a));
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe('stopObjectCode');
    expect(out[1]!.aligned).toBe(false);
    expect(out[1]!.text).toContain('UNKNOWN');
  });

  it('never loops past the buffer on truncated/garbage operands', () => {
    // A verbOps whose sub-op list is never terminated must still return.
    expect(() => disassemble(bytes(0x7a, 0x64, 0x02, 0x41))).not.toThrow();
    // A lone startScript with a runaway arg list, no 0xFF terminator.
    expect(() => disassemble(bytes(0x0a, 0x01, 0x01, 0x00))).not.toThrow();
  });

  it('keeps alignment across an indexed var-ref (extra offset word)', () => {
    // isEqual var[g5] (indexed, +offset word 0) == 0 -> +0, then stop.
    // 0x48 [dest 0x2005][off 0x0000][val 0x0000][target 0x0000] 0x00
    const out = disassemble(bytes(
      0x48, 0x05, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00,
    ));
    expect(out[0]!.text).toContain('isEqual var=g5[0]');
    expect(out[1]!.text).toBe('stopObjectCode');
  });
});
