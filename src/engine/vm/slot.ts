/**
 * One SCUMM v5 script slot — the unit the VM's scheduler rotates through.
 * Freezing is CUMULATIVE and orthogonal to status: a count, not a state —
 * see pages/docs/scumm/cutscenes.md.
 */

export type ScriptSlotStatus = 'dead' | 'running' | 'yielded';

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
  /** Label for synthetic scripts (ENCD/EXCD/verb/sentence); empty for globals. */
  label: string = '';
  /** Bytecode being executed (empty Uint8Array if dead). */
  bytecode: Uint8Array = EMPTY;
  /** Program counter — byte offset into `bytecode`. */
  pc: number = 0;
  /** Owning room id (or 0 if not tied to a room). */
  room: number = 0;
  /** 25 local int vars, zeroed on `start`. */
  readonly locals: Int32Array = new Int32Array(25);
  /**
   * Escape-skip target PC, armed by `beginOverride`, cleared by
   * `endOverride` / slot death. `null` when not in an override window.
   */
  overridePc: number | null = null;
  /** Jiffies remaining before the slot may resume from a `delay`. */
  delayRemaining: number = 0;
  /**
   * Cumulative freeze depth; `> 0` ⇒ skipped by the scheduler (neither
   * dispatched nor resumed) until it returns to 0.
   */
  freezeCount: number = 0;
  /**
   * Spared by a normal `freezeScripts`; only a force-freeze (flag ≥ 0x80)
   * freezes it. From the 0x20 bit on the `startScript` opcode.
   */
  freezeResistant: boolean = false;

  constructor(slotIndex: number) {
    this.slotIndex = slotIndex;
  }

  /** True when the slot can be dispatched this tick. */
  get runnable(): boolean {
    return this.status === 'running' && this.freezeCount === 0;
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
    label?: string;
    freezeResistant?: boolean;
  }): void {
    if (this.status !== 'dead') {
      throw new ScriptSlotError(
        this.slotIndex,
        `start() requires status 'dead', got '${this.status}'`,
      );
    }
    this.scriptId = opts.scriptId;
    this.label = opts.label ?? '';
    this.bytecode = opts.bytecode;
    this.pc = 0;
    this.room = opts.room ?? 0;
    this.locals.fill(0);
    this.overridePc = null;
    this.delayRemaining = 0;
    this.freezeCount = 0;
    this.freezeResistant = opts.freezeResistant ?? false;
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
    if (this.status === 'yielded') {
      this.status = 'running';
    }
  }

  /** Increase freeze depth (cumulative). Does nothing to a dead slot. */
  freeze(): void {
    if (this.status !== 'dead') this.freezeCount++;
  }

  /** Decrease freeze depth, clamped at 0. */
  unfreeze(): void {
    if (this.freezeCount > 0) this.freezeCount--;
  }

  kill(): void {
    this.status = 'dead';
    this.scriptId = 0;
    this.label = '';
    this.bytecode = EMPTY;
    this.pc = 0;
    this.room = 0;
    this.locals.fill(0);
    this.overridePc = null;
    this.delayRemaining = 0;
    this.freezeCount = 0;
    this.freezeResistant = false;
  }
}

const EMPTY = new Uint8Array(0);
