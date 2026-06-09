/**
 * SCUMM v5 variable bank — globals, bit-vars, room-vars, sized from MAXS
 * (locals live on each script slot). See pages/docs/scumm/opcodes.md for
 * the scope encoding.
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
   * Out-of-range accesses, grouped by (scope, index, kind). Shipped scripts
   * go past MAXS in dead branches (the original had no bounds checks), so
   * OOB is absorbed — but recorded for the inspector, never hidden.
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

  /** Copy of the packed bit buffer, for save-state serialization. */
  snapshotBits(): Uint8Array {
    return this.bitBuffer.slice();
  }

  /**
   * Overwrite the packed bit buffer from a snapshot; a shorter input leaves
   * the tail zeroed, a longer one is truncated.
   */
  restoreBits(bytes: Uint8Array): void {
    this.bitBuffer.fill(0);
    this.bitBuffer.set(bytes.subarray(0, this.bitBuffer.length));
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
