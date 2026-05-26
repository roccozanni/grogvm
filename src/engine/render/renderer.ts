/**
 * Engine-side renderer interface. The engine only talks to this; the
 * shell picks a concrete implementation (Canvas2D today; potentially
 * WebGL later).
 */
export interface Renderer {
  /** Set the active 256-color palette. `rgb` must be 768 bytes (R, G, B × 256). */
  setPalette(rgb: Uint8Array): void;
  /**
   * Set the palette index that should render fully transparent (alpha = 0).
   * Pass `null` to disable; pixels of every index become opaque.
   */
  setTransparentIndex(index: number | null): void;
  /** Push an indexed-color framebuffer to the screen. */
  present(indexed: Uint8Array): void;
  /** Release any backing resources. */
  dispose(): void;
}
