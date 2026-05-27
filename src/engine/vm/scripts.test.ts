import { describe, expect, it } from 'vitest';
import { ScriptLoadError, loadGlobalScript } from './scripts';
import { parseBlocks } from '../resources/block';
import type { IndexFile } from '../resources/index-file';
import type { ResourceFile } from '../resources/tree';

function block(tag: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  const sz = 8 + payload.length;
  out[4] = (sz >>> 24) & 0xff;
  out[5] = (sz >>> 16) & 0xff;
  out[6] = (sz >>> 8) & 0xff;
  out[7] = sz & 0xff;
  out.set(payload, 8);
  return out;
}

/**
 * Build a synthetic `.001`-shaped resource file: LECF { LOFF, LFLF#1, LFLF#2, ... }
 * with the given rooms. Each room's LFLF holds a ROOM child plus zero
 * or more SCRP children. Returns the resource file, the LOFF map, and
 * a record of where each SCRP ended up so tests can wire DSCR offsets.
 */
function buildResource(
  rooms: ReadonlyArray<{ roomId: number; scrps: ReadonlyArray<Uint8Array> }>,
): {
  file: ResourceFile;
  loff: Map<number, number>;
  scrpAbs: Array<Array<number>>; // [roomIndex][scrpIndex] = absolute file offset
  roomAbs: Array<number>;
} {
  const scrpAbs: Array<Array<number>> = rooms.map(() => []);
  const roomAbs: Array<number> = [];

  const lflfBytes = rooms.map(({ scrps }, ri) => {
    const roomBlk = block('ROOM', new Uint8Array(0));
    const scrpBlks = scrps.map((p) => block('SCRP', p));
    const lflfPayload = new Uint8Array(
      roomBlk.length + scrpBlks.reduce((s, b) => s + b.length, 0),
    );
    let c = 0;
    lflfPayload.set(roomBlk, c);
    c += roomBlk.length;
    for (const b of scrpBlks) {
      lflfPayload.set(b, c);
      c += b.length;
    }
    void ri;
    return block('LFLF', lflfPayload);
  });

  const loff = new Map<number, number>();
  const loffPayload = new Uint8Array(1 + 5 * rooms.length);
  loffPayload[0] = rooms.length;
  const loffBlk = block('LOFF', loffPayload);

  const lecfPayloadSize =
    loffBlk.length + lflfBytes.reduce((s, b) => s + b.length, 0);
  const lecfPayload = new Uint8Array(lecfPayloadSize);
  let cur = 0;
  lecfPayload.set(loffBlk, cur);
  const loffPayloadAbs = 8 + cur + 8; // LECF header (8) + LOFF position (cur) + LOFF header (8)
  cur += loffBlk.length;

  for (let i = 0; i < rooms.length; i++) {
    const lflfAbs = 8 + cur; // +8 for LECF header
    const roomBlockAbs = lflfAbs + 8; // first child of LFLF
    roomAbs.push(roomBlockAbs);
    loff.set(rooms[i]!.roomId, roomBlockAbs);

    // Record SCRP positions.
    let scrpStart = roomBlockAbs + 8; // ROOM block has 8-byte header, no payload
    for (let j = 0; j < rooms[i]!.scrps.length; j++) {
      scrpAbs[i]!.push(scrpStart);
      scrpStart += 8 + rooms[i]!.scrps[j]!.length;
    }

    // Patch the LOFF entry for this room.
    const entryAbs = loffPayloadAbs + 1 + i * 5;
    const entryInLecfPayload = entryAbs - 8;
    lecfPayload[entryInLecfPayload] = rooms[i]!.roomId;
    lecfPayload[entryInLecfPayload + 1] = roomBlockAbs & 0xff;
    lecfPayload[entryInLecfPayload + 2] = (roomBlockAbs >>> 8) & 0xff;
    lecfPayload[entryInLecfPayload + 3] = (roomBlockAbs >>> 16) & 0xff;
    lecfPayload[entryInLecfPayload + 4] = (roomBlockAbs >>> 24) & 0xff;

    lecfPayload.set(lflfBytes[i]!, cur);
    cur += lflfBytes[i]!.length;
  }

  const fileBytes = block('LECF', lecfPayload);
  return { file: { bytes: fileBytes, tree: parseBlocks(fileBytes) }, loff, scrpAbs, roomAbs };
}

function makeIndex(
  scripts: ReadonlyArray<{ room: number; offset: number }>,
): IndexFile {
  return {
    maxs: {
      raw: [],
      numVariables: 0,
      numBitVariables: 0,
      numLocalObjects: 0,
      numCharsets: 0,
      numVerbs: 0,
    },
    rooms: [],
    scripts,
    sounds: [],
    costumes: [],
    charsets: [],
  };
}

describe('loadGlobalScript', () => {
  it('resolves a script via DSCR room id and LOFF', () => {
    const payload1 = new Uint8Array([0x80, 0x00]);
    const payload2 = new Uint8Array([0x00]);
    const { file, loff, scrpAbs, roomAbs } = buildResource([
      { roomId: 10, scrps: [payload1] },
      { roomId: 11, scrps: [payload2] },
    ]);

    const dscrOff1 = scrpAbs[0]![0]! - roomAbs[0]!;
    const dscrOff2 = scrpAbs[1]![0]! - roomAbs[1]!;

    const index = makeIndex([
      { room: 0, offset: 0 },
      { room: 10, offset: dscrOff1 },
      { room: 11, offset: dscrOff2 },
    ]);
    const s1 = loadGlobalScript(file, index, loff, 1);
    expect(Array.from(s1.bytecode)).toEqual([0x80, 0x00]);
    expect(s1.room).toBe(10);
    expect(s1.offsetInFile).toBe(scrpAbs[0]![0]!);

    const s2 = loadGlobalScript(file, index, loff, 2);
    expect(Array.from(s2.bytecode)).toEqual([0x00]);
    expect(s2.room).toBe(11);
  });

  it('resolves the correct SCRP when two rooms share the same DSCR offset', () => {
    // Both rooms place their only SCRP at the same offset relative to
    // their ROOM block. The loader must use LOFF to pick the right
    // room, not just walk forward looking for any SCRP at that offset.
    const a = new Uint8Array([0xAA]);
    const b = new Uint8Array([0xBB]);
    const { file, loff, scrpAbs, roomAbs } = buildResource([
      { roomId: 7, scrps: [a] },
      { roomId: 9, scrps: [b] },
    ]);
    const off = scrpAbs[0]![0]! - roomAbs[0]!;
    // Same relative offset works for room 9 because both LFLFs have
    // the same shape (one empty ROOM + one SCRP).
    expect(scrpAbs[1]![0]! - roomAbs[1]!).toBe(off);

    const index = makeIndex([
      { room: 7, offset: off },
      { room: 9, offset: off },
    ]);
    const s7 = loadGlobalScript(file, index, loff, 0);
    expect(Array.from(s7.bytecode)).toEqual([0xAA]);
    const s9 = loadGlobalScript(file, index, loff, 1);
    expect(Array.from(s9.bytecode)).toEqual([0xBB]);
  });

  it('throws on unused (room=0) entries', () => {
    const { file, loff } = buildResource([
      { roomId: 1, scrps: [new Uint8Array([0])] },
    ]);
    const index = makeIndex([{ room: 0, offset: 0 }]);
    expect(() => loadGlobalScript(file, index, loff, 0)).toThrow(ScriptLoadError);
  });

  it('throws on out-of-range id', () => {
    const { file, loff } = buildResource([
      { roomId: 1, scrps: [new Uint8Array([0])] },
    ]);
    const index = makeIndex([{ room: 1, offset: 8 }]);
    expect(() => loadGlobalScript(file, index, loff, 99)).toThrow(
      ScriptLoadError,
    );
  });

  it('throws when the owning room is missing from LOFF', () => {
    const { file, loff } = buildResource([
      { roomId: 1, scrps: [new Uint8Array([0])] },
    ]);
    const index = makeIndex([{ room: 99, offset: 8 }]);
    expect(() => loadGlobalScript(file, index, loff, 0)).toThrow(
      ScriptLoadError,
    );
  });

  it('throws when the resolved offset does not land on a SCRP tag', () => {
    const { file, loff, scrpAbs, roomAbs } = buildResource([
      { roomId: 5, scrps: [new Uint8Array([0])] },
    ]);
    const goodOff = scrpAbs[0]![0]! - roomAbs[0]!;
    const index = makeIndex([{ room: 5, offset: goodOff + 1 }]);
    expect(() => loadGlobalScript(file, index, loff, 0)).toThrow(
      ScriptLoadError,
    );
  });
});
