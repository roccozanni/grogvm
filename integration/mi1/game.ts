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
 * objects/scripts that live there) plus global {@link VERBS} (verb ids) and
 * {@link VARS} (story/puzzle var ids) groups. Add a room by adding an entry;
 * add an object/script by adding a field to its room — the playthrough reads
 * them as `ROOMS.x.field`.
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

/**
 * Game-global var ids the playthrough asserts on (SCUMM globals — same in
 * every build). Engine-reserved vars (VAR_EGO, …) come from `vm/vars`; this
 * group is for MI1's own story/puzzle flags. Assert these instead of matching
 * localized dialog.
 */
export const VARS = {
  /**
   * The three-pirates conversation stage (g197). 0 before they've explained
   * the trials; flips to 1 once they have (and climbs as trials are
   * completed/reported later).
   */
  trialsLearned: 197,
  /**
   * The seagull's scare counter (g272). Each board-stomp bumps it; the third
   * makes the gull bolt. Confirms a stomp registered without poking script
   * internals.
   */
  gullScare: 272,
  /**
   * Pieces of eight — the player's money (g195). The Fettucini brothers'
   * human-cannonball payout adds 478 to it (object #488's verb-250 script:
   * `g195 += 478` then the coins go to ego). 0 until that payout.
   */
  money: 195,
} as const;

/** Verb ids — global, not owned by any room (same in every build). */
export const VERBS = {
  /** "Esamina" / Look at. */
  look: 8,
  /** Default walk-to / use verb committed by a scene click. */
  walk: 11,
  /** "Open"-style verb (e.g. push the bar door before walking through). */
  open: 2,
  /** "Prendi" / Pick up. */
  pickUp: 9,
  /** "Parla" / Talk to. */
  talk: 10,
  /** "Dai" / Give — two-object (Give X to <actor>). */
  give: 4,
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
    /**
     * "lo scoglio" (the cliff) — the room's west edge (x=0). A Walk-to
     * (verb 11) sentence on it runs the cliff's exit script → the cliff path
     * ({@link ROOMS.cliffPath}, room 38).
     */
    cliff: 426,
  },

  /**
   * The cliff path between the lookout and the Mêlée map — a short connector
   * room (steps back down, the path up, a sentry to look at / talk to).
   */
  cliffPath: {
    id: 38,
    /**
     * "il sentiero" (the path) — the top exit up to the Mêlée map
     * ({@link ROOMS.meleeMap}, room 85). Its verb table is [90, 255]: a
     * Walk-to (verb 11) isn't listed, so it falls back to the 0xFF/255
     * default entry, which runs the exit. (See `Vm.startVerbScript`.)
     */
    path: 487,
    /** "gli scalini" (the steps) — back down toward the lookout. */
    steps: 486,
    /** "la sentinella" (the sentry) — look-at / talk-to; not a gate. */
    sentry: 489,
  },

  /**
   * The Mêlée Island map — the travel hub. Each location is a verb-11 node;
   * clicking one walks the on-map figure there and loads that area.
   */
  meleeMap: {
    id: 85,
    /** "la zona disboscata" (the clearing) — the Fettucini brothers' camp. */
    clearing: 912,
    /** "l'osservatorio" (the lookout) — back to the lookout area. */
    lookout: 913,
    /** "il bivio" (the crossroads) — the town fork. */
    crossroads: 911,
  },

  /** The clearing (room 52) — the Fettucini circus camp. */
  clearing: {
    id: 52,
    /** "il tendone del circo" (the circus tent) — Walk-to (verb 11) enters
     *  the circus interior ({@link ROOMS.circus}, room 51). */
    circusTent: 621,
    /** "il sentiero" (the path) — back up to the map. */
    pathToMap: 622,
  },

  /**
   * The Fettucini circus interior (room 51). Entering auto-starts the
   * brothers' arguing conversation (local script #207); the player breaks in
   * and negotiates the human-cannonball job, ending in a 478-coin payout.
   *
   * Dialog answers are live verbs whose id is `120 + (optionIndex - 1)` within
   * the *current* menu, so the SAME id (esp. 120) recurs across menus — the
   * menus are sequential and separated by speech, so pick them in order. Each
   * verb's `name` is the localized line; we capture it (never hardcode a
   * translation) to prove the right option armed.
   */
  circus: {
    id: 51,
    fettuciniAnswers: {
      /** Menu 1 (the interrupt menu): ". . .ahem. . ." — break into the argument. */
      ahem: 120,
      /** Menu 2: "Quanto mi pagherete?" — ask the pay. */
      howMuchPay: 121,
      /** Menu 3: "OK, mi sembra buono." — accept the deal. */
      acceptDeal: 120,
      /** Menu 4: "Certo che ho un elmetto..." — claim the helmet (the pot we
       *  took in the kitchen); takes the cannon-launch branch. */
      haveHelmet: 120,
      /** Menu 5 (post-launch amnesia gag): "Sono Bobbin. Sei mia madre?" —
       *  either option leads to the payout. */
      amnesia: 120,
    },
    /**
     * A Fettucini brother — an ACTOR (id 3; brother 4 stands beside him).
     * After the helmet answer, control returns and the room's sentence
     * handler (local #200) waits for the pot to be GIVEN to a brother
     * (`actorFromPos == 3 or 4` + object 567) — that sets `bit#103` and
     * fires the cannon launch. Either brother works.
     */
    brotherActor: 3,
    /** "fuori" (outside) — the exit back to the clearing. */
    exit: 617,
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
    /**
     * The three important-looking pirates (one object, #322; rendered as
     * actor 3). "Parla" (verb 10) runs their conversation script #220
     * *inline* in the bar — no close-up room, unlike {@link loomPirate}.
     */
    threePirates: 322,
    /** Dialog-answer verb ids for the three-pirates conversation. */
    trialsAnswers: {
      /**
       * "Voglio diventare un pirata." — the real opener (vs. the two joke
       * options); the pirates then explain the three trials and {@link
       * VARS.trialsLearned} (g197) flips 0→1.
       */
      wantToBePirate: 122,
      /** "Beh, sarà meglio che vada via adesso." — goodbye; ends the
       *  conversation and hands control back in the bar. */
      goodbye: 127,
    },
    /**
     * Right-hand door → the kitchen ({@link ROOMS.kitchen}). The cook leaves
     * it open, so entry is a plain Walk-to (verb 11): its script runs the
     * walk-through transition (room-28 local #218 → `loadRoomWithEgo` 41).
     * Must be a verb sentence on the door — a bare floor click won't run it.
     */
    kitchenDoor: 316,
    /**
     * The cook — an ACTOR (not an object), id 6. Cycles: hidden in the
     * kitchen (~2000t), then out wandering the bar (~800t). The kitchen is
     * only enterable while he's out AND clear of the door (sweeps to x≈300);
     * heading in while he guards it gets kicked back (script 216).
     */
    cookActor: 6,
    /**
     * The left exit door → back out to the Mêlée Lookout (33). A Walk-to
     * (verb 11) sentence runs its `loadRoomWithEgo` 33. The FIRST exit also
     * fires a one-time cutscene (the Sheriff; through rooms 70→72) before
     * control lands at the lookout — so the room change takes a while.
     */
    exitDoor: 315,
  },

  /** The SCUMM Bar kitchen (entered through {@link ROOMS.scummBar}'s
   *  `kitchenDoor` once the cook is clear). */
  kitchen: {
    id: 41,
    /** On the kitchen floor — Pick up (verb 9) flips ownership room→ego. */
    meat: 566,
    pot: 567,
    /**
     * Out on the dock — guarded by the seagull. Its Pick up refuses ("the
     * bird will peck my hand") until the gull bolts: takeable only DURING the
     * fly-away, while the bird's class-6 guard is momentarily clear.
     */
    fish: 568,
    /** The dock door. Opening it unblocks the dock walkboxes, makes the fish
     *  touchable, and starts the gull watcher (local #203). */
    dockDoor: 564,
    /**
     * The loose board (#575). Walking onto its walk-to point scares the
     * seagull a notch; the gull watcher fires on ego's distance to it.
     */
    board: 575,
    /** #575's walk-to point — where ego must stand to stomp the board. */
    boardWalkTo: { x: 298, y: 134 },
    /** A floor point clear of the board, to step off between stomps. */
    offBoard: { x: 220, y: 130 },
    /** The seagull — an ACTOR (id 7). It bolts (x 252→310) on the 3rd stomp. */
    seagullActor: 7,
    /** Kitchen-side door back to the SCUMM Bar (28); Walk-to runs its
     *  `loadRoomWithEgo` 28. No cook gating on this side. */
    barDoor: 570,
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
