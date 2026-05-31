import { describe, it, expect } from 'vitest';
import { VIEWPORT_W, viewportLeft } from './viewport';

describe('viewportLeft', () => {
  it('is 0 for a room no wider than the viewport', () => {
    expect(viewportLeft(160, 320)).toBe(0);
    expect(viewportLeft(0, 320)).toBe(0);
    expect(viewportLeft(9999, 320)).toBe(0);
    expect(viewportLeft(160, 200)).toBe(0); // narrower than viewport
  });

  it('centres the viewport on the camera, clamped to room edges', () => {
    // 500-wide room, 320 viewport → maxLeft = 180.
    expect(viewportLeft(160, 500)).toBe(0); // 160-160=0
    expect(viewportLeft(300, 500)).toBe(140); // 300-160
    expect(viewportLeft(400, 500)).toBe(180); // clamped to maxLeft
    expect(viewportLeft(0, 500)).toBe(0); // clamped low
  });

  it('rounds the camera centre', () => {
    expect(viewportLeft(300.4, 500)).toBe(140);
    expect(viewportLeft(300.6, 500)).toBe(141);
  });

  it('honours a custom viewport width', () => {
    expect(viewportLeft(200, 500, 100)).toBe(150); // 200-50, max 400
    expect(viewportLeft(500, 500, 100)).toBe(400); // clamped
  });

  it('exposes the 320 screen width', () => {
    expect(VIEWPORT_W).toBe(320);
  });
});
