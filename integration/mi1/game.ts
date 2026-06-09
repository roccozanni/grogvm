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
import {
  bootScummV5,
  driveToRoom,
  driveUntil,
  hasData,
  makeSeededRandom,
  pickAnswer,
  use,
  walkTo,
} from '../../src/testkit/scummv5';
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
  /**
   * Insult-swordfighting cross-fight win tally (g282). Incremented in the
   * win/loss handler (global #74) each time a duel is *won* (winning exchanges
   * g263 exceed the per-duel threshold g351). The Sword Master only agrees to
   * fight once `g282 > 3` (room 61 #58) — i.e. four pirate duels won — at which
   * point a beaten pirate says "Sei bravo abbastanza per sfidare il Maestro
   * della Spada." This is the readiness gate the grind drives toward.
   */
  fightsWon: 282,
  /**
   * The insult the opponent most recently threw (g240) — set when the pirate
   * insults the player (global #83). On a player *reply* turn this is the
   * insult to counter; the winning comeback is {@link INSULT_COMEBACK}`[g240]`.
   */
  currentInsult: 240,
  /**
   * Duel mode (g285): 0 during the greeting menu (small talk / "prepare to
   * die" / leave), nonzero (3 in the pirate duels observed) once the insult
   * game is running. Used to tell the opener apart from the insult rounds.
   */
  duelMode: 285,
} as const;

/**
 * Insult-swordfighting mechanic — the data needed to play a duel deterministically.
 *
 * Extracted ground-truth from this build (see `scratch/insult-map.ts`): the duel
 * loop #90 builds its match table (string #37) from constants, and the matcher
 * #87 accepts comeback C against insult I iff C is in that table at I. Decoded,
 * the pirate insults (ids 1–15) are countered by the **same-numbered** comeback,
 * and the Sword Master's insults (16–33) reuse the pirate comebacks. The two
 * persistent "what you've learned" stores are bit arrays, NOT cleared between
 * duels: {@link INSULTS_LEARNED_BIT} (insults you can throw, set when a pirate
 * uses one on you, #83) and {@link COMEBACKS_LEARNED_BIT} (comebacks you can
 * use, set when a pirate replies with one, #82).
 *
 * `INSULT_COMEBACK[i]` = the comeback id that wins against insult `i`. Where an
 * insult has two valid answers, the first is listed.
 */
export const INSULT_COMEBACK: Readonly<Record<number, number>> = {
  // Pirate insults — identity: comeback i beats insult i.
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10,
  11: 11, 12: 12, 13: 13, 14: 14, 15: 15,
  // Sword Master insults — reuse pirate comebacks (insult 16+k → comeback k).
  16: 16, 17: 1, 18: 2, 19: 3, 20: 4, 21: 5, 22: 6, 23: 7, 24: 8, 25: 9,
  26: 10, 27: 11, 28: 12, 29: 13, 30: 14, 31: 15, 32: 16, 33: 16,
} as const;

/** Persistent bit array of insults the player has learned to throw (set in #83). */
export const INSULTS_LEARNED_BIT = 140;
/** Persistent bit array of comebacks the player has learned to use (set in #82). */
export const COMEBACKS_LEARNED_BIT = 222;

/** Verb ids — global, not owned by any room (same in every build). */
export const VERBS = {
  /** "Esamina" / Look at. */
  look: 8,
  /** "Apri" / Open (e.g. the bar door before walking through). */
  open: 2,
  /** "Prendi" / Pick up. */
  pickUp: 9,
  /** "Parla" / Talk to. */
  talk: 10,
  /** "Dai" / Give — two-object (Give X to <actor>). */
  give: 4,
  /** "Premi" / Push — e.g. ring the general-store bell. */
  push: 5,
  /** "Usa" / Use — two-object (Use X with Y), e.g. the shovel on the dig X. */
  use: 7,
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
    /**
     * "l'arco" (the arch) — the room's far-east edge (x≈984; room 33 is a
     * wide scrolling room). Clicking it carries ego east through into the
     * Mêlée town street ({@link ROOMS.meleeStreet}, room 35).
     */
    townArch: 427,
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
    /** "il ponte" (the bridge, #914) — the troll bridge ({@link trollBridge},
     *  room 57). Its verb-11 branches on which side ego stands; fresh from
     *  elsewhere it lands on the troll's side. */
    bridge: 914,
    /** "la casa" (the house, #916) — its verb-11 loads room 43
     *  ({@link house}). */
    house: 916,
    /**
     * "il villaggio" (the village). The node's verb-11 script branches on
     * story progress (g196 / a clutch of plot bits); early on — g196 still 0
     * through the trials — it lands ego in the lookout/town room 33, from
     * whose east arch ({@link ROOMS.meleeLookout}'s `townArch`) the town
     * street is reached. (Later progress reroutes it to the docks, room 83.)
     */
    village: 917,
    /**
     * "dal Maestro della Spada" (#918) — the Sword Master node. Its verb-11
     * walks the map figure over and `loadRoomWithEgo room=61` into her clearing
     * ({@link swordMaster}), where talking to her starts the swordfighting-trial
     * duel once the readiness gate (`g282 > 3`) is clear.
     */
    swordMaster: 918,
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
     * it open, so a click on it walks ego through (its default action runs the
     * room-28 local #218 → `loadRoomWithEgo` 41 transition). The click must
     * land on the door object — a bare floor click beside it won't run it.
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

  /**
   * The Mêlée town street (room 35) — the shop-lined Low Street reached from
   * the lookout's east arch. Here the player buys the treasure map off a
   * citizen and ducks into the Voodoo Lady's; two arches lead on (west back
   * to the lookout, north-east to the general-store street, room 34).
   */
  meleeStreet: {
    id: 35,
    /**
     * "Il cittadino di Mêlée" (the Mêlée citizen) — an OBJECT (#441), not an
     * actor. Talk to (verb 10) runs his conversation (#218); the right opener
     * gets him to sell the treasure map.
     */
    citizen: 441,
    citizenAnswers: {
      /**
       * "No, ma una volta avevo un barbiere chiamato Dominique." — the cousin-
       * Dominique opener; it turns the chat to the map he's holding and arms
       * the buy menu. (The other openers dead-end.)
       */
      dominique: 123,
      /** "La prendo. Sarà un regalo stupendo." — buy it; the map (#442) goes
       *  to ego for 100 pieces of eight. */
      takeMap: 121,
    },
    /** "la mappa" (the map) — enters inventory when the citizen sells it. */
    map: 442,
    /**
     * "la porta" (#444) → the Voodoo Lady ({@link ROOMS.voodooShop}, room 29).
     * Open it (verb 2) then click it to walk through, like the bar door.
     */
    voodooDoor: 444,
    /** "l'arco" (#451) → the general-store street ({@link ROOMS.storeStreet},
     *  room 34); click to walk through. */
    storeArch: 451,
    /**
     * "l'arco" (#450) — the west arch back to the lookout/town room
     * ({@link ROOMS.meleeLookout}, room 33). Its verb-11 branches on plot bits
     * (later it reroutes to the docks, room 83); early on — those bits clear —
     * it lands ego at room 33's east arch (#427). The return leg of the trip
     * out to the shops.
     */
    lookoutArch: 450,
  },

  /** The Voodoo Lady's shop (room 29), entered through the street's
   *  `voodooDoor`. */
  voodooShop: {
    id: 29,
    /** "il pollo" (the chicken, #377) — Pick up (verb 9) flips it to ego. */
    chicken: 377,
    /** "la porta" (#367) → back out to the street (room 35); click to exit. */
    door: 367,
  },

  /**
   * The general-store street (room 34) — a wide scrolling street off the
   * town's north-east arch, with the store, the Governor's-mansion approach
   * and an alley. We only transit it to the store and back.
   */
  storeStreet: {
    id: 34,
    /**
     * "il palazzo del Governatore" (#431) — the mansion in the street's far
     * background. Walk-to (verb 11) is a straight `loadRoomWithEgo room=36`,
     * carrying ego up to the mansion gate ({@link governorMansion}, room 36),
     * where the piranha poodles guard the door. (Clicking the dogs themselves,
     * #439, just chains to this same script.)
     */
    mansion: 431,
    /**
     * "la porta" (#437) → the general store ({@link ROOMS.store}, room 30).
     * Approach it, Open it (verb 2 — its handler only fires with ego at the
     * door), then click it to walk through.
     */
    storeDoor: 437,
    /**
     * "l'arco" (#433) — the far-east arch back to the Mêlée town street
     * ({@link ROOMS.meleeStreet}, room 35); click to walk through. (Early on
     * bit#453, the church-detour gate, is clear, so it just loads room 35.)
     */
    townArch: 433,
    /** "l'entrata" (#434) — the prison entrance. Walk-to (verb 11) →
     *  `loadRoomWithEgo obj=400 room=31`, dropping ego inside the jail
     *  ({@link prison}, room 31) where Otis is locked up. */
    prison: 434,
  },

  /**
   * The general store (room 30). The sword and shovel sit out on display;
   * grabbing them and ringing the bell brings the shopkeeper, who makes you
   * pay through a buy conversation.
   */
  store: {
    id: 30,
    /** "la spada" (the sword, #388) — Pick up (verb 9). */
    sword: 388,
    /** "la pala" (the shovel, #396) — Pick up (verb 9). */
    shovel: 396,
    /** "il campanello" (the bell, #399) — Push (verb 5) summons the
     *  shopkeeper out. */
    bell: 399,
    /** "il negoziante" (the shopkeeper, #394) — an OBJECT. Talk to (verb 10)
     *  opens the buy conversation. */
    shopkeeper: 394,
    /**
     * Buy-conversation answer verb ids. The menu reuses ids across stages
     * (120/121 recur), so pick them in order — the harness sequences by the
     * verb leaving the menu between picks. Sword costs 100, shovel 75.
     */
    buyAnswers: {
      /** Top menu: "Si tratta della spada^" — bring up the sword. */
      aboutSword: 120,
      /** Top menu: "Si tratta della pala^" — bring up the shovel. */
      aboutShovel: 121,
      /** Sub-menu: "La voglio." — buy the item just brought up. */
      wantIt: 120,
      /**
       * "Avrei bisogno d'una mentina per l'alito." — buy the breath mint
       * ({@link mint}, #395) for 1 piece of eight. This option is GATED: it
       * only arms after Otis has been spoken to (the prison sets {@link
       * ROOMS.prison}'s `talkedBit`, bit#420), which is what unlocks the
       * mint line in the shopkeeper's tree.
       */
      breathMint: 124,
      /** "Vorrei dare un'occhiata in giro." — ends the chat, control back. */
      lookAround: 125,
    },
    /** "la mentina" (#395) — the breath mint, bought via {@link
     *  buyAnswers}.`breathMint`; given to Otis to settle his death-breath so he
     *  trades the cake. */
    mint: 395,
    /** "la porta" (#387) → back out to the street (room 34); Open (verb 2)
     *  then click to walk through. */
    door: 387,
  },

  /**
   * The Governor's mansion gate (room 36), reached from the store street's
   * "il palazzo del Governatore" ({@link storeStreet}'s `mansion`, #431). Three
   * piranha poodles guard the door; the thievery trial is to get past them
   * (the yellow petal {@link ROOMS.forest}'s `yellowPetal` is their sedative)
   * and into the mansion to steal the idol.
   */
  governorMansion: {
    id: 36,
    /**
     * "i cani piranha letali" (#467) — the three guard dogs. Giving them the
     * drugged meat ({@link ROOMS.kitchen}'s `meat` once dressed with the petal)
     * runs the dogs' verb-80 → room-local #201, which checks the drugged class
     * and sets {@link dogsAsleepBit}; the dogs are renamed "i cani piranha che
     * dormono" and the door is passable.
     */
    dogs: 467,
    /** `bit#15` — the dogs-asleep flag (#201 sets it once they eat the drugged
     *  meat). The gate for getting past them into the mansion. */
    dogsAsleepBit: 15,
    /**
     * "la porta" (#465) — the mansion gate door. Once the dogs are drugged
     * asleep (#201 unlocks the pen boxes + sets the door's class), Open it
     * (verb 2 → global #25 swings it to state 1) then Walk to it (verb 11 →
     * `loadRoomWithEgo obj=633 room=53`) to step into the mansion interior
     * ({@link governorInterior}).
     */
    door: 465,
    /** "il sentiero" (#466) — the path back out to the general-store street
     *  ({@link storeStreet}, room 34); verb-11 is a straight `loadRoomWithEgo
     *  obj=431 room=34`. The route to the prison for the file. */
    path: 466,
  },

  /**
   * The Governor's mansion interior (room 53), entered through the gate door
   * ({@link governorMansion}'s `door`, ego arrives at the interior door #633).
   * The idol ("l'idolo favoloso", #635) sits behind a booby-trap gauntlet; the
   * thievery trial plays out here across several cutscenes (grab via the hole,
   * the Sheriff's catch).
   */
  governorInterior: {
    id: 53,
    /**
     * "la porta" (#633) — the interior side of the gate door, back out to the
     * mansion gate ({@link governorMansion}, room 36). Verb 2 branches: if ego
     * already holds the idol (#635) it runs the Sheriff catch (#217) instead of
     * letting you leave.
     */
    entryDoor: 633,
    /**
     * "la porta" (#632) — the right-hand door. Open it (verb 2), then Walk to
     * it (verb 11): with the door open its verb-11 runs the booby-trap gauntlet
     * cutscene (local #210), which arms the joke items and hands ego four of
     * them — {@link styleManual} #641, {@link waxLips} #642, {@link
     * stapleRemover} #643 and {@link ratRepellent} #640 — then returns control.
     */
    rightDoor: 632,
    /** "la finestra rotta" (#638) — the broken window. Its own verbs all warn
     *  "careful not to cut myself"; the hole you actually go through is the
     *  {@link hole} (#637) beside it. */
    brokenWindow: 638,
    /**
     * "lo spioncino" (#637) — the hole in the wall. Walk-to (verb 11, a bare
     * click) is its only verb: it checks ego holds the file, then runs the grab
     * cutscene (local #211) — Guybrush reaches through the gauntlet and the
     * cutscene `pickupObject`s the idol (#635) into inventory. ("Enter the hole
     * in the wall" with the file.)
     */
    hole: 637,
    /** "l'idolo favoloso" (#635) — the idol, the thievery-trial prize. Not
     *  directly pickable; the grab cutscene #211 `pickupObject`s it. */
    idol: 635,
    /** "il repellente per roditori" (#640) — rat repellent; one of the gauntlet
     *  items, traded to Otis in the prison for the cake. */
    ratRepellent: 640,
    /** "Il Manuale dello Stile" (#641) — gauntlet joke item. */
    styleManual: 641,
    /** "le labbra di cera" (#642) — gauntlet joke item. */
    waxLips: 642,
    /** "il togli-graffette" (#643) — gauntlet joke item. */
    stapleRemover: 643,
    /**
     * The grab cutscene (#211) runs straight into the Sheriff/Governor catch
     * (#212): an excuse menu, then the smitten-stammer cascade in the Governor's
     * close-up (room 23) — all don't-care options (pick any). Control then
     * returns in the mansion; trying to leave via {@link entryDoor} (#633) with
     * the idol runs the Sheriff block (#217), whose taunt menu offers this:
     * verb 122 "…ma stai bloccando l'uscita" — provoking Fester to dump ego (and
     * the idol) into the harbor.
     */
    festerBlockingExit: 122,
  },

  /**
   * The sea bottom (room 42) — where Fester throws ego, tied to the idol, after
   * the mansion theft. The idol here is a fresh object ("l'idolo meraviglioso",
   * #578) with a real Pick up verb (9); grabbing it is the thievery prize. The
   * floor is littered with sharp things (saw/knife/scissors/cleaver/axe/sword)
   * for the rope-cutting escape that follows.
   */
  seaBottom: {
    id: 42,
    /** "l'idolo meraviglioso" (#578) — Pick up (verb 9) to recover the idol. Its
     *  verb-9 (#203) grabs it AND auto-climbs the ladder, surfacing ego on the
     *  Mêlée docks ({@link docks}, room 83). */
    idol: 578,
  },

  /**
   * The Mêlée docks (room 83) — ego surfaces here after the underwater escape.
   * A dockside conversation about the Governor's kidnapping runs; declaring the
   * rescue plan ("get a crew and a ship") closes out Part I's setup and sends
   * the player off to find a ship.
   */
  docks: {
    id: 83,
    /**
     * Dialog answer "Andrò a procurarmi un equipaggio ed una nave e la salverò"
     * (#123) — the "I'll get a crew and a ship" vow. Picking it ends the
     * conversation and sets {@link questDeclaredBit}.
     */
    getCrewAndShip: 123,
    /** `bit#304` — set when the rescue is vowed (#123); the Part-I-into-II
     *  quest flag (also read by other rooms' ENCD, e.g. the jail). */
    questDeclaredBit: 304,
  },

  /**
   * The Mêlée jail (room 31), reached from the store street's "l'entrata"
   * ({@link storeStreet}'s `prison`, #434). Otis the prisoner is locked in a
   * cell; he has Aunt Tillie's carrot cake with a file baked in. The trade is a
   * two-step bribe: settle his death-breath with a mint, then give him the rat
   * repellent — he hands over the cake, which opens to the file ("la lima")
   * needed to grab the idol. (Rats scurry the cell — three same-box-frame
   * animation loops, local #207.)
   */
  prison: {
    id: 31,
    /** "l'entrata" (#400) — the exit, back out to the store street (room 34). */
    entrance: 400,
    /**
     * "il prigioniero" (#405) — Otis, also ACTOR 4 (the give-target is the
     * object id). Talk to him (verb 10) once, near the bars: he runs his
     * monologue (he's a victim of society; his breath is awful) and sets {@link
     * talkedBit} — which unlocks the breath-mint line at the store. Giving him
     * an item routes to his verb-80 → room-local #203.
     */
    prisoner: 405,
    /** Otis as an ACTOR (id 4) — used to find a floor point by the bars to walk
     *  to before talking / giving (he sits at the far-left cell). */
    prisonerActor: 4,
    /** `bit#420` — set the first time Otis is spoken to; the gate that arms the
     *  store's breath-mint dialog option. */
    talkedBit: 420,
    /**
     * "la torta" (#420) — Aunt Tillie's carrot cake, handed over after Otis gets
     * his mint + rat repellent. Open it (verb 2) and it renames to "la lima"
     * (the file) — the file for the idol grab.
     */
    cake: 420,
    /** Class 3 (bit 2) on {@link cake} — SET when the cake is opened into the
     *  file (the verb-2 `actorSetClass` clears class 6 and sets class 3).
     *  Asserted instead of the localized "la lima" rename. */
    cakeIsFileClassBit: 2,
  },

  /**
   * The forest maze (room 218 — the entry, reached from the map's crossroads
   * node #911). It's a single screen of graphics (backed by room 58) re-dressed
   * as twenty pseudo-rooms 201–220: the engine's pseudo-room alias table maps
   * them all to room 58, and `g4` (VAR_ROOM) holds which one you're standing in.
   *
   * Each visible path is one "il sentiero" object whose verb-11 is a giant
   * switch on `g4` → `loadRoomWithEgo` the next pseudo-room. The SAME object id
   * is the SAME conceptual direction on every screen (re-positioned per screen
   * via SO_AT, so {@link objectPoint} tracks where it actually draws). Three
   * directions, fixed by object id:
   *   • back  = #685 (also #686, a duplicate hot-region that defers to #685)
   *   • left  = #688
   *   • right = #687
   * From the entry (218) the path `back, left, right, left, right, back, right,
   * left, back` threads out to the treasure-dig clearing ({@link forestDig},
   * room 64); other turns loop or dump you back at the map. A different route
   * (`back, back, right, right, left, back`) reaches the sword-master fork
   * (pseudo-room 209), whose right path leads on to the Sword Master ({@link
   * swordMaster}, room 61). (Each route and the pseudo-room it lands in at every
   * step live with its navigation beat.)
   */
  forest: {
    id: 218,
    back: 685,
    left: 688,
    right: 687,
    /**
     * "l'insegna" (the signpost, #681) at the sword-master fork (209). Push
     * (verb 5) runs its local #203: it drops the dead tree-trunk into a bridge
     * (setBoxFlags unblocks the box, `startScript 205` plays the fall) and sets
     * `bit#546`. Only then is the right path ({@link right}, #687) walkable
     * across to the Sword Master. Pushing again toggles it back (local #204).
     */
    signpost: 681,
    /** `bit#546` — set once the signpost's push has dropped the trunk-bridge;
     *  the gate to wait on before crossing the right path to room 61. */
    bridgeBit: 546,
    /**
     * The yellow-flower screen — pseudo-room 215, one `back` step in from the
     * entry (218). It's the ONE forest screen whose flowers are yellow (every
     * other screen has "gli stessi vecchi fiori rossi" — the same old red
     * flowers); the per-screen distinction is `g4==215`, which the plant's
     * scripts gate on.
     */
    flowerScreen: 215,
    /**
     * "le piante" (the plants, #678). In the flower screen (`g4==215`) Pick up
     * (verb 9) runs `pickupObject 689` — the yellow petal into inventory; on
     * any other forest screen it refuses ("...non è degno di un pirata"). Also
     * gated on not already holding the petal ("Ne ho già uno."). The petal
     * itself (#689) carries no Pick up verb — the plant is how you get it.
     */
    flowerPlant: 678,
    /** "il petalo giallo" (the yellow petal, #689) — what picking {@link
     *  flowerPlant} hands ego; the sedative for the mansion's guard dogs in the
     *  thievery trial. */
    yellowPetal: 689,
  },

  /**
   * The treasure-dig clearing (room 64), at the end of the {@link forest} maze.
   * Use (verb 7) the shovel ({@link ROOMS.store}'s `shovel`, #396) on the X
   * (#749) → the dig cutscene (local #200) plays out "Passano ore" and hands
   * ego the buried treasure: object #752, the joke T-shirt.
   */
  forestDig: {
    id: 64,
    /** "X" (#749) — the dig spot. Use the shovel on it (its verb-7 checks the
     *  partner is the shovel #396, then runs the dig script #200). */
    x: 749,
    /** "la T-shirt" (#752) — the treasure; the dig cutscene `pickupObject`s it
     *  into ego's inventory. */
    tshirt: 752,
    /** "il sentiero nella foresta" (#750) — the path out. Its verb-11 is a
     *  straight `loadRoomWithEgo obj=911 room=85`: back up to the Mêlée map,
     *  landing on the crossroads node. */
    pathToMap: 750,
  },

  /**
   * The Sword Master's clearing (room 61), reached from the forest's
   * sword-master fork ({@link forest}, pseudo-room 209): push the signpost to
   * drop the trunk-bridge, then take the right path. Object #744 ("Il Maestro
   * della Spada") is the Sword Master herself — present here, though hidden
   * until later story (the entry hides her via class while `bit#89` is clear).
   * Reaching this room is the discovery: the location is now known for the
   * swordfighting trial later.
   */
  swordMaster: {
    id: 61,
    /** "Il Maestro della Spada" (#744) — the Sword Master (Carla). Talk to her
     *  (verb 10) once `g282 > 3` to start the trial duel: her verb script runs
     *  #116 → `startScript 73 [1,58]` (#58 sets duel mode `g285=2`, pirate-
     *  attack), then #90 drives the fight in {@link duelRoom}. */
    master: 744,
    /** "il sentiero" (#743) — the path out. It has no walk verb, so a bare
     *  click falls to its default (verb 255) → back to the Mêlée map. */
    path: 743,
    /** Room the duel itself plays in (#116 `loadRoom 44`); the talk first plays
     *  an intro cutscene in the close-up room 62, then the fight runs here. */
    duelRoom: 44,
    /** bit#20 — set once Carla has been fought (#116 gates on it being clear).
     *  Beating her sets it; the trial is complete on the win. */
    foughtBit: 20,
  },

  /**
   * The troll bridge (room 57) — reached from the map's "il ponte" node
   * ({@link meleeMap}'s `bridge`). A troll (actor 5, rendered as object #655)
   * blocks the span; he wants "una cosa rossa" — the red herring (the kitchen
   * fish, {@link ROOMS.kitchen}'s `fish` #568). Giving it (the two-object
   * "Dai" sentence to the troll) runs local #204: "Un'aringa rossa! ... Passa!",
   * unblocks the bridge boxes, and walks ego across — landing back on the map
   * on the far side. The fish ends owned by the troll (owner 14).
   */
  trollBridge: {
    id: 57,
    /** The troll — an ACTOR (id 5). Give the red herring TO him. */
    trollActor: 5,
  },

  /**
   * "la casa" (room 43) — Captain Smirk's place, reached from the map's `house`
   * node. Knocking (Open the door) starts Smirk's doorway conversation (global
   * #57): negotiate the swordfighting lesson, pay 30, and ego is sent into the
   * gym ({@link smirkGym}, room 60) for the lesson.
   */
  house: {
    id: 43,
    /** "la porta" (#591) — knock by Opening it (verb 2); starts global #57. */
    door: 591,
    /** bit#483 — the swordfighting-lesson flag, set once the lesson is taken;
     *  it gates Smirk's post-lesson dialog branch. */
    lessonTakenBit: 483,
    /** "il sentiero" (#592) — the lower path; a bare click walks ego back out
     *  to the Mêlée map (room 85). (Room 43 has a second "il sentiero", #594,
     *  the upper one; #592 is the map exit.) */
    pathToMap: 592,
  },

  /**
   * Captain Smirk's training gym (room 60) — entered mid-cutscene after the
   * doorway negotiation. The insult-swordfighting lesson plays here; with no
   * real comebacks learned yet, two insults end the lesson and boot Guybrush
   * back outside the house (room 43).
   */
  smirkGym: {
    id: 60,
  },

  /**
   * The pirate-duel close-up (room 49) — where on-map insult swordfights play
   * out. A wandering pirate on the map (local #202) that closes on ego fires
   * global #114, which `loadRoom 49`, sets up ego (#1) vs the pirate, and runs
   * the duel via #73/#90; when it ends, ego is returned to the map (room 85).
   * The trade-insults UI is dialog verbs (120+, like other menus). See
   * {@link INSULT_COMEBACK} for the pick logic.
   */
  pirateDuel: {
    id: 49,
    /**
     * West-of-the-fork map spots to wander between to provoke an encounter.
     * Pirates spawn at random map positions and walk toward random nodes; a
     * duel fires when one reaches ego. Idling at the east/house edge stays
     * cold for tens of thousands of ticks, but cycling these west spots
     * (near the fork node #911 @ 72,88) reliably bumps a pirate within a few
     * thousand ticks (confirmed: `scratch/stumble.ts`). Ego snaps to the
     * map's narrow walkboxes, so these are click *targets*, not exact parks.
     */
    westSpots: [
      { x: 50, y: 95 },
      { x: 72, y: 100 },
    ],
  },
} as const;

// ── Insult-swordfight driving ─────────────────────────────────────────────
// MI1-specific helpers to drive a pirate duel, kept here so the walkthrough
// reads as plain beats. A duel is dialog verbs (120+): menu slot `k` (1-based)
// is verb `119+k` and the insult/comeback id behind it is `VAR(166+k)` (the
// menu-builders #75/#89 write `g166[k]` and id-name them; confirmed via
// scratch/duel-introspect.ts). One duel = provoke → open → trade.
const DUEL_OPENER = 127; // "Mi chiamo Guybrush Threepwood. Preparati a morire!"
const DUEL_SURRENDER_INSULT = 37; // "Mi arrendo, vinci tu!" — picking it forfeits
// The duel menu is a 6-wide sliding window over the learned insults/comebacks;
// these verbs page it (confirmed scratch/carla-scrollprobe.ts).
const DUEL_SCROLL_UP = 109; // toward lower ids
const DUEL_SCROLL_DOWN = 110; // toward higher ids

const duelArmed = (vm: Vm): number[] => {
  const out: number[] = [];
  for (let v = 120; v <= 130; v++) if (vm.verbs.get(v)?.state === 'on') out.push(v);
  return out;
};
const duelBackingId = (vm: Vm, verb: number): number => vm.vars.readGlobal(166 + (verb - 119));

/** Step 1 — ping-pong the west-of-fork spots until a wandering pirate closes on
 *  ego and the duel loads (room 49). Bounded retry; returns whether it fired. */
export function provokeDuel(vm: Vm): boolean {
  const spots = ROOMS.pirateDuel.westSpots;
  for (let leg = 0; leg < 12; leg++) {
    walkTo(vm, spots[leg % spots.length]!);
    if (driveToRoom(vm, ROOMS.pirateDuel.id, { maxTicks: 4000 })) return true;
  }
  return false;
}

/** Step 2 — the greeting menu: pick "Preparati a morire!" to start the insult
 *  game (duel mode {@link VARS.duelMode}/g285 flips 0 → nonzero). */
export function openDuel(vm: Vm): void {
  driveUntil(vm, (v) => v.verbs.get(DUEL_OPENER)?.state === 'on', { maxTicks: 8000 });
  pickAnswer(vm, DUEL_OPENER);
  driveUntil(vm, (v) => v.vars.readGlobal(VARS.duelMode) !== 0, { maxTicks: 4000 });
}

/** Step 3 — trade insults round by round until the duel resolves (ego back on
 *  the map): the winning comeback for the current insult ({@link INSULT_COMEBACK}
 *  of {@link VARS.currentInsult}) if it's offered — that wins the exchange, and
 *  on our own attack turn the same id is just a valid insult to throw — else any
 *  non-surrender option (lose but LEARN the comeback). Never the surrender line.
 *  Capped so a misread can't hang. */
export function tradeInsults(vm: Vm): void {
  for (let round = 0; round < 40; round++) {
    driveUntil(vm, (v) => v.currentRoom !== ROOMS.pirateDuel.id || duelArmed(v).length > 0, {
      maxTicks: 8000,
    });
    if (vm.currentRoom !== ROOMS.pirateDuel.id) return; // duel over
    const options = duelArmed(vm);
    if (options.length === 0) return; // stuck — caller asserts the failure
    const want = INSULT_COMEBACK[vm.vars.readGlobal(VARS.currentInsult)];
    const safe = options.filter((v) => duelBackingId(vm, v) !== DUEL_SURRENDER_INSULT);
    const pick = safe.find((v) => duelBackingId(vm, v) === want) ?? safe[0] ?? options[0]!;
    pickAnswer(vm, pick);
    driveUntil(vm, (v) => v.verbs.get(pick)?.state !== 'on', { maxTicks: 4000 });
  }
}

// ── Learned-state truth & lose-to-learn grind ────────────────────────────
// The game's own counters g308/g309 (#160/#161) are the menu-rebuild scratch,
// NOT cumulative learned totals — they SHRINK between reads. The source of
// truth is the persistent bit arrays themselves.
const readLearned = (vm: Vm, base: number): number[] => {
  const out: number[] = [];
  for (let id = 1; id <= 33; id++) if (vm.vars.readBit(base + id)) out.push(id);
  return out;
};
/** Insults the player can throw (bit#140), the source of truth. */
export const learnedInsults = (vm: Vm): number[] => readLearned(vm, INSULTS_LEARNED_BIT);
/** Comebacks the player can use (bit#222), the source of truth. */
export const learnedComebacks = (vm: Vm): number[] => readLearned(vm, COMEBACKS_LEARNED_BIT);

/** In a pirate duel (full mode g285=3) we DEFEND when the turn marker g288 holds
 *  the opponent (g270); otherwise we ATTACK. (Validated against the #83-runs
 *  signal, scratch/check-turn.ts.) */
const duelDefending = (vm: Vm): boolean =>
  vm.vars.readGlobal(288) === vm.vars.readGlobal(270);

/** Scroll the 6-wide duel window (it pages 6 entries at a time) until `target`
 *  — an insult on attack, a comeback on defense — is visible, then return its
 *  verb (or undefined if it can't be paged into view). Performs the scroll picks
 *  itself; harmless when the menu doesn't page. */
const duelScrollTo = (vm: Vm, target: number): number | undefined => {
  const find = (): number | undefined =>
    duelArmed(vm).find((v) => duelBackingId(vm, v) === target);
  for (let guard = 0; find() === undefined && guard < 24; guard++) {
    const window = duelArmed(vm).map((v) => duelBackingId(vm, v));
    if (window.length === 0) break;
    const dir =
      target < Math.min(...window) ? DUEL_SCROLL_UP
      : target > Math.max(...window) ? DUEL_SCROLL_DOWN
      : 0;
    if (dir === 0 || vm.verbs.get(dir)?.state !== 'on') break;
    const before = window.join(',');
    pickAnswer(vm, dir);
    driveUntil(vm, (v) => duelArmed(v).map((x) => duelBackingId(v, x)).join(',') !== before, {
      maxTicks: 3000,
    });
  }
  return find();
};

/** The comeback set the swordfighting trial drives toward — every comeback the
 *  Sword Master's insults (16..33) can map to (1..16). We control the seed, so
 *  rather than chase a generic minimum the grind targets this fixed set; learning
 *  a superset of whatever Carla actually draws makes her duel winnable regardless
 *  of her draw order. For pirate insults the comeback id EQUALS the insult id
 *  (INSULT_COMEBACK[i]=i), so to learn comeback c we throw insult c. */
const TARGET_COMEBACKS: readonly number[] = Array.from({ length: 16 }, (_, i) => i + 1);

/** Lose-to-learn pick for one duel menu, with paging. On ATTACK, throw the
 *  lowest TARGET comeback we still lack (whose insult we know), SCROLLING the
 *  attack menu to reach it — the high insults 12..16 sit on later pages, so a
 *  no-scroll picker never throws them and never learns those comebacks. The
 *  pirate's counter then teaches that comeback (#82) and the lost exchange flips
 *  us to DEFENSE, where the pirate insults us and we learn a new insult (#83).
 *  On DEFENSE, scroll to the winning comeback and counter if known; else take the
 *  hit (the insult's already learned). Never surrenders. */
const losePick = (vm: Vm): number => {
  const knownIns = new Set(learnedInsults(vm));
  const knownCb = new Set(learnedComebacks(vm));
  const fallback = (): number =>
    duelArmed(vm).find((v) => duelBackingId(vm, v) !== DUEL_SURRENDER_INSULT) ?? duelArmed(vm)[0]!;
  if (duelDefending(vm)) {
    const want = INSULT_COMEBACK[vm.vars.readGlobal(VARS.currentInsult)];
    if (want !== undefined && knownCb.has(want)) {
      const v = duelScrollTo(vm, want);
      if (v !== undefined) return v;
    }
    return fallback();
  }
  const stillNeeded = TARGET_COMEBACKS.filter((c) => !knownCb.has(c) && knownIns.has(c)).sort(
    (a, b) => a - b,
  );
  for (const c of stillNeeded) {
    const v = duelScrollTo(vm, c);
    if (v !== undefined) return v;
  }
  // Nothing left to learn this turn — throw any known insult to keep the duel going.
  for (const i of [...knownIns].filter((x) => x >= 1 && x <= 16).sort((a, b) => a - b)) {
    const v = duelScrollTo(vm, i);
    if (v !== undefined) return v;
  }
  return fallback();
};

/** Play ONE provoked pirate duel lose-to-learn, all the way back to the map.
 *  Drives the greeting opener, the g285=3 exchanges, and the post-gate "Sei
 *  bravo abbastanza" conversation (exit via its last option) uniformly. Returns
 *  whether a pirate was found and the duel resolved back on the map. */
export function grindOneDuel(vm: Vm): boolean {
  if (!provokeDuel(vm)) return false;
  for (let step = 0; step < 120; step++) {
    driveUntil(
      vm,
      (v) =>
        v.currentRoom === ROOMS.meleeMap.id ||
        v.verbs.get(DUEL_OPENER)?.state === 'on' ||
        duelArmed(v).length > 0,
      { maxTicks: 8000 },
    );
    if (vm.currentRoom === ROOMS.meleeMap.id) return true;
    if (vm.verbs.get(DUEL_OPENER)?.state === 'on') {
      pickAnswer(vm, DUEL_OPENER);
      driveUntil(vm, (v) => v.verbs.get(DUEL_OPENER)?.state !== 'on', { maxTicks: 4000 });
      continue;
    }
    const opts = duelArmed(vm);
    if (opts.length === 0) continue;
    // In the insult game (g285 nonzero) play lose-to-learn; in the post-gate
    // conversation (mode 0) exit via the last option.
    const pick = vm.vars.readGlobal(VARS.duelMode) !== 0 ? losePick(vm) : opts[opts.length - 1]!;
    pickAnswer(vm, pick);
    driveUntil(vm, (v) => v.verbs.get(pick)?.state !== 'on' || v.currentRoom === ROOMS.meleeMap.id, {
      maxTicks: 6000,
    });
  }
  return vm.currentRoom === ROOMS.meleeMap.id;
}

/** Readiness floor for the Sword Master. She only throws ~5 insults (the duel is
 *  best-of-5), so the *minimum* we'd need is just those comebacks — but we can't
 *  pin them: the gate's stop-point shifts the RNG at her duel, which changes
 *  which insults she draws (the grind & duel share the seeded stream). So this is
 *  a deliberately generous, LATE-tripping set — its hardest members (12/15/16 are
 *  learned last) guarantee the easy comebacks are in by trip time, leaving margin
 *  to win 5–0 rather than scraping a 5–1. (Comeback 9 is the one the pirate pool
 *  never teaches on this seed; she doesn't need it.) Tighter sets still win but
 *  with a one-exchange margin — see PROGRESS for the tradeoff. */
const SWORD_MASTER_NEEDED: readonly number[] = [2, 3, 4, 5, 6, 8, 12, 13, 14, 15, 16];
/** Ready to face the Sword Master: every comeback her seeded duel demands is
 *  learned AND the readiness gate (`g282 > 3`, four duels won) is clear. */
export const enoughForSwordMaster = (vm: Vm): boolean => {
  const have = new Set(learnedComebacks(vm));
  return SWORD_MASTER_NEEDED.every((c) => have.has(c)) && vm.vars.readGlobal(VARS.fightsWon) > 3;
};

/** Defense pick for the Sword Master: page the 6-wide comeback window (scroll
 *  verbs) until the needed comeback is visible, then pick it and let the
 *  exchange resolve. */
const pickComebackScrolling = (vm: Vm, want: number | undefined): void => {
  const pick =
    (want === undefined ? undefined : duelScrollTo(vm, want)) ??
    duelArmed(vm).find((v) => duelBackingId(vm, v) !== DUEL_SURRENDER_INSULT) ??
    duelArmed(vm)[0]!;
  const tally = vm.vars.readGlobal(263) + vm.vars.readGlobal(262);
  pickAnswer(vm, pick);
  driveUntil(
    vm,
    (v) =>
      v.vars.readGlobal(263) + v.vars.readGlobal(262) !== tally ||
      v.currentRoom !== ROOMS.swordMaster.duelRoom,
    { maxTicks: 6000 },
  );
};

/** Duel the Sword Master (Carla) — assumes ego is already in her clearing (room
 *  61, reached via the Mêlée-map node #918). Talk to her (#744) to start the
 *  trial, sit out the intro cutscene, then defend with scroll-to-want until the
 *  duel resolves. Returns whether she's beaten (bit#20 set and more wins than
 *  losses). Requires the readiness gate (`g282 > 3`) and the comebacks her seeded
 *  insults demand. */
export function fightSwordMaster(vm: Vm): boolean {
  use(vm, VERBS.talk, ROOMS.swordMaster.master);
  for (let round = 0; round < 80; round++) {
    driveUntil(vm, (v) => duelArmed(v).length > 0, { maxTicks: 4000 });
    const opts = duelArmed(vm);
    if (opts.length === 0) {
      if (vm.currentRoom !== ROOMS.swordMaster.duelRoom) break; // duel over
      continue;
    }
    // Her insult game is mode 2 (pirate-attack); before that the menus are the
    // intro/greeting — advance with the first option.
    if (vm.vars.readGlobal(VARS.duelMode) !== 2) {
      pickAnswer(vm, opts[0]!);
      driveUntil(vm, (v) => v.verbs.get(opts[0]!)?.state !== 'on', { maxTicks: 6000 });
      continue;
    }
    pickComebackScrolling(vm, INSULT_COMEBACK[vm.vars.readGlobal(VARS.currentInsult)]);
  }
  return (
    vm.vars.readBit(ROOMS.swordMaster.foughtBit) === 1 &&
    vm.vars.readGlobal(263) > vm.vars.readGlobal(262)
  );
}
