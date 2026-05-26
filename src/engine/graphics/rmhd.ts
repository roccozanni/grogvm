/**
 * RMHD — Room header. Three 16-bit little-endian fields.
 */
export interface RoomHeader {
  readonly width: number;
  readonly height: number;
  readonly numObjects: number;
}

export function parseRmhd(payload: Uint8Array): RoomHeader {
  if (payload.length < 6) {
    throw new Error(`RMHD payload too short: ${payload.length} bytes (need ≥ 6)`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    width: view.getUint16(0, true),
    height: view.getUint16(2, true),
    numObjects: view.getUint16(4, true),
  };
}
