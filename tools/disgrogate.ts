/**
 * disgrogate — CLI front-end for the first-class disassembler in
 * src/engine/vm/disasm.ts. Loads a script from the MI1 data and prints
 * its decoded instructions; the decode logic itself lives in the module
 * (and has unit tests) — this file is just file-loading + arg parsing.
 *
 *   npm run disgrogate -- <globalId>
 *   npm run disgrogate -- L<id> <room>      # room-local script
 *   npm run disgrogate -- ENCD <room>       # room entry script
 *   npm run disgrogate -- EXCD <room>
 *   npm run disgrogate -- SCAN grep=lights  # sweep every script
 *
 * Optional `grep=<term>` filters printed lines to those containing the
 * term. NB: SCAN is a linear sweep — treat hits in scripts that report
 * "(misaligned)" as leads, not proof (see the module doc).
 */
import { readFileSync } from 'node:fs';
import { parseResourceFile } from '../src/engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../src/engine/resources/xor';
import { parseIndexFile } from '../src/engine/resources/index-file';
import { parseLoff } from '../src/engine/resources/loff';
import { loadGlobalScript } from '../src/engine/vm/scripts';
import { loadRoom } from '../src/engine/room/loader';
import { disassemble } from '../src/engine/vm/disasm';

const idx = parseResourceFile(new Uint8Array(readFileSync('games/MI1-IT-CD-DOS-VGA/MONKEY.000')), SCUMM_V5_XOR_KEY);
const res = parseResourceFile(new Uint8Array(readFileSync('games/MI1-IT-CD-DOS-VGA/MONKEY.001')), SCUMM_V5_XOR_KEY);
const index = parseIndexFile(idx);
const loff = parseLoff(res);

const arg = process.argv[2] ?? '1';
const room = parseInt(process.argv[3] ?? '10', 10);
const grep = process.argv.find((a) => a.startsWith('grep='))?.slice(5);

function emit(bytecode: Uint8Array, label: string): void {
  const lines = disassemble(bytecode);
  const matched = lines.filter((l) => !grep || l.text.toLowerCase().includes(grep.toLowerCase()));
  if (grep && matched.length === 0) return;
  console.log(`\n## ${label} (${bytecode.length} bytes)`);
  for (const l of matched) {
    console.log(`${l.offset.toString().padStart(5)} (0x${l.opcode.toString(16).padStart(2, '0')}) ${l.text}`);
  }
  if (!lines[lines.length - 1]?.aligned) console.log('  (misaligned — sweep stopped)');
}

if (arg === 'SCAN') {
  for (let id = 1; id < 250; id++) {
    try {
      const s = loadGlobalScript(res, index, loff, id);
      emit(s.bytecode, `global #${id} (room ${s.room})`);
    } catch {}
  }
  for (const roomId of loff.keys()) {
    try {
      const r = loadRoom(res, loff, roomId);
      if (r.entryScript) emit(r.entryScript, `room ${roomId} ENCD`);
      if (r.exitScript) emit(r.exitScript, `room ${roomId} EXCD`);
      for (const [lid, code] of r.localScripts) emit(code, `room ${roomId} local #${lid}`);
    } catch {}
  }
} else if (arg === 'ENCD' || arg === 'EXCD') {
  const r = loadRoom(res, loff, room);
  emit((arg === 'ENCD' ? r.entryScript : r.exitScript) ?? new Uint8Array(), `room ${room} ${arg}`);
} else if (arg.startsWith('L')) {
  emit(loadRoom(res, loff, room).localScripts.get(parseInt(arg.slice(1), 10))!, `room ${room} local #${arg.slice(1)}`);
} else {
  const s = loadGlobalScript(res, index, loff, parseInt(arg, 10));
  emit(s.bytecode, `global #${arg} (room ${s.room})`);
}
