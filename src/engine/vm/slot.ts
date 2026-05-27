/**
 * One SCUMM v5 script slot. The VM keeps an array of these and rotates
 * through them on each tick; only the slots that are `running` get
 * dispatched.
 *
 * # Lifecycle
 *
 *   dead ─start─▶ running ─yield─▶ yielded ─resume─▶ running
 *                  │  │                                 │
 *                  │  └──────── kill ──────────▶ dead   │
 *                  │                                    │
 *                  └────── freeze ─▶ frozen ◀─resume────┘
 *
 * - `dead` is the only state from which `start()` is legal. Reusing a
 *   non-dead slot would silently lose the previous script's locals,
 *   so we throw — the VM's slot allocator is responsible for picking
 *   a dead slot.
 * - `yielded` is the post-`breakHere` rest state. The VM flips every
 *   yielded slot back to `running` at the top of the next tick.
 * - `frozen` is for `freezeScripts` and is *not* automatically
 *   resumed each tick — only explicit `unfreezeScripts` does that.
 */

export type ScriptSlotStatus = 'dead' | 'running' | 'yielded' | 'frozen';

export class ScriptSlotError extends Error {
  constructor(public readonly slotIndex: number, detail: string) {
    super(`Slot ${slotIndex}: ${detail}`);
    this.name = 'ScriptSlotError';
  }
}

export class ScriptSlot {
  /** Slot's fixed array index — same value across its lifetime. */
  readonly slotIndex: number;
  status: ScriptSlotStatus = 'dead';

  /** Global script id (or 0 if dead). */
  scriptId: number = 0;
  /** Bytecode being executed (empty Uint8Array if dead). */
  bytecode: Uint8Array = EMPTY;
  /** Program counter — byte offset into `bytecode`. */
  pc: number = 0;
  /** Owning room id (or 0 if not tied to a room). */
  room: number = 0;
  /** 25 local int vars, zeroed on `start`. */
  readonly locals: Int32Array = new Int32Array(25);

  constructor(slotIndex: number) {
    this.slotIndex = slotIndex;
  }

  /**
   * Begin running a script in this slot. Must be dead. Args populate
   * `locals[0..args.length-1]`; the rest is zeroed.
   */
  start(opts: {
    scriptId: number;
    bytecode: Uint8Array;
    args?: ReadonlyArray<number>;
    room?: number;
  }): void {
    if (this.status !== 'dead') {
      throw new ScriptSlotError(
        this.slotIndex,
        `start() requires status 'dead', got '${this.status}'`,
      );
    }
    this.scriptId = opts.scriptId;
    this.bytecode = opts.bytecode;
    this.pc = 0;
    this.room = opts.room ?? 0;
    this.locals.fill(0);
    if (opts.args) {
      for (let i = 0; i < opts.args.length && i < this.locals.length; i++) {
        this.locals[i] = opts.args[i]! | 0;
      }
    }
    this.status = 'running';
  }

  yield_(): void {
    if (this.status === 'dead') {
      throw new ScriptSlotError(this.slotIndex, `cannot yield a dead slot`);
    }
    this.status = 'yielded';
  }

  resume(): void {
    if (this.status === 'yielded' || this.status === 'frozen') {
      this.status = 'running';
    }
  }

  freeze(): void {
    if (this.status !== 'dead') this.status = 'frozen';
  }

  kill(): void {
    this.status = 'dead';
    this.scriptId = 0;
    this.bytecode = EMPTY;
    this.pc = 0;
    this.room = 0;
    this.locals.fill(0);
  }
}

const EMPTY = new Uint8Array(0);
