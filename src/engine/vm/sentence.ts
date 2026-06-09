/**
 * SCUMM v5 sentence queue — `(verb, objectA, objectB)` triples enqueued on
 * commit and run asynchronously by the sentence-script driver. A STACK, not
 * FIFO: the newest sentence runs first, matching the original. See
 * pages/docs/scumm/input.md.
 */

/** A pending sentence: a verb applied to up to two objects. */
export interface Sentence {
  /** Verb id (e.g. "look at", "use"). */
  readonly verb: number;
  /** Primary object id (0 = none). */
  readonly objectA: number;
  /** Secondary object id for two-object verbs like "use X with Y" (0 = none). */
  readonly objectB: number;
}

/** Verb id passed to `doSentence` meaning "clear the queue" rather than "enqueue this". */
export const SENTENCE_CLEAR_VERB = 0xfe;
