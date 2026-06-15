/**
 * spyglass — watch which scripts/opcodes actually execute as a save plays
 * forward. The dynamic counterpart to disgrogate (which statically
 * disassembles one script): boot → restore → drive N jiffies → print the
 * per-frame execution trace. CLI front-end for the tracer in
 * src/testkit/trace.ts (the collecting + formatting logic lives there and has
 * unit tests); this file is just file-loading + arg parsing.
 *
 *   npm run spyglass -- <save> [ticks] [options]
 *
 *   <save>   save slot name (→ saves/<name>.websave.json) or a path.
 *            Pass "fresh" to trace from a bare boot (e.g. the title sequence).
 *   [ticks]  jiffies to drive before stopping (default 200; stops early on halt).
 *
 * Options:
 *   --script=<id[,id,...]>  keep only runs of these script ids
 *   --compact               list scripts + opcode counts, not full opcode detail
 *   --idle                  keep idle frames (default: drop frames that ran nothing)
 *   --game=<dir>            game data dir (default games/MI1-IT-CD-DOS-VGA)
 *   --seed=<n>              RNG seed for deterministic boot (default 1)
 *
 *   npm run spyglass -- MI1-Italiano-quicksave 60
 *   npm run spyglass -- fresh 400 --script=1,2 --compact
 */
import {
  bootScummV5,
  formatFrames,
  makeSeededRandom,
  restoreSave,
  traceTicks,
} from '../src/testkit/scummv5';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const has = (name: string): boolean => process.argv.includes(`--${name}`);
const flag = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const save = positional[0] ?? 'fresh';
const ticks = parseInt(positional[1] ?? '200', 10);
const gameDir = flag('game', 'games/MI1-IT-CD-DOS-VGA');
const seed = parseInt(flag('seed', '1'), 10);
const scriptArg = flag('script', '');
const scripts = scriptArg
  ? new Set(scriptArg.split(',').map((s) => parseInt(s, 10)))
  : undefined;

const vm = bootScummV5(gameDir, 'MI1', makeSeededRandom(seed));
if (save !== 'fresh') restoreSave(vm, save);

const frames = traceTicks(vm, ticks, { scripts, keepIdle: has('idle') });
for (const line of formatFrames(frames, { ops: !has('compact') })) console.log(line);

const opsRun = frames.reduce((n, f) => n + f.ran, 0);
console.error(
  `\n${frames.length} frame(s), ${opsRun} opcode(s) over ${ticks} jiffies — ` +
    `${save === 'fresh' ? 'fresh boot' : save}` +
    `${scripts ? `, scripts {${[...scripts].join(',')}}` : ''}` +
    `${vm.haltInfo ? ` — HALTED: ${vm.haltInfo.reason}` : ''}`,
);
