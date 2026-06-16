/**
 * Corpus alignment net: the disassembler decodes EVERY script in the real
 * game cleanly (measured baseline 2026-06-10: 2,114 scripts, 0 misaligned).
 * A regression here means an operand layout in the opcode registry is wrong
 * — the executing dispatcher reads the same table, so fix the shape, not
 * the test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseResourceFile } from '../../src/engine/resources/file';
import { SCUMM_V5_XOR_KEY } from '../../src/engine/resources/xor';
import { parseIndexFile } from '../../src/engine/resources/index-file';
import { parseLoff } from '../../src/engine/resources/loff';
import { loadGlobalScript } from '../../src/engine/vm/scripts';
import { listRooms, extractRoom } from '../../src/engine/room/extract';
import { disassemble } from '../../src/engine/vm/disasm';
import { BUILDS } from './game';

describe.each(BUILDS)('MI1 — Disassembler - $variant', (build) => {
  it('decodes every global, room, and object-verb script with zero misalignments', () => {
    const res = parseResourceFile(
      new Uint8Array(readFileSync(`${build.dir}/MONKEY.001`)),
      SCUMM_V5_XOR_KEY,
    );
    const idx = parseResourceFile(
      new Uint8Array(readFileSync(`${build.dir}/MONKEY.000`)),
      SCUMM_V5_XOR_KEY,
    );
    const index = parseIndexFile(idx);
    const loff = parseLoff(res);

    const corpus: Array<{ label: string; bytecode: Uint8Array }> = [];
    for (let id = 1; id < 250; id++) {
      try {
        const s = loadGlobalScript(res, index, loff, id);
        corpus.push({ label: `global#${id}`, bytecode: s.bytecode });
      } catch {
        /* unallocated global id */
      }
    }
    for (const ref of listRooms(res, loff)) {
      const dossier = extractRoom(res, ref);
      if (dossier.scripts.ok) {
        for (const s of dossier.scripts.value) {
          corpus.push({ label: `r${ref.roomId}/${s.label}`, bytecode: s.bytecode });
        }
      }
      if (dossier.objects.ok) {
        for (const [objId, obj] of dossier.objects.value) {
          for (const [verbId, code] of obj.verbs) {
            corpus.push({ label: `r${ref.roomId}/obj${objId}/v${verbId}`, bytecode: code });
          }
        }
      }
    }

    const misaligned: string[] = [];
    for (const { label, bytecode } of corpus) {
      const out = disassemble(bytecode);
      const last = out[out.length - 1];
      if (last && !last.aligned) {
        misaligned.push(`${label} @ ${last.offset}: ${last.text}`);
      }
    }

    expect(corpus.length).toBeGreaterThan(2000);
    expect(misaligned).toEqual([]);
  });
});
