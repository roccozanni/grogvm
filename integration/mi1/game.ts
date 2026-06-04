/**
 * MI1 integration config — the per-game knobs the playthrough drives by.
 *
 * The engine is driven entirely by **numeric ids** (verb ids, object ids,
 * dialog-answer verb ids), which are game-structural: identical across the
 * IT/EN builds because the bytecode is the same — only the displayed string
 * resources are translated. So one suite covers the game, against any build.
 * Keep it that way: assert *mechanics*, never a localized string. Where a
 * test needs to check produced text, derive the expectation from the same
 * build (e.g. a dialog answer's own `name`), don't hardcode a translation.
 *
 * Ids are grouped by **room** (each `ROOMS.<name>` bundles its own id with the
 * objects/scripts that live there) plus a global {@link VERBS} group for the
 * cross-room verb ids. Add a room by adding an entry; add an object/script by
 * adding a field to its room — the playthrough reads them as `ROOMS.x.field`.
 *
 * These tests are NOT part of the default `npm test` run — they need the real
 * (copyrighted) game files. Launch with `npm run test:integration`; when the
 * data isn't present the suite skips via {@link hasGame}.
 */
import { bootScummV5, hasData, makeSeededRandom } from '../../src/testkit/scummv5';
import type { Vm } from '../../src/engine/vm/vm';

/** The build we run the playthrough against (IT — also carries the saves). */
export const DATA_DIR = 'games/MI1-IT-CD-DOS-VGA';

/**
 * Fixed RNG seed for the playthrough. Boot seeds the engine's entropy
 * source with this so the whole run is reproducible — a regression net
 * we run each session must not be flaky. Change only with reason.
 */
export const SEED = 0x6d6f6e6b; // "monk"

/** Whether the MI1 data is present (gate the suite on this). */
export const hasGame = (): boolean => hasData(DATA_DIR);

/** Boot MI1 to the title screen, seeded for a deterministic playthrough. */
export const boot = (): Vm => bootScummV5(DATA_DIR, 'MI1', makeSeededRandom(SEED));

/** Verb ids — global, not owned by any room (same in every build). */
export const VERBS = {
  /** "Esamina" / Look at. */
  look: 8,
  /** Default walk-to / use verb committed by a scene click. */
  walk: 11,
  /** "Open"-style verb (e.g. push the bar door before walking through). */
  open: 2,
  /** "Parla" / Talk to. */
  talk: 10,
} as const;

/** Per-room ids: each room's number + the objects/scripts that live there. */
export const ROOMS = {
  /** Mêlée Island lookout — the first interactive room the intro lands in. */
  meleeLookout: {
    id: 33,
    /** The election poster + a room-px point inside it. */
    poster: { x: 268, y: 104 },
    /** The SCUMM Bar door (exterior side) — walk through it to enter room 28. */
    barDoor: 428,
  },

  /** The SCUMM Bar interior (entered through the lookout's bar door). */
  scummBar: {
    id: 28,
    /**
     * The LOOM-ad salesman pirate. "Parla" (talk to, verb 10) — also his
     * default verb (g182) — runs his verb script, which starts the
     * conversation script #93 → the close-up {@link ROOMS.pirateCloseup}.
     */
    loomPirate: 333,
  },

  /** The LOOM-ad pirate close-up (reached by talking to {@link ROOMS.scummBar}'s
   *  `loomPirate`, whose verb script starts conversation script #93). */
  pirateCloseup: {
    id: 82,
    /** Dialog-answer verb ids (verb ids; their `name` is the localized line). */
    answers: {
      /** "Che bel cappello." / "Nice hat." */
      niceHat: 121,
      /**
       * "E' stato bello parlare con te." / "Nice talking to you." — the
       * goodbye option; picking it ends the close-up and returns to the
       * SCUMM Bar (room 28).
       */
      goodbye: 124,
    },
  },
} as const;
