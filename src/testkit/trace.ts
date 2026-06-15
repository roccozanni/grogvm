/**
 * Execution tracer — the dynamic counterpart to the static disassembler
 * (vm/disasm.ts). disgrogate shows what a script *could* run; the tracer
 * drives a live VM and records what actually executed, grouped by frame and
 * by the script that ran each opcode. Reads the VM's built-in trace ring
 * (capacity {@link Vm}'s TRACE_CAPACITY) after every jiffy, so it needs no
 * engine hooks. Game-agnostic and synthetic-testable; the CLI front end is
 * tools/trace.ts (`npm run trace`). See pages/docs/engine/harness.md.
 */
import type { TraceEntry, Vm } from '../engine/vm/vm';

/** A contiguous stretch of opcodes one script ran within a single frame. */
export interface ScriptRun {
  readonly scriptId: number;
  readonly slotIndex: number;
  readonly ops: ReadonlyArray<TraceEntry>;
}

/** What executed during one framed jiffy. */
export interface FrameTrace {
  /** Jiffy index within the trace run (0-based, as driven). */
  readonly tick: number;
  /** Opcodes dispatched this frame (`vm.tick().ran`). */
  readonly ran: number;
  /** True if `ran` outran the VM trace ring, so `runs` covers only its tail. */
  readonly truncated: boolean;
  /** The frame's opcodes grouped into per-script runs, in execution order. */
  readonly runs: ReadonlyArray<ScriptRun>;
}

/**
 * Group a frame's flat trace slice into per-script runs, preserving execution
 * order: a new run begins whenever the running slot changes, so a script
 * re-entered after another ran shows up as a second run (interleavings are
 * not collapsed). Pure.
 *
 * Note: a script's terminating `stopObjectCode` is recorded by the VM after
 * the slot's id was cleared, so it surfaces as a trailing `#0` run — expected,
 * not a bug.
 */
export function groupFrame(entries: ReadonlyArray<TraceEntry>): ScriptRun[] {
  const runs: { scriptId: number; slotIndex: number; ops: TraceEntry[] }[] = [];
  let cur: { scriptId: number; slotIndex: number; ops: TraceEntry[] } | undefined;
  for (const e of entries) {
    if (!cur || cur.scriptId !== e.scriptId || cur.slotIndex !== e.slotIndex) {
      cur = { scriptId: e.scriptId, slotIndex: e.slotIndex, ops: [] };
      runs.push(cur);
    }
    cur.ops.push(e);
  }
  return runs;
}

/** Options for {@link traceTicks}. */
export interface TraceOptions {
  /** Keep only runs whose scriptId is in this set (default: keep all). */
  scripts?: ReadonlySet<number>;
  /** Emit frames with no surviving runs, e.g. idle jiffies (default false). */
  keepIdle?: boolean;
}

/**
 * Drive `vm` for up to `n` jiffies (stopping early on halt) and return the
 * per-frame execution trace. After each jiffy it reads the newest `ran`
 * entries off the VM trace ring — the opcodes that frame dispatched. Idle
 * frames (and, with a `scripts` filter, frames matching nothing) are dropped
 * unless `keepIdle` is set.
 */
export function traceTicks(vm: Vm, n: number, opts: TraceOptions = {}): FrameTrace[] {
  const frames: FrameTrace[] = [];
  for (let t = 0; t < n && !vm.haltInfo; t++) {
    const { ran } = vm.tick();
    const slice = ran > 0 ? vm.trace.slice(-ran) : [];
    let runs = groupFrame(slice);
    if (opts.scripts) runs = runs.filter((r) => opts.scripts!.has(r.scriptId));
    if (runs.length === 0 && !opts.keepIdle) continue;
    frames.push({ tick: t, ran, truncated: ran > slice.length, runs });
  }
  return frames;
}

/** One opcode as `mnemonic@pc` (falling back to `0xNN@pc` when unlabelled). */
function formatOp(e: TraceEntry): string {
  const name = e.mnemonic ?? `0x${e.opcode.toString(16).padStart(2, '0')}`;
  return `${name}@${e.pc}`;
}

/**
 * Render a frame trace as text lines: one header per frame, one indented line
 * per script run. `--ops` callers want the opcode detail; pass `ops: false`
 * for a compact view that lists only the scripts (and their opcode counts)
 * that ran each frame.
 */
export function formatFrames(
  frames: ReadonlyArray<FrameTrace>,
  { ops = true }: { ops?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const f of frames) {
    lines.push(`t${f.tick} ran=${f.ran}${f.truncated ? ' (ring truncated)' : ''}`);
    for (const run of f.runs) {
      lines.push(
        ops
          ? `  #${run.scriptId} ${run.ops.map(formatOp).join(' ')}`
          : `  #${run.scriptId} (${run.ops.length})`,
      );
    }
  }
  return lines;
}
