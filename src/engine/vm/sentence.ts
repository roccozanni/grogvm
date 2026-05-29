/**
 * SCUMM v5 sentence queue.
 *
 * # The flow
 *
 * The verb UI doesn't run verb scripts directly. When the user commits
 * a verb + object(s) combo, the engine *enqueues a sentence* — a
 * `(verb, objectA, objectB)` triple. Each engine tick the sentence
 * driver checks the queue: if it's non-empty and the global sentence
 * script isn't already running, it pops the most-recent sentence and
 * starts that script with the triple as its first three locals. The
 * sentence script then walks the actor to the object, faces it, runs
 * the object's verb script, prints results, etc.
 *
 * Keeping it asynchronous (enqueue now, run on a later tick) is what
 * lets the walk-to / face / wait steps happen in the right order —
 * running the verb script straight off the click would skip them.
 *
 * # Stack, not FIFO
 *
 * The original engine treats `_sentence[]` as a stack: the
 * most-recently pushed sentence runs first (`_sentence[_sentenceNum-1]`,
 * then `_sentenceNum--`). We match that — a verb script that pushes a
 * follow-up sentence expects it to run before older queued ones.
 *
 * # The script id
 *
 * `VAR_SENTENCE_SCRIPT` (global 33) *holds the id of* the sentence
 * script — it is not the script id itself. MI1 boot writes 2 there.
 * The driver reads the var at runtime so we never hardcode the id.
 * (Confirmed empirically — see `scratch/inspect-sentence.ts`.)
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

/**
 * Verb id passed to `doSentence` to mean "clear the queue" rather than
 * "enqueue this". When the opcode sees this verb it drops all pending
 * sentences instead of pushing a new one.
 */
export const SENTENCE_CLEAR_VERB = 0xfe;
