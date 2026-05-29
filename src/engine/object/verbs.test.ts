import { describe, expect, it } from 'vitest';
import { parseBlocks } from '../resources/block';
import { findChild, payloadOf } from '../resources/tree';
import type { ResourceFile } from '../resources/tree';
import { DEFAULT_VERB, findVerbScript, parseVerbScripts } from './verbs';

// ─── helpers ──────────────────────────────────────────────────────────

/**
 * Build a VERB block payload from an entry table + a concatenated
 * bytecode blob. `entries` give (verbId, offset) pairs where `offset`
 * is relative to the VERB *block* start (header included) — exactly
 * the on-disk convention. The table is laid out, NUL-terminated, then
 * `scripts` is appended verbatim.
 */
function verbPayload(
  entries: ReadonlyArray<{ verbId: number; offset: number }>,
  scripts: Uint8Array,
): Uint8Array {
  const table: number[] = [];
  for (const e of entries) {
    table.push(e.verbId, e.offset & 0xff, (e.offset >>> 8) & 0xff);
  }
  table.push(0x00); // terminator
  return new Uint8Array([...table, ...scripts]);
}

describe('parseVerbScripts', () => {
  it('resolves a single verb to its bytecode slice', () => {
    // table = 4 bytes (1 entry + terminator). VERB payload begins 8
    // bytes past block start, so offset 12 → payload index 4 → right
    // after the table. This mirrors real MI1 object #16.
    const scripts = new Uint8Array([0x48, 0x04, 0x00, 0xa0]);
    const payload = verbPayload([{ verbId: 11, offset: 12 }], scripts);

    const verbs = parseVerbScripts(payload);
    expect([...verbs.keys()]).toEqual([11]);
    expect([...verbs.get(11)!]).toEqual([0x48, 0x04, 0x00, 0xa0]);
  });

  it('handles two verbs sharing one script offset', () => {
    // Real MI1 object #17: verbs 7 and 11 both point at offset 15
    // (the byte after a 7-byte table). The slice runs to end of
    // payload for both.
    const scripts = new Uint8Array([0x01, 0x02, 0x03, 0xa0]);
    const payload = verbPayload(
      [
        { verbId: 7, offset: 15 },
        { verbId: 11, offset: 15 },
      ],
      scripts,
    );

    const verbs = parseVerbScripts(payload);
    expect([...verbs.keys()]).toEqual([7, 11]);
    expect([...verbs.get(7)!]).toEqual([0x01, 0x02, 0x03, 0xa0]);
    expect([...verbs.get(11)!]).toEqual([0x01, 0x02, 0x03, 0xa0]);
  });

  it('gives each verb a slice running to the end of the payload', () => {
    // Two distinct offsets: verb A at the table end, verb B partway
    // into the blob. B's slice is a suffix of A's.
    const scripts = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    // table = 2 entries × 3 + terminator = 7 bytes → first script at
    // offset 15 (payload index 7). Second verb points 2 bytes in.
    const payload = verbPayload(
      [
        { verbId: 8, offset: 15 },
        { verbId: 9, offset: 17 },
      ],
      scripts,
    );

    const verbs = parseVerbScripts(payload);
    expect([...verbs.get(8)!]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect([...verbs.get(9)!]).toEqual([0xcc, 0xdd]);
  });

  it('stops at the 0x00 terminator and ignores trailing bytecode', () => {
    const scripts = new Uint8Array([0x99]);
    const payload = verbPayload([{ verbId: 42, offset: 12 }], scripts);
    // Sanity: the byte after the 3-byte entry is the terminator.
    expect(payload[3]).toBe(0x00);
    const verbs = parseVerbScripts(payload);
    expect(verbs.size).toBe(1);
    expect(verbs.has(42)).toBe(true);
  });

  it('returns an empty map for a header-only / empty payload', () => {
    expect(parseVerbScripts(new Uint8Array([0x00])).size).toBe(0);
    expect(parseVerbScripts(new Uint8Array([])).size).toBe(0);
  });

  it('skips entries whose offset points into the header or past the payload', () => {
    // offset 4 → payload index -4 (inside the 8-byte header): invalid.
    // offset 999 → past end: invalid. offset 12 → valid.
    const scripts = new Uint8Array([0x77]);
    const payload = verbPayload(
      [
        { verbId: 1, offset: 4 },
        { verbId: 2, offset: 999 },
        { verbId: 3, offset: 12 },
      ],
      scripts,
    );
    const verbs = parseVerbScripts(payload);
    expect([...verbs.keys()]).toEqual([3]);
  });

  it('keeps the first slice when a verb id repeats', () => {
    const scripts = new Uint8Array([0x10, 0x20]);
    const payload = verbPayload(
      [
        { verbId: 5, offset: 13 }, // payload index 5 → [0x20]... wait
        { verbId: 5, offset: 12 },
      ],
      scripts,
    );
    // table = 2 entries × 3 + terminator = 7 bytes; scripts start at
    // payload index 7 (offset 15). offsets 12/13 land inside the
    // table region but are still in-bounds, so we exercise the
    // first-wins rule deterministically.
    const verbs = parseVerbScripts(payload);
    expect(verbs.size).toBe(1);
    // First entry (offset 13 → index 5) wins.
    expect(verbs.get(5)![0]).toBe(payload[5]);
  });
});

describe('findVerbScript', () => {
  const a = new Uint8Array([1]);
  const def = new Uint8Array([0xff]);

  it('returns the exact verb when present', () => {
    const verbs = new Map([[7, a]]);
    expect(findVerbScript(verbs, 7)).toBe(a);
  });

  it('falls back to the default verb (0xFF) when the requested verb is absent', () => {
    const verbs = new Map([[DEFAULT_VERB, def]]);
    expect(findVerbScript(verbs, 7)).toBe(def);
  });

  it('prefers the exact verb over the default', () => {
    const verbs = new Map([
      [7, a],
      [DEFAULT_VERB, def],
    ]);
    expect(findVerbScript(verbs, 7)).toBe(a);
  });

  it('returns null when neither the verb nor a default exists', () => {
    expect(findVerbScript(new Map([[3, a]]), 7)).toBeNull();
  });
});

// ─── end-to-end through the OBCD loader path ───────────────────────────
// Mirrors how parseRoomObjects extracts the VERB block: the offset
// convention is block-relative, so it only works when the VERB block
// sits at a real offset inside a parsed file. This guards the
// payload-relative `offset - 8` math against the live block parser.

function rawBlock(tag: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(payload, 8);
  return out;
}

describe('parseVerbScripts via the block parser', () => {
  it('decodes a VERB block sliced out of a real parsed file', () => {
    const scripts = new Uint8Array([0x48, 0x04, 0x00, 0xa0]);
    const payload = verbPayload([{ verbId: 11, offset: 12 }], scripts);
    const bytes = rawBlock('VERB', payload);
    const file: ResourceFile = { bytes, tree: parseBlocks(bytes) };
    const verb = findChild({ tag: '', offset: 0, size: 0, children: file.tree }, 'VERB')!;

    const verbs = parseVerbScripts(payloadOf(file, verb));
    expect([...verbs.get(11)!]).toEqual([0x48, 0x04, 0x00, 0xa0]);
  });
});
