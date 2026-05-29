/**
 * SCUMM v5 object verb-script parsing.
 *
 * # Layout
 *
 * An OBCD block holds three sibling children: CDHD (header), VERB
 * (verb-id → script table + the scripts themselves), and OBNA (name).
 * The VERB block's payload is:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ (verb_id u8, script_offset u16le) *           │  ← entry table
 *   │ verb_id = 0x00                                │  ← terminator
 *   │ <bytecode for verb A> <bytecode for verb B> … │  ← concatenated
 *   └──────────────────────────────────────────────┘
 *
 * `script_offset` is relative to the **start of the VERB block
 * header**, not its payload. Verified empirically against real MI1
 * (see `scratch/inspect-verb-block.ts`): for every object the smallest
 * offset resolves to exactly the byte after the entry table. Because
 * the VERB payload begins 8 bytes (the tag + size header) past the
 * block start, the payload-relative index is `script_offset - 8`.
 *
 * # Verb sharing
 *
 * Multiple verbs can point at the same offset (e.g. "look at" and
 * "use" both run one script that branches on the verb var). We don't
 * deduplicate — each verb id maps to a bytecode slice starting at its
 * offset and running to the end of the VERB payload. The VM stops at
 * the script's own stop opcode, so an over-long slice is harmless.
 *
 * # The default verb (0xFF)
 *
 * SCUMM's verb-dispatch convention: if an object lacks the requested
 * verb, the engine retries with verb id `0xFF` (the catch-all default
 * handler). {@link findVerbScript} implements that fallback.
 */

/** Verb id used as the catch-all default handler in SCUMM v5. */
export const DEFAULT_VERB = 0xff;

/**
 * Parse a VERB block payload into a `verbId → bytecode` map. Each
 * bytecode slice is a view into `payload` (no copy) running from the
 * verb's script offset to the end of the payload.
 *
 * Malformed entries (offset pointing into the header or past the
 * payload) are skipped rather than throwing — consistent with the
 * engine's lenient-on-real-data posture. An empty or header-only
 * payload yields an empty map.
 */
export function parseVerbScripts(payload: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  let i = 0;
  // Each table entry is 3 bytes (verb u8 + offset u16le); we need all
  // three present to read one. The terminator is a single 0x00 verb id.
  while (i + 2 < payload.length) {
    const verbId = payload[i]!;
    if (verbId === 0) break;
    const offset = payload[i + 1]! | (payload[i + 2]! << 8);
    const payloadIndex = offset - 8;
    if (payloadIndex >= 0 && payloadIndex < payload.length) {
      // First entry wins if a verb id repeats (shouldn't happen in
      // real data, but keep it deterministic).
      if (!out.has(verbId)) out.set(verbId, payload.subarray(payloadIndex));
    }
    i += 3;
  }
  return out;
}

/**
 * Resolve the bytecode to run for `verbId` against an object's parsed
 * verb map, applying the SCUMM default-verb (0xFF) fallback. Returns
 * `null` when neither the requested verb nor a default handler exists.
 */
export function findVerbScript(
  verbs: ReadonlyMap<number, Uint8Array>,
  verbId: number,
): Uint8Array | null {
  return verbs.get(verbId) ?? verbs.get(DEFAULT_VERB) ?? null;
}
