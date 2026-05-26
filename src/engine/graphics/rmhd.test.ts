import { describe, it, expect } from 'vitest';
import { parseRmhd } from './rmhd';

function rmhd(width: number, height: number, numObjects: number): Uint8Array {
  const out = new Uint8Array(6);
  const view = new DataView(out.buffer);
  view.setUint16(0, width, true);
  view.setUint16(2, height, true);
  view.setUint16(4, numObjects, true);
  return out;
}

describe('parseRmhd', () => {
  it('parses a standard 320x144 room with 10 objects', () => {
    expect(parseRmhd(rmhd(320, 144, 10))).toEqual({
      width: 320,
      height: 144,
      numObjects: 10,
    });
  });

  it('parses a wide scrolling room', () => {
    expect(parseRmhd(rmhd(640, 144, 25))).toEqual({
      width: 640,
      height: 144,
      numObjects: 25,
    });
  });

  it('parses a zero-object room', () => {
    expect(parseRmhd(rmhd(160, 100, 0)).numObjects).toBe(0);
  });

  it('throws if the payload is shorter than 6 bytes', () => {
    expect(() => parseRmhd(new Uint8Array(5))).toThrow(/too short/);
  });

  it('ignores extra trailing bytes', () => {
    const payload = new Uint8Array(20);
    new DataView(payload.buffer).setUint16(0, 320, true);
    new DataView(payload.buffer).setUint16(2, 144, true);
    new DataView(payload.buffer).setUint16(4, 7, true);
    expect(parseRmhd(payload).width).toBe(320);
  });
});
