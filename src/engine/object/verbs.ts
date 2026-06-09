/** OBCD VERB-block parsing. See pages/docs/scumm/objects.md §6. */

/** Verb id used as the catch-all default handler in SCUMM v5. */
export const DEFAULT_VERB = 0xff;

/**
 * Parse a VERB payload into a `verbId → bytecode` map (views, no copy). Each
 * slice runs to the end of the payload — the VM stops at the script's own
 * stop opcode, and verbs sharing an offset is normal. Malformed entries are
 * skipped, not thrown.
 */
export function parseVerbScripts(payload: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  let i = 0;
  // 3-byte entries (verb u8 + offset u16le); terminator is a 0x00 verb id.
  while (i + 2 < payload.length) {
    const verbId = payload[i]!;
    if (verbId === 0) break;
    const offset = payload[i + 1]! | (payload[i + 2]! << 8);
    // script_offset is relative to the VERB block HEADER, which sits 8 bytes
    // (tag + size) before the payload — hence the -8.
    const payloadIndex = offset - 8;
    if (payloadIndex >= 0 && payloadIndex < payload.length) {
      // First entry wins if a verb id repeats — deterministic.
      if (!out.has(verbId)) out.set(verbId, payload.subarray(payloadIndex));
    }
    i += 3;
  }
  return out;
}

/** Resolve `verbId` with the 0xFF default-handler fallback; `null` when neither exists. */
export function findVerbScript(
  verbs: ReadonlyMap<number, Uint8Array>,
  verbId: number,
): Uint8Array | null {
  return verbs.get(verbId) ?? verbs.get(DEFAULT_VERB) ?? null;
}
