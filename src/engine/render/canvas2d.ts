import type { Renderer } from './renderer';
import { indexedToRgba } from './indexed-to-rgba';

/**
 * Canvas2D-backed renderer. Owns its canvas: sets the canvas's internal
 * bitmap to `width × height` (native game resolution). On-screen scaling
 * is the host shell's job, done with CSS — engine code stays in native
 * pixel coordinates.
 */
export class Canvas2DRenderer implements Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private palette: Uint8Array = new Uint8Array(768);
  private transparentIndex: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private width: number,
    private height: number,
  ) {
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context not available');
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    // Setting canvas.width/height resets the 2D context state, so
    // re-apply the no-smoothing flag the pixel-art upscale relies on.
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.imageSmoothingEnabled = false;
  }

  setPalette(rgb: Uint8Array): void {
    this.palette = rgb;
  }

  setTransparentIndex(index: number | null): void {
    this.transparentIndex = index;
  }

  present(indexed: Uint8Array): void {
    const expected = this.width * this.height;
    if (indexed.length !== expected) {
      throw new Error(
        `Canvas2DRenderer.present: framebuffer size ${indexed.length} ≠ ${this.width}×${this.height} = ${expected}`,
      );
    }
    // putImageData replaces — clear any prior frame first so transparent pixels
    // actually expose what's beneath rather than blending with the previous one.
    this.ctx.clearRect(0, 0, this.width, this.height);
    const rgba = indexedToRgba(indexed, this.palette, this.transparentIndex);
    const image = new ImageData(rgba, this.width, this.height);
    this.ctx.putImageData(image, 0, 0);
  }

  dispose(): void {
    // Nothing to release yet. The canvas element is owned by the shell.
  }
}
