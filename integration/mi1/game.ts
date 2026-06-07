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
      /** "Vorrei dare un'occhiata in giro." — ends the chat, control back. */
      lookAround: 125,
    },
    /** "la porta" (#387) → back out to the street (room 34); Open (verb 2)
     *  then click to walk through. */
    door: 387,
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
    /** "Il Maestro della Spada" (#744) — the Sword Master. */
    master: 744,
    /** "il sentiero" (#743) — the path out. It has no walk verb, so a bare
     *  click falls to its default (verb 255) → back to the Mêlée map. */
    path: 743,
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

  /** "la casa" (room 43) — the house reached from the map's `house` node. */
  house: {
    id: 43,
  },
} as const;
