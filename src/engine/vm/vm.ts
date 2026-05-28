/**
 * SCUMM v5 virtual machine — the dispatch loop.
 *
 * # Model
 *
 * - **Cooperative scheduling.** Scripts run until they call
 *   `breakHere` (or finish via `stopObjectCode`). The VM rotates
 *   through runnable slots one opcode at a time inside `step()`; a
 *   full "tick" of work is `runUntilAllYield()`.
 *
 * - **Halt is a first-class state.** Hitting an opcode we haven't
 *   implemented does not throw out to the caller — the dispatcher
 *   catches the `UnknownOpcodeError` (and any other VM-level error)
 *   and freezes the VM into a `HaltInfo` snapshot. The inspector UI
 *   reads `vm.haltInfo` and renders a halt panel; subsequent
 *   `step()` / `runUntilAllYield()` calls are no-ops until
 *   `vm.reset()`.
 *
 * - **Per-opcode trace ring.** Every dispatched opcode is appended to
 *   `vm.trace` (a circular buffer). The inspector renders the last
 *   N entries; halt also embeds the tail of the trace into
 *   `HaltInfo` for crash forensics.
 *
 * # What's deliberately not here
 *
 * - No tick clock, no real-time pacing — `delay` is a stub in the
 *   opcode set; correct timing lands with the main loop in Phase 6.
 * - No actor / object / palette state — the VM mutates variables
 *   and slots only. Effectful opcodes (loadRoom, walkActor, …) come
 *   when their subsystems exist.
 * - No save/restore — Phase 8.
 */

import { ActorTable, DEFAULT_ACTOR_COUNT } from '../actor/actor';
import type { LoadedCostume } from '../graphics/costume-loader';
import type { LoadedRoom } from '../room/loader';
import { ScriptSlot } from './slot';
import { Variables } from './variables';

export class UnknownOpcodeError extends Error {
  constructor(public readonly opcode: number) {
    super(`Unknown opcode 0x${opcode.toString(16).padStart(2, '0')}`);
    this.name = 'UnknownOpcodeError';
  }
}

/** One dispatched opcode in the trace ring. */
export interface TraceEntry {
  readonly slotIndex: number;
  readonly scriptId: number;
  /** PC of the opcode byte, before dispatch advanced past it. */
  readonly pc: number;
  readonly opcode: number;
  /** Optional human label, set by the handler. */
  readonly mnemonic?: string;
}

/** Frozen snapshot of the VM at halt time. */
export interface HaltInfo {
  readonly reason: string;
  readonly slotIndex: number;
  readonly scriptId: number;
  readonly pc: number;
  readonly opcode: number;
  /** Up to 16 bytes of bytecode context centred on the PC. */
  readonly bytecodeContext: Uint8Array;
  /** Offset of the failing opcode inside `bytecodeContext`. */
  readonly contextOpcodeOffset: number;
  /** Tail of the trace ring (oldest → newest). */
  readonly trace: ReadonlyArray<TraceEntry>;
}

export type OpcodeHandler = (vm: Vm, slot: ScriptSlot, opcode: number) => void;

export const NUM_SLOTS = 25;
const TRACE_CAPACITY = 64;

/** Resolve a global script id to its loaded bytecode + owning room. */
export type GlobalScriptResolver = (
  scriptId: number,
) => { readonly bytecode: Uint8Array; readonly room: number };

/**
 * Decode a room id to a fully-loaded room (background bitmap, palette,
 * z-planes, ENCD/EXCD bytecode). Throws on unknown room ids — the
 * VM's `loadRoom` opcode handler catches that and clears the room.
 */
export type RoomResolver = (roomId: number) => LoadedRoom;

/**
 * Decode a costume id to its parsed header + payload. Throws on
 * unknown ids; the VM caches successful results so each costume is
 * only decoded once per session.
 */
export type CostumeResolver = (costumeId: number) => LoadedCostume;

export interface VmInit {
  readonly numVariables: number;
  readonly numBitVariables: number;
  readonly numRoomVariables?: number;
  readonly handlers: ReadonlyMap<number, OpcodeHandler>;
  /**
   * Resolver for the `startScript` family of opcodes. Optional in
   * tests that don't exercise script start; the real boot path wires
   * it via {@link bootGame}.
   */
  readonly resolveGlobalScript?: GlobalScriptResolver;
  /**
   * Resolver for `loadRoom` (0x72 / 0xF2). Optional in tests that
   * don't exercise room loading. When absent, the opcode handler
   * still updates `vm.currentRoom` + `VAR_ROOM` but leaves
   * `loadedRoom` as `null`.
   */
  readonly resolveRoom?: RoomResolver;
  /**
   * Resolver for actor costumes. Called lazily by
   * {@link Vm.getCostume}; loaded costumes are cached on the VM so
   * each id is only decoded once.
   */
  readonly resolveCostume?: CostumeResolver;
}

export class Vm {
  readonly vars: Variables;
  readonly slots: ReadonlyArray<ScriptSlot>;
  /**
   * Engine string resources, keyed by id. Created and mutated by the
   * `stringOps` (0x27) opcode family; consumed by text-output opcodes
   * once they land. Empty until a script writes.
   */
  readonly strings = new Map<number, Uint8Array>();
  /**
   * Per-object state byte (0..255). Scripts read with `getObjectState`
   * / `ifState` and write with `setState`. Object state determines
   * which OBIM image variant gets composited and which entry of an
   * object's verb-script bank runs on use.
   */
  readonly objectStates = new Map<number, number>();
  /**
   * Per-object owner — actor id that "has" the object (typically
   * because the player picked it up). 0 = nobody (still in the room).
   */
  readonly objectOwners = new Map<number, number>();
  /**
   * Currently-loaded room id (per the VM's view). Set by `loadRoom`
   * (0x72/0xF2) and related opcodes; consumed by the room-render path
   * once the compositor lands. Zero = no room yet.
   */
  currentRoom = 0;
  /**
   * Fully-decoded data for the current room — background bitmap,
   * palette, z-planes, ENCD/EXCD bytecode. `null` until the first
   * successful `loadRoom`, and any time the script loads the room-0
   * sentinel ("no room").
   */
  loadedRoom: LoadedRoom | null = null;
  /**
   * Last room-load error message (if any). Surfaced by the inspector
   * when a `loadRoom` opcode fires for a room the loader can't decode
   * (room id 0, missing block, etc.) — we don't halt for these.
   */
  lastRoomLoadError: string | null = null;
  /**
   * Actor table — fixed-size, indexed by id with slot 0 as sentinel.
   * Mutated by putActor / actorOps / animateActor / walk opcodes; read
   * by the frame compositor and the inspector.
   */
  readonly actors = new ActorTable(DEFAULT_ACTOR_COUNT);
  /**
   * Decoded costumes loaded on demand. Keyed by costume id. Populated
   * by {@link Vm.getCostume}; surfaces in the inspector / compositor.
   */
  readonly costumes = new Map<number, LoadedCostume>();
  readonly resolveGlobalScript: GlobalScriptResolver | undefined;
  readonly resolveRoom: RoomResolver | undefined;
  readonly resolveCostume: CostumeResolver | undefined;
  private readonly handlers: ReadonlyMap<number, OpcodeHandler>;
  private readonly traceBuffer: (TraceEntry | undefined)[] = new Array(
    TRACE_CAPACITY,
  ).fill(undefined);
  private traceHead = 0;
  private traceCount = 0;

  private _haltInfo: HaltInfo | null = null;

  /** Slot whose opcode we labelled most recently — set by handlers via `annotate()`. */
  private lastAnnotation: string | undefined;

  constructor(init: VmInit) {
    this.vars = new Variables({
      numVariables: init.numVariables,
      numBitVariables: init.numBitVariables,
      numRoomVariables: init.numRoomVariables,
    });
    this.slots = Array.from({ length: NUM_SLOTS }, (_, i) => new ScriptSlot(i));
    this.handlers = init.handlers;
    this.resolveGlobalScript = init.resolveGlobalScript;
    this.resolveRoom = init.resolveRoom;
    this.resolveCostume = init.resolveCostume;
  }

  /**
   * Resolve a costume id to its parsed data, using the cache. Returns
   * `null` for id 0 (sentinel), if no resolver was provided, or if
   * the resolver throws. Safe to call from the compositor for every
   * actor every frame — the cache makes it O(1) after first load.
   */
  getCostume(id: number): LoadedCostume | null {
    if (id <= 0) return null;
    const cached = this.costumes.get(id);
    if (cached) return cached;
    if (!this.resolveCostume) return null;
    try {
      const loaded = this.resolveCostume(id);
      this.costumes.set(id, loaded);
      return loaded;
    } catch {
      // Costume id present in DCOS but undecodable — return null so
      // the compositor skips this actor rather than halting.
      return null;
    }
  }

  get haltInfo(): HaltInfo | null {
    return this._haltInfo;
  }

  get isHalted(): boolean {
    return this._haltInfo !== null;
  }

  get trace(): ReadonlyArray<TraceEntry> {
    const out: TraceEntry[] = [];
    const start = (this.traceHead - this.traceCount + TRACE_CAPACITY) % TRACE_CAPACITY;
    for (let i = 0; i < this.traceCount; i++) {
      out.push(this.traceBuffer[(start + i) % TRACE_CAPACITY]!);
    }
    return out;
  }

  /** Find the lowest-index dead slot. Throws if all are in use. */
  startScript(opts: {
    scriptId: number;
    bytecode: Uint8Array;
    args?: ReadonlyArray<number>;
    room?: number;
  }): ScriptSlot {
    const slot = this.slots.find((s) => s.status === 'dead');
    if (!slot) {
      throw new Error('no free script slot available');
    }
    slot.start(opts);
    return slot;
  }

  /**
   * Dispatch a single opcode in the next runnable slot. Returns the
   * slot that ran (or undefined if no slot was runnable / VM halted).
   */
  step(): ScriptSlot | undefined {
    if (this._haltInfo) return undefined;
    const slot = this.slots.find((s) => s.status === 'running');
    if (!slot) return undefined;

    if (slot.pc >= slot.bytecode.length) {
      this.haltFromOpcode(
        slot,
        0,
        `pc=${slot.pc} past end of bytecode (len=${slot.bytecode.length})`,
      );
      return slot;
    }

    const opcodePc = slot.pc;
    const opcode = slot.bytecode[opcodePc]!;
    slot.pc++;
    const handler = this.handlers.get(opcode);

    this.lastAnnotation = undefined;

    if (!handler) {
      this.haltFromOpcode(slot, opcode, new UnknownOpcodeError(opcode).message);
      this.appendTrace({
        slotIndex: slot.slotIndex,
        scriptId: slot.scriptId,
        pc: opcodePc,
        opcode,
        mnemonic: '(unknown)',
      });
      return slot;
    }

    try {
      handler(this, slot, opcode);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.haltFromOpcode(slot, opcode, reason, opcodePc);
      this.appendTrace({
        slotIndex: slot.slotIndex,
        scriptId: slot.scriptId,
        pc: opcodePc,
        opcode,
        mnemonic: this.lastAnnotation ?? '(error)',
      });
      return slot;
    }

    this.appendTrace({
      slotIndex: slot.slotIndex,
      scriptId: slot.scriptId,
      pc: opcodePc,
      opcode,
      ...(this.lastAnnotation !== undefined && { mnemonic: this.lastAnnotation }),
    });
    return slot;
  }

  /**
   * Step until every slot is dead/yielded/frozen — i.e. until the
   * next `step()` would return undefined. Caps at `maxSteps` to
   * prevent runaway tight loops.
   */
  runUntilAllYield(maxSteps: number = 100_000): number {
    let count = 0;
    while (count < maxSteps && !this._haltInfo) {
      const ran = this.step();
      if (!ran) break;
      count++;
    }
    if (count === maxSteps && !this._haltInfo) {
      // Treat exceeding the step budget as a loud halt: usually means
      // a runaway loop with no breakHere. Snapshot the current slot
      // so the inspector can see where we got stuck.
      const slot = this.slots.find((s) => s.status === 'running');
      if (slot) {
        this.haltFromOpcode(
          slot,
          slot.bytecode[slot.pc] ?? 0,
          `runUntilAllYield exceeded ${maxSteps} steps without yielding (likely a tight loop)`,
        );
      }
    }
    return count;
  }

  /** Reset trace + halt + every slot back to dead. */
  reset(): void {
    for (const s of this.slots) s.kill();
    this.traceBuffer.fill(undefined);
    this.traceHead = 0;
    this.traceCount = 0;
    this._haltInfo = null;
    this.strings.clear();
    this.objectStates.clear();
    this.objectOwners.clear();
    this.currentRoom = 0;
    this.loadedRoom = null;
    this.lastRoomLoadError = null;
    this.actors.reset();
    this.costumes.clear();
  }

  /** Set the human label for the *next* trace entry (called from a handler). */
  annotate(mnemonic: string): void {
    this.lastAnnotation = mnemonic;
  }

  /** Manually halt the VM with a reason — exposed for handlers. */
  haltManual(slot: ScriptSlot, reason: string): void {
    const opcode = slot.bytecode[slot.pc] ?? 0;
    this.haltFromOpcode(slot, opcode, reason);
  }

  private haltFromOpcode(
    slot: ScriptSlot,
    opcode: number,
    reason: string,
    overridePc?: number,
  ): void {
    if (this._haltInfo) return;
    const pc = overridePc ?? Math.max(0, slot.pc - 1);
    const lo = Math.max(0, pc - 8);
    const hi = Math.min(slot.bytecode.length, pc + 8);
    const ctx = slot.bytecode.subarray(lo, hi);
    this._haltInfo = {
      reason,
      slotIndex: slot.slotIndex,
      scriptId: slot.scriptId,
      pc,
      opcode,
      bytecodeContext: new Uint8Array(ctx),
      contextOpcodeOffset: pc - lo,
      trace: this.trace.slice(-16),
    };
  }

  private appendTrace(entry: TraceEntry): void {
    this.traceBuffer[this.traceHead] = entry;
    this.traceHead = (this.traceHead + 1) % TRACE_CAPACITY;
    this.traceCount = Math.min(this.traceCount + 1, TRACE_CAPACITY);
  }
}
