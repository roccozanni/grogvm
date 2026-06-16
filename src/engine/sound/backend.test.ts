import { describe, expect, it } from 'vitest';
import { SilentTimingBackend } from './backend';
import type { SoundResource } from './resource';

const oneShot = (jiffies: number): SoundResource => ({
  durationJiffies: jiffies,
  looping: false,
  rendition: { kind: 'silent' },
});

describe('SilentTimingBackend', () => {
  it('counts a one-shot down and flips isRunning false at zero', () => {
    const a = new SilentTimingBackend();
    a.startSound(5, oneShot(3));
    expect(a.isRunning(5)).toBe(true);
    a.advance(2);
    expect(a.isRunning(5)).toBe(true);
    a.advance(1);
    expect(a.isRunning(5)).toBe(false); // drained exactly at its duration
  });

  it('never drains a looping sound', () => {
    const a = new SilentTimingBackend();
    a.startSound(7, { durationJiffies: 0, looping: true, rendition: { kind: 'silent' } });
    a.advance(10_000);
    expect(a.isRunning(7)).toBe(true);
  });

  it('stopSound and stopAll clear immediately', () => {
    const a = new SilentTimingBackend();
    a.startSound(1, oneShot(100));
    a.startSound(2, oneShot(100));
    a.stopSound(1);
    expect(a.isRunning(1)).toBe(false);
    expect(a.isRunning(2)).toBe(true);
    a.stopAll();
    expect(a.isRunning(2)).toBe(false);
  });

  it('treats music as looping and stopMusic clears it', () => {
    const a = new SilentTimingBackend();
    a.startMusic(40, oneShot(5)); // duration ignored — music loops
    a.advance(10_000);
    expect(a.isRunning(40)).toBe(true);
    a.stopMusic();
    expect(a.isRunning(40)).toBe(false);
  });

  it('inspect() reports kind, device, length and the music slot', () => {
    const a = new SilentTimingBackend();
    a.startSound(5, { durationJiffies: 120, looping: false, rendition: { kind: 'pcm', samples: new Uint8Array(), rate: 6849 } });
    a.startSound(6, { durationJiffies: 60, looping: false, rendition: { kind: 'midi', device: 'ADL', data: new Uint8Array() } });
    a.startMusic(9, { durationJiffies: 0, looping: false, rendition: { kind: 'cd', track: 3, startSec: 0 } });
    a.advance(20); // length is the full duration, not a countdown — total stays put

    const byId = new Map(a.inspect().map((s) => [s.id, s]));
    expect(byId.get(5)).toMatchObject({ kind: 'pcm', total: 120, looping: false, isMusic: false });
    expect(byId.get(6)).toMatchObject({ kind: 'midi', device: 'ADL', isMusic: false });
    expect(byId.get(9)).toMatchObject({ kind: 'cd', looping: true, isMusic: true });
  });

  it('inspect() reports a restored sound as unknown (snapshot carries no rendition)', () => {
    const a = new SilentTimingBackend();
    a.startSound(3, oneShot(50));
    const b = new SilentTimingBackend();
    b.restore(a.serialize());
    expect(b.inspect()).toMatchObject([{ id: 3, kind: 'unknown' }]);
  });

  it('round-trips its active map through serialize/restore', () => {
    const a = new SilentTimingBackend();
    a.startSound(3, oneShot(50));
    a.startMusic(9, oneShot(0));
    a.advance(20);
    const snap = a.serialize();
    const b = new SilentTimingBackend();
    b.restore(snap);
    expect(b.isRunning(3)).toBe(true);
    expect(b.isRunning(9)).toBe(true);
    b.advance(30); // #3 had 30 left
    expect(b.isRunning(3)).toBe(false);
    expect(b.isRunning(9)).toBe(true); // music still loops
  });
});
