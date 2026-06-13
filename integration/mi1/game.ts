/**
 * MI1 playthrough config + duel helpers — numeric ids only (build-agnostic:
 * IT/EN share bytecode; never assert a localized string — see
 * pages/docs/engine/harness.md §7). The id labels and mechanic notes here are
 * the knowledge home for game-specific walkthrough facts.
 */
import {
  bootScummV5,
  driveToRoom,
  driveUntil,
  hasData,
  makeSeededRandom,
  pickAnswer,
  use,
  waitPlayable,
  walkTo,
} from '../../src/testkit/scummv5';
import { VAR_EGO } from '../../src/engine/vm/vars';
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
 * Expected sound-playback durations (jiffies, 1/60 s) per release, keyed by
 * index-file content hash — the variant identity `detect.ts` resolves (its
 * `KNOWN_VARIANTS` uses the same keys). Almost everything in this file is
 * build-identical (numeric ids); sound timing is the exception, because the CD
 * music ships in a different encoding per release (IT FLAC vs EN MP3), so the
 * CD-track lengths differ by a couple of jiffies of encoder padding. The
 * in-resource SBL/MIDI sounds (#28, #50) are byte-shared and time identically.
 * The sound suite autodetects the {@link DATA_DIR} variant and asserts its row.
 */
export interface SoundDurations {
  /** Digitized SBL gate #28. */
  readonly sbl28: number;
  /** Standard-MIDI gate #50. */
  readonly midi50: number;
  /** CD track 6 (#104–107). */
  readonly track6: number;
  /** CD track 7 (#117). */
  readonly track7: number;
}

export const KNOWN_SOUND_DURATIONS: Record<string, SoundDurations> = {
  // English (MP3 CD tracks)
  '8f40364323a755b1b69fa026a4bb4f351cd3bf330cc005d91fa5d77f55cadefe': {
    sbl28: 164,
    midi50: 285,
    track6: 749,
    track7: 4199,
  },
  // Italiano (FLAC CD tracks)
  '4dfbd8f4ba61fcf604073c6960d98caa2c5dd43d6be296b82c25bd2ee1acc3f8': {
    sbl28: 164,
    midi50: 285,
    track6: 747,
    track7: 4196,
  },
};

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
  /**
   * Voyage stage (g259): 0 aboard the Sea Monkey before the broth; 1 once
   * the cooking cutscene (#108) has sailed the ship — the gate the cannon's
   * climb-in checks, and the deck ENCD's wide-scroll / island-on-the-horizon
   * switch; 2 once the deck has been re-entered post-voyage (its ENCD tail
   * plays the "siamo arrivati a Monkey Island" look and bumps the stage).
   */
  voyageStage: 259,
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
  /** "Tira" / Pull — the safe handle's other direction. */
  pull: 6,
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
    /** "la spiaggia" (#910) — Hook Isle's beach (#909 "l'isola" defers to it);
     *  its verb-11 lands ego on Meathook's island ({@link hookIsle}, room 48). */
    beach: 910,
    /** "le luci" (#915) — the lights of Stan's Previously Owned Vessels; its
     *  verb-11 is a straight `loadRoomWithEgo room=59` ({@link stan}). */
    lights: 915,
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
     * The five pewter mugs ("la tazza", #362–366) on the bar tables. Pick up
     * (verb 9 → global #183) pockets each. Post-vow they're the grog carriers
     * for Otis's lock: class 12 = a usable mug (the barrel only fills class-12
     * partners), class 18 = currently holds grog. See {@link ROOMS.kitchen}'s
     * `barrel` for the fill and the melt ladder.
     */
    mugs: [362, 363, 364, 365, 366],
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
    /**
     * "il barile" (#569) — the grog barrel. Use a mug with it (its verb-7
     * gates on the partner being class 12 and on the melt timer #68 not
     * already running) → local #215 fills the mug: class 18 set ("has grog")
     * and global #68 starts the MELT LADDER — class 19 ("si scioglie"), then
     * a g233 countdown that drains FASTER in transit rooms (33: −2/tick,
     * 35: −3, 34: −5, elsewhere −1), then class 6 ("in fin di vita"), then
     * class 12 cleared (a useless pewter wad) and the mug is destroyed.
     * Pour mug-to-mug (use grog mug with a fresh one → global #69) restarts
     * the ladder in the target; pour onto Otis's lock (#69 routes cell ids →
     * #70) while classes 12+18 still hold.
     */
    barrel: 569,
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
    /** The shopkeeper — ACTOR 11 (object {@link shopkeeper} is his talk
     *  target). His presence in room 30 is the safe's guard: handle moves
     *  while he's in get a scolding instead of registering. */
    keeperActor: 11,
    /** "la cassaforte" (#389) — its state flips to 1 (open) while the keeper
     *  dials it during the credit interview, and when the player cracks it. */
    safe: 389,
    /**
     * "la maniglia" (#390) — the safe handle. Push (verb 5) / Pull (verb 6)
     * feed local #202, the combination matcher: moves group by direction;
     * each direction CHANGE closes a group whose size must equal the next
     * combination digit. The combination is FOUR digits in g221..g224
     * (generated once, 1–4 each, by local #205 on the first store entry —
     * random per game, so read it from the vars, never hardcode). Entry
     * state: g226 = groups consumed, g227 = current group count, g228 = last
     * direction (0 pull / 1 push — the FIRST group must continue whatever
     * g228 holds), bit#73 = still-correct flag. On the final matching move
     * the safe opens and the first open hands over {@link creditNote}.
     */
    handle: 390,
    /** First of the four combination digit globals (g221..g224). */
    comboVar: 221,
    /** g226/g227/g228 — the matcher's live state (see {@link handle}). */
    comboPosVar: 226,
    comboCountVar: 227,
    comboDirVar: 228,
    /** "il biglietto del negoziante" (#397) — the note of credit, picked up
     *  automatically on the first player open of the safe. */
    creditNote: 397,
    /**
     * The credit interview + errand (conversation #211, after Stan's
     * referral). Slot ids as armed at this stage of the tree (sword/shovel/
     * mint long bought): top menu has the Sword-Master line at 122 and the
     * credit ask at 123; the job question answers "Certo che sì!" at 120;
     * the job-detail menu has "Pulisco le navi al concessionario Stan." at
     * 123. Asking the keeper to fetch the Sword Master (122) sends him out —
     * the safe-cracking window.
     */
    creditAnswers: {
      askNote: 123,
      haveJob: 120,
      jobAtStans: 123,
      fetchSwordMaster: 122,
    },
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
    /**
     * Boarding: with the ship bought ({@link ROOMS.stan}'s `shipBoughtBit`)
     * and the crew flags set, arriving at the docks runs the crew-at-the-dock
     * scene (ENCD → local #200): each crew member greets ego with a small
     * don't-care menu, then the departure plays through rooms 97 → 87 → the
     * below-decks chat (19) and hands control back aboard the Sea Monkey —
     * the captain's cabin ({@link ROOMS.shipCabin}), Part II begun.
     */
    seaMonkeyCabin: 7,
  },

  /**
   * The Sea Monkey, captain's cabin (room 7) — where Part II opens. The ship
   * is five connected rooms: cabin (7) ⇄ deck ({@link shipDeck}, 19) ⇄
   * between-decks landing ({@link shipLanding}, 9) ⇄ hold ({@link shipHold},
   * 8) / galley ({@link shipGalley}, 14), plus the crow's nest
   * ({@link crowsNest}, 17) up the deck's rope ladder.
   */
  shipCabin: {
    id: 7,
    /** "la penna d'oca" (#75) — the quill pen. Its Pick up also clears the
     *  ink's untouchable class, so the ink is grabbable only after the pen. */
    pen: 75,
    /** "l'inchiostro" (#82) — the ink, a broth ingredient. Plain Pick up
     *  (once {@link pen} has been taken). */
    ink: 82,
    /** "il cassetto" (#83) — the Captain's drawer. Open flips its state;
     *  LOOK at it while open runs the look-inside cutscene that auto-pockets
     *  the dusty book (#74). */
    drawer: 83,
    /** "il libro impolverato" (#74) — the dusty navigation book, handed over
     *  by the drawer's look-inside. (Its own Use/Look opens reader #148.) */
    book: 74,
    /**
     * "l'armadio" (#79; #80 is the second door half) — the Captain's locked
     * cabinet. Open by hand refuses ("Sembra ben chiuso"); Use the small key
     * ({@link ROOMS.shipGalley}'s `smallKey`, #157) with it → global #25
     * swings both halves to state 1, revealing the heavy chest inside.
     */
    cabinet: 79,
    /**
     * "il baule" (#81) — the heavy metal chest INSIDE the cabinet
     * (parent-gated: hoverable only with the cabinet open). Pick up → global
     * #184: ego drags it out and sets it down on the floor as #77 (state 1,
     * touchable), then LOCKS walkbox 11 under it and `createBoxMatrix` — the
     * runtime matrix rebuild that makes walks detour around the chest
     * (box 2 → 10 → 9 → 1) instead of through the now-sealed strip.
     */
    heavyChest: 81,
    /** The dragged-out chest on the floor (#77; #78 is its open image).
     *  Open swaps 77→0 / 78→1; LOOK at it while open fires the verb-61
     *  reveal cutscene: the recipe (#85) and the cinnamon (#88) are
     *  pocketed and {@link recipeBit} is set. */
    placedChest: 77,
    /** #77's open-image twin — state 1 marks the chest open. */
    placedChestOpen: 78,
    /** "il foglio di carta" (#85) — the voyage recipe. Look/Use shows the
     *  close-up (room 84, click-dismissed); holding it is what matters. */
    recipe: 85,
    /** "le stecche di cannella" (#88) — cinnamon sticks, a broth ingredient. */
    cinnamon: 88,
    /** bit#531 — the recipe is in hand (set by the chest reveal). The big
     *  pot refuses every ingredient until this is set. */
    recipeBit: 531,
    /** "la porta" (#84) — out to the deck (19); a bare click walks through
     *  (its verb-11 also swings the deck-side door #253 open). */
    door: 84,
  },

  /** The Sea Monkey's deck (room 19) — the cannon lives here. */
  shipDeck: {
    id: 19,
    /** "la porta" (#253) — back into the cabin; Open it (global #25), then a
     *  bare click walks through (its walk-verb gates on state 1). */
    cabinDoor: 253,
    /** "il portello" (#254) — down to the between-decks landing (9). */
    hatch: 254,
    /** "una scala di corda" (#258) — up to the crow's nest (17). */
    ropeLadder: 258,
    /**
     * "il cannone" (#256). Use the giant rope ({@link ROOMS.shipHold}'s
     * `rope`, #91) with it → local #250 ties it on as the fuse: the fuse
     * actor appears and the fuse object (#252) becomes touchable. (Each
     * tying shortens the rope's name a notch — g357.)
     */
    cannon: 256,
    /**
     * "la bocca del cannone" (#257). Use the gunpowder (#101) with it →
     * {@link powderLoadedBit} set, powder consumed. Climbing in — the small
     * pot's one-object Use dispatches here — while the fuse burns
     * ({@link fuseScript} running) requires the voyage done (g259≥1), the
     * powder loaded, and the small pot in hand (the helmet), then runs the
     * launch cutscene #107 → ego lands on Monkey Island
     * ({@link ROOMS.monkeyBeach}, room 20) and the used props are dropped.
     */
    nozzle: 257,
    /** "la miccia" (#252) — the tied-on fuse. Use the flaming mass (#167)
     *  with it → local #251 (freeze-resistant): the fuse burns ~2.5s, then
     *  the cannon fires — with ego inside only if #107 is already running,
     *  else it fires empty (or fizzles without powder). Light it and wear
     *  the pot IMMEDIATELY. */
    fuse: 252,
    /** bit#399 — gunpowder loaded in the nozzle (cleared again when the
     *  burn-down consumes it). */
    powderLoadedBit: 399,
    /** Room-local #251 — the burning-fuse countdown window. */
    fuseScript: 251,
  },

  /** The crow's nest (room 17), up the deck's rope ladder. */
  crowsNest: {
    id: 17,
    /** "Il Jolly Roger" (#238) — the flag, a broth ingredient. Plain Pick up
     *  (it also dismisses the flag actor). */
    jollyRoger: 238,
    /** "il ponte della nave" (#237) — a bare click (default 255) slides ego
     *  back down to the deck (19). */
    deckBelow: 237,
  },

  /** The between-decks landing (room 9) connecting deck, hold and galley. */
  shipLanding: {
    id: 9,
    /** "la scala" (#105) — up to the deck (19). */
    ladderUp: 105,
    /** "il portello" (#106) — down into the hold (8). */
    holdHatch: 106,
    /** "la porta" (#107) — through to the galley (14). */
    galleyDoor: 107,
  },

  /** The Sea Monkey's hold (room 8). */
  shipHold: {
    id: 8,
    /** "la scala" (#89) — back up to the landing (9). */
    ladder: 89,
    /**
     * "i barili" (#90) — the powder kegs. Pick up hands over the gunpowder
     * object (#101) whenever it isn't already held — and the pot returns the
     * potted powder to owner 15 (the room), so a second visit refills for
     * the cannon.
     */
    kegs: 90,
    /** "la polvere da sparo" (#101) — the gunpowder, a broth ingredient AND
     *  the cannon charge. */
    gunpowder: 101,
    /** "la corda gigante" (#91) — plain Pick up; later tied to the cannon as
     *  its fuse. */
    rope: 91,
    /** "il baule" (#92) — the wine chest. Open (global #25), then LOOK at it
     *  while open → the look-inside cutscene pockets the wine (#104) and
     *  marks the chest looted (class 18). */
    wineChest: 92,
    /** "il buon vino" (#104) — the fine wine, a broth ingredient. */
    wine: 104,
  },

  /**
   * The Sea Monkey's galley (room 14) — the voyage puzzle's kitchen: the big
   * pot over the fire cooks the navigation broth.
   */
  shipGalley: {
    id: 14,
    /** "la scala" (#166) — back out to the landing (9). */
    ladder: 166,
    /** "l'armadio" (#163) — the cupboard; Open (global #25) reveals the
     *  cereal box. */
    cupboard: 163,
    /** The cereal box as it sits in the cupboard (#168) — a forwarder: every
     *  verb re-dispatches onto {@link cereal} (#164), so the scene click
     *  targets THIS id. */
    cerealShelf: 168,
    /**
     * "i cereali" (#164) — the cereal, a broth ingredient. Pick up pockets
     * the box (staging the prize #157 at owner 14, hidden); Open the carried
     * box → the eat cutscene ("Crunch" ×10, bit#366) → global #185 hands the
     * surprise (#157) to ego.
     */
    cereal: 164,
    /** "la sorpresa" → "la chiave piccola" (#157) — the cereal prize. LOOK at
     *  it to discover it's a small key ({@link prizeRevealedBit}); it opens
     *  exactly one thing: the cabin cabinet (#79). */
    smallKey: 157,
    /** bit#367 — the prize has been looked at and renamed to the small key. */
    prizeRevealedBit: 367,
    /**
     * "la pentola" (#158) — the BIG pot over the fire, the ingredient sink.
     * Its Use-with handler gates on the recipe ({@link ROOMS.shipCabin}'s
     * `recipeBit`) then accepts EXACTLY eight ingredients, one bit each:
     * ink #82→bit#427, gunpowder #101→bit#428 (returned to the room, owner
     * 15), Jolly Roger #238→bit#429, cereal #164→bit#430, wine #104→bit#431,
     * breath mint #395→bit#432, rubber chicken #377→bit#433, cinnamon
     * #88→bit#434. The running total lives in g260; at 8 the cooking
     * cutscene (global #108) fires: ego faints, "Passano giorni", the ship
     * sails itself ({@link VARS.voyageStage} g259 → 1), and ego wakes in the
     * galley on the next click (g32 → local #201).
     */
    bigPot: 158,
    /** g260 — how many of the eight ingredients are in the pot. */
    potCountVar: 260,
    /** The eight pot partners and the bit each one sets (see {@link bigPot}). */
    ingredients: [
      [82, 427], [101, 428], [238, 429], [164, 430], [104, 431], [395, 432], [377, 433], [88, 434],
    ],
    /** "la pentola" (#165) — the SMALL pot, the launch helmet. Plain Pick up;
     *  its one-object Use on deck dispatches the climb-into-the-nozzle. */
    smallPot: 165,
    /** "il fuoco ardente" (#161). Use the business card (#702) with it →
     *  the card burns ("li brucerò tutti") and the flaming mass (#167) lands
     *  in inventory — the fuse lighter. */
    fire: 161,
    /** "la massa infuocata" (#167) — the burning business card. */
    flamingMass: 167,
  },

  /** Monkey Island's beach (room 20) — where the cannon launch (#107) drops
   *  ego (x 344, y 105), Part III's opening shore. The launch strips the
   *  voyage props (rope, powder, key, pots, recipe…) on landing. */
  monkeyBeach: {
    id: 20,
    /**
     * Ego lands lying face-down (costume 72) with the next click routed to the
     * get-up wakeup: the room ENCD leaves g32 (VAR_VERB_SCRIPT) = 201, so a bare
     * floor click runs local #201 — ego stands (costume → 1) and g32 is restored
     * to 4. The first interaction of Part III is just getting up.
     */
    wakeupVerbScript: 201,
    /** "la banana" (#265) — a single banana on the sand; Pick up (verb 9). */
    banana: 265,
    /**
     * "il foglio di carta" (#271) — the public-assembly notice by the tree.
     * Look at (verb 8) runs local #203, which reads the LeChuck "occupazione
     * della Testa Sacra di Scimmia" announcement and hands control back.
     */
    assemblyNote: 271,
    /**
     * "la giungla" (#261) — the jungle. Walk-to (verb 11) doesn't load a room
     * the usual way: it `putActorInRoom`s ego into the overhead map (room 2)
     * and `actorFollowCamera`s — the camera-follows-a-relocated-ego path that
     * makes room 2 the current room. The way up onto the island map.
     */
    jungle: 261,
    /**
     * "le banane" (#270) — the cluster the catapult knocks off the tree onto
     * the beach; state flips to 1 when the catapult hits. A plain Pick up
     * (verb 9 → its own script) takes BOTH beach bananas ({@link beachBananaA}
     * #266 + {@link beachBananaB} #267) and clears the cluster (state → 0) — no
     * banana-picker needed. (#265 was already pocketed in the opening beat.)
     * These three plus the village pair (#282/#283) are the five the monkey wants,
     * so the cluster MUST be taken on the south beach before rowing away — there's
     * no convenient return to room 20 afterward.
     */
    fallenBananas: 270,
    /** "la banana" (#266) — a beach banana, handed over by the {@link
     *  fallenBananas} cluster's Pick up (no own Pick up verb of its own). */
    beachBananaA: 266,
    /** "la banana" (#267) — the other beach banana from the cluster pickup. */
    beachBananaB: 267,
    /** "la barca a remi" (#263) — the rowboat. Use the oars ({@link crack}'s
     *  `oars` #245) on it (verb 7 → local #200): ego rows out onto the overhead
     *  map's water (room 2) as the boat figure (costume 4). */
    rowboat: 263,
  },

  /**
   * The Monkey Island overhead map — several walkable screens (rooms 2–6) you
   * cross as a small figure (ego costume 3), not a node-travel hub like Mêlée's.
   * Locations are entered by walking the figure ONTO their marker; edge objects
   * carry the figure between adjacent screens (via global #34). From the beach's
   * jungle you arrive on screen 2 (room 2); the Fort sits on screen 3 (room 3).
   */
  monkeyMap: {
    id: 2,
    /** Screen-2 top-left edge connector (#28) — its verb-11 runs global #34,
     *  crossing the figure to the Fort screen (room 3). */
    toFortScreen: 28,
    fortScreen: 3,
    /**
     * "la fortezza" marker (#44 on screen 3 — it carries no verbs of its own).
     * Walking the figure within distance 2 of it trips room-3 local #200, which
     * `doSentence STOP`s the walk and `loadRoomWithEgo room=80` — into the Fort.
     * Walk to its on-screen spot to enter.
     */
    fortApproach: { x: 119, y: 57 },
    /** Screen-3 → screen-4 edge connector (#39, "the path"), via global #34. The
     *  Fort exits onto screen 3; the River Fork sits on screen 4. */
    fortScreenToRiver: 39,
    riverScreen: 4,
    /** "la biforcazione del fiume" marker (#51, on screen 4): its verb-11 is a
     *  straight loadRoomWithEgo room=15 — into the River Fork. */
    riverForkMarker: 51,
    /** "il laghetto" marker (#59, on screen 4): verb-11 loadRoomWithEgo room=40 —
     *  the Pond. */
    pondMarker: 59,
    /** Screen-4 → screen-2 edge connector (#46), via global #34. The Crack sits
     *  on screen 2 ({@link crackScreen}). */
    riverScreenToCrackScreen: 46,
    crackScreen: 2,
    /** "il crepaccio" marker (#35, on screen 2): verb-11 putActorInRoom 18 +
     *  follow — into the Crack. */
    crackMarker: 35,
    /** "la spiaggia" marker (#30, on screen 2): → the south beach (room 20). */
    beachMarker: 30,
    /**
     * The boat route around the island. In the boat (costume 4) the water exits
     * are touchable: screen 2's #33 → screen 5, screen 5's #64 → screen 6, and
     * screen 6's "la spiaggia" #71 lands ego at the north beach ({@link
     * northBeach}, room 132). The relative-crossing placement depends on the
     * fixed edge-distance box snapping (see `pathfinding/boxes.ts`) to keep the
     * boat on water across each edge rather than stranding it on a land box.
     * The REVERSE leg (north beach back to the monkey's side) rows screen 6 → 5
     * (#70) → 2 (#65) then lands at the south beach via {@link beachMarker} #30:
     * the walking figure can't path screen 6 → 2 (the inland map's two halves
     * only join by boat), so this is how you get back to the monkey/clearing.
     */
    boatScreen2to5: 33,
    boatScreen5to6: 64,
    northBeachLanding: 71,
    boatScreen6to5: 70,
    boatScreen5to2: 65,
    /**
     * Screen 6 (the north screen) also carries the way INLAND: "il villaggio"
     * marker (#72) — its verb-11 is `loadRoomWithEgo room=25`, into the cannibal
     * village ({@link cannibalVillage}). The hut escape (room 27) also dumps ego
     * back onto this screen.
     */
    villageScreen: 6,
    villageMarker: 72,
  },

  /**
   * Monkey Island's north beach (room 132, a pseudo-room backing room 1 — the
   * three-screen beach cluster 130/131/132, `g4` holds which) — where the rowboat
   * lands after circumnavigating the island. Jungle paths lead inland to the
   * cannibal village. Part III's surface ended here; "Under Monkey Island" proper
   * begins beyond.
   */
  northBeach: {
    id: 132,
    /** "la giungla" (#16, a room-1 object) — from screen 132 its Walk-to
     *  `putActorInRoom`s ego onto overhead-map screen 6 (room 6) and follows.
     *  The way inland toward the cannibal village. */
    jungle: 16,
    /** "la barca ed i remi" (#17) — the beached rowboat (oars included). Use
     *  (verb 7) re-launches ego onto the map water as the boat (costume 4), on
     *  the adjacent screen — the way back to the monkey's side. */
    rowboat: 17,
  },

  /**
   * The cannibal village (room 25) — reached from overhead-map screen 6's "il
   * villaggio" marker (#72). Stealing the bowl bananas triggers the cannibals'
   * capture (#202); they escort ego to the guest hut ({@link cannibalHut},
   * room 27). Later the navigator's head (#293) and the idol-offer play out here.
   */
  cannibalVillage: {
    id: 25,
    /**
     * "le banane" (#291) in the fruit bowl. Pick up (verb 9) pockets the two
     * village bananas ({@link bowlBananaA} #282 + {@link bowlBananaB} #283) and
     * starts the capture cutscene (#202). The basket "il cesto di frutta" (#304)
     * just forwards here when bananas are present.
     */
    bowlBananas: 291,
    bowlBananaA: 282,
    bowlBananaB: 283,
    /**
     * After the bowl take, #202 parks until the camera pans back RIGHT toward
     * the cannibals (g2 > 270) — NOT a softlock; walking toward this spot springs
     * the confrontation cutscene. (Grab-and-go: you steal, then turn back.)
     */
    confrontSpot: { x: 400, y: 138 },
    /**
     * Confrontation menu (the cannibals threaten to eat you). "E va bene,
     * mangiami." (#122) chains global #105 — the natives escort ego to the guest
     * hut (`putActorInRoom room=27`). The other options loop "Allora?" (no offer
     * yet) or fail the three-headed-monkey trick (#207).
     */
    fineEatMe: 122,
  },

  /**
   * The cannibal guest hut (room 27) — where #105 drops ego after the capture.
   * The escape: take the skull (it hides the loose board), open the board into a
   * hole, crawl out onto the map. The banana-picker is here too but can't fit
   * through the hole — it's retrieved later through the (now-locked) door.
   */
  cannibalHut: {
    id: 27,
    /**
     * "il teschio" (#310) — the skull on the wall. Pick up (verb 9) pockets it
     * and REVEALS the loose board ({@link looseBoard} #309, its child — Open does
     * nothing until the skull is taken). Otherwise inert ("Non è successo niente").
     */
    skull: 310,
    /**
     * "la tavola lenta" (#309) — the loose board. Open (verb 2) turns it into
     * "il buco" (the hole, state 1); then a bare click (verb 11) crawls ego
     * through onto overhead-map screen 6 (room 6, `putActorInRoom`).
     */
    looseBoard: 309,
    /**
     * "il raccoglibanane" (#314) — the banana-picker. NOT taken on the escape:
     * it won't fit through the hole (local #200 has ego drop it back to the room),
     * so it's retrieved later through the door once the idol makes the cannibals
     * friendly.
     */
    picker: 314,
  },

  /**
   * The wandering monkey — ACTOR 2, "la scimmia" (costume 73 on the map). It
   * paces overhead-map screen 2; clicking it (its catch handler, room-2 local
   * #203) walks ego over and runs #201 → `loadRoomWithEgo room=21`, the monkey
   * close-up. There you FEED it bananas: each Give (verb 4, banana → the monkey
   * actor) routes through close-up local #202 → #203, which consumes the banana
   * (owner → 14) and bumps {@link fedVar} g145. Global #43 (the follow
   * controller, kicked off on the first feed) then makes the monkey trail ego —
   * including ACROSS map screens (global #34 carries it along). It follows from
   * g145 ≥ 1; the g145 > 5 "sated" branches are unreachable (only five bananas
   * exist), so feeding never stops the follow. The five = beach #265/#266/#267 +
   * village #282/#283.
   */
  monkey: {
    actor: 2,
    /** Close-up room the catch loads (room 21); feeding happens here. */
    closeup: 21,
    /** "la giungla" (#274) — the close-up's exit back onto the map (screen 2);
     *  the monkey follows ego out. */
    closeupExit: 274,
    /** The monkey must be "down" (costume 6) in the close-up to accept a banana;
     *  feeding mid-animation is refused ("Non prima che scenda lui"), so wait for
     *  this costume between feeds. */
    receptiveCostume: 6,
    /** g145 — bananas fed to the monkey (each feed +1). */
    fedVar: 145,
    /** The five bananas to feed, in inventory by now. */
    bananas: [265, 266, 267, 282, 283],
  },

  /**
   * The abandoned Fort on the volcano rim (room 80) — the rope, the spyglass,
   * and the rusty cannon whose spill yields the gunpowder + cannonball. Herman
   * Toothrot (actor 7) haunts the place.
   */
  fort: {
    id: 80,
    /** "la corda" (#881) — a rope; plain Pick up (verb 9). One of the two ropes
     *  the Crack descent needs (the pond's is the other). */
    rope: 881,
    /** "il cannocchiale" (#882) — the spyglass; Pick up (verb 9). */
    spyglass: 882,
    /**
     * The spyglass becomes the lens IN PLACE: Open (verb 2) renames #882
     * "la lente" and flips its class — bit 1 (value 2) goes ON (and class 6
     * OFF). Assert {@link lensClassBit}, not the localized name. The lens
     * focuses the sun on the dam (the flint+cannonball-free igniting route).
     */
    lensClassBit: 1,
    /**
     * "il cannone" (#883) — the rusty cannon. Push (verb 5 → local #200): it
     * tips and spills the gunpowder pile (#887) + cannonball (#885) onto the
     * floor (state 1, touchable), setting bit#137. Herman (actor 7) then wanders
     * in to confront you over his spyglass — the spill is only reachable once
     * he's gone.
     */
    cannon: 883,
    /** Herman Toothrot — ACTOR 7. After the cannon spill his watcher (local #202)
     *  walks him in to complain; a conversation answer sends him off and he
     *  leaves room 80. */
    hermanActor: 7,
    /** Dialog answer "Lasciami in pace, dai?" (#122) — sends Herman away. */
    dismissHerman: 122,
    /** "la polvere da sparo" pile (#887) — Pick up (verb 9 → local #201) pockets
     *  the gunpowder object {@link gunpowder} #884 (the dam charge). Spilled by
     *  the cannon push. */
    gunpowderPile: 887,
    /** "la polvere da sparo" (#884) — the gunpowder that lands in inventory. */
    gunpowder: 884,
    /** "la palla da cannone" (#885) — the cannonball; Pick up (verb 9 → #201).
     *  Spilled by the cannon push; the dam's igniter together with the flint. */
    cannonball: 885,
    /** "il sentiero" (#886) — the path out, back onto the overhead map (screen 3,
     *  near the fortezza marker but clear of its re-entry watcher). */
    path: 886,
  },

  /**
   * The River Fork (room 15) — the dam, and the climb up to the catapult. The
   * dry riverbed runs through; blowing the dam floods it and fills the pond.
   */
  riverFork: {
    id: 15,
    /**
     * "la pietra sopra al biglietto" (#169) — the rock sitting on a note. Pick
     * up (verb 9 → global #167) pockets it, renamed "la pietra focaia" (the
     * flint), AND reads the note (#231) underneath in the same gesture. Later
     * the dam igniter — Use it with the cannonball (#885) for a flint-and-steel
     * spark by the dam.
     */
    flint: 169,
    /** "il biglietto sotto la pietra" (#231) — the note under the rock, read as
     *  part of taking the flint. */
    note: 231,
    /** "i punti d'appoggio" (#170) — the footholds. Walk-to (verb 11 → local
     *  #203) climbs up to the catapult platform ({@link catapult}, room 16). */
    footholds: 170,
    /**
     * "la diga" (#176; #177 is its twin hot-region) — the dam. Use the Fort
     * gunpowder ({@link fort}'s `gunpowder` #884) with it → the powder is placed
     * on the dam (#178 drawn, the gunpowder consumed). Then a flint-and-cannonball
     * spark beside it ignites it (global #44): the dam blows, the river floods,
     * the pond fills, and ego is washed back onto the overhead map (room 4).
     */
    dam: 176,
  },

  /**
   * The catapult ("l'arte primitiva", a cannibal contraption) — two stacked
   * rooms: the aiming platform (room 16) and the firing ledge above it (room 11),
   * reached by a further climb. Aimed right and fired, it lobs a rock across the
   * island and knocks the bananas off the beach tree.
   */
  catapult: {
    /** The aiming platform (room 16), reached up {@link riverFork}'s `footholds`. */
    platform: 16,
    /** The firing ledge above (room 11), reached up {@link upToLedge}. */
    ledge: 11,
    /**
     * "l'arte primitiva" (#235; #234 is its other end) — the catapult arm. Pull
     * (verb 6 → local #200) raises the aim ({@link aimVar} g242) by 1 per pull
     * (#234 lowers it); it caps with "Non va oltre". A hit lands only at
     * g242=={@link aimTarget} — it rests at 2, so two pulls aim it.
     */
    crank: 235,
    aimVar: 242,
    aimTarget: 4,
    /** "gli appoggi per i piedi" (#232) — footholds up to the firing ledge (11). */
    upToLedge: 232,
    /**
     * "la pietra" (#116) — a rock ALREADY seated in the catapult on the ledge
     * (no need to take one from the pile #120). Push (verb 5 → local #200) fires
     * it; with the aim right (g242==4) it hits the beach banana tree, dropping
     * bananas there and latching {@link hitBit}. Herman may wander in to complain
     * (he comes on his own when ego nears the catapult) — shoo him with
     * {@link dismissHerman}.
     */
    seatedRock: 116,
    /** Dialog answer "Lasciami in pace, dai?" (#122) — shoo Herman, same as the
     *  Fort. */
    dismissHerman: 122,
    /** bit#530 — set once the catapult has hit the beach banana tree. It's a
     *  one-shot: a later shot just says it won't hit again. */
    hitBit: 530,
    /** The catapult ledge can't path straight to the down-path object; stage ego
     *  onto box 1 here first. */
    ledgeDownStage: { x: 114, y: 134 },
    /** "il sentiero in basso" (#115, on the ledge) — down to the platform (16). */
    ledgeDown: 115,
    /** "il sentiero in basso" (#233, on the platform) — down to the River Fork (15). */
    platformDown: 233,
  },

  /**
   * The Pond (room 40) — filled by the dam flood. A battered man (#563) sits by
   * a rope; a corpse dangles above on another. The rope by the man is the second
   * rope the Crack descent needs.
   */
  pond: {
    id: 40,
    /** "la corda" (#561) — the second rope, by the unhealthy man (#563). The
     *  flood (global #44) made it touchable; a plain Pick up (verb 9) takes it. */
    secondRope: 561,
    /** "la giungla" (#554) — the exit, back onto the overhead map (screen 4). */
    exit: 554,
  },

  /**
   * The Crack (room 18) — a cleft you descend in two roped stages to the oars at
   * the bottom. Reached from the map's "il crepaccio" ({@link monkeyMap}'s
   * `crackMarker`).
   */
  crack: {
    id: 18,
    /** "il ramo robusto" (#248) — the sturdy branch (upper). Use a rope with it
     *  (verb 7 → local #202): it ties on and ego climbs down a level. Gated on
     *  ego's walkbox (≥5), which the Use-walk satisfies. */
    branch: 248,
    /** "il tronco robusto" (#249) — the sturdy trunk (lower). Use the other rope
     *  with it → ego climbs to the bottom, by the oars. */
    trunk: 249,
    /** "i remi" (#245) — the oars at the bottom; Pick up (verb 9). The rowboat's
     *  propulsion (Use them on the boat back at the south beach). */
    oars: 245,
    /** "la giungla" (#244) — the exit, back onto the overhead map (screen 2). */
    exit: 244,
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
    /**
     * "la serratura" (#403) — the lock on Otis's cell. Using a grog mug on it
     * routes (via the mug's verb-7 → #69 → #70 [mug, 401]) into the lock-melt
     * cutscene: the lock dissolves, Otis is freed, and — with {@link
     * otisAgreedBit} already set — local #208 plays the friendly join
     * (otherwise he just bolts mocking you).
     */
    lock: 403,
    /**
     * Otis's POST-VOW conversation (#405's talk, with bit#304 set): answer
     * #123 twice — first "Hanno rapito il Governatore!" (the news), then
     * "Se ti faccio uscire, ti unirai al mio equipaggio?" — the second pick
     * sets {@link otisAgreedBit}.
     */
    recruitAnswer: 123,
    /** bit#477 — Otis agreed to join (the second #123 pick above). Must be
     *  set BEFORE the lock melts for the friendly-join branch of #70. */
    otisAgreedBit: 477,
    /** bit#76 — the cell lock melted / Otis freed (#70 sets it at the top of
     *  the rescue). One of the three crew flags the island scripts OR
     *  together (with bit#88 Meathook and bit#89 Carla). */
    otisFreedBit: 76,
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
    /**
     * Post-vow recruit: talk to her (#744) and answer #122 ("Hanno RAPITO il
     * Governatore!"). Her reaction plays through the close-up (room 44) and
     * sets {@link recruitedBit}; control returns in her clearing (61).
     */
    recruitAnswer: 122,
    /** bit#89 — Carla recruited (one of the three crew flags). */
    recruitedBit: 89,
  },

  /**
   * Hook Isle (room 48) — Meathook's island, reached from the map's beach
   * node ({@link meleeMap}'s `beach`, #910). His house sits across a chasm
   * spanned by a cable between two poles; the rubber chicken ({@link
   * ROOMS.voodooShop}'s `chicken`, #377) is the zipline grip. Local #203
   * branches on ego's walkbox — tower top (box 7) ziplines across to the
   * house pole top (box 10) and vice versa — and locals #201/#202 swap which
   * side's objects are touchable (class 32) after each crossing.
   */
  hookIsle: {
    id: 48,
    /** "il palo" (#601) — the LADDER TOWER on the path side. A bare click
     *  climbs ego to its platform, walkbox 7 (its verb branches on box 7:
     *  local #204 climbs up, #205 climbs down). */
    tower: 601,
    /** Walkbox of the tower platform — the zipline's near end. */
    towerTopBox: 7,
    /** "il palo" (#600) — the pole by the house; box 10 at its top is the
     *  zipline's far end, and a bare click there climbs back up. */
    housePole: 600,
    /** Walkbox at the house-pole top — the zipline landing. */
    houseTopBox: 10,
    /** "il cavo" segments (#603–606). Use the chicken with one: from box 7
     *  #605 is the touchable segment, from box 10 it's #603 — either runs the
     *  crossing (#203). The chicken is NOT consumed. */
    cableFromTower: 605,
    cableFromHouse: 603,
    /** "la porta" (#598) — Meathook's front door; touchable only on the house
     *  side (local #201 clears its class 32 after the crossing). Open, then
     *  walk through → the house ({@link meathookHouse}, room 37). */
    door: 598,
    /** "il sentiero" (#599) — back to the Mêlée map; touchable only on the
     *  path side. */
    path: 599,
  },

  /**
   * Meathook's house (room 37). Walking in fires his accost (#60, started by
   * the room's ENCD via local #203) — no Talk click needed. The recruit:
   * answer the news, propose getting a crew, and he challenges your bravery —
   * the tour cutscene (local #201) leads to the little door, "aprire quella
   * porticina ^e toccare la bestia".
   */
  meathookHouse: {
    id: 37,
    /**
     * "la porta" (#478) — the little door, later renamed to the winged-devil
     * object. Open it (verb 2, class 6 set → global #49): the bird pops out
     * shrieking, #49 then CLEARS class 6 and renames it. Touch the beast =
     * any verb without its own entry on #478 (e.g. "Usa"; the game's own
     * hover default is the joke verb 18 "Palpa") → falls back to the 255
     * entry → local #205, the payoff: Meathook joins ({@link recruitedBit}),
     * and the cutscene walks ego back outside.
     */
    littleDoor: 478,
    answers: {
      /** Accost menu 1: "Il Governatore è stato RAPITO!" — the news. */
      kidnapped: 120,
      /** Menu 2 (what do we do): "Potremmo mettere insieme un equipaggio ed
       *  inseguirli." — the crew idea; Meathook then runs the dare tour. */
      crewIdea: 122,
    },
    /** Room-local #201 — the dare tour cutscene (he opens the trophy doors up
     *  to the porticina). Its end makes {@link littleDoor} touchable. */
    tourScript: 201,
    /** bit#323 — set by #49 when the beast first pops out (the scream gag). */
    beastOutBit: 323,
    /** bit#88 — Meathook recruited (one of the three crew flags). */
    recruitedBit: 88,
  },

  /**
   * Stan's Previously Owned Vessels (room 59), reached from the map's lights
   * node ({@link meleeMap}'s `lights`, #915). Stan (actor 3) accosts on
   * arrival; his whole pitch is global #56 — one giant menu state machine
   * (ship tour, financing, accessories, the haggle). The Sea Monkey is the
   * cheap ship; its asking price g202 starts at 8000.
   */
  stan: {
    id: 59,
    /** "il sentiero" (#698) — back up to the Mêlée map (only reachable when
     *  the conversation has released control). */
    path: 698,
    /** "il biglietto da visita" (#702) — Stan's business card; his farewell
     *  branch hands it (and {@link compass}) over while exiting you to the
     *  map. */
    businessCard: 702,
    /** "la bussola magnetica" (#732) — thrown in on the same farewell. */
    compass: 732,
    /** bit#51 — the Sea Monkey is bought (the deal-close branch sets it). */
    shipBoughtBit: 51,
    /** g202 — Stan's current asking price for the ship under discussion. */
    priceVar: 202,
    /** g220 — walk-away-threat counter; each of the first three threats drops
     *  g202 by g216[g220] (1000/500/100 on this build's tables), a FOURTH
     *  walks you off the lot. */
    walkAwaysVar: 220,
    /** g204 — the last offer made (the offer ladder compares against it). */
    lastOfferVar: 204,
    answers: {
      /** Browse menu: "Veramente non posso spendere tanto." → the Sea Monkey
       *  pitch. (On a later visit the same slot reads "posso rivedere quella
       *  che costa poco?".) */
      cheapest: 122,
      /** Sea Monkey menu: "Veramente, speravo di prenderla a credito." — Stan
       *  points you at the storekeeper (no bit; the store's credit line arms
       *  off this referral). */
      onCredit: 121,
      /** Sea Monkey menu: "Pensandoci bene, questa non è proprio la nave che
       *  mi serve." — back out of the pitch to the browse menu. */
      backOut: 125,
      /** Browse menu: "Veramente, vorrei pensarci su un'altro po'." — leave;
       *  Stan's farewell hands the card + compass and exits to the map. */
      thinkItOver: 124,
      /** Browse menu, note in hand: "Ho un credito dal negoziante. Lo
       *  accetterai?" — opens the deal menu. */
      haveCreditNote: 124,
      /** Deal menu: "Vorrei farti un'offerta." — the offer ladder. */
      makeAnOffer: 121,
      /** Deal menu: "Scordatelo. Tanto non mi serve questa barca." — the
       *  walk-away threat (see {@link walkAwaysVar}). */
      walkAway: 123,
      /** Threat follow-up: "Beh, forse hai ragione^" — stay on the lot. */
      stay: 120,
    },
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
 *  a deliberately generous, LATE-tripping set: every comeback the pirate pool
 *  teaches *promptly* on the current stream — all of 1..16 except 12, which the
 *  pool teaches very late or never (she must not draw a missing one more than
 *  the loss margin allows; the walkthrough's win is the proof she doesn't).
 *  Trips around duel 42 of the grind. Any engine change that shifts tick dynamics moves the seeded stream,
 *  relocating the stragglers/unlearnable holes and the trip point — re-derive
 *  this set from the grind's learning order when that happens. */
const SWORD_MASTER_NEEDED: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16];
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

// ── Crew & ship helpers (the Part-I finale) ──────────────────────────────

/**
 * From the Mêlée town street (35) up to the island map (85). The west arch's
 * verb-11 branches on plot bits — post-vow it can land at the lookout (33) or
 * dump ego on the docks (83, whose molo then climbs to the lookout) — so this
 * absorbs the reroute, then takes the cliff and the path up.
 */
export function townToMap(vm: Vm): void {
  walkTo(vm, ROOMS.meleeStreet.lookoutArch);
  driveUntil(vm, (v) => v.currentRoom === ROOMS.meleeLookout.id || v.currentRoom === ROOMS.docks.id, {
    maxTicks: 14000,
  });
  waitPlayable(vm, 10000);
  if (vm.currentRoom === ROOMS.docks.id) {
    walkTo(vm, 905); // il molo → the lookout (bit#453 reroute)
    driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 14000 });
    waitPlayable(vm, 10000);
  }
  walkTo(vm, ROOMS.meleeLookout.cliff);
  driveToRoom(vm, ROOMS.cliffPath.id, { maxTicks: 8000 });
  walkTo(vm, ROOMS.cliffPath.path);
  driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 });
  waitPlayable(vm, 10000);
}

/** Class N is bit N−1 of the runtime class mask. */
const hasClass = (vm: Vm, obj: number, cls: number): boolean =>
  ((vm.objectClasses.get(obj) ?? 0) & (1 << (cls - 1))) !== 0;
/** The mug still works as a container (class 12 — cleared at the wad stage). */
export const mugUsable = (vm: Vm, mug: number): boolean => hasClass(vm, mug, 12);
/** The mug currently holds grog (class 18 — set on fill/pour). */
export const mugHasGrog = (vm: Vm, mug: number): boolean => hasClass(vm, mug, 18);
/** The mug entered its last stage ("in fin di vita", class 6) — pour NOW. */
export const mugDying = (vm: Vm, mug: number): boolean => hasClass(vm, mug, 6);

/**
 * Crack the store safe — keeper already away. Reads the four combination
 * digits (g221..g224) and the dial state the keeper's own opening left
 * behind (g228 = his last direction, which the first group must continue),
 * then feeds the handle the four alternating-direction groups. Each move is
 * a real Push/Pull click on the handle (#390 — a hotspot only while its
 * parent safe is shut, which it is) and waits for the matcher to register
 * before the next. Returns whether the note (#397) landed in ego's inventory.
 */
export function crackSafe(vm: Vm): boolean {
  const ego = vm.vars.readGlobal(VAR_EGO);
  const combo = [0, 1, 2, 3].map((i) => vm.vars.readGlobal(ROOMS.store.comboVar + i));
  const firstPush = vm.vars.readGlobal(ROOMS.store.comboDirVar) === 1;
  const state = (): string =>
    [ROOMS.store.comboPosVar, ROOMS.store.comboCountVar, ROOMS.store.comboDirVar]
      .map((v) => vm.vars.readGlobal(v))
      .join(',');
  for (let group = 0; group < 4; group++) {
    const push = group % 2 === 0 ? firstPush : !firstPush;
    for (let k = 0; k < combo[group]!; k++) {
      const before = state();
      use(vm, push ? VERBS.push : VERBS.pull, ROOMS.store.handle);
      driveUntil(vm, (v) => state() !== before || v.getObjectOwner(ROOMS.store.creditNote) === ego, {
        maxTicks: 6000,
      });
      if (vm.getObjectOwner(ROOMS.store.creditNote) === ego) return true;
    }
  }
  return driveUntil(vm, (v) => v.getObjectOwner(ROOMS.store.creditNote) === ego, { maxTicks: 30000 });
}

/**
 * Close the Sea Monkey deal — assumes the browse menu is reachable (Stan's
 * pitch live) and the credit note (#397) is in hand. Drives #56's deal state
 * machine: open the deal with the note, threaten to walk ×3 (price 8000 →
 * 6400 via g216[]'s 1000/500/100 drops; a 4th threat walks you off the lot),
 * then climb the offer ladder 2000→3000→4000→5000 (each rising offer drops
 * the price another 500) and insist on 5000 until it clears the price (4900).
 * Returns whether the ship was bought (bit#51).
 */
export function buySeaMonkey(vm: Vm): boolean {
  const armed = (): Array<[number, string]> => {
    const out: Array<[number, string]> = [];
    for (let v = 120; v <= 129; v++) {
      const slot = vm.verbs.get(v);
      if (slot?.state === 'on') out.push([v, slot.name ?? '']);
    }
    return out;
  };
  const A = ROOMS.stan.answers;
  for (let step = 0; step < 24; step++) {
    if (vm.vars.readBit(ROOMS.stan.shipBoughtBit) === 1) return true;
    if (!driveUntil(vm, () => armed().length > 0 || vm.vars.readBit(ROOMS.stan.shipBoughtBit) === 1, { maxTicks: 24000 })) break;
    if (vm.vars.readBit(ROOMS.stan.shipBoughtBit) === 1) return true;
    const m = armed();
    const ids = new Set(m.map(([k]) => k));
    const price = vm.vars.readGlobal(ROOMS.stan.priceVar);
    const threats = vm.vars.readGlobal(ROOMS.stan.walkAwaysVar);
    const lastOffer = vm.vars.readGlobal(ROOMS.stan.lastOfferVar);
    // The deal menu and the threat follow-up reuse low slots; tell the offer
    // menu apart by its full five-slot spread (the four rungs + "soffrire").
    const offerMenu = ids.has(124) && ids.has(122) && ids.has(121) && ids.has(120) && ids.has(123) && !ids.has(125);
    let pick: number;
    if (offerMenu) {
      // climb: first offer 2000 (slot 120), then one rung above the last
      pick = 120 + Math.min(3, lastOffer === 0 ? 0 : lastOffer / 1000 - 1);
    } else if (ids.has(A.stay) && m.length === 2) {
      pick = A.stay; // "Beh, forse hai ragione^" — stay after a threat
    } else if (ids.has(A.haveCreditNote) && ids.has(125)) {
      pick = A.haveCreditNote; // browse menu, note in hand → open the deal
    } else if (threats < 3 && ids.has(A.walkAway)) {
      pick = A.walkAway;
    } else if (price > 5000 || ids.has(A.makeAnOffer)) {
      pick = A.makeAnOffer;
    } else {
      pick = m[0]![0];
    }
    pickAnswer(vm, pick);
    driveUntil(
      vm,
      (v) => !armed().some(([j]) => j === pick) || v.vars.readBit(ROOMS.stan.shipBoughtBit) === 1,
      { maxTicks: 24000 },
    );
  }
  return driveUntil(vm, (v) => v.vars.readBit(ROOMS.stan.shipBoughtBit) === 1, { maxTicks: 90000 });
}

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
