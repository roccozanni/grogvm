/**
 * SCUMM v5 linear disassembler.
 *
 * Decodes a script's bytecode into human-readable instructions, with
 * accurate operand lengths for every opcode (per
 * pages/docs/scumm/opcode-reference.md) so it stays in sync walking a
 * stream. This is a *static* decoder — it does not execute anything; it
 * is the read-only companion to the executing opcode table in
 * `opcodes/index.ts`.
 *
 * # Reentrancy
 *
 * Each {@link disassemble} call owns its own cursor (the decoder is a
 * throwaway instance), so it is safe to run over many scripts
 * concurrently and to call from the UI / a worker.
 *
 * # Alignment
 *
 * Linear sweep can lose sync on data the table doesn't model (rare
 * opcodes, embedded blobs). When the decoder meets a byte it can't
 * decode it emits an instruction with `aligned: false` and stops —
 * misalignment is surfaced loudly rather than silently producing
 * garbage. Callers should treat a run that ends with `aligned: false`
 * as "decoded up to here, then gave up".
 *
 * Known gaps (documented, not yet fixed): a handful of non-orthogonal
 * families are decoded by the most common variant and may mis-slice an
 * unusual mode — when a SCAN-style sweep flags something surprising,
 * confirm against the executing engine before trusting it.
 */

/** One decoded instruction. */
export interface DisasmInstruction {
  /** Byte offset of the opcode within the script. */
  readonly offset: number;
  /** The opcode byte (with param-mode bits). */
  readonly opcode: number;
  /** Decoded mnemonic + operands, e.g. `move g7 = 100`. */
  readonly text: string;
  /**
   * False when the decoder could not decode this byte (unknown opcode
   * or sub-op) — the sweep stops after the first such instruction.
   */
  readonly aligned: boolean;
}

/**
 * Decode a var-reference word the way the runtime does (see
 * `params.ts`): `0x8000` → bit-var, `0x4000` → local, `0x2000` →
 * indexed (carries an extra offset word, consumed via `next`), else
 * global. `next` supplies the indexed offset word when needed.
 */
export function formatVarRef(word: number, next?: () => number): string {
  let suffix = '';
  if (word & 0x2000 && next) {
    const off = next();
    suffix = off & 0x2000 ? `[${formatVarRef(off & ~0x2000, next)}]` : `[${off & 0x1fff}]`;
    word &= ~0x2000;
  }
  if (word & 0x8000) return `bit#${word & 0x7fff}${suffix}`;
  if (word & 0x4000) return `L${word & 0x0fff}${suffix}`;
  return `g${word & 0x1fff}${suffix}`;
}

/** Disassemble a whole script into a list of instructions. */
export function disassemble(bytecode: Uint8Array): DisasmInstruction[] {
  return new Decoder(bytecode).run();
}

class Decoder {
  private p = 0;
  constructor(private readonly b: Uint8Array) {}

  run(): DisasmInstruction[] {
    const out: DisasmInstruction[] = [];
    while (this.p < this.b.length) {
      const offset = this.p;
      const opcode = this.u8();
      let text: string;
      try {
        text = this.decode(opcode);
      } catch (e) {
        text = `<<error: ${e instanceof Error ? e.message : String(e)}>>`;
      }
      const aligned = !text.includes('<<');
      out.push({ offset, opcode, text, aligned });
      if (!aligned) break;
    }
    return out;
  }

  // ── cursor primitives ───────────────────────────────────────────
  private u8(): number {
    return this.b[this.p++]!;
  }
  private u16(): number {
    const v = this.b[this.p]! | (this.b[this.p + 1]! << 8);
    this.p += 2;
    return v;
  }
  private s16(): number {
    return (this.u16() << 16) >> 16;
  }
  private vref(): string {
    return formatVarRef(this.u16(), () => this.u16());
  }
  /**
   * Match an opcode against a base + its param-mode variants. SCUMM
   * encodes each value param's mode (immediate vs var-ref) in a high
   * bit of the opcode byte — bit 0x80 for param 1, 0x40 for 2, 0x20 for
   * 3 — so an opcode with `n` value params occupies 2^n byte values.
   * `is(op, base, n)` returns true for any of them. For non-orthogonal
   * families (where a high bit is an opcode *selector*, not a param
   * mode) the selector bit sits outside this mask, so distinct bases
   * stay distinguishable.
   */
  private is(op: number, base: number, paramCount: number): boolean {
    const mask = [0, 0x80, 0xc0, 0xe0][paramCount]!;
    return (op & ~mask) === base;
  }

  // NB on param indices: a raw `result`/`var` operand (read via vref())
  // does NOT consume a param-mode slot. So the first *value* operand
  // after a result is mode-index 1 (bit 0x80), the second is index 2
  // (0x40) — e.g. `getInventoryCount result actor[p8]` reads the actor
  // at index 1, matching the executing handlers in opcodes/index.ts.

  /** p8 value: word var-ref when the param bit is set, else a byte. */
  private p8(op: number, idx: number): string {
    return op & (0x80 >> (idx - 1)) ? this.vref() : `${this.u8()}`;
  }
  /** p16 value: word var-ref when the param bit is set, else a word. */
  private p16(op: number, idx: number): string {
    return op & (0x80 >> (idx - 1)) ? this.vref() : `${this.u16()}`;
  }
  /** Variable-length word list: `aux[8] param[p16]` pairs until 0xFF. */
  private v16(): string {
    const out: string[] = [];
    while (this.p < this.b.length && this.b[this.p] !== 0xff) {
      const aux = this.u8();
      out.push(aux & 0x80 ? this.vref() : `${this.u16()}`);
    }
    this.p++; // 0xFF terminator
    return `[${out.join(',')}]`;
  }
  /**
   * Message string up to `term`, rendering SCUMM escape codes as \xNN.
   * Mirrors the engine's `readScummString` length rule (opcodes/index.ts):
   * a `0xFF`/`0xFE` escape with code ≥ 4 carries a 2-byte argument (var /
   * string / object / verb id), codes 1–3 do not. (The old `code <= 9`
   * bound under-read by 2 on the colour/name codes 0x0A/0x0E.) Used for
   * the *display* strings (print, object/actor/verb names) that the engine
   * expands at print time.
   */
  private cstr(term: number): string {
    const bytes: number[] = [];
    while (this.p < this.b.length && this.b[this.p] !== term) {
      const c = this.u8();
      if (c === 0xff || c === 0xfe) {
        const code = this.u8();
        bytes.push(c, code);
        if (code >= 4) {
          this.u8();
          this.u8();
        }
      } else bytes.push(c);
    }
    if (this.p < this.b.length) this.p++; // terminator
    return this.render(bytes);
  }

  /**
   * Raw string up to `term`, with NO escape-code expansion — mirrors the
   * engine's `stringOps`/`roomOps` load/save readers, which copy bytes
   * verbatim to the NUL terminator (a stored string's escapes are expanded
   * only later, at print time, by {@link cstr}). Decoding these with the
   * escape-aware reader over-reads: code 0x07 in MI1 #154's `loadString`
   * swallowed the '?' and the NUL terminator as a phantom 2-byte argument.
   */
  private rawstr(term: number): string {
    const bytes: number[] = [];
    while (this.p < this.b.length && this.b[this.p] !== term) bytes.push(this.u8());
    if (this.p < this.b.length) this.p++; // terminator
    return this.render(bytes);
  }

  /** Render decoded bytes: printable ASCII verbatim, else `\xNN`. */
  private render(bytes: number[]): string {
    return bytes
      .map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : `\\x${x.toString(16).padStart(2, '0')}`))
      .join('');
  }

  // ── main dispatch ────────────────────────────────────────────────
  private decode(op: number): string {
    // Full-byte specials (no param-mode variants).
    if (op === 0x80) return 'breakHere';
    if (op === 0x00 || op === 0xa0) return 'stopObjectCode';
    if (op === 0x20) return 'stopMusic';
    if (op === 0xa7) return 'dummy';
    if (op === 0x40) return `cutScene ${this.v16()}`;
    if (op === 0xc0) return 'endCutScene';
    if (op === 0x46) return `increment ${this.vref()}`;
    if (op === 0xc6) return `decrement ${this.vref()}`;
    if (op === 0xae) {
      const s = this.u8();
      const lo = s & 0x1f;
      if (lo === 1) return `wait forActor ${this.p8(s, 1)}`;
      if (lo === 2) return 'wait forMessage';
      if (lo === 3) return 'wait forCamera';
      if (lo === 4) return 'wait forSentence';
      return `<<wait sub 0x${s.toString(16)}>>`;
    }
    if (op === 0x2e) {
      const lo24 = this.u8() | (this.u8() << 8) | (this.u8() << 16);
      return `delay ${lo24}`;
    }
    if (op === 0x2b) return `delayVariable ${this.vref()}`;
    if (op === 0x58) {
      const sub = this.u8();
      if (sub === 0) return 'override END';
      this.u8(); // 0x18 jumpRelative marker
      return `override BEGIN (then jump ${this.s16()})`;
    }
    if (op === 0xac) {
      let outp = `expression res=${this.vref()}`;
      while (this.p < this.b.length) {
        const s = this.u8();
        if (s === 0xff) break;
        const lo = s & 0x1f;
        if (lo === 1) outp += ` push(${this.p16(s, 1)})`;
        else if (lo === 6) outp += ` [${this.decode(this.u8())}]`;
        else outp += ` op${lo}`;
      }
      return outp;
    }

    // Branches / arithmetic (paired base + 0x80 var-source variant).
    const cmp = this.compare(op);
    if (cmp) return cmp;

    // Scripts / flow.
    if (op === 0x60 || op === 0xe0) return `freezeScripts ${this.p8(op, 1)}`;
    if (op === 0x62 || op === 0xe2) return `stopScript ${this.p8(op, 1)}`;
    if (op === 0x6e || op === 0xee) return `stopObjectScript ${this.p16(op, 1)}`;
    if (op === 0x68 || op === 0xe8) return `getScriptRunning res=${this.vref()} script=${this.p8(op, 1)}`;
    if ((op & 0x1f) === 0x0a) {
      const flags = `${op & 0x40 ? '(recursive)' : ''}${op & 0x20 ? '(freezeResist)' : ''}`;
      return `startScript${flags} ${this.p8(op, 1)} ${this.v16()}`;
    }
    if (op === 0x42 || op === 0xc2) return `chainScript ${this.p8(op, 1)} ${this.v16()}`;
    if (op === 0x18) return `jump ${this.s16()}`;

    // Objects.
    if (op === 0x29 || op === 0x69 || op === 0xa9 || op === 0xe9)
      return `setOwnerOf obj=${this.p16(op, 1)} owner=${this.p8(op, 2)}`;
    if (op === 0x25 || op === 0x65 || op === 0xa5 || op === 0xe5)
      return `pickupObject obj=${this.p16(op, 1)} room=${this.p8(op, 2)}`;
    if (op === 0x54 || op === 0xd4) return `setObjectName obj=${this.p16(op, 1)} name="${this.cstr(0)}"`;
    if (op === 0x5d || op === 0xdd) return `actorSetClass obj=${this.p16(op, 1)} classes=${this.v16()}`;
    if (op === 0x07 || op === 0x47 || op === 0x87 || op === 0xc7)
      return `setState obj=${this.p16(op, 1)} state=${this.p8(op, 2)}`;
    if (op === 0x0f || op === 0x8f) return `getObjectState res=${this.vref()} obj=${this.p16(op, 1)}`;
    if (op === 0x10 || op === 0x90) return `getObjectOwner res=${this.vref()} obj=${this.p16(op, 1)}`;
    if (op === 0x34 || op === 0x74 || op === 0xb4 || op === 0xf4)
      return `getDist res=${this.vref()} objA=${this.p16(op, 1)} objB=${this.p16(op, 2)}`;
    if (op === 0x31 || op === 0xb1) return `getInventoryCount res=${this.vref()} actor=${this.p8(op, 1)}`;
    if (op === 0x3d || op === 0x7d || op === 0xbd || op === 0xfd)
      return `findInventory res=${this.vref()} owner=${this.p8(op, 1)} index=${this.p8(op, 2)}`;
    if (op === 0x1d || op === 0x9d) {
      const val = this.p16(op, 1);
      const classes = this.v16();
      return `ifClassOfIs val=${val} classes=${classes} -> ${this.s16()}`;
    }
    if (this.is(op, 0x0b, 2))
      return `getVerbEntryPoint res=${this.vref()} obj=${this.p16(op, 1)} verb=${this.p16(op, 2)}`;
    if (op === 0x66 || op === 0xe6) return `getClosestObjActor res=${this.vref()} a=${this.p16(op, 1)}`;
    // startObject (0x37/0x77/0xB7/0xF7) — shares low5 0x17 with and/or;
    // bit 0x20 selects startObject.
    if (op === 0x37 || op === 0x77 || op === 0xb7 || op === 0xf7)
      return `startObject obj=${this.p16(op, 1)} script=${this.p8(op, 2)} ${this.v16()}`;
    if (op === 0x17 || op === 0x97) return `and ${this.vref()} val=${this.p16(op, 1)}`;
    if (op === 0x57 || op === 0xd7) return `or ${this.vref()} val=${this.p16(op, 1)}`;

    // Camera / room.
    if (op === 0x72 || op === 0xf2) return `loadRoom room=${this.p8(op, 1)}`;
    if (op === 0x24 || op === 0x64 || op === 0xa4 || op === 0xe4)
      return `loadRoomWithEgo obj=${this.p16(op, 1)} room=${this.p8(op, 2)} x=${this.s16()} y=${this.s16()}`;
    if (op === 0x52 || op === 0xd2) return `actorFollowCamera a=${this.p8(op, 1)}`;
    if (op === 0x12 || op === 0x92) return `panCameraTo x=${this.p16(op, 1)}`;
    if (op === 0x32 || op === 0xb2) return `setCameraAt x=${this.p16(op, 1)}`;
    if (op === 0x33 || op === 0x73 || op === 0xb3 || op === 0xf3) return `roomOps ${this.roomOpsSub()}`;
    if (op === 0x70 || op === 0xf0)
      return `lights arg1=${this.p8(op, 1)} arg2=${this.u8()} arg3=${this.u8()}`;
    if (op === 0xcc) {
      const val = this.u8();
      const list: number[] = [];
      while (this.p < this.b.length) {
        const r = this.u8();
        if (r === 0) break;
        list.push(r);
      }
      return `pseudoRoom val=${val} [${list}]`;
    }

    // Verbs / cursor / text.
    if (op === 0x7a || op === 0xfa) return `verbOps verb=${this.p8(op, 1)} ${this.verbSubs()}`;
    if (op === 0x2c) return `cursorCommand ${this.cursorSub()}`;
    if (op === 0x14 || op === 0x94) return `print a=${this.p8(op, 1)} ${this.printSubs()}`;
    if (op === 0xd8) return `printEgo ${this.printSubs()}`;
    if (op === 0x67 || op === 0xe7) return `getStringWidth res=${this.vref()} str=${this.p8(op, 1)}`;
    if (op === 0x27) return `stringOps ${this.stringSub()}`;
    if (op === 0xab) {
      const sub = this.u8();
      return `saveRestoreVerbs sub=${sub} ${this.p8(sub, 1)} ${this.p8(sub, 2)} ${this.p8(sub, 3)}`;
    }

    // Sound / system / misc.
    if (op === 0x02 || op === 0x82) return `startMusic ${this.p8(op, 1)}`;
    if (op === 0x1c || op === 0x9c) return `startSound ${this.p8(op, 1)}`;
    if (op === 0x3c || op === 0xbc) return `stopSound ${this.p8(op, 1)}`;
    if (op === 0x7c || op === 0xfc) return `isSoundRunning res=${this.vref()} sound=${this.p8(op, 1)}`;
    if (op === 0x4c) return `soundKludge ${this.v16()}`;
    if (op === 0x0c) return `resourceRoutines ${this.resourceSub()}`;
    if (op === 0x98) return `systemOps ${this.u8()}`;
    if (op === 0x30 || op === 0xb0) return `matrixOp ${this.matrixSub()}`;
    if (op === 0x6b || op === 0xeb) return `debug ${this.p16(op, 1)}`;
    if (op === 0x3f || op === 0x7f || op === 0xbf || op === 0xff) {
      const l = this.u16();
      const t = this.u16();
      const ax = this.u8();
      const r = this.u16();
      const bo = this.u16();
      return `drawBox ${l},${t},${r},${bo} color=${this.p8(ax, 1)}`;
    }
    if (op === 0x16 || op === 0x96) return `getRandomNumber res=${this.vref()} seed=${this.p8(op, 1)}`;
    if (op === 0x26 || op === 0xa6) {
      const r = this.vref();
      const n = this.u8();
      const vals: number[] = [];
      const wide = (op & 0x80) !== 0;
      for (let i = 0; i < n; i++) vals.push(wide ? this.u16() : this.u8());
      return `setVarRange ${r} n=${n} [${vals}]`;
    }
    if (op === 0x1a || op === 0x9a) return `move ${this.vref()} = ${this.p16(op, 1)}`;

    // Actor get-family + actor verbs.
    const actor = this.actorOp(op);
    if (actor) return actor;

    return `<<UNKNOWN 0x${op.toString(16)}>>`;
  }

  /** Comparison + arithmetic family (`unless (value OP var) goto`). */
  private compare(op: number): string | null {
    switch (op) {
      case 0x28: case 0xa8:
        return `${op === 0xa8 ? 'notEqualZero' : 'equalZero'} ${this.vref()} -> ${this.s16()}`;
      case 0x48: case 0xc8: return `isEqual var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x08: case 0x88: return `isNotEqual var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x44: case 0xc4: return `isLess var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x78: case 0xf8: return `isGreater var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x38: case 0xb8: return `lessOrEqual var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x04: case 0x84: return `isGE var=${this.vref()} val=${this.p16(op, 1)} -> ${this.s16()}`;
      case 0x5a: case 0xda: return `add ${this.vref()} val=${this.p16(op, 1)}`;
      case 0x3a: case 0xba: return `subtract ${this.vref()} val=${this.p16(op, 1)}`;
      case 0x1b: case 0x9b: return `multiply ${this.vref()} val=${this.p16(op, 1)}`;
      case 0x5b: case 0xdb: return `divide ${this.vref()} val=${this.p16(op, 1)}`;
      default: return null;
    }
  }

  /** Actor opcodes: doSentence, the get-* family, and movement/anim. */
  private actorOp(op: number): string | null {
    if (this.is(op, 0x19, 3)) {
      const verb = this.p8(op, 1);
      if (verb === '254') return 'doSentence STOP';
      return `doSentence verb=${verb} objA=${this.p16(op, 2)} objB=${this.p16(op, 3)}`;
    }
    if (this.is(op, 0x01, 3))
      return `putActor a=${this.p8(op, 1)} x=${this.p16(op, 2)} y=${this.p16(op, 3)}`;
    if (op === 0x2d || op === 0x6d || op === 0xad || op === 0xed)
      return `putActorInRoom a=${this.p8(op, 1)} room=${this.p8(op, 2)}`;
    if (op === 0x0d || op === 0x4d || op === 0x8d || op === 0xcd)
      return `walkActorToActor w=${this.p8(op, 1)} we=${this.p8(op, 2)} dist=${this.u8()}`;
    if (op === 0x0e || op === 0x4e || op === 0x8e || op === 0xce)
      return `putActorAtObject a=${this.p8(op, 1)} obj=${this.p16(op, 2)}`;
    if (this.is(op, 0x1e, 3))
      return `walkActorTo a=${this.p8(op, 1)} x=${this.p16(op, 2)} y=${this.p16(op, 3)}`;
    if (op === 0x36 || op === 0x76 || op === 0xb6 || op === 0xf6)
      return `walkActorToObject a=${this.p8(op, 1)} obj=${this.p16(op, 2)}`;
    if (op === 0x11 || op === 0x51 || op === 0x91 || op === 0xd1)
      return `animateActor a=${this.p8(op, 1)} anim=${this.p8(op, 2)}`;
    if (op === 0x09 || op === 0x49 || op === 0x89 || op === 0xc9)
      return `faceActor a=${this.p8(op, 1)} obj=${this.p16(op, 2)}`;
    if (op === 0x13 || op === 0x53 || op === 0x93 || op === 0xd3) {
      const a = this.p8(op, 1);
      const subs: string[] = [];
      while (this.p < this.b.length) {
        const s = this.u8();
        if (s === 0xff) break;
        subs.push(this.actorOpSub(s));
        if (subs[subs.length - 1]!.includes('<<')) break;
      }
      return `actorOps a=${a} {${subs.join('; ')}}`;
    }
    if (this.is(op, 0x15, 2)) return `actorFromPos res=${this.vref()} x=${this.p16(op, 1)} y=${this.p16(op, 2)}`;
    if (op === 0x35 || op === 0x75 || op === 0xb5 || op === 0xf5)
      return `findObject res=${this.vref()} x=${this.p8(op, 1)} y=${this.p8(op, 2)}`;
    if (op === 0x1f || op === 0x5f || op === 0x9f || op === 0xdf)
      return `isActorInBox a=${this.p8(op, 1)} box=${this.p8(op, 2)} -> ${this.s16()}`;
    if (op === 0x56 || op === 0xd6) return `getActorMoving res=${this.vref()} a=${this.p8(op, 1)}`;
    if (op === 0x05 || op === 0x85) {
      const o = this.p16(op, 1);
      const sub = this.u8();
      // One subop byte: low 5 bits = action, high bits = param var-modes.
      if ((sub & 0x1f) === 1) return `drawObject ${o} at x=${this.p16(sub, 1)} y=${this.p16(sub, 2)}`;
      if ((sub & 0x1f) === 2) return `drawObject ${o} state=${this.p16(sub, 1)}`;
      return `drawObject ${o} draw`;
    }
    // getActor* (result, actor[p8] — except X/Y which use p16).
    const names: Record<number, string> = {
      0x03: 'getActorRoom', 0x23: 'getActorY', 0x43: 'getActorX', 0x63: 'getActorFacing',
      0x06: 'getActorElevation', 0x3b: 'getActorScale', 0x6c: 'getActorWidth',
      0x7b: 'getActorWalkBox', 0x71: 'getActorCostume', 0x22: 'getAnimCounter',
    };
    const base = op & 0x7f;
    if (names[base]) {
      // `result actor` — result is raw, so the actor is mode-index 1.
      const res = this.vref();
      const wordActor = base === 0x43 || base === 0x23;
      const a = wordActor ? this.p16(op, 1) : this.p8(op, 1);
      return `${names[base]} res=${res} a=${a}`;
    }
    return null;
  }

  private actorOpSub(s: number): string {
    switch (s & 0x1f) {
      case 0x01: return `costume=${this.p8(s, 1)}`;
      case 0x02: return `stepDist ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x03: return `sound=${this.p8(s, 1)}`;
      case 0x04: return `walkFrame=${this.p8(s, 1)}`;
      case 0x05: return `talkFrames ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x06: return `standFrame=${this.p8(s, 1)}`;
      case 0x08: return 'init';
      case 0x09: return `elevation=${this.p16(s, 1)}`;
      case 0x0a: return 'animDefault';
      case 0x0b: return `palette ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x0c: return `talkColor=${this.p8(s, 1)}`;
      case 0x0d: return `name="${this.cstr(0)}"`;
      case 0x0e: return `initFrame=${this.p8(s, 1)}`;
      case 0x10: return `width=${this.p8(s, 1)}`;
      case 0x11: return `scale ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x12: return 'neverZclip';
      case 0x13: return `alwaysZclip=${this.p8(s, 1)}`;
      case 0x14: return 'ignoreBoxes';
      case 0x15: return 'followBoxes';
      case 0x16: return `animSpeed=${this.p8(s, 1)}`;
      case 0x17: return `shadow=${this.p8(s, 1)}`;
      case 0x18: return `talkPos ${this.p16(s, 1)},${this.p16(s, 2)}`;
      default: return `<<actorSub 0x${s.toString(16)}>>`;
    }
  }

  private printSubs(): string {
    const out: string[] = [];
    while (this.p < this.b.length) {
      const s = this.u8();
      if (s === 0xff) break;
      switch (s & 0x1f) {
        case 0x00: out.push(`at ${this.p16(s, 1)},${this.p16(s, 2)}`); break;
        case 0x01: out.push(`color=${this.p8(s, 1)}`); break;
        case 0x02: out.push(`right=${this.p16(s, 1)}`); break;
        case 0x03: out.push(`erase ${this.p16(s, 1)},${this.p16(s, 2)}`); break;
        case 0x04: out.push('center'); break;
        case 0x06: out.push('left'); break;
        case 0x07: out.push('overhead'); break;
        case 0x08: out.push('PlayCDtrack'); break;
        // SO_TEXTSTRING ends the print and is NUL-terminated; 0xFF/0xFE
        // are escape-code prefixes WITHIN the string (cstr handles them),
        // not the terminator. Stopping at 0xFF over-reads past the string
        // into the following opcodes (it hid script 200's startSound +
        // isSoundRunning wait loop behind the "Parte Uno" text).
        case 0x0f: out.push(`text="${this.cstr(0)}"`); return out.join(' ');
        default: out.push(`<<printSub 0x${s.toString(16)}>>`); return out.join(' ');
      }
    }
    return out.join(' ');
  }

  private roomOpsSub(): string {
    const s = this.u8();
    switch (s & 0x1f) {
      case 0x01: return `scroll ${this.p16(s, 1)},${this.p16(s, 2)}`;
      case 0x02: return 'colorScale';
      case 0x03: return `screen ${this.p16(s, 1)},${this.p16(s, 2)}`;
      // setPalColor: r,g,b (3 words) then a SECOND subop byte carrying the
      // index's param mode, then the index (var-ref when its bit 0x80 is set,
      // else a byte). Reading only two operands here is what desynced room
      // 63's blackout loop (`setPalColor (0,0,0) → var`).
      case 0x04: {
        const r = this.p16(s, 1), g = this.p16(s, 2), b = this.p16(s, 3);
        const s2 = this.u8();
        return `setPalColor (${r},${g},${b}) slot=${this.p8(s2, 1)}`;
      }
      case 0x05: return 'shakeOn';
      case 0x06: return 'shakeOff';
      case 0x08: return `roomIntensity ${this.p8(s, 1)},${this.p8(s, 2)},${this.p8(s, 3)}`;
      case 0x09: return `saveLoad ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x0a: return `fade effect=${this.p16(s, 1)}`;
      case 0x0b: {
        const r = this.p16(s, 1), g = this.p16(s, 2), b = this.p16(s, 3);
        const s2 = this.u8();
        return `setRGBRoomIntensity (${r},${g},${b}) ${this.p8(s2, 1)}..${this.p8(s2, 2)}`;
      }
      case 0x0c: return 'shadowPalette';
      case 0x0d: return `saveString ${this.p8(s, 1)} "${this.rawstr(0)}"`;
      case 0x0e: return `loadString ${this.p8(s, 1)} "${this.rawstr(0)}"`;
      case 0x10: return `cycleSpeed ${this.u8()},${this.u8()}`;
      default: return `<<roomOps sub 0x${s.toString(16)}>>`;
    }
  }

  private verbSubs(): string {
    const out: string[] = [];
    while (this.p < this.b.length) {
      const s = this.u8();
      if (s === 0xff) break;
      switch (s & 0x1f) {
        case 0x01: out.push(`image obj=${this.p16(s, 1)}`); break;
        case 0x02: out.push(`name="${this.cstr(0)}"`); break;
        case 0x03: out.push(`color=${this.p8(s, 1)}`); break;
        case 0x04: out.push(`hicolor=${this.p8(s, 1)}`); break;
        case 0x05: out.push(`at ${this.p16(s, 1)},${this.p16(s, 2)}`); break;
        case 0x06: out.push('on'); break;
        case 0x07: out.push('off'); break;
        case 0x08: out.push('delete'); break;
        case 0x09: out.push('new'); break;
        case 0x10: out.push(`dimcolor=${this.p8(s, 1)}`); break;
        case 0x11: out.push('dim'); break;
        case 0x12: out.push(`key=${this.p8(s, 1)}`); break;
        case 0x13: out.push('center'); break;
        case 0x14: out.push(`nameStr=${this.p16(s, 1)}`); break;
        case 0x16: out.push(`assignObj obj=${this.p16(s, 1)} room=${this.p8(s, 2)}`); break;
        case 0x17: out.push(`backColor=${this.p8(s, 1)}`); break;
        default: out.push(`<<verbSub 0x${s.toString(16)}>>`); return out.join(' ');
      }
    }
    return out.join(' ');
  }

  private cursorSub(): string {
    const s = this.u8();
    switch (s & 0x1f) {
      case 0x01: return 'cursorOn';
      case 0x02: return 'cursorOff';
      case 0x03: return 'userputOn';
      case 0x04: return 'userputOff';
      case 0x05: return 'cursorSoftOn';
      case 0x06: return 'cursorSoftOff';
      case 0x07: return 'userputSoftOn';
      case 0x08: return 'userputSoftOff';
      case 0x0a: return `cursorImage ${this.p8(s, 1)},${this.p8(s, 2)}`;
      case 0x0b: return `hotspot ${this.p8(s, 1)},${this.p8(s, 2)},${this.p8(s, 3)}`;
      case 0x0c: return `setCursor=${this.p8(s, 1)}`;
      case 0x0d: return `charsetSet=${this.p8(s, 1)}`;
      case 0x0e: {
        const out: string[] = [];
        while (this.p < this.b.length && this.b[this.p] !== 0xff) {
          const aux = this.u8();
          out.push(aux & 0x80 ? this.vref() : `${this.u16()}`);
        }
        this.p++;
        return `charsetColors [${out}]`;
      }
      default: return `<<cursorSub 0x${s.toString(16)}>>`;
    }
  }

  private resourceSub(): string {
    const s = this.u8();
    const lo = s & 0x1f;
    // Mirror the executing handler (opcodes/index.ts 0x0C): subop 0x11
    // (clearHeap) takes NO arg, 0x14 (loadFlObject) takes TWO var-or-byte
    // args, every other subop takes exactly ONE. The old `lo <= 0x12` rule
    // wrongly gave 0x11 an arg (over-read by 1) and denied 0x13 (nukeCharset)
    // one (under-read by 1), and read 0x14's object as a word.
    if (lo === 0x11) return 'clearHeap';
    if (lo === 0x14) return `loadFlObject obj=${this.p8(s, 1)} room=${this.p8(s, 2)}`;
    return `sub=0x${lo.toString(16)} ${this.p8(s, 1)}`;
  }

  private matrixSub(): string {
    const s = this.u8();
    const lo = s & 0x1f;
    if (lo === 1) return `setBoxFlags ${this.p8(s, 1)},${this.p8(s, 2)}`;
    if (lo === 2 || lo === 3) return `setBoxScale ${this.p8(s, 1)},${this.p8(s, 2)}`;
    if (lo === 4) return 'createBoxMatrix';
    return `<<matrix 0x${s.toString(16)}>>`;
  }

  private stringSub(): string {
    const s = this.u8();
    const lo = s & 0x1f;
    if (lo === 1) return `loadString id=${this.p8(s, 1)} "${this.cstr(0)}"`;
    if (lo === 2) return `copyString ${this.p8(s, 1)},${this.p8(s, 2)}`;
    if (lo === 3) return `writeChar ${this.p8(s, 1)},${this.p8(s, 2)},${this.p8(s, 3)}`;
    if (lo === 4) return `readChar res=${this.vref()} ${this.p8(s, 1)},${this.p8(s, 2)}`;
    if (lo === 5) return `newString ${this.p8(s, 1)},${this.p8(s, 2)}`;
    return `<<stringSub 0x${s.toString(16)}>>`;
  }
}
