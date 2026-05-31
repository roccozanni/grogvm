import type { Renderer } from './renderer';
import { indexedToRgba } from './indexed-to-rgba';

/**
 * In-memory renderer used by tests. Records the latest palette and
 * framebuffer so behaviour can be asserted without a DOM.
 */
export class MemoryRenderer implements Renderer {
  palette: Uint8Array = new Uint8Array(768);
  framebuffer: Uint8Array = new Uint8Array(0);
  transparentIndex: number | null = null;
  /** Latest dims set via {@link resize}; 0 until the first resize. */
  width = 0;
  height = 0;
  presentCount = 0;
  disposed = false;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setPalette(rgb: Uint8Array): void {
    this.palette = Uint8Array.from(rgb);
  }

  setTransparentIndex(index: number | null): void {
    this.transparentIndex = index;
  }

  present(indexed: Uint8Array): void {
    this.framebuffer = Uint8Array.from(indexed);
    this.presentCount++;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Compute the equivalent RGBA the canvas backend would have produced. */
  rgbaSnapshot(): Uint8ClampedArray<ArrayBuffer> {
    return indexedToRgba(this.framebuffer, this.palette, this.transparentIndex);
  }
}
