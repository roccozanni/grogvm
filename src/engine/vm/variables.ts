/**
 * SCUMM v5 variable bank — globals, bit-vars, room-vars.
 *
 * Locals live on each script slot (see `slot.ts`), not here, because
 * they're owned by the running script's invocation context.
 *
 * # Scope summary
 *
 * SCUMM v5 has four variable scopes, encoded by the top bits of the
 * 16-bit reference word that the bytecode carries:
 *
 *   - **globals** — the big shared int bank (800 entries on MI1).
 *     Used for game state, system flags, current room id, scores,
 *     timers, …
 *   - **bit-vars** — packed booleans (2048 bits on MI1). Used for
 *     "have I seen this cutscene?", per-object flags, etc.
 *   - **room-vars** — small int bank scoped to the currently loaded
 *     room (16 entries on MI1). Hardly used by MI1 scripts in
 *     practice but cheap to model.
 *   - **locals** — per-script-invocation, 25 entries on v5. Stored on
 *     the slot, not here.
 *
 * # Sizing
 *
 * Sizes come from `MAXS` at load time and are passed in to the
 * constructor. We use `Int32Array` so we can hold the full signed
 * range without surprises (variables can hold negative values; the
 * VM does signed arithmetic).
 */

export class VariableError extends Error {
  constructor(detail: string) {
    super(`Variable error: ${detail}`);
    this.name = 'VariableError';
  }
}

/** Out-of-range diagnostic: which scope, which index, how often. */
export interface OobAccess {
  readonly scope: 'global' | 'bit' | 'room';
  readonly index: number;
  readonly kind: 'read' | 'write';
  count: number;
}

export class Variables {
  readonly globals: Int32Array;
  readonly roomVars: Int32Array;
  private readonly bitBuffer: Uint8Array;
  readonly numBits: number;
  /**
   * Out-of-range accesses, grouped by (scope, index, kind). The original
   * SCUMM engine had no bounds checks — shipped scripts frequently
   * touch indices past MAXS in dead-code branches that real play
   * never reaches (script #12 in MI1 is an example). We silently
   * absorb these so the boot can progress, but keep a record so the
   * inspector can surface them — never silently hide.
   */
  readonly oobAccesses = new Map<string, OobAccess>();

  constructor(opts: {
    readonly numVariables: number;
    readonly numBitVariables: number;
    readonly numRoomVariables?: number;
  }) {
    this.globals = new Int32Array(opts.numVariables);
    this.roomVars = new Int32Array(opts.numRoomVariables ?? 16);
    this.numBits = opts.numBitVariables;
    this.bitBuffer = new Uint8Array((opts.numBitVariables + 7) >>> 3);
  }

  private recordOob(scope: 'global' | 'bit' | 'room', index: number, kind: 'read' | 'write'): void {
    const key = `${scope}:${kind}:${index}`;
    const existing = this.oobAccesses.get(key);
    if (existing) existing.count++;
    else this.oobAccesses.set(key, { scope, index, kind, count: 1 });
  }

  readGlobal(index: number): number {
    if (index < 0 || index >= this.globals.length) {
      this.recordOob('global', index, 'read');
      return 0;
    }
    return this.globals[index]!;
  }

  writeGlobal(index: number, value: number): void {
    if (index < 0 || index >= this.globals.length) {
      this.recordOob('global', index, 'write');
      return;
    }
    this.globals[index] = value | 0;
  }

  readBit(index: number): 0 | 1 {
    if (index < 0 || index >= this.numBits) {
      this.recordOob('bit', index, 'read');
      return 0;
    }
    return ((this.bitBuffer[index >>> 3]! >>> (index & 7)) & 1) as 0 | 1;
  }

  writeBit(index: number, value: boolean | 0 | 1): void {
    if (index < 0 || index >= this.numBits) {
      this.recordOob('bit', index, 'write');
      return;
    }
    const byte = index >>> 3;
    const mask = 1 << (index & 7);
    if (value) this.bitBuffer[byte] = this.bitBuffer[byte]! | mask;
    else this.bitBuffer[byte] = this.bitBuffer[byte]! & ~mask;
  }

  readRoom(index: number): number {
    if (index < 0 || index >= this.roomVars.length) {
      this.recordOob('room', index, 'read');
      return 0;
    }
    return this.roomVars[index]!;
  }

  writeRoom(index: number, value: number): void {
    if (index < 0 || index >= this.roomVars.length) {
      this.recordOob('room', index, 'write');
      return;
    }
    this.roomVars[index] = value | 0;
  }
}
