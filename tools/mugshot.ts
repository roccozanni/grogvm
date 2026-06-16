/**
 * mugshot — render a frame of the running game to a PNG. CLI front-end for the
 * screenshot library in src/testkit/screenshot.ts (boot → restore → drive →
 * write); the rendering logic lives in the module (and has unit tests).
 *
 *   npm run mugshot -- <save> [ticks] [options]
 *
 *   <save>   save slot name (→ saves/<name>.websave.json) or a path.
 *            Pass "fresh" to boot without restoring a save (e.g. the title).
 *   [ticks]  game ticks to advance before capturing (default 0).
 *
 * Options:
 *   --out=<path>   output PNG (default scratch/mugshot.png — gitignored)
 *   --scale=<n>    nearest-neighbour upscale (default 3)
 *   --game=<dir>   game data dir (required — no default)
 *   --seed=<n>     RNG seed for deterministic boot (default 1)
 *
 *   npm run mugshot -- MI1-Italiano-quicksave 60
 *   npm run mugshot -- fresh 200 --out=scratch/title.png
 */
import { bootScummV5, restoreSave, makeSeededRandom, writeScreenshot } from '../src/testkit/scummv5';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name: string, fallback: string): string =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const save = positional[0] ?? 'fresh';
const ticks = parseInt(positional[1] ?? '0', 10);
const out = flag('out', 'scratch/mugshot.png');
const scale = parseInt(flag('scale', '3'), 10);
const gameDir = process.argv.find((a) => a.startsWith('--game='))?.slice(7);
if (!gameDir) {
  console.error('mugshot: missing required --game=<dir> (the v5 game-data directory)');
  process.exit(1);
}
const seed = parseInt(flag('seed', '1'), 10);

const vm = bootScummV5(gameDir, 'MI1', makeSeededRandom(seed));
if (save !== 'fresh') restoreSave(vm, save);
for (let i = 0; i < ticks; i++) vm.tick();

writeScreenshot(vm, out, { scale });

const room = vm.loadedRoom;
console.log(
  `wrote ${out} — full screen ×${scale} (room ${room?.id} ${room?.width}×${room?.height}), ` +
    `${save === 'fresh' ? 'fresh boot' : save} +${ticks} ticks`,
);
