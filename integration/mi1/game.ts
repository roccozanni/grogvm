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
import { bootScummV5, hasData } from '../../src/testkit/scummv5';
import type { Vm } from '../../src/engine/vm/vm';

/** The build we run the playthrough against (IT — also carries the saves). */
export const DATA_DIR = 'games/MI1-IT-CD-DOS-VGA';

/** Whether the MI1 data is present (gate the suite on this). */
export const hasGame = (): boolean => hasData(DATA_DIR);

/** Boot MI1 to the title screen. */
export const boot = (): Vm => bootScummV5(DATA_DIR);

/** Verb ids — global, not owned by any room (same in every build). */
export const VERBS = {
  /** "Esamina" / Look at. */
  look: 8,
  /** Default walk-to / use verb committed by a scene click. */
  walk: 11,
  /** "Open"-style verb (e.g. push the bar door before walking through). */
  open: 2,
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
  },

  /** The LOOM-ad pirate close-up. */
  pirateCloseup: {
    id: 82,
    /** Conversation script that loads room 82 and arms the dialog verbs. */
    convoScript: 93,
    /** Dialog-answer verb ids (verb ids; their `name` is the localized line). */
    answers: {
      /** "Che bel cappello." / "Nice hat." */
      niceHat: 121,
    },
  },
} as const;
