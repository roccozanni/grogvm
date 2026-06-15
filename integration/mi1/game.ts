/**
 * MI1 playthrough config + duel helpers. Numeric ids only — IT/EN share
 * bytecode, so never assert a localized string (see engine/harness.md §7).
 * The id labels and mechanic notes here are the knowledge home for
 * walkthrough facts.
 */
import {
  bootScummV5,
  driveToRoom,
  driveUntil,
  hasData,
  makeSeededRandom,
  objectPoint,
  pickAnswer,
  pickDialogAnswer,
  use,
  waitPlayable,
  walkTo,
} from '../../src/testkit/scummv5';
import { VAR_EGO } from '../../src/engine/vm/vars';
import type { Vm } from '../../src/engine/vm/vm';

/** The build we run the playthrough against (IT — also carries the saves). */
export const DATA_DIR = 'games/MI1-IT-CD-DOS-VGA';

/** Fixed RNG seed — boot seeds the engine's entropy with this so the run is
 *  reproducible. Change only with reason. */
export const SEED = 0x6d6f6e6b; // ASCII "monk"

/** Whether the MI1 data is present (gate the suite on this). */
export const hasGame = (): boolean => hasData(DATA_DIR);

/** Boot MI1 to the title screen, seeded for a deterministic playthrough. */
export const boot = (): Vm => bootScummV5(DATA_DIR, 'MI1', makeSeededRandom(SEED));

/**
 * Expected sound durations (jiffies, 1/60 s) per release, keyed by index-file
 * content hash (same keys as `detect.ts`'s `KNOWN_VARIANTS`). Sound timing is
 * the one build-variant exception in this file: the CD music ships in a
 * different encoding per release (IT FLAC vs EN MP3), so CD-track lengths differ
 * by a few jiffies of encoder padding; the in-resource SBL/MIDI sounds (#28,
 * #50) are byte-shared and time identically. The sound suite autodetects the
 * {@link DATA_DIR} variant and asserts its row.
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
  // Italian (FLAC CD tracks)
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
  /** Insult-swordfighting win tally (g282), bumped in the win/loss handler
   *  (global #74) per duel won (winning exchanges g263 > per-duel threshold
   *  g351). The Sword Master only fights once `g282 > 3` (four duels won) — the
   *  readiness gate the grind drives toward. */
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
  /** Voyage stage (g259): 0 before the broth; 1 once the cooking cutscene
   *  (#108) sails the ship (the gate the cannon climb-in checks, and the deck
   *  ENCD's wide-scroll switch); 2 once the deck is re-entered post-voyage (its
   *  ENCD tail plays the arrival look and bumps the stage). */
  voyageStage: 259,
  /** Part IV finale stage (g277) — a per-arrival SELECTOR, not a progress
   *  counter. The Mêlée-docks ENCD (room 83) branches on it (1–6) to pick the
   *  arrival script; the Part III→IV lift (global #131) sets it to 6 on landing,
   *  where the docks ENCD strips ego's inventory to the keepers (money #488,
   *  magic seltzer #823, root beer #733). The dock ghost (#204) and LeChuck
   *  punch (room 45 #200) clear it to 0. Read it for "Part IV begun". */
  finaleStage: 277,
} as const;

/**
 * Insult-swordfighting — the data to play a duel deterministically. Pirate
 * insults (ids 1–15) are countered by the same-numbered comeback; the Sword
 * Master's insults (16–33) reuse the pirate comebacks. Two persistent bit-array
 * stores, NOT cleared between duels: {@link INSULTS_LEARNED_BIT} (insults you
 * can throw, set when a pirate uses one on you, #83) and {@link
 * COMEBACKS_LEARNED_BIT} (comebacks you can use, set when a pirate replies, #82).
 * `INSULT_COMEBACK[i]` = the comeback that wins against insult `i` (first listed
 * where two answers are valid).
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
  /** Look at. */
  look: 8,
  /** Open (e.g. the bar door before walking through). */
  open: 2,
  /** Pick up. */
  pickUp: 9,
  /** Talk to. */
  talk: 10,
  /** Give — two-object (Give X to <actor>). */
  give: 4,
  /** Push — e.g. ring the general-store bell. */
  push: 5,
  /** Pull — the safe handle's other direction. */
  pull: 6,
  /** Use — two-object (Use X with Y), e.g. the shovel on the dig X. */
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
    /** The cliff — the room's west edge (x=0). A bare Walk-to runs its exit
     *  script → the cliff path ({@link cliffPath}, room 38). */
    cliff: 426,
    /** The arch — the room's far-east edge (x≈984; room 33 is a wide scrolling
     *  room). Clicking it carries ego east into the Mêlée town street
     *  ({@link meleeStreet}, room 35). */
    townArch: 427,
  },

  /** The cliff path between the lookout and the Mêlée map — a short connector
   *  (steps down, the path up, a sentry to look at / talk to). */
  cliffPath: {
    id: 38,
    /** The path — the top exit up to the Mêlée map ({@link meleeMap}, room 85).
     *  Its verb table is [90, 255] with no Walk-to (verb 11), so a bare click
     *  falls back to the 255 default entry, which runs the exit. */
    path: 487,
    /** The steps — back down toward the lookout. */
    steps: 486,
    /** The sentry — look-at / talk-to; not a gate. */
    sentry: 489,
  },

  /**
   * The Mêlée Island map — the travel hub. Each location is a verb-11 node;
   * clicking one walks the on-map figure there and loads that area.
   */
  meleeMap: {
    id: 85,
    /** The clearing — the Fettucini brothers' camp. */
    clearing: 912,
    /** The lookout — back to the lookout area. */
    lookout: 913,
    /** The crossroads — the town fork. */
    crossroads: 911,
    /** The bridge (#914) — the troll bridge ({@link trollBridge}, room 57). Its
     *  verb-11 branches on which side ego stands; fresh from elsewhere it lands
     *  on the troll's side. */
    bridge: 914,
    /** The house (#916) — verb-11 loads room 43 ({@link house}). */
    house: 916,
    /** The village. Its verb-11 branches on story progress (g196 / plot bits);
     *  early on — g196 still 0 through the trials — it lands ego in room 33, from
     *  whose east arch ({@link ROOMS.meleeLookout}'s `townArch`) the town street
     *  is reached. (Later it reroutes to the docks, room 83.) */
    village: 917,
    /** The Sword Master node (#918). Its verb-11 walks the map figure over and
     *  `loadRoomWithEgo room=61` into her clearing ({@link swordMaster}), where
     *  talking to her starts the swordfighting-trial duel once `g282 > 3`. */
    swordMaster: 918,
    /** Hook Isle's beach (#910; #909 the isle defers to it); its verb-11 lands
     *  ego on Meathook's island ({@link hookIsle}, room 48). */
    beach: 910,
    /** The lights of Stan's Previously Owned Vessels (#915); verb-11 is a bare
     *  `loadRoomWithEgo room=59` ({@link stan}). */
    lights: 915,
  },

  /** The clearing (room 52) — the Fettucini circus camp. */
  clearing: {
    id: 52,
    /** The circus tent — Walk-to enters the circus interior
     *  ({@link ROOMS.circus}, room 51). */
    circusTent: 621,
    /** The path — back up to the map. */
    pathToMap: 622,
  },

  /**
   * The Fettucini circus interior (room 51). Entering auto-starts the brothers'
   * arguing conversation (local #207); the player breaks in and negotiates the
   * human-cannonball job, ending in a 478-coin payout.
   *
   * Dialog answers are live verbs, id `120 + (optionIndex - 1)` within the
   * CURRENT menu, so the same id (esp. 120) recurs across menus — pick them in
   * order (menus are sequential, separated by speech).
   */
  circus: {
    id: 51,
    fettuciniAnswers: {
      /** Menu 1: the interrupt line — break into the argument. */
      ahem: 120,
      /** Menu 2: the ask-the-pay line. */
      howMuchPay: 121,
      /** Menu 3: the accept-the-deal line. */
      acceptDeal: 120,
      /** Menu 4: the claim-the-helmet line (the pot taken in the kitchen);
       *  takes the cannon-launch branch. */
      haveHelmet: 120,
      /** Menu 5 (post-launch amnesia gag): either option leads to the payout. */
      amnesia: 120,
    },
    /** A Fettucini brother — an ACTOR (id 3; brother 4 stands beside him). After
     *  the helmet answer, the room sentence handler (local #200) waits for the
     *  pot to be GIVEN to a brother (`actorFromPos == 3 or 4` + object 567) —
     *  that sets bit#103 and fires the cannon launch. Either brother works. */
    brotherActor: 3,
  },

  /** The SCUMM Bar interior (entered through the lookout's bar door). */
  scummBar: {
    id: 28,
    /** The five pewter mugs (#362–366) on the bar tables. Pick up (verb 9 →
     *  global #183) pockets each. Post-vow they're the grog carriers for Otis's
     *  lock: class 12 = a usable mug (the barrel only fills class-12 partners),
     *  class 18 = currently holds grog. See {@link ROOMS.kitchen}'s `barrel`
     *  for the fill and the melt ladder. */
    mugs: [362, 363, 364, 365, 366],
    /** The LOOM-ad salesman pirate. Talk to (verb 10 — also his default verb
     *  g182) runs his verb script → conversation script #93 → the close-up
     *  {@link ROOMS.pirateCloseup}. */
    loomPirate: 333,
    /** The three important-looking pirates (one object, #322; rendered as actor
     *  3). Talk to (verb 10) runs their conversation script #220 INLINE in the
     *  bar — no close-up room, unlike {@link loomPirate}. */
    threePirates: 322,
    /** Dialog-answer verb ids for the three-pirates conversation. */
    trialsAnswers: {
      /** The real opener (want-to-be-a-pirate, vs. two joke options); the
       *  pirates then explain the three trials and {@link VARS.trialsLearned}
       *  (g197) flips 0→1. */
      wantToBePirate: 122,
      /** The goodbye line; ends the conversation, control back in the bar. */
      goodbye: 127,
    },
    /** Right-hand door → the kitchen ({@link ROOMS.kitchen}). The cook leaves it
     *  open, so a click walks ego through (default action runs room-28 local
     *  #218 → `loadRoomWithEgo` 41). The click must land on the door object — a
     *  bare floor click beside it won't run it. */
    kitchenDoor: 316,
    /** The cook — an ACTOR (not an object), id 6. Cycles: hidden in the kitchen
     *  (~2000t), then out wandering the bar (~800t). The kitchen is only
     *  enterable while he's out AND clear of the door (sweeps to x≈300); heading
     *  in while he guards it gets kicked back (script 216). */
    cookActor: 6,
    /** Left exit door → back out to the Mêlée Lookout (33). Walk-to runs its
     *  `loadRoomWithEgo` 33. The FIRST exit also fires a one-time cutscene (the
     *  Sheriff; through rooms 70→72) before control lands at the lookout — so
     *  the room change takes a while. */
    exitDoor: 315,
  },

  /** The SCUMM Bar kitchen (entered through {@link ROOMS.scummBar}'s
   *  `kitchenDoor` once the cook is clear). */
  kitchen: {
    id: 41,
    /** On the kitchen floor — Pick up (verb 9) flips ownership room→ego. */
    meat: 566,
    pot: 567,
    /** Out on the dock — guarded by the seagull. Pick up refuses until the gull
     *  bolts: takeable only DURING the fly-away, while the bird's class-6 guard
     *  is momentarily clear. */
    fish: 568,
    /** The dock door. Opening it unblocks the dock walkboxes, makes the fish
     *  touchable, and starts the gull watcher (local #203). */
    dockDoor: 564,
    /** The loose board (#575). Walking onto its walk-to point scares the seagull
     *  a notch; the gull watcher fires on ego's distance to it. */
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
    /** The grog barrel (#569). Use a mug with it (verb-7 gates on the partner
     *  being class 12 and on melt timer #68 not running) → local #215 fills the
     *  mug: class 18 set (has grog) and global #68 starts the MELT LADDER —
     *  class 19 (melting), then a g233 countdown draining FASTER in transit
     *  rooms (33: −2/tick, 35: −3, 34: −5, elsewhere −1), then class 6 (dying),
     *  then class 12 cleared (a useless pewter wad) and the mug destroyed. Pour
     *  mug-to-mug (use grog mug with a fresh one → global #69) restarts the
     *  ladder in the target; pour onto Otis's lock (#69 routes cell ids → #70)
     *  while classes 12+18 still hold. */
    barrel: 569,
  },

  /** The LOOM-ad pirate close-up (reached by talking to {@link ROOMS.scummBar}'s
   *  `loomPirate`, whose verb script starts conversation script #93). */
  pirateCloseup: {
    id: 82,
    /** Dialog-answer verb ids. */
    answers: {
      /** The nice-hat line. */
      niceHat: 121,
      /** The goodbye option; ends the close-up and returns to the SCUMM Bar
       *  (room 28). */
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
    /** The Mêlée citizen — an OBJECT (#441), not an actor. Talk to (verb 10)
     *  runs his conversation (#218); the right opener gets him to sell the
     *  treasure map. */
    citizen: 441,
    citizenAnswers: {
      /** The cousin-Dominique opener; turns the chat to the map he's holding and
       *  arms the buy menu. (The other openers dead-end.) */
      dominique: 123,
      /** The buy-it line; the map (#442) goes to ego for 100 pieces of eight. */
      takeMap: 121,
    },
    /** The map — enters inventory when the citizen sells it. */
    map: 442,
    /** The door (#444) → the Voodoo Lady ({@link ROOMS.voodooShop}, room 29).
     *  Open it (verb 2) then click to walk through, like the bar door. */
    voodooDoor: 444,
    /** The arch (#451) → the general-store street ({@link ROOMS.storeStreet},
     *  room 34); click to walk through. The town-ward leg of the Part IV walk
     *  to the church — ego arrives from the docks at the east arch (#450, x≈437)
     *  and crosses west to this one. */
    storeArch: 451,
    /** The west arch (#450) back to the lookout/town room
     *  ({@link ROOMS.meleeLookout}, room 33). Its verb-11 branches on plot bits
     *  (later it reroutes to the docks, room 83); early on — those bits clear —
     *  it lands ego at room 33's east arch (#427). The return leg of the shop
     *  trip. (In Part IV ego ARRIVES here from the docks #905.) */
    lookoutArch: 450,
    /** PART IV — a ghost pirate (#440) blocking the cross-street. Walking past
     *  it trips its conversation (room 35 local #211, the longer cousin of the
     *  dock ghost): a BRANCHING banter tree — other lines wander through stages
     *  of insults — but the root-beer line ({@link ghostRootBeerAnswer}) jumps
     *  straight to the spray (#211 offset 2653) that dissolves it. Then the way
     *  west to `storeArch` opens. */
    ghost: 440,
    /** The root-beer answer in the street ghost's first menu — the 3rd option
     *  (verb 122, offer-root-beer). Dialog verbs are positional
     *  (`g100 = 120 + option index`), so option 3 is always 122; its case in
     *  #211 jumps directly to the spray. One pick clears the ghost — see
     *  {@link leaveSprayingGhosts}. */
    ghostRootBeerAnswer: 122,
  },

  /** The Voodoo Lady's shop (room 29), entered through the street's
   *  `voodooDoor`. */
  voodooShop: {
    id: 29,
    /** The chicken (#377) — Pick up (verb 9) flips it to ego. */
    chicken: 377,
    /** The door (#367) → back out to the street (room 35); click to exit. */
    door: 367,
  },

  /**
   * The general-store street (room 34) — a wide scrolling street off the
   * town's north-east arch, with the store, the Governor's-mansion approach
   * and an alley. We only transit it to the store and back.
   */
  storeStreet: {
    id: 34,
    /** The Governor's mansion (#431) in the street's far background. Walk-to is
     *  a bare `loadRoomWithEgo room=36`, carrying ego up to the mansion gate
     *  ({@link governorMansion}, room 36) where the piranha poodles guard the
     *  door. (Clicking the dogs themselves, #439, chains to this same script.) */
    mansion: 431,
    /** The door (#437) → the general store ({@link ROOMS.store}, room 30).
     *  Approach it, Open it (verb 2 — its handler only fires with ego at the
     *  door), then click to walk through. */
    storeDoor: 437,
    /** The far-east arch (#433) back to the Mêlée town street
     *  ({@link ROOMS.meleeStreet}, room 35); click to walk through. (Early on
     *  bit#453, the church-detour gate, is clear, so it just loads room 35.)
     *  Once bit#453 is set (Part IV begun) its verb-11 instead scolds (the
     *  church-isn't-that-way) and redirects the walk to the church door
     *  {@link churchDoor} — the finale is funneled toward the church. */
    townArch: 433,
    /** The prison entrance (#434). Walk-to → `loadRoomWithEgo obj=400 room=31`,
     *  dropping ego inside the jail ({@link prison}, room 31) where Otis is
     *  locked up. */
    prison: 434,
    /** PART IV — the church door (#438, between the store and the jail). A
     *  standard two-state door: Open it (verb 2 — runs the open animation to
     *  state 1), then walk to it; its walk-to handler then `loadRoomWithEgo
     *  obj=857 room=78` into the wedding ({@link church}). Shut until Part IV. */
    churchDoor: 438,
  },

  /**
   * The general store (room 30). The sword and shovel sit out on display;
   * grabbing them and ringing the bell brings the shopkeeper, who makes you
   * pay through a buy conversation.
   */
  store: {
    id: 30,
    /** The sword (#388) — Pick up (verb 9). */
    sword: 388,
    /** The shovel (#396) — Pick up (verb 9). */
    shovel: 396,
    /** The bell (#399) — Push (verb 5) summons the shopkeeper out. */
    bell: 399,
    /** The shopkeeper (#394) — an OBJECT. Talk to (verb 10) opens the buy
     *  conversation. */
    shopkeeper: 394,
    /** Buy-conversation answer verb ids. The menu reuses ids across stages
     *  (120/121 recur), so pick them in order — the harness sequences by the
     *  verb leaving the menu between picks. Sword costs 100, shovel 75. */
    buyAnswers: {
      /** Top menu: the about-the-sword line — bring up the sword. */
      aboutSword: 120,
      /** Top menu: the about-the-shovel line — bring up the shovel. */
      aboutShovel: 121,
      /** Sub-menu: the buy-it line — buy the item just brought up. */
      wantIt: 120,
      /** The buy-breath-mint line — buy the breath mint ({@link mint}, #395)
       *  for 1 piece of eight. GATED: only arms after Otis has been spoken to
       *  (the prison sets {@link ROOMS.prison}'s `talkedBit`, bit#420), which
       *  unlocks the mint line in the shopkeeper's tree. */
      breathMint: 124,
      /** The look-around line — ends the chat, control back. */
      lookAround: 125,
    },
    /** The breath mint (#395), bought via {@link buyAnswers}.`breathMint`; given
     *  to Otis to settle his death-breath so he trades the cake. */
    mint: 395,
    /** The door (#387) → back out to the street (room 34); Open (verb 2) then
     *  click to walk through. */
    door: 387,
    /** The shopkeeper — ACTOR 11 (object {@link shopkeeper} is his talk target).
     *  His presence in room 30 is the safe's guard: handle moves while he's in
     *  get a scolding instead of registering. */
    keeperActor: 11,
    /** The safe (#389) — its state flips to 1 (open) while the keeper dials it
     *  during the credit interview, and when the player cracks it. */
    safe: 389,
    /** The safe handle (#390). Push (verb 5) / Pull (verb 6) feed local #202,
     *  the combination matcher: moves group by direction; each direction CHANGE
     *  closes a group whose size must equal the next combination digit. The
     *  combination is FOUR digits in g221..g224 (generated once, 1–4 each, by
     *  local #205 on the first store entry — random per game, so read it from
     *  the vars, never hardcode). Entry state: g226 = groups consumed, g227 =
     *  current group count, g228 = last direction (0 pull / 1 push — the FIRST
     *  group must continue whatever g228 holds), bit#73 = still-correct flag. On
     *  the final matching move the safe opens and the first open hands over
     *  {@link creditNote}. */
    handle: 390,
    /** First of the four combination digit globals (g221..g224). */
    comboVar: 221,
    /** g226/g227/g228 — the matcher's live state (see {@link handle}). */
    comboPosVar: 226,
    comboCountVar: 227,
    comboDirVar: 228,
    /** The note of credit (#397), picked up automatically on the first player
     *  open of the safe. */
    creditNote: 397,
    /** The credit interview + errand (conversation #211, after Stan's referral).
     *  Slot ids as armed at this stage (sword/shovel/mint long bought): top menu
     *  has the Sword-Master line at 122 and the credit ask at 123; the job
     *  question's yes-answer is at 120; the job-detail menu has the
     *  clean-ships-at-Stan's line at 123. Asking the keeper to fetch the Sword
     *  Master (122) sends him out — the safe-cracking window. */
    creditAnswers: {
      askNote: 123,
      haveJob: 120,
      jobAtStans: 123,
      fetchSwordMaster: 122,
    },
  },

  /**
   * The Governor's mansion gate (room 36), reached from the store street's
   * mansion ({@link storeStreet}'s `mansion`, #431). Three piranha poodles
   * guard the door; the thievery trial is to get past them (the yellow petal
   * {@link ROOMS.forest}'s `yellowPetal` is their sedative) and into the
   * mansion to steal the idol.
   */
  governorMansion: {
    id: 36,
    /** The three guard dogs (#467). Giving them the drugged meat
     *  ({@link ROOMS.kitchen}'s `meat` once dressed with the petal) runs the
     *  dogs' verb-80 → room-local #201, which checks the drugged class and sets
     *  {@link dogsAsleepBit}; the dogs are renamed (sleeping) and the door is
     *  passable. */
    dogs: 467,
    /** bit#15 — the dogs-asleep flag (#201 sets it once they eat the drugged
     *  meat). The gate for getting past them into the mansion. */
    dogsAsleepBit: 15,
    /** The mansion gate door (#465). Once the dogs are drugged asleep (#201
     *  unlocks the pen boxes + sets the door's class), Open it (verb 2 → global
     *  #25 swings it to state 1) then Walk to it (verb 11 → `loadRoomWithEgo
     *  obj=633 room=53`) to step into the mansion interior
     *  ({@link governorInterior}). */
    door: 465,
    /** The path (#466) back out to the general-store street
     *  ({@link storeStreet}, room 34); verb-11 is a bare `loadRoomWithEgo
     *  obj=431 room=34`. The route to the prison for the file. */
    path: 466,
  },

  /**
   * The Governor's mansion interior (room 53), entered through the gate door
   * ({@link governorMansion}'s `door`, ego arrives at the interior door #633).
   * The idol (#635) sits behind a booby-trap gauntlet; the thievery trial plays
   * out here across several cutscenes (grab via the hole, the Sheriff's catch).
   */
  governorInterior: {
    id: 53,
    /** The interior side of the gate door (#633), back out to the mansion gate
     *  ({@link governorMansion}, room 36). Verb 2 branches: if ego already holds
     *  the idol (#635) it runs the Sheriff catch (#217) instead of letting you
     *  leave. */
    entryDoor: 633,
    /** The right-hand door (#632). Open it (verb 2), then Walk to it (verb 11):
     *  with the door open its verb-11 runs the booby-trap gauntlet cutscene
     *  (local #210), which arms the joke items and hands ego four of them —
     *  {@link styleManual} #641, {@link waxLips} #642, {@link stapleRemover}
     *  #643 and {@link ratRepellent} #640 — then returns control. */
    rightDoor: 632,
    /** The broken window (#638). Its own verbs all warn against cutting yourself
     *  on it; the hole you actually go through is the {@link hole} (#637)
     *  beside it. */
    brokenWindow: 638,
    /** The hole in the wall (#637). Walk-to (verb 11, a bare click) is its only
     *  verb: it checks ego holds the file, then runs the grab cutscene (local
     *  #211) — Guybrush reaches through the gauntlet and the cutscene
     *  `pickupObject`s the idol (#635) into inventory. (Enter the hole while
     *  holding the file.) */
    hole: 637,
    /** The idol (#635), the thievery-trial prize. Not directly pickable; the
     *  grab cutscene #211 `pickupObject`s it. */
    idol: 635,
    /** Rat repellent (#640); one of the gauntlet items, traded to Otis in the
     *  prison for the cake. */
    ratRepellent: 640,
    /** Style-manual gauntlet joke item (#641). */
    styleManual: 641,
    /** Wax-lips gauntlet joke item (#642). */
    waxLips: 642,
    /** Staple-remover gauntlet joke item (#643). */
    stapleRemover: 643,
    /** The grab cutscene (#211) runs straight into the Sheriff/Governor catch
     *  (#212): an excuse menu, then the smitten-stammer cascade in the
     *  Governor's close-up (room 23) — all don't-care options (pick any).
     *  Control then returns in the mansion; trying to leave via {@link
     *  entryDoor} (#633) with the idol runs the Sheriff block (#217), whose
     *  taunt menu offers this: verb 122, the you're-blocking-the-exit line —
     *  provoking Fester to dump ego (and the idol) into the harbor. */
    festerBlockingExit: 122,
  },

  /**
   * The sea bottom (room 42) — where Fester throws ego, tied to the idol, after
   * the mansion theft. The idol here is a fresh object (#578) with a real Pick
   * up verb (9); grabbing it is the thievery prize. The floor is littered with
   * sharp things (saw/knife/scissors/cleaver/axe/sword) for the rope-cutting
   * escape that follows.
   */
  seaBottom: {
    id: 42,
    /** The idol (#578) — Pick up (verb 9) to recover it. Its verb-9 (#203) grabs
     *  it AND auto-climbs the ladder, surfacing ego on the Mêlée docks
     *  ({@link docks}, room 83). */
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
    /** Dialog answer (#123) — the get-a-crew-and-a-ship rescue vow. Picking it
     *  ends the conversation and sets {@link questDeclaredBit}. */
    getCrewAndShip: 123,
    /** bit#304 — set when the rescue is vowed (#123); the Part-I-into-II quest
     *  flag (also read by other rooms' ENCD, e.g. the jail). */
    questDeclaredBit: 304,
    /** Boarding: with the ship bought ({@link ROOMS.stan}'s `shipBoughtBit`) and
     *  the crew flags set, arriving at the docks runs the crew-at-the-dock scene
     *  (ENCD → local #200): each crew member greets ego with a small don't-care
     *  menu, then the departure plays through rooms 97 → 87 → the below-decks
     *  chat (19) and hands control back aboard the Sea Monkey — the captain's
     *  cabin ({@link ROOMS.shipCabin}), Part II begun. */
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
    /** The quill pen (#75). Its Pick up also clears the ink's untouchable class,
     *  so the ink is grabbable only after the pen. */
    pen: 75,
    /** The ink (#82), a broth ingredient. Plain Pick up (once {@link pen} has
     *  been taken). */
    ink: 82,
    /** The Captain's drawer (#83). Open flips its state; LOOK at it while open
     *  runs the look-inside cutscene that auto-pockets the dusty book (#74). */
    drawer: 83,
    /** The dusty navigation book (#74), handed over by the drawer's look-inside.
     *  (Its own Use/Look opens reader #148.) */
    book: 74,
    /** The Captain's locked cabinet (#79; #80 is the second door half). Open by
     *  hand refuses (locked); Use the small key ({@link ROOMS.shipGalley}'s
     *  `smallKey`, #157) with it → global #25 swings both halves to state 1,
     *  revealing the heavy chest inside. */
    cabinet: 79,
    /** The heavy metal chest INSIDE the cabinet (#81; parent-gated: hoverable
     *  only with the cabinet open). Pick up → global #184: ego drags it out and
     *  sets it on the floor as #77 (state 1, touchable), then LOCKS walkbox 11
     *  under it and `createBoxMatrix` — the runtime matrix rebuild that makes
     *  walks detour around the chest (box 2 → 10 → 9 → 1) instead of through the
     *  now-sealed strip. */
    heavyChest: 81,
    /** The dragged-out chest on the floor (#77; #78 is its open image). Open
     *  swaps 77→0 / 78→1; LOOK at it while open fires the verb-61 reveal
     *  cutscene: the recipe (#85) and the cinnamon (#88) are pocketed and
     *  {@link recipeBit} is set. */
    placedChest: 77,
    /** #77's open-image twin — state 1 marks the chest open. */
    placedChestOpen: 78,
    /** The voyage recipe (#85). Look/Use shows the close-up (room 84,
     *  click-dismissed); holding it is what matters. */
    recipe: 85,
    /** Cinnamon sticks (#88), a broth ingredient. */
    cinnamon: 88,
    /** bit#531 — the recipe is in hand (set by the chest reveal). The big pot
     *  refuses every ingredient until this is set. */
    recipeBit: 531,
    /** The door (#84) — out to the deck (19); a bare click walks through (its
     *  verb-11 also swings the deck-side door #253 open). */
    door: 84,
  },

  /** The Sea Monkey's deck (room 19) — the cannon lives here. */
  shipDeck: {
    id: 19,
    /** The door (#253) — back into the cabin; Open it (global #25), then a bare
     *  click walks through (its walk-verb gates on state 1). */
    cabinDoor: 253,
    /** The hatch (#254) — down to the between-decks landing (9). */
    hatch: 254,
    /** The rope ladder (#258) — up to the crow's nest (17). */
    ropeLadder: 258,
    /** The cannon (#256). Use the giant rope ({@link ROOMS.shipHold}'s `rope`,
     *  #91) with it → local #250 ties it on as the fuse: the fuse actor appears
     *  and the fuse object (#252) becomes touchable. (Each tying shortens the
     *  rope's name a notch — g357.) */
    cannon: 256,
    /** The cannon mouth (#257). Use the gunpowder (#101) with it →
     *  {@link powderLoadedBit} set, powder consumed. Climbing in — the small
     *  pot's one-object Use dispatches here — while the fuse burns
     *  ({@link fuseScript} running) requires the voyage done (g259≥1), the
     *  powder loaded, and the small pot in hand (the helmet), then runs the
     *  launch cutscene #107 → ego lands on Monkey Island
     *  ({@link ROOMS.monkeyBeach}, room 20) and the used props are dropped. */
    nozzle: 257,
    /** The tied-on fuse (#252). Use the flaming mass (#167) with it → local #251
     *  (freeze-resistant): the fuse burns ~2.5s, then the cannon fires — with
     *  ego inside only if #107 is already running, else it fires empty (or
     *  fizzles without powder). Light it and wear the pot IMMEDIATELY. */
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
    /** The Jolly Roger flag (#238), a broth ingredient. Plain Pick up (it also
     *  dismisses the flag actor). */
    jollyRoger: 238,
    /** The ship's deck (#237) — a bare click (default 255) slides ego back down
     *  to the deck (19). */
    deckBelow: 237,
  },

  /** The between-decks landing (room 9) connecting deck, hold and galley. */
  shipLanding: {
    id: 9,
    /** The ladder (#105) — up to the deck (19). */
    ladderUp: 105,
    /** The hatch (#106) — down into the hold (8). */
    holdHatch: 106,
    /** The door (#107) — through to the galley (14). */
    galleyDoor: 107,
  },

  /** The Sea Monkey's hold (room 8). */
  shipHold: {
    id: 8,
    /** The ladder (#89) — back up to the landing (9). */
    ladder: 89,
    /** The powder kegs (#90). Pick up hands over the gunpowder object (#101)
     *  whenever it isn't already held — and the pot returns the potted powder
     *  to owner 15 (the room), so a second visit refills for the cannon. */
    kegs: 90,
    /** The gunpowder (#101), a broth ingredient AND the cannon charge. */
    gunpowder: 101,
    /** The giant rope (#91) — plain Pick up; later tied to the cannon as its
     *  fuse. */
    rope: 91,
    /** The wine chest (#92). Open (global #25), then LOOK at it while open → the
     *  look-inside cutscene pockets the wine (#104) and marks the chest looted
     *  (class 18). */
    wineChest: 92,
    /** The fine wine (#104), a broth ingredient. */
    wine: 104,
  },

  /**
   * The Sea Monkey's galley (room 14) — the voyage puzzle's kitchen: the big
   * pot over the fire cooks the navigation broth.
   */
  shipGalley: {
    id: 14,
    /** The ladder (#166) — back out to the landing (9). */
    ladder: 166,
    /** The cupboard (#163); Open (global #25) reveals the cereal box. */
    cupboard: 163,
    /** The cereal box as it sits in the cupboard (#168) — a forwarder: every
     *  verb re-dispatches onto {@link cereal} (#164), so the scene click
     *  targets THIS id. */
    cerealShelf: 168,
    /** The cereal (#164), a broth ingredient. Pick up pockets the box (staging
     *  the prize #157 at owner 14, hidden); Open the carried box → the eat
     *  cutscene (the eating gag, bit#366) → global #185 hands the surprise
     *  (#157) to ego. */
    cereal: 164,
    /** The cereal prize (#157), revealed as a small key. LOOK at it to discover
     *  it's the key ({@link prizeRevealedBit}); it opens exactly one thing: the
     *  cabin cabinet (#79). */
    smallKey: 157,
    /** bit#367 — the prize has been looked at and renamed to the small key. */
    prizeRevealedBit: 367,
    /** The BIG pot over the fire (#158), the ingredient sink. Its Use-with
     *  handler gates on the recipe ({@link ROOMS.shipCabin}'s `recipeBit`) then
     *  accepts EXACTLY eight ingredients, one bit each: ink #82→bit#427,
     *  gunpowder #101→bit#428 (returned to the room, owner 15), Jolly Roger
     *  #238→bit#429, cereal #164→bit#430, wine #104→bit#431, breath mint
     *  #395→bit#432, rubber chicken #377→bit#433, cinnamon #88→bit#434. The
     *  running total lives in g260; at 8 the cooking cutscene (global #108)
     *  fires: ego faints, days pass, the ship sails itself
     *  ({@link VARS.voyageStage} g259 → 1), and ego wakes in the galley on the
     *  next click (g32 → local #201). */
    bigPot: 158,
    /** g260 — how many of the eight ingredients are in the pot. */
    potCountVar: 260,
    /** The eight pot partners and the bit each one sets (see {@link bigPot}). */
    ingredients: [
      [82, 427], [101, 428], [238, 429], [164, 430], [104, 431], [395, 432], [377, 433], [88, 434],
    ],
    /** The SMALL pot (#165), the launch helmet. Plain Pick up; its one-object
     *  Use on deck dispatches the climb-into-the-nozzle. */
    smallPot: 165,
    /** The burning fire (#161). Use the business card (#702) with it → the card
     *  burns (the burn-them-all gag) and the flaming mass (#167) lands in
     *  inventory — the fuse lighter. */
    fire: 161,
    /** The burning business card / flaming mass (#167). */
    flamingMass: 167,
  },

  /** Monkey Island's beach (room 20) — where the cannon launch (#107) drops
   *  ego (x 344, y 105), Part III's opening shore. The launch strips the
   *  voyage props (rope, powder, key, pots, recipe…) on landing. */
  monkeyBeach: {
    id: 20,
    /** Ego lands lying face-down (costume 72) with the next click routed to the
     *  get-up wakeup: the room ENCD leaves g32 (VAR_VERB_SCRIPT) = 201, so a bare
     *  floor click runs local #201 — ego stands (costume → 1) and g32 is restored
     *  to 4. The first interaction of Part III is just getting up. */
    wakeupVerbScript: 201,
    /** A single banana on the sand (#265); Pick up (verb 9). */
    banana: 265,
    /** The public-assembly notice by the tree (#271). Look at (verb 8) runs
     *  local #203, which reads the LeChuck occupation announcement and hands
     *  control back. */
    assemblyNote: 271,
    /** The jungle (#261). Walk-to (verb 11) doesn't load a room the usual way:
     *  it `putActorInRoom`s ego into the overhead map (room 2) and
     *  `actorFollowCamera`s — the camera-follows-a-relocated-ego path that makes
     *  room 2 the current room. The way up onto the island map. */
    jungle: 261,
    /** The banana cluster the catapult knocks off the tree onto the beach
     *  (#270); state flips to 1 when the catapult hits. A plain Pick up (verb 9
     *  → its own script) takes BOTH beach bananas ({@link beachBananaA} #266 +
     *  {@link beachBananaB} #267) and clears the cluster (state → 0) — no
     *  banana-picker needed. (#265 was already pocketed in the opening beat.)
     *  These three plus the village pair (#282/#283) are the five the monkey
     *  wants, so the cluster MUST be taken on the south beach before rowing away
     *  — there's no convenient return to room 20 afterward. */
    fallenBananas: 270,
    /** A beach banana (#266), handed over by the {@link fallenBananas} cluster's
     *  Pick up (no Pick up verb of its own). */
    beachBananaA: 266,
    /** The other beach banana from the cluster pickup (#267). */
    beachBananaB: 267,
    /** The rowboat (#263). Use the oars ({@link crack}'s `oars` #245) on it
     *  (verb 7 → local #200): ego rows out onto the overhead map's water
     *  (room 2) as the boat figure (costume 4). */
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
    /** The Fort marker (#44 on screen 3 — carries no verbs of its own). Walking
     *  the figure within distance 2 of it trips room-3 local #200, which
     *  `doSentence STOP`s the walk and `loadRoomWithEgo room=80` — into the
     *  Fort. Walk to its on-screen spot to enter. */
    fortApproach: { x: 119, y: 57 },
    /** Screen-3 → screen-4 edge connector (#39, the path), via global #34. The
     *  Fort exits onto screen 3; the River Fork sits on screen 4. */
    fortScreenToRiver: 39,
    riverScreen: 4,
    /** The River Fork marker (#51, on screen 4): verb-11 is a bare
     *  loadRoomWithEgo room=15 — into the River Fork. */
    riverForkMarker: 51,
    /** The Pond marker (#59, on screen 4): verb-11 loadRoomWithEgo room=40. */
    pondMarker: 59,
    /** Screen-4 → screen-2 edge connector (#46), via global #34. The Crack sits
     *  on screen 2 ({@link crackScreen}). */
    riverScreenToCrackScreen: 46,
    crackScreen: 2,
    /** The Crack marker (#35, on screen 2): verb-11 putActorInRoom 18 + follow —
     *  into the Crack. */
    crackMarker: 35,
    /** The beach marker (#30, on screen 2): → the south beach (room 20). */
    beachMarker: 30,
    /** The boat route around the island. In the boat (costume 4) the water exits
     *  are touchable: screen 2's #33 → screen 5, screen 5's #64 → screen 6, and
     *  screen 6's beach #71 lands ego at the north beach ({@link northBeach},
     *  room 132). The relative-crossing placement depends on the fixed
     *  edge-distance box snapping (see `pathfinding/boxes.ts`) to keep the boat
     *  on water across each edge rather than stranding it on a land box. The
     *  REVERSE leg (north beach back to the monkey's side) rows screen 6 → 5
     *  (#70) → 2 (#65) then lands at the south beach via {@link beachMarker} #30:
     *  the walking figure can't path screen 6 → 2 (the inland map's two halves
     *  only join by boat), so this is how you get back to the monkey/clearing. */
    boatScreen2to5: 33,
    boatScreen5to6: 64,
    northBeachLanding: 71,
    boatScreen6to5: 70,
    boatScreen5to2: 65,
    /** Screen 6 (the north screen) also carries the way INLAND: the village
     *  marker (#72) — verb-11 is `loadRoomWithEgo room=25`, into the cannibal
     *  village ({@link cannibalVillage}). The hut escape (room 27) also dumps
     *  ego back onto this screen. */
    villageScreen: 6,
    villageMarker: 72,
    /** Walking route to the clearing (the boat-side inland, screens 2–5): the
     *  figure can't reach screen 5 directly from screen 2 (#33 is a water edge),
     *  so go screen 2 → 4 (#29, top edge) → 5 (#47, right edge), then screen 5's
     *  clearing marker (#63) → the clearing ({@link monkeyClearing}, room 12). */
    screen2toScreen4: 29,
    screen4toScreen5: 47,
    clearingMarker: 63,
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
    /** The jungle (#16, a room-1 object) — from screen 132 its Walk-to
     *  `putActorInRoom`s ego onto overhead-map screen 6 (room 6) and follows.
     *  The way inland toward the cannibal village. */
    jungle: 16,
    /** The beached rowboat, oars included (#17). Use (verb 7) re-launches ego
     *  onto the map water as the boat (costume 4), on the adjacent screen — the
     *  way back to the monkey's side. */
    rowboat: 17,
  },

  /**
   * The cannibal village (room 25) — reached from overhead-map screen 6's
   * village marker (#72). Stealing the bowl bananas triggers the cannibals'
   * capture (#202); they escort ego to the guest hut ({@link cannibalHut},
   * room 27). Later the navigator's head (#293) and the idol-offer play out here.
   */
  cannibalVillage: {
    id: 25,
    /** The fruit-bowl bananas (#291). Pick up (verb 9) pockets the two village
     *  bananas ({@link bowlBananaA} #282 + {@link bowlBananaB} #283) and starts
     *  the capture cutscene (#202). The basket (#304) just forwards here when
     *  bananas are present. */
    bowlBananas: 291,
    bowlBananaA: 282,
    bowlBananaB: 283,
    /** After the bowl take, #202 parks until the camera pans back RIGHT toward
     *  the cannibals (g2 > 270) — NOT a softlock; walking toward this spot
     *  springs the confrontation cutscene. (Grab-and-go: steal, then turn back.) */
    confrontSpot: { x: 400, y: 138 },
    /** Confrontation menu (the cannibals threaten to eat you). The fine-eat-me
     *  line (#122) chains global #105 — the natives escort ego to the guest hut
     *  (`putActorInRoom room=27`). The other options loop (no offer yet) or fail
     *  the three-headed-monkey trick (#207). */
    fineEatMe: 122,
    /** The cannibals (#303) — the idol's give-target on the RETURN visit. The
     *  village looks empty; provoke the ambush by walking far WEST then back EAST
     *  toward the exit (the camera-crossing watcher, local #200/#202). At the
     *  confront menu pick {@link offerAnything} → the offering speech → a brief
     *  window where #303 turns touchable (its untouchable class bit 31 clears)
     *  and the verb script is g32=206 (the give-us-something hold). Give the
     *  wimpy idol then → #203 → #205 (the idol-accepted reaction): the idol is
     *  consumed, the cannibals turn friendly, and the hut door ({@link hutDoor})
     *  opens. Too slow and they throw you back in the hut. */
    cannibals: 303,
    /** Confront-menu option (the offer-anything line, #121) — opens the offering
     *  window. */
    offerAnything: 121,
    /** Provoke the re-confrontation: the camera must pan left (walk west) then
     *  back right (walk east toward the exit) past the watcher's threshold. */
    recaptureWest: { x: 120, y: 139 },
    recaptureEast: { x: 560, y: 130 },
    /** The hut door (#285); locked on the first visit, OPEN once the idol wins
     *  the cannibals over. Open + walk through → the hut (room 27). */
    hutDoor: 285,
    /** Herman Toothrot — ACTOR 7. Re-entering the village holding the picker
     *  (and with bit#548 still unset) makes room 25's ENCD summon him
     *  (`startScript 218`): he's been hunting the cannibals to get his
     *  banana-picker back, parked at the right edge (x≈521). Walking east scrolls
     *  the camera so he's on-screen. */
    herman: 7,
    /** Walk target that scrolls the camera right to Herman before the give. */
    hermanSpot: { x: 470, y: 138 },
    /** The Monkey-Head key (#269). Giving the picker (#314) to Herman runs global
     *  #96: he takes it and hands ego this key (and sets g411 = 8742). Used later
     *  on the Giant Monkey Head's ear. */
    monkeyHeadKey: 269,
    /** The village's exit edge (#290) back out to overhead-map screen 6
     *  ({@link monkeyMap}.villageScreen). */
    jungleExit: 290,
    /** The friendly natives (#292), the give-target once the LeChuck talk
     *  ({@link lechuckTalk}) finishes and they go idle (#215). They're absent at
     *  rest and only reappear on entry FROM the map (g101==6); see
     *  {@link jungleExit}/{@link monkeyMap}.villageMarker. */
    friendlyNatives: 292,
    /** The forced "how to defeat LeChuck" conversation (#214 → #213) that opens
     *  when you re-enter the village from the map. Driving it to the end is the
     *  gate for the navigator's head: each {@link probe} (answer #120) digs into
     *  a fresh menu until the cannibals have explained their exorcist potion
     *  needs a rare root LeChuck stole ({@link rootStolenBit} #510) and where he
     *  hides ({@link hideoutBit} #511) — only THEN does {@link goGetRoot} (answer
     *  #124, the go-get-the-root line) arm; picking it sets {@link committedBit}
     *  #513, makes them offer the head, and turns the natives idle/giveable.
     *  (Answer #120 recurs across menus; #124 is an unrelated "you've done
     *  enough, bye" exit in the FIRST menu, so gate the goGetRoot pick on #510 &&
     *  #511 to tell them apart.) */
    lechuckTalk: {
      probe: 120,
      goGetRoot: 124,
      rootStolenBit: 510,
      hideoutBit: 511,
      committedBit: 513,
    },
    /** The navigator's head (#293). GIVE the navigation leaflet (#902) to
     *  {@link friendlyNatives}: room-25 #203 chains global #104, which takes the
     *  leaflet, plays the room-86 magic-necklace close-up, and hands ego the head
     *  (sets bit#358 + g411 = 4313). Held out in the catacombs it points the way
     *  to LeChuck. */
    navigatorHead: 293,
    /** The magic necklace (#294), ON the navigator's head. Begging the head for
     *  it ({@link ghostCavern}.headTalk) hands it over; wearing it makes ego
     *  invisible to ghosts. Pocketed with the head by the leaflet trade
     *  (global #104). */
    necklace: 294,
    /** The navigation leaflet (#902, the Sea Monkey's how-to), traded to the
     *  cannibals for {@link navigatorHead}. */
    leaflet: 902,
    /** Set by global #104 when the head is handed over; arms the room-25
     *  re-confrontation (#214/#217) for the catacombs return. */
    navHeadGivenBit: 358,
    /** The seltzer is made AUTOMATICALLY on returning to the village with the
     *  voodoo root ({@link ghostGalley}.root #823): the room-25 ENCD starts local
     *  #200, which sees `owner(#823)==ego && bit#383==0` → global #106 — the
     *  cannibals' cutscene that turns the root into magic seltzer (renames #823 →
     *  the magic-seltzer bottle, sets {@link seltzerBit} #383) and walks ego off
     *  to the overhead map (room 6). No Give verb; just arrive holding the root. */
    seltzerBit: 383,
    /** The lift home — ends Part III. Once the seltzer is made (bit#383), the
     *  village's jungle exit ({@link jungleExit} #290) verb-11 → global #171 (the
     *  run-home transition cutscene) → the ghost-ship cavern
     *  ({@link ghostCavern}, room 70), where the ghost crew greet ego as "Bob"
     *  and give a ride → global #131 → Part IV (room 95 title card → the Mêlée
     *  docks, room 83; sets bit#453). (Pre-seltzer, #290 is the plain exit to map
     *  screen 6.) */
    partFourBit: 453,
  },

  /**
   * The cannibal guest hut (room 27) — where #105 drops ego after the capture.
   * The escape: take the skull (it hides the loose board), open the board into a
   * hole, crawl out onto the map. The banana-picker is here too but can't fit
   * through the hole — it's retrieved later through the (now-locked) door.
   */
  cannibalHut: {
    id: 27,
    /** The skull on the wall (#310). Pick up (verb 9) pockets it and REVEALS the
     *  loose board ({@link looseBoard} #309, its child — Open does nothing until
     *  the skull is taken). Otherwise inert (a nothing-happened line). */
    skull: 310,
    /** The loose board (#309). Open (verb 2) turns it into the hole (state 1);
     *  then a bare click (verb 11) crawls ego through onto overhead-map screen 6
     *  (room 6, `putActorInRoom`). */
    looseBoard: 309,
    /** The banana-picker (#314). NOT taken on the escape: it won't fit through
     *  the hole (local #200 has ego drop it back to the room), so it's retrieved
     *  later through the door once the idol makes the cannibals friendly. */
    picker: 314,
    /** The hut's door (#307) back out to the village (room 25). */
    door: 307,
  },

  /**
   * The wandering monkey — ACTOR 2 (costume 73 on the map). It paces
   * overhead-map screen 2; clicking it (its catch handler, room-2 local #203)
   * walks ego over and runs #201 → `loadRoomWithEgo room=21`, the monkey
   * close-up. There you FEED it bananas: each Give (verb 4, banana → the monkey
   * actor) routes through close-up local #202 → #203, which consumes the banana
   * (owner → 14) and bumps {@link fedVar} g145. Global #43 (the follow
   * controller, kicked off on the first feed) then makes the monkey trail ego —
   * including ACROSS map screens (global #34 carries it along). It follows from
   * g145 ≥ 1; the g145 > 5 sated branches are unreachable (only five bananas
   * exist), so feeding never stops the follow. The five = beach #265/#266/#267 +
   * village #282/#283.
   */
  monkey: {
    actor: 2,
    /** Close-up room the catch loads (room 21); feeding happens here. */
    closeup: 21,
    /** The close-up's exit (#274) back onto the map (screen 2); the monkey
     *  follows ego out. */
    closeupExit: 274,
    /** The monkey must be "down" (costume 6) in the close-up to accept a banana;
     *  feeding mid-animation is refused (a wait-until-it-comes-down line), so
     *  wait for this costume between feeds. */
    receptiveCostume: 6,
    /** g145 — bananas fed to the monkey (each feed +1). */
    fedVar: 145,
    /** The five bananas to feed, in inventory by now. */
    bananas: [265, 266, 267, 282, 283],
  },

  /**
   * The clearing (room 12) — the totem poles and the Giant Monkey Head, reached
   * from screen 5's marker {@link monkeyMap}'s `clearingMarker`. With the fed
   * monkey following, Pull the totem's nose; the monkey holds the gate open so
   * ego can walk the length of the clearing and through the gate into the idol
   * chamber ({@link idolChamber}, room 69). (Part I's circus clearing is the
   * SEPARATE {@link clearing}, room 52.)
   */
  monkeyClearing: {
    id: 12,
    /** The totem's nose (#144). Pull (verb 6 → local #204): ego yanks it and,
     *  with the monkey still following (#43), local #205 sets the monkey to hold
     *  the gate. */
    totemNose: 144,
    /** The Giant Monkey Head (#133) at the far right (x≈813). It is BOTH the
     *  idol-chamber gate AND the catacombs gateway. Walking up to it (after the
     *  nose-pull) lets the following monkey grab and hold the gate —
     *  {@link gateHeldObj} #142 flips to 1 — opening the idol chamber. On the
     *  RETURN with the mouth open ({@link mouthOpenObj} #151==1), walking it again
     *  loads the catacombs antechamber instead. Its verb-11 reads: #142==1 &&
     *  #151==1 → room 65 (catacombs); #142==1 only → room 69 (idol chamber, via
     *  #155); else nothing. A bare walk-to fires it only once ego has arrived at
     *  the head, so the click is RETRIED until the room changes. */
    head: 133,
    /** The gate entrance at the head (#155): once the gate is held, its verb-11
     *  `putActorInRoom room=69` — into the idol chamber (only while the mouth is
     *  still closed, #151==0; inert once the mouth is open). */
    headGate: 155,
    /** obj #142 — the gate-held flag (state 1 once the monkey holds it open). */
    gateHeldObj: 142,
    /** obj #151 — the mouth-open flag. The key-on-ear ({@link idolChamber}.ear)
     *  global #94 flips it to 1; with the gate still held, #133 then opens the
     *  catacombs ({@link catacombsAntechamber}, room 65). */
    mouthOpenObj: 151,
    /** The clearing's exit (#134) back onto overhead-map screen 5. */
    jungleExit: 134,
  },

  /**
   * The idol chamber inside the Giant Monkey Head (room 69) — a shelf of
   * look-alike idols. Take the wimpy little idol (#761); the rest are decoys.
   * Exit (#756) on the far left.
   */
  idolChamber: {
    id: 69,
    /** The wimpy little idol (#761). Pick up (verb 9 → pickupObject into
     *  inventory). The offering for the cannibals. */
    wimpyIdol: 761,
    /** The exit (#756, Walk-to, far left). */
    exit: 756,
    /** The giant ear (#767). On the catacombs RETURN visit (re-entered through
     *  the still-held gate), Use the Monkey-Head key ({@link cannibalVillage}'s
     *  `monkeyHeadKey` #269) on it (verb 7; partner `L0==269`) → global #94: ego
     *  climbs in, the mouth-open animation plays, the mouth state object #151
     *  flips to 1, and ego is dropped back in the clearing (room 12, x≈876). The
     *  "head" #765 rejects the key (a nowhere-to-put-it line) — it goes in the
     *  EAR. */
    ear: 767,
  },

  /**
   * The abandoned Fort on the volcano rim (room 80) — the rope, the spyglass,
   * and the rusty cannon whose spill yields the gunpowder + cannonball. Herman
   * Toothrot (actor 7) haunts the place.
   */
  fort: {
    id: 80,
    /** A rope (#881); plain Pick up (verb 9). One of the two ropes the Crack
     *  descent needs (the pond's is the other). */
    rope: 881,
    /** The spyglass (#882); Pick up (verb 9). */
    spyglass: 882,
    /** The spyglass becomes the lens IN PLACE: Open (verb 2) renames #882 and
     *  flips its class — bit 1 (value 2) goes ON (and class 6 OFF). Assert
     *  {@link lensClassBit}, not the localized name. The lens focuses the sun on
     *  the dam (the flint+cannonball-free igniting route). */
    lensClassBit: 1,
    /** The rusty cannon (#883). Push (verb 5 → local #200): it tips and spills
     *  the gunpowder pile (#887) + cannonball (#885) onto the floor (state 1,
     *  touchable), setting bit#137. Herman (actor 7) then wanders in to confront
     *  you over his spyglass — the spill is only reachable once he's gone. */
    cannon: 883,
    /** Herman Toothrot — ACTOR 7. After the cannon spill his watcher (local #202)
     *  walks him in to complain; a conversation answer sends him off and he
     *  leaves room 80. */
    hermanActor: 7,
    /** Dialog answer (the leave-me-alone line, #122) — sends Herman away. */
    dismissHerman: 122,
    /** The gunpowder pile (#887) — Pick up (verb 9 → local #201) pockets the
     *  gunpowder object {@link gunpowder} #884 (the dam charge). Spilled by the
     *  cannon push. */
    gunpowderPile: 887,
    /** The gunpowder (#884) that lands in inventory. */
    gunpowder: 884,
    /** The cannonball (#885); Pick up (verb 9 → #201). Spilled by the cannon
     *  push; the dam's igniter together with the flint. */
    cannonball: 885,
    /** The path out (#886), back onto the overhead map (screen 3, near the Fort
     *  marker but clear of its re-entry watcher). */
    path: 886,
  },

  /**
   * The River Fork (room 15) — the dam, and the climb up to the catapult. The
   * dry riverbed runs through; blowing the dam floods it and fills the pond.
   */
  riverFork: {
    id: 15,
    /** The rock sitting on a note (#169). Pick up (verb 9 → global #167) pockets
     *  it, renamed to the flint, AND reads the note (#231) underneath in the same
     *  gesture. Later the dam igniter — Use it with the cannonball (#885) for a
     *  flint-and-steel spark by the dam. */
    flint: 169,
    /** The note under the rock (#231), read as part of taking the flint. */
    note: 231,
    /** The footholds (#170). Walk-to (verb 11 → local #203) climbs up to the
     *  catapult platform ({@link catapult}, room 16). */
    footholds: 170,
    /** The dam (#176; #177 is its twin hot-region). Use the Fort gunpowder
     *  ({@link fort}'s `gunpowder` #884) with it → the powder is placed on the
     *  dam (#178 drawn, the gunpowder consumed). Then a flint-and-cannonball
     *  spark beside it ignites it (global #44): the dam blows, the river floods,
     *  the pond fills, and ego is washed back onto the overhead map (room 4). */
    dam: 176,
  },

  /**
   * The catapult (a cannibal contraption) — two stacked rooms: the aiming
   * platform (room 16) and the firing ledge above it (room 11), reached by a
   * further climb. Aimed right and fired, it lobs a rock across the island and
   * knocks the bananas off the beach tree.
   */
  catapult: {
    /** The aiming platform (room 16), reached up {@link riverFork}'s `footholds`. */
    platform: 16,
    /** The firing ledge above (room 11), reached up {@link upToLedge}. */
    ledge: 11,
    /** The catapult arm (#235; #234 is its other end). Pull (verb 6 → local
     *  #200) raises the aim ({@link aimVar} g242) by 1 per pull (#234 lowers it);
     *  it caps out (a won't-go-further line). A hit lands only at g242==
     *  {@link aimTarget} — it rests at 2, so two pulls aim it. */
    crank: 235,
    aimVar: 242,
    aimTarget: 4,
    /** Footholds (#232) up to the firing ledge (11). */
    upToLedge: 232,
    /** A rock (#116) ALREADY seated in the catapult on the ledge (no need to take
     *  one from the pile #120). Push (verb 5 → local #200) fires it; with the aim
     *  right (g242==4) it hits the beach banana tree, dropping bananas there and
     *  latching {@link hitBit}. Herman may wander in to complain (he comes on his
     *  own when ego nears the catapult) — shoo him with {@link dismissHerman}. */
    seatedRock: 116,
    /** Dialog answer (the leave-me-alone line, #122) — shoo Herman, same as the
     *  Fort. */
    dismissHerman: 122,
    /** bit#530 — set once the catapult has hit the beach banana tree. It's a
     *  one-shot: a later shot just says it won't hit again. */
    hitBit: 530,
    /** The catapult ledge can't path straight to the down-path object; stage ego
     *  onto box 1 here first. */
    ledgeDownStage: { x: 114, y: 134 },
    /** The down-path on the ledge (#115) — down to the platform (16). */
    ledgeDown: 115,
    /** The down-path on the platform (#233) — down to the River Fork (15). */
    platformDown: 233,
  },

  /**
   * The Pond (room 40) — filled by the dam flood. A battered man (#563) sits by
   * a rope; a corpse dangles above on another. The rope by the man is the second
   * rope the Crack descent needs.
   */
  pond: {
    id: 40,
    /** The second rope (#561), by the unhealthy man (#563). The flood (global
     *  #44) made it touchable; a plain Pick up (verb 9) takes it. */
    secondRope: 561,
    /** The exit (#554), back onto the overhead map (screen 4). */
    exit: 554,
  },

  /**
   * The Crack (room 18) — a cleft you descend in two roped stages to the oars at
   * the bottom. Reached from the map's Crack marker ({@link monkeyMap}'s
   * `crackMarker`).
   */
  crack: {
    id: 18,
    /** The sturdy branch, upper (#248). Use a rope with it (verb 7 → local
     *  #202): it ties on and ego climbs down a level. Gated on ego's walkbox
     *  (≥5), which the Use-walk satisfies. */
    branch: 248,
    /** The sturdy trunk, lower (#249). Use the other rope with it → ego climbs to
     *  the bottom, by the oars. */
    trunk: 249,
    /** The oars at the bottom (#245); Pick up (verb 9). The rowboat's propulsion
     *  (Use them on the boat back at the south beach). */
    oars: 245,
    /** The exit (#244), back onto the overhead map (screen 2). */
    exit: 244,
  },

  /**
   * The Mêlée jail (room 31), reached from the store street's prison entrance
   * ({@link storeStreet}'s `prison`, #434). Otis the prisoner is locked in a
   * cell; he has Aunt Tillie's carrot cake with a file baked in. The trade is a
   * two-step bribe: settle his death-breath with a mint, then give him the rat
   * repellent — he hands over the cake, which opens to the file needed to grab
   * the idol. (Rats scurry the cell — three same-box-frame animation loops,
   * local #207.)
   */
  prison: {
    id: 31,
    /** The exit (#400), back out to the store street (room 34). */
    entrance: 400,
    /** Otis the prisoner (#405), also ACTOR 4 (the give-target is the object id).
     *  Talk to him (verb 10) once, near the bars: he runs his monologue (victim
     *  of society; his breath is awful) and sets {@link talkedBit} — which
     *  unlocks the breath-mint line at the store. Giving him an item routes to
     *  his verb-80 → room-local #203. */
    prisoner: 405,
    /** Otis as an ACTOR (id 4) — used to find a floor point by the bars to walk
     *  to before talking / giving (he sits at the far-left cell). */
    prisonerActor: 4,
    /** bit#420 — set the first time Otis is spoken to; the gate that arms the
     *  store's breath-mint dialog option. */
    talkedBit: 420,
    /** Aunt Tillie's carrot cake (#420), handed over after Otis gets his mint +
     *  rat repellent. Open it (verb 2) and it renames to the file — for the idol
     *  grab. */
    cake: 420,
    /** Class 3 (bit 2) on {@link cake} — SET when the cake is opened into the
     *  file (the verb-2 `actorSetClass` clears class 6 and sets class 3).
     *  Asserted instead of the localized rename. */
    cakeIsFileClassBit: 2,
    /** The lock on Otis's cell (#403). Using a grog mug on it routes (via the
     *  mug's verb-7 → #69 → #70 [mug, 401]) into the lock-melt cutscene: the lock
     *  dissolves, Otis is freed, and — with {@link otisAgreedBit} already set —
     *  local #208 plays the friendly join (otherwise he just bolts mocking you). */
    lock: 403,
    /** Otis's POST-VOW conversation (#405's talk, with bit#304 set): answer #123
     *  twice — first the Governor-was-kidnapped news line, then the join-my-crew
     *  line — the second pick sets {@link otisAgreedBit}. */
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
   * Each visible path is one object whose verb-11 is a giant switch on `g4` →
   * `loadRoomWithEgo` the next pseudo-room. The SAME object id is the SAME
   * conceptual direction on every screen (re-positioned per screen via SO_AT, so
   * {@link objectPoint} tracks where it actually draws). Three directions, fixed
   * by object id:
   *   • back  = #685 (also #686, a duplicate hot-region that defers to #685)
   *   • left  = #688
   *   • right = #687
   * From the entry (218) the path `back, left, right, left, right, back, right,
   * left, back` threads out to the treasure-dig clearing ({@link forestDig},
   * room 64); other turns loop or dump you back at the map. A different route
   * (`back, back, right, right, left, back`) reaches the sword-master fork
   * (pseudo-room 209), whose right path leads on to the Sword Master ({@link
   * swordMaster}, room 61).
   */
  forest: {
    id: 218,
    back: 685,
    left: 688,
    right: 687,
    /** The signpost (#681) at the sword-master fork (209). Push (verb 5) runs its
     *  local #203: it drops the dead tree-trunk into a bridge (setBoxFlags
     *  unblocks the box, `startScript 205` plays the fall) and sets bit#546. Only
     *  then is the right path ({@link right}, #687) walkable across to the Sword
     *  Master. Pushing again toggles it back (local #204). */
    signpost: 681,
    /** bit#546 — set once the signpost's push has dropped the trunk-bridge; the
     *  gate to wait on before crossing the right path to room 61. */
    bridgeBit: 546,
    /** The yellow-flower screen — pseudo-room 215, one `back` step in from the
     *  entry (218). It's the ONE forest screen whose flowers are yellow (every
     *  other has the same old red flowers); the per-screen distinction is
     *  `g4==215`, which the plant's scripts gate on. */
    flowerScreen: 215,
    /** The plants (#678). In the flower screen (`g4==215`) Pick up (verb 9) runs
     *  `pickupObject 689` — the yellow petal into inventory; on any other forest
     *  screen it refuses (a not-worthy-of-a-pirate line). Also gated on not
     *  already holding the petal (an already-have-one line). The petal itself
     *  (#689) carries no Pick up verb — the plant is how you get it. */
    flowerPlant: 678,
    /** The yellow petal (#689) — what picking {@link flowerPlant} hands ego; the
     *  sedative for the mansion's guard dogs in the thievery trial. */
    yellowPetal: 689,
  },

  /**
   * The treasure-dig clearing (room 64), at the end of the {@link forest} maze.
   * Use (verb 7) the shovel ({@link ROOMS.store}'s `shovel`, #396) on the X
   * (#749) → the dig cutscene (local #200) plays out (hours pass) and hands ego
   * the buried treasure: object #752, the joke T-shirt.
   */
  forestDig: {
    id: 64,
    /** The dig spot X (#749). Use the shovel on it (its verb-7 checks the partner
     *  is the shovel #396, then runs the dig script #200). */
    x: 749,
    /** The T-shirt treasure (#752); the dig cutscene `pickupObject`s it into
     *  ego's inventory. */
    tshirt: 752,
    /** The path out (#750). Its verb-11 is a bare `loadRoomWithEgo obj=911
     *  room=85`: back up to the Mêlée map, landing on the crossroads node. */
    pathToMap: 750,
  },

  /**
   * The Sword Master's clearing (room 61), reached from the forest's
   * sword-master fork ({@link forest}, pseudo-room 209): push the signpost to
   * drop the trunk-bridge, then take the right path. Object #744 is the Sword
   * Master herself — present here, though hidden until later story (the entry
   * hides her via class while bit#89 is clear). Reaching this room is the
   * discovery: the location is now known for the swordfighting trial later.
   */
  swordMaster: {
    id: 61,
    /** The Sword Master Carla (#744). Talk to her (verb 10) once `g282 > 3` to
     *  start the trial duel: her verb script runs #116 → `startScript 73 [1,58]`
     *  (#58 sets duel mode `g285=2`, pirate-attack), then #90 drives the fight in
     *  {@link duelRoom}. */
    master: 744,
    /** The path out (#743). It has no walk verb, so a bare click falls to its
     *  default (verb 255) → back to the Mêlée map. */
    path: 743,
    /** Room the duel itself plays in (#116 `loadRoom 44`); the talk first plays
     *  an intro cutscene in the close-up room 62, then the fight runs here. */
    duelRoom: 44,
    /** bit#20 — set once Carla has been fought (#116 gates on it being clear).
     *  Beating her sets it; the trial is complete on the win. */
    foughtBit: 20,
    /** Post-vow recruit: talk to her (#744) and answer #122 (the
     *  Governor-was-kidnapped line). Her reaction plays through the close-up
     *  (room 44) and sets {@link recruitedBit}; control returns in her clearing
     *  (61). */
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
    /** The LADDER TOWER on the path side (#601). A bare click climbs ego to its
     *  platform, walkbox 7 (its verb branches on box 7: local #204 climbs up,
     *  #205 climbs down). */
    tower: 601,
    /** Walkbox of the tower platform — the zipline's near end. */
    towerTopBox: 7,
    /** The pole by the house (#600); box 10 at its top is the zipline's far end,
     *  and a bare click there climbs back up. */
    housePole: 600,
    /** Walkbox at the house-pole top — the zipline landing. */
    houseTopBox: 10,
    /** The cable segments (#603–606). Use the chicken with one: from box 7 #605
     *  is the touchable segment, from box 10 it's #603 — either runs the crossing
     *  (#203). The chicken is NOT consumed. */
    cableFromTower: 605,
    cableFromHouse: 603,
    /** Meathook's front door (#598); touchable only on the house side (local #201
     *  clears its class 32 after the crossing). Open, then walk through → the
     *  house ({@link meathookHouse}, room 37). */
    door: 598,
    /** The path (#599) back to the Mêlée map; touchable only on the path side. */
    path: 599,
  },

  /**
   * Meathook's house (room 37). Walking in fires his accost (#60, started by
   * the room's ENCD via local #203) — no Talk click needed. The recruit:
   * answer the news, propose getting a crew, and he challenges your bravery —
   * the tour cutscene (local #201) leads to the little door (the bravery dare:
   * open the little door and touch the beast).
   */
  meathookHouse: {
    id: 37,
    /** The little door (#478), later renamed to the winged-devil object. Open it
     *  (verb 2, class 6 set → global #49): the bird pops out shrieking, #49 then
     *  CLEARS class 6 and renames it. Touch the beast = any verb without its own
     *  entry on #478 (e.g. Use; the game's own hover default is the joke verb 18
     *  Fondle) → falls back to the 255 entry → local #205, the payoff: Meathook
     *  joins ({@link recruitedBit}), and the cutscene walks ego back outside. */
    littleDoor: 478,
    answers: {
      /** Accost menu 1: the Governor-was-kidnapped news line. */
      kidnapped: 120,
      /** Menu 2 (what do we do): the put-together-a-crew line; Meathook then
       *  runs the dare tour. */
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
    /** The path (#698) back up to the Mêlée map (only reachable when the
     *  conversation has released control). */
    path: 698,
    /** Stan's business card (#702); his farewell branch hands it (and
     *  {@link compass}) over while exiting you to the map. */
    businessCard: 702,
    /** The magnetic compass (#732) — thrown in on the same farewell. */
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
      /** Browse menu: the can't-spend-that-much line → the Sea Monkey
       *  pitch. (On a later visit the same slot is the show-me-the-cheap-one
       *  line.) */
      cheapest: 122,
      /** Sea Monkey menu: the buy-on-credit line — Stan points you at the
       *  storekeeper (no bit; the store's credit line arms off this referral). */
      onCredit: 121,
      /** Sea Monkey menu: the not-the-ship-I-need line — back out of the pitch
       *  to the browse menu. */
      backOut: 125,
      /** Browse menu: the think-it-over line — leave; Stan's farewell hands the
       *  card + compass and exits to the map. */
      thinkItOver: 124,
      /** Browse menu, note in hand: the have-a-credit-note line — opens the deal
       *  menu. */
      haveCreditNote: 124,
      /** Deal menu: the make-an-offer line — the offer ladder. */
      makeAnOffer: 121,
      /** Deal menu: the walk-away threat line (see {@link walkAwaysVar}). */
      walkAway: 123,
      /** Threat follow-up: the stay-on-the-lot line. */
      stay: 120,
    },
  },

  /**
   * The troll bridge (room 57) — reached from the map's bridge node
   * ({@link meleeMap}'s `bridge`). A troll (actor 5, rendered as object #655)
   * blocks the span; he demands something red — the red herring (the kitchen
   * fish, {@link ROOMS.kitchen}'s `fish` #568). Giving it (the two-object Give
   * sentence to the troll) runs local #204 (the troll accepts it and lets you
   * pass), unblocks the bridge boxes, and walks ego across — landing back on the
   * map on the far side. The fish ends owned by the troll (owner 14).
   */
  trollBridge: {
    id: 57,
    /** The troll — an ACTOR (id 5). Give the red herring TO him. */
    trollActor: 5,
  },

  /**
   * The house (room 43) — Captain Smirk's place, reached from the map's `house`
   * node. Knocking (Open the door) starts Smirk's doorway conversation (global
   * #57): negotiate the swordfighting lesson, pay 30, and ego is sent into the
   * gym ({@link smirkGym}, room 60) for the lesson.
   */
  house: {
    id: 43,
    /** The door (#591) — knock by Opening it (verb 2); starts global #57. */
    door: 591,
    /** bit#483 — the swordfighting-lesson flag, set once the lesson is taken; it
     *  gates Smirk's post-lesson dialog branch. */
    lessonTakenBit: 483,
    /** The lower path (#592); a bare click walks ego back out to the Mêlée map
     *  (room 85). (Room 43 has a second path #594, the upper one; #592 is the
     *  map exit.) */
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
     * duel fires when one reaches ego. Idling at the east/house edge stays cold
     * for tens of thousands of ticks, but cycling these west spots (near the
     * fork node #911 @ 72,88) reliably bumps a pirate within a few thousand
     * ticks. Ego snaps to the map's narrow walkboxes, so these are click
     * TARGETS, not exact parks.
     */
    westSpots: [
      { x: 50, y: 95 },
      { x: 72, y: 100 },
    ],
  },

  // ─── Part III endgame: the catacombs, the ghost ship, the lift ───────────

  /**
   * The catacombs antechamber (room 65) — reached from the clearing's Giant Monkey
   * Head ({@link monkeyClearing}.head #133) once the mouth is open. A bare walk-to
   * on its objects fires only once ego arrives, so clicks are RETRIED.
   */
  catacombsAntechamber: {
    id: 65,
    /** The monkey head (#754) — climb back UP to the clearing (room 12). */
    headUp: 754,
    /** The cavern (#755, verbs [90,255]) — on into the catacombs maze
     *  ({@link catacombsMaze}, room 39); with the seltzer made (bit#383) it
     *  shortcuts straight to the ghost-ship cavern (room 70). A bare walk-to
     *  falls to the 255 default. */
    cavern: 755,
  },

  /**
   * The catacombs maze (room 39) — procedural, RNG-reseeded per screen. Navigated
   * with the navigator's head: USE the head ({@link cannibalVillage}.navigatorHead
   * #293, verb 7 or 8) to RAISE it (bit#426 → 1, ego points), then each junction
   * walk into the correct cave (the head points at it). Six correct steps reach the
   * ghost-ship cavern (room 70). The five caves are the screen exits.
   */
  catacombsMaze: {
    id: 39,
    /** The five direction caves. The correct one for the current screen is named
     *  by {@link correctCaveVar} g164. */
    caves: [495, 496, 497, 498, 521] as const,
    /** g164 — the correct (head-pointed) cave object for the current screen, set by
     *  local #206. Walk into it to advance. */
    correctCaveVar: 164,
    /** g265 — the step counter; local #205 increments it per correct move and
     *  loads the cavern (room 70) once it passes the threshold (≈6). */
    stepVar: 265,
    /** g266 — the cave ego ENTERED from (the back-direction); walking into it bounces
     *  back to the antechamber. */
    enterCaveVar: 266,
    /** g274 — the head's direction hint (0=left 1=right 2=forward 3=back); the head
     *  speaks it (the which-way line) and ego points that way. */
    hintVar: 274,
    /** bit#426 — the head is raised/out (ego pointing). Required for the head guidance
     *  (#207/#212); USE the head to toggle it. */
    headOutBit: 426,
  },

  /**
   * The ghost-ship cavern (room 70) — the maze ends here. Make ego invisible (beg the
   * head for the necklace, then wear it), board the ship. On the RETURN with the
   * voodoo root, the cave exit leads back to the village (and post-seltzer this room
   * becomes the lift's "Bob" greeting → Part IV).
   */
  ghostCavern: {
    id: 70,
    /**
     * Talk to the navigator's head (#293, verb 10) → the room-86 close-up. BEG for
     * the necklace: pick the ask-for-the-necklace line ({@link begTopic} #121), then
     * the plead line (also #121, its name escalating per repeat) until
     * the beg counter {@link begCountVar} g286 passes 4 and the head relents
     * → hands the necklace over. The
     * dialog options are positioned text verbs resolved by VAR_MOUSE_Y, so the click
     * must land on the option's row (the testkit's pickAnswer plants the cursor there).
     */
    headTalk: { closeup: 86, talk: 10, begTopic: 121, begCountVar: 286 },
    /** The necklace (#294) — once handed over, Use it (verb 7) HERE (where the
     *  ghosts are) → global #141 → {@link wornBit} bit#357 = 1 (invisible). */
    necklace: 294,
    /** bit#357 — the necklace is worn = ego invisible to ghosts (the room-77 ENCD
     *  ghost-detection gate, global #78, reads it). */
    wornBit: 357,
    /** The ghost ship (#769) — board it (verb 11, while invisible) → cutscene
     *  (`startScript 111` stand-up) → the main deck ({@link ghostDeck}, room 77). */
    ship: 769,
    /** The exit cavern (#768). With the voodoo root in hand it runs global #170
     *  (the long-walk transition) → the cannibal village (room 25); without it,
     *  back to the antechamber (room 65). */
    caveExit: 768,
  },

  /**
   * The ghost ship's main deck (room 77). Boarding lands ego here (invisible).
   * Doors: cabin #838, the squeaky door #840 (→ brig, once greased), crew
   * quarters #841, and the cavern #855 (→ cavern 70). Closed doors need Open
   * (verb 2) then walk.
   */
  ghostDeck: {
    id: 77,
    /** The door (#838) → the captain's cabin ({@link ghostCabin}, room 72). */
    cabinDoor: 838,
    /** The squeaky door (#840) → the brig ({@link ghostBrig}, room 71). Opening
     *  it while it still squeaks (has class 6) wakes the deck ghost; GREASE it
     *  first — Use the grease glob ({@link ghostBilge}.grease #815) on it →
     *  clears class 6 (silent) — then Open + walk through. */
    squeakyDoor: 840,
    /** The hatch (#841) → the crew quarters ({@link ghostCrewQuarters}, room 73). */
    crewDoor: 841,
    /** The cavern (#855) → back to the ghost-ship cavern (room 70). */
    cavern: 855,
  },

  /**
   * The captain's cabin (room 72) — the magnetic compass catches the spinning key.
   * The ENCD draws the key as a spinning actor only on a true entry (`getActorRoom
   * (ego)==g4`), which needs ego placed in the room before the ENCD runs.
   */
  ghostCabin: {
    id: 72,
    /** The spinning ghost key (#799). Use the magnetic compass (#732, carried) on
     *  it (verb 7) → local #202 → magnet cutscene → pickupObject 799. A bare Pick
     *  up is refused (a can't-grab-the-ghost-key line). */
    key: 799,
    /** The carried magnetic compass (#732), used on {@link key}. */
    compass: 732,
    /** The door (#794) → back to the deck (room 77). */
    door: 794,
  },

  /**
   * The crew quarters (room 73) — a sleeping ghost crew and a jug o' grog. Tickle the
   * ticklish sleeper with the feather to free the grog.
   */
  ghostCrewQuarters: {
    id: 73,
    /** The passage (#800) → the galley ({@link ghostGalley}, room 75). */
    galleyPassage: 800,
    /** The stairs (#801) → up to the deck (room 77). */
    deckStairs: 801,
    /** The TICKLISH sleeper (#804; the other, #803, isn't ticklish). Use the
     *  feather ({@link ghostGalley}.feather #820) on it (verb 7 → #820's handler →
     *  local #200); it takes TWO tickles (g237 climbs each) to flip the grog
     *  touchable. */
    ticklishSleeper: 804,
    /** The jug o' grog (#802). Untouchable until the sleeper is tickled (class-32
     *  cleared); then Pick up (verb 9 → global #183). */
    grog: 802,
  },

  /**
   * The galley (room 75) — the ghost feather, the locked hatch down to the bilge, and
   * the glowing crate that holds the voodoo root.
   */
  ghostGalley: {
    id: 75,
    /** The ghost feather (#820). Pick up (verb 9), then tickle the sleeper
     *  ({@link ghostCrewQuarters}.ticklishSleeper). */
    feather: 820,
    /** The passage (#822) → back to the crew quarters (room 73). */
    crewPassage: 822,
    /** The locked hatch (#824) → the bilge ({@link ghostBilge}, room 74). Open
     *  (verb 2) gates on the held item being class 6 — the cabin key
     *  ({@link ghostCabin}.key #799) is the class-6 key — then walk through. */
    hatch: 824,
    /** The glowing crate (#821). Use the ghost tools ({@link ghostBrig}.tools
     *  #788) on it (verb 7) → global #25 → opens (state 1). Then LOOK at the open
     *  crate (verb 8) — NOT the root directly — and ego takes the voodoo root →
     *  pickupObject 823. */
    crate: 821,
    /** The voodoo root (#823), taken by looking in the open {@link crate}. Carried
     *  back to the village, it auto-becomes the magic seltzer
     *  ({@link cannibalVillage}.seltzerBit). */
    root: 823,
  },

  /**
   * The bilge (room 74) — drunk the rats with grog to reach the cooking grease.
   */
  ghostBilge: {
    id: 74,
    /** The rat dish (#807). Pour the grog ({@link ghostCrewQuarters}.grog #802)
     *  into it (verb 4 or 7) → local #201: the rats get drunk, the chase guard
     *  stops, {@link ratsFedBit} bit#316 = 1. */
    ratDish: 807,
    /** bit#316 — the rats are fed/drunk (the bilge is safe to cross). */
    ratsFedBit: 316,
    /** The grease jar (#806). Pick up (verb 9) → the glob {@link grease} #815
     *  lands in inventory. */
    greaseJar: 806,
    /** The cooking-grease glob (#815); Use it on the squeaky door
     *  ({@link ghostDeck}.squeakyDoor) to silence it. */
    grease: 815,
    /** The stairs (#811) → up to the galley (room 75). */
    galleyStairs: 811,
  },

  /**
   * The brig (room 71) — past the sleeping guard, the ghost tools that open the crate.
   * Reached through the squeaky door once it is greased.
   */
  ghostBrig: {
    id: 71,
    /** The ghost tools (#788). Pick up (verb 9). Used on the galley crate
     *  ({@link ghostGalley}.crate). */
    tools: 788,
    /** The door (#789) → back to the deck (room 77). */
    door: 789,
  },

  // ── PART IV — The Finale ──────────────────────────────────────────────────

  /**
   * The Mêlée docks (room 83) — where the lift drops "Bob" to open Part IV
   * (g277 = 6, ego holding only money #488 + magic seltzer #823). LeChuck has
   * overrun the island with ghost pirates; ego heads town-ward, spraying any
   * ghost that blocks the way with the seltzer.
   */
  meleeDocks: {
    id: 83,
    /** The east/town-ward exit jetty (#905). Its walk-to leaves to the Mêlée
     *  street ({@link meleeStreet}, room 35) — BUT a ghost pirate (actor 7)
     *  guards it: the first walk runs the dock-ghost script (local #204) instead.
     *  The ghost forces a conversation ({@link ghostAnswers}); picking the
     *  root-beer line runs the seltzer spray that dissolves it, after which a
     *  SECOND walk to #905 leaves to room 35 — see {@link leaveSprayingGhosts}.
     *  (#904, the west jetty, just bounces you back to #905 in Part IV.) */
    townExit: 905,
    /** The dock-ghost conversation answers (verbs 120–123) — a sales-pitch gag:
     *  120 root beer, 121 mouthwash, 122 a funny trick, 123 an aggressive line.
     *  ALL FOUR jump to the same spray (#204 offset 801); we pick `rootBeer`
     *  (120), the canonical root-beer line. */
    ghostAnswers: { rootBeer: 120, mouthwash: 121, trick: 122, takeThis: 123 },
    /** The magic seltzer bottle (#823) ego sprays ghosts with — the voodoo root,
     *  transmuted back in the village ({@link cannibalVillage}.seltzerBit).
     *  Carried in from Part III; the spray is automatic in each ghost's
     *  conversation, never a manual Use. */
    seltzer: 823,
  },

  /**
   * The church (room 78) — LeChuck is forcing Elaine into a wedding. Entering
   * (through {@link storeStreet}.churchDoor) auto-plays the ceremony: the priest
   * (actor 2) reaches the objection cue and a four-line
   * objection menu arms. Picking ANY line interrupts the wedding and whisks ego
   * to the confrontation ({@link confrontation}, room 45).
   */
  church: {
    id: 78,
    /** The entry/exit (#857) ego arrives at (the door from room 34 lands here at
     *  (145,142)). */
    entry: 857,
    /** LeChuck the groom — ACTOR 9 (costume 32) at the altar. The same actor
     *  carries through the confrontation and the Stan's showdown. */
    lechuckActor: 9,
    /**
     * The objection menu (verbs 120–123) — four wedding-objection lines.
     * Any pick advances (room 78 local #201 waits on g194 then transports ego to
     * room 45), so the beat picks the first, `objectionVerbs[0]`.
     */
    objectionVerbs: [120, 121, 122, 123] as const,
  },

  /**
   * The confrontation (room 45) — the long LeChuck dialogue (local #200): ego
   * objects, Elaine (actor 10) enters and reveals the bride under the veil is
   * monkeys holding her ghost-dissolving root beer, ego threatens to spray —
   * and the seltzer bottle JAMS (it's corked). LeChuck (costume 95)
   * winds up and punches Bob across the island (global #133, a punch montage over
   * the overhead map), which strips the spent seltzer and lands him in Stan's.
   */
  confrontation: {
    id: 45,
    /** LeChuck — ACTOR 9 (as in the {@link church}). */
    lechuckActor: 9,
    /** Elaine — ACTOR 10, entering partway through the cutscene. */
    elaineActor: 10,
    /**
     * The confrontation is a BRANCHING chain of answer menus (verbs positional,
     * `g100 = 120 + option index`). Driving it canonically is four picks along
     * the plot thread — {@link answerPath} — each advancing one scripted stage:
     * the objection → the "who's under the dress" reveal → the objection again →
     * the spray threat (where the seltzer jams and LeChuck punches Bob out).
     */
    sceneScript: 200,
    /**
     * The canonical pick sequence through local #200:
     *  - 124 the objection line (stop-the-wedding)
     *  - 121 the who's-under-the-dress reveal line
     *  - 124 the objection line again
     *  - 121 the spray-threat line
     * The last is the seltzer-spray threat that triggers the jam → punch (#133).
     */
    answerPath: [124, 121, 124, 121] as const,
    /** Global #133 — the punch montage that flings ego to {@link stansShowdown}
     *  (room 59) and disowns the seltzer (#823). */
    punchScript: 133,
  },

  /**
   * Stan's Used Ship Emporium (room 59) — the final showdown. The punch lands
   * Bob on the floor; the first scene click stands him up (#129) next to a root
   * beer vending machine. Two punch timers arm — #126 (a ~9 s "do nothing"
   * windup) and #125 (punch the instant ego tries to MOVE) — so grab the root
   * beer (which sits on ego's own walk-spot, needing no walk) and spray LeChuck
   * fast. Using it on him detonates him → the win (#132) → credits.
   */
  stansShowdown: {
    id: 59,
    /** The root beer (#733), on ego's own walk-spot (297,106). Pick up (verb 9):
     *  a zero-distance grab, so it must NOT trip the move-punch timer #125 (the
     *  startWalkActor zero-distance early-out). */
    rootBeer: 733,
    /** LeChuck the use-target object (#734, backed by actor 9) at (297,106). Use
     *  the root beer on him → he detonates. */
    lechuck: 734,
    /** LeChuck the actor (9) — flips to his death costume (115) as he chokes and
     *  detonates in the win cutscene (#132); the durable "defeated" signal. */
    lechuckActor: 9,
    /** The root-beer vending machine (#690) ego is flung against; the root beer
     *  #733 is dispensed from it. */
    machine: 690,
    /** The stand-up cutscene started by the first scene click after landing. */
    standUpScript: 129,
    /** The move-punch gate (#125) and the ~9 s do-nothing windup (#126) — both
     *  arm once ego is standing; each fires the punch ({@link punchScript}) — #125
     *  the instant ego moves, #126 when its timer elapses — ending the game. */
    movePunchScript: 125,
    windupPunchScript: 126,
    /** Global #127 — the actual punch both timers start (`startScript 127`).
     *  The zero-distance root-beer grab must NOT fire it; asserting it never ran
     *  is how the beat proves the grab didn't move ego. */
    punchScript: 127,
    /** The win — global #132, started when the root beer is used on LeChuck. */
    winScript: 132,
  },
} as const;

// ── Insult-swordfight driving ─────────────────────────────────────────────
// MI1-specific helpers to drive a pirate duel, kept here so the walkthrough
// reads as plain beats. A duel is dialog verbs (120+): menu slot `k` (1-based)
// is verb `119+k` and the insult/comeback id behind it is `VAR(166+k)` (the
// menu-builders #75/#89 write `g166[k]` and id-name them). One duel = provoke →
// open → trade.
const DUEL_OPENER = 127; // the duel-opening line
const DUEL_SURRENDER_INSULT = 37; // the surrender line — picking it forfeits
// The duel menu is a 6-wide sliding window over the learned insults/comebacks;
// these verbs page it.
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

/** Step 2 — the greeting menu: pick the duel-opening line to start the insult
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
 *  the opponent (g270); otherwise we ATTACK. */
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
 *  Drives the greeting opener, the g285=3 exchanges, and the post-gate
 *  ready-to-challenge conversation (exit via its last option) uniformly. Returns
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

/** Grind pirate duels lose-to-learn until ready to face the Sword Master, and
 *  return the number of duels fought. The Sword Master's insults (16..33) demand
 *  comebacks 1..16, but we can't pin WHICH she'll draw — her duel shares the
 *  seeded RNG stream with the grind, so the stop-point shifts her draw. We also
 *  can't pin the *learning order*: any engine change that moves tick dynamics
 *  relocates which comebacks the pirate pool teaches and when. A fixed
 *  "needed set" therefore has to be hand-re-derived every time the stream moves.
 *
 *  Instead this stops DYNAMICALLY: keep grinding until the pool PLATEAUS — no new
 *  comeback learned in `plateau` consecutive duels — with the readiness gate
 *  (`g282 > 3`, four duels won) clear, or every demandable comeback (1..16) known.
 *  That converges on the maximal defensible set the stream offers (comeback 12 is
 *  the perennial straggler — the pool teaches it very late or never), which is
 *  the most-ready the grind can get without simulating her draw; the proof of
 *  sufficiency is the Sword-Master win that follows. `cap` only backstops a
 *  broken gate so the caller's assertion fails loud instead of looping forever.
 *  Set `GRIND_DEBUG=1` to log the per-duel learning curve. */
export function grindForSwordMaster(vm: Vm, cap = 90, plateau = 12): number {
  const debug = !!process.env.GRIND_DEBUG;
  let fought = 0;
  let sinceNew = 0;
  let known = learnedComebacks(vm).length;
  for (;;) {
    const gateClear = vm.vars.readGlobal(VARS.fightsWon) > 3;
    if (gateClear && (known >= 16 || sinceNew >= plateau)) break;
    if (fought >= cap) break;
    if (!grindOneDuel(vm)) break; // no pirate found / duel didn't resolve to the map
    fought++;
    const now = learnedComebacks(vm).length;
    if (now > known) {
      known = now;
      sinceNew = 0;
    } else {
      sinceNew++;
    }
    if (debug) {
      console.error(
        `[grind] duel ${fought}: comebacks(${now})=[${learnedComebacks(vm).join(',')}] ` +
          `insults=[${learnedInsults(vm).join(',')}] g282=${vm.vars.readGlobal(VARS.fightsWon)} ` +
          `sinceNew=${sinceNew}`,
      );
    }
  }
  return fought;
}

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

// ── Conversation menus ───────────────────────────────────────────────────
// Dialog answers are positional verbs: the engine arms `g100 = 119 + N` for the
// Nth menu line (line 1 → verb 120), in a contiguous band above the normal
// verb/inventory ids. The rule is to drive dialogue by the NAMED answer a beat
// means to pick (e.g. {@link ROOMS.confrontation}'s `answerPath`); these
// primitives are the single home for the band itself, for the two cases a name
// can't fit — detecting whether a menu is even up, and advancing a menu the GAME
// ITSELF makes convergent (every line leads to the same outcome, so there is no
// one canonical line to name).
const DIALOG_ANSWER_MIN = 119;
const DIALOG_ANSWER_MAX = 135;

/** The conversation answers live right now, by ascending id (i.e. menu order). */
export const dialogAnswers = (vm: Vm): number[] => {
  const out: number[] = [];
  for (let v = DIALOG_ANSWER_MIN; v <= DIALOG_ANSWER_MAX; v++) {
    if (vm.verbs.get(v)?.state === 'on') out.push(v);
  }
  return out;
};

/** Whether a conversation menu is currently offering options. */
export const dialogUp = (vm: Vm): boolean => dialogAnswers(vm).length > 0;

/**
 * Advance a CONVERGENT conversation — one the game makes don't-care, every line
 * leading to the same place (the smitten-Governor stammer cascade, the crew's
 * boarding greetings, the cannibals' seltzer send-off, the ghost crew's ferry
 * ride home). Take the lowest-id live answer each menu — the continue/ride line,
 * spent small-talk self-gating away as it's used — and drive until `until` holds
 * or the menus stop arming. Picks by that documented convergence, never a guessed
 * "canonical" answer (there isn't one). `maxMenus` is only a hang-guard.
 */
export function advanceDialog(
  vm: Vm,
  until: (vm: Vm) => boolean = () => false,
  { maxMenus = 16, armTicks = 14000 }: { maxMenus?: number; armTicks?: number } = {},
): boolean {
  for (let menu = 0; menu < maxMenus && !until(vm); menu++) {
    if (!driveUntil(vm, (v) => dialogUp(v) || until(v), { maxTicks: armTicks })) break;
    if (until(vm)) break;
    const opts = dialogAnswers(vm);
    if (opts.length === 0) break;
    pickDialogAnswer(vm, opts[0]!, { armTicks });
  }
  return until(vm);
}

/**
 * Wind a conversation down by saying goodbye — the exit line sits last in the
 * menu (highest id), the lower slots being small talk. Take the last live answer
 * each menu until none remain. (Post-recruit Otis, whose remaining lines just
 * loop pleasantries.)
 */
export function exitDialog(
  vm: Vm,
  { maxMenus = 4, armTicks = 10000 }: { maxMenus?: number; armTicks?: number } = {},
): void {
  for (let menu = 0; menu < maxMenus; menu++) {
    const opts = dialogAnswers(vm);
    if (opts.length === 0) break;
    pickAnswer(vm, opts[opts.length - 1]!);
    driveUntil(vm, (v) => !dialogUp(v), { maxTicks: armTicks });
  }
}

// ── Crew & ship helpers (the Part-I finale) ──────────────────────────────

/**
 * From the Mêlée town street (35) up to the island map (85). The west arch's
 * verb-11 branches on plot bits — post-vow it can land at the lookout (33) or
 * dump ego on the docks (83, whose jetty then climbs to the lookout) — so this
 * absorbs the reroute, then takes the cliff and the path up.
 */
export function townToMap(vm: Vm): void {
  walkTo(vm, ROOMS.meleeStreet.lookoutArch);
  driveUntil(vm, (v) => v.currentRoom === ROOMS.meleeLookout.id || v.currentRoom === ROOMS.docks.id, {
    maxTicks: 14000,
  });
  waitPlayable(vm, 10000);
  if (vm.currentRoom === ROOMS.docks.id) {
    walkTo(vm, 905); // the jetty (#905) → the lookout (bit#453 reroute)
    driveToRoom(vm, ROOMS.meleeLookout.id, { maxTicks: 14000 });
    waitPlayable(vm, 10000);
  }
  walkTo(vm, ROOMS.meleeLookout.cliff);
  driveToRoom(vm, ROOMS.cliffPath.id, { maxTicks: 8000 });
  walkTo(vm, ROOMS.cliffPath.path);
  driveToRoom(vm, ROOMS.meleeMap.id, { maxTicks: 8000 });
  waitPlayable(vm, 10000);
}

/**
 * Leave a Part IV room through `exitObj`, dissolving the ghost pirate that bars
 * it. Walking into the exit makes the ghost intercept with its sales-pitch
 * conversation; picking its root-beer line (`rootBeerAnswer`) runs the seltzer
 * spray that removes the ghost and clears the guard class off the
 * exit, after which the way leads on. Returns whether it arrived.
 *
 * Two reasons this is a loop, both watching real conditions rather than blind-
 * retrying: the rooms are wide, so one walk only reaches the next walkbox edge
 * and ego must re-walk to cross (each hop is paced by {@link walkTo}'s own
 * waitReady — it blocks until the previous leg finishes); and the ghost
 * intercepts on whichever hop reaches its trigger, RNG-dependent from boot. The
 * hop cap is only a hang-guard. Picking by name (not "whatever's armed") matters
 * because the street ghost's menu is a branching tree — only the root-beer line
 * jumps straight to the spray; the others wander through stages of banter.
 */
export function leaveSprayingGhosts(vm: Vm, exitObj: number, targetRoom: number, rootBeerAnswer: number, maxHops = 8): boolean {
  const start = vm.currentRoom;
  const armed = (): boolean => vm.verbs.get(rootBeerAnswer)?.state === 'on';
  for (let hop = 0; hop < maxHops && vm.currentRoom === start; hop++) {
    walkTo(vm, exitObj);
    // The leg either crosses to the target, settles at a box edge with control
    // back, or the ghost intercepts with its menu — wait for whichever.
    driveUntil(vm, (v) => v.currentRoom !== start || armed() || v.cursor.userput > 0, { maxTicks: 14000 });
    if (armed()) pickDialogAnswer(vm, rootBeerAnswer); // root beer → spray → ghost gone
    driveUntil(vm, (v) => v.currentRoom !== start || v.cursor.userput > 0, { maxTicks: 14000 });
  }
  return vm.currentRoom === targetRoom;
}

/** Class N is bit N−1 of the runtime class mask. Class 32 is the engine's
 *  Untouchable bit ({@link isTouchable}); class 6 is the "guard" bit on
 *  doors/animals (e.g. the ghost ship's squeaky door, silenced once cleared). */
export const hasClass = (vm: Vm, obj: number, cls: number): boolean =>
  ((vm.objectClasses.get(obj) ?? 0) & (1 << (cls - 1))) !== 0;
/** Whether `obj` can be interacted with — its Untouchable class (32) is clear. */
export const isTouchable = (vm: Vm, obj: number): boolean => !hasClass(vm, obj, 32);
/** Whether ego is currently aboard the rowboat (boat costume 4). */
export const egoInBoat = (vm: Vm): boolean =>
  vm.actors.get(vm.vars.readGlobal(VAR_EGO)).costume === 4;
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
    // menu apart by its full five-slot spread (the four rungs + the extra line).
    const offerMenu = ids.has(124) && ids.has(122) && ids.has(121) && ids.has(120) && ids.has(123) && !ids.has(125);
    let pick: number;
    if (offerMenu) {
      // climb: first offer 2000 (slot 120), then one rung above the last
      pick = 120 + Math.min(3, lastOffer === 0 ? 0 : lastOffer / 1000 - 1);
    } else if (ids.has(A.stay) && m.length === 2) {
      pick = A.stay; // stay after a threat
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

// ── Part III endgame helpers (the catacombs + ghost ship) ────────────────

/** Control returned, ego stopped, no line/cutscene in flight. */
const egoReady = (vm: Vm): boolean => {
  const ego = vm.vars.readGlobal(VAR_EGO);
  return (
    vm.cursor.userput > 0 &&
    vm.activeDialog === null &&
    vm.cutsceneStack.length === 0 &&
    (ego <= 0 || !vm.actors.get(ego).isMoving)
  );
};

/**
 * Walk through a door/exit into `target` — the playthrough's one room-to-room
 * move, for the wide-room gates as much as the ghost-ship doors. The sentence
 * script (#2) walks ego to the exit and fires its verb on arrival (proximity-
 * gated — see input.md). Two faithful wrinkles, both DETECTED from state rather
 * than blind-retried:
 *
 * - A CLOSED door. A door carries an "open" image-state (state >= 1) and its
 *   verb-11 only walks ego through when its own state equals that (its script
 *   reads `getObjectState(VAR_ME)`, and VAR_ME is the door itself). A plain exit
 *   (passage, cave, gate) has no such image and just transitions — Opening one
 *   only earns "it's just an opening". So if THIS exit is a door that isn't open
 *   yet, Open it first; an Open that itself walks ego through ends the loop.
 * - A wide scrolling room. One walk-to routes ego only to the next walkbox edge,
 *   so when the exit's walk-point is screens away (e.g. room 65's cave at x=973
 *   in a 960-wide room) ego stops short. We re-issue the walk while ego KEEPS
 *   ADVANCING — gated on its x changing, not a fixed count — and stop the moment
 *   a walk leaves ego where the last one did (a real wall) or the room flips.
 *
 * Returns whether the room changed. The hop cap is only a hang-guard.
 */
export function enterRoom(
  vm: Vm,
  door: number,
  target: number,
  { maxTicks = 14000 }: { maxTicks?: number } = {},
): boolean {
  if (vm.currentRoom === target) return true;
  const ego = vm.vars.readGlobal(VAR_EGO);
  const egoX = (): number => vm.actors.get(ego).x;
  const obj = vm.loadedRoom?.objects.get(door);
  const openState = obj ? [...obj.images.keys()].find((s) => s > 0) : undefined;
  const shutDoor = (): boolean =>
    openState !== undefined && (vm.objectStates.get(door) ?? 0) !== openState;

  let prevX = NaN;
  for (let hop = 0; hop < 16 && vm.currentRoom !== target; hop++) {
    if (shutDoor()) {
      use(vm, VERBS.open, door); // flip it to its open state; verb-11 then lets ego pass
      // Wait for the open to actually land (its state flips, or that Open itself
      // walked ego through) — NOT a bare settle, which can return mid-cutscene.
      driveUntil(vm, (v) => !shutDoor() || v.currentRoom === target, { maxTicks });
      if (vm.currentRoom === target) break; // an Open that itself walks ego through
    }
    const x = egoX();
    if (x === prevX && !shutDoor()) break; // the last walk made no progress and nothing to open
    prevX = x;
    walkTo(vm, door);
    driveUntil(vm, (v) => v.currentRoom === target || !v.actors.get(ego).isMoving, { maxTicks });
  }
  return vm.currentRoom === target;
}

/**
 * Solve the procedural catacombs maze (room 39) → the ghost-ship cavern (room 70).
 * The head, raised, names the correct cave each screen in `g164`
 * ({@link ROOMS.catacombsMaze.correctCaveVar}); walking into it climbs the step
 * counter `g265` to the cavern. RNG-driven, so this is ADAPTIVE — never a fixed
 * path: read g164, walk into it, and if a step stalls (ego pinned mid-screen, no
 * progress) force a "turn" by walking to the far edge so the watcher (#202) pans
 * to a fresh layout. Returns whether the cavern was reached.
 */
export function solveMaze(vm: Vm): boolean {
  const maze = ROOMS.catacombsMaze;
  const cavern = ROOMS.ghostCavern.id;
  const ante = ROOMS.catacombsAntechamber.id;
  const g = (n: number): number => vm.vars.readGlobal(n);
  const egoX = (): number => vm.actors.get(vm.vars.readGlobal(VAR_EGO)).x;
  // Raise the navigator's head ONCE: USE it and it stays "in hand", pointing the
  // way, for the whole maze — it never drops between screens, so there's nothing
  // to re-raise per step.
  driveUntil(vm, (v) => egoReady(v), { maxTicks: 4000 });
  use(vm, VERBS.use, ROOMS.cannibalVillage.navigatorHead);
  driveUntil(vm, (v) => v.vars.readBit(maze.headOutBit) === 1, { maxTicks: 6000 });
  for (let iter = 0; iter < 80 && vm.currentRoom !== cavern; iter++) {
    if (vm.currentRoom === ante) {
      // bounced out — back into the maze through the antechamber's cave mouth
      enterRoom(vm, ROOMS.catacombsAntechamber.cavern, maze.id, { maxTicks: 8000 });
    }
    if (vm.currentRoom !== maze.id) break;
    driveUntil(vm, (v) => v.vars.readGlobal(maze.correctCaveVar) !== 0 && egoReady(v), { maxTicks: 8000 });
    const correct = g(maze.correctCaveVar);
    let reachable = true;
    try {
      objectPoint(vm, correct);
    } catch {
      reachable = false;
    }
    if (!reachable) {
      driveUntil(vm, (v) => v.vars.readGlobal(maze.correctCaveVar) !== correct || v.currentRoom !== maze.id, {
        maxTicks: 3000,
      });
      continue;
    }
    const before = g(maze.stepVar);
    const roomBefore = vm.currentRoom;
    const egoBefore = egoX();
    walkTo(vm, correct);
    driveUntil(
      vm,
      (v) =>
        v.currentRoom !== roomBefore ||
        v.vars.readGlobal(maze.stepVar) !== before ||
        (v.vars.readGlobal(maze.correctCaveVar) !== correct && v.vars.readGlobal(maze.correctCaveVar) !== 0),
      { maxTicks: 10000 },
    );
    waitPlayable(vm, 2500);
    const stalled =
      vm.currentRoom === roomBefore &&
      g(maze.stepVar) === before &&
      g(maze.correctCaveVar) === correct &&
      Math.abs(egoX() - egoBefore) < 24;
    if (stalled) {
      // The correct cave is across a wall from where ego entered (it sits on a
      // ledge by the entry cave and can't path there, nor cross center to "turn").
      // Walk BACK into the entry cave (g266) — always reachable — to bounce to the
      // antechamber; the loop then re-enters a freshly-reseeded screen. g265 is
      // preserved across the bounce, so no progress is lost.
      const enter = g(maze.enterCaveVar);
      if (enter !== 0) {
        walkTo(vm, enter);
        driveToRoom(vm, ante, { maxTicks: 6000 });
        waitPlayable(vm, 2000);
      }
    }
  }
  return vm.currentRoom === cavern;
}
