/**
 * Human-readable descriptions of every SCUMM v5 block tag webscumm knows
 * about. Single source of truth — the UI uses this to annotate the
 * resource tree.
 *
 * Source: public SCUMM reverse-engineering notes (ScummVM wiki,
 * Aric Wilmunder's design docs, descumm). Descriptions are summarized in
 * our own words; no copying.
 */

export interface BlockInfo {
  readonly tag: string;
  /** Brief human label (2–5 words). */
  readonly shortName: string;
  /** One-sentence explanation of what the block holds and what it's for. */
  readonly description: string;
}

const CATALOG: Record<string, BlockInfo> = {
  // -------------------------------------------------------------------
  // Index file — MONKEY.000 / MONKEY2.000
  // The top-level blocks here are directories that say "resource N of
  // type T lives in MONKEY.001 at file F, offset O".
  // -------------------------------------------------------------------

  RNAM: {
    tag: 'RNAM',
    shortName: 'Room names',
    description: 'Debug labels for each room — internal names like "scumm-bar", used by the original dev tools.',
  },
  MAXS: {
    tag: 'MAXS',
    shortName: 'Maximum counts',
    description: 'Upper bounds the VM needs to know up front: variables, scripts, sounds, costumes, charsets, objects.',
  },
  DROO: {
    tag: 'DROO',
    shortName: 'Room directory',
    description: 'For each room id: which disk file it lives in and at what offset inside MONKEY.001.',
  },
  DSCR: {
    tag: 'DSCR',
    shortName: 'Global-script directory',
    description: 'Per global-script id: disk file + offset of the SCRP block in MONKEY.001.',
  },
  DSOU: {
    tag: 'DSOU',
    shortName: 'Sound directory',
    description: 'Per sound id: disk file + offset of the SOUN block in MONKEY.001.',
  },
  DCOS: {
    tag: 'DCOS',
    shortName: 'Costume directory',
    description: 'Per costume id: disk file + offset of the COST block in MONKEY.001.',
  },
  DCHR: {
    tag: 'DCHR',
    shortName: 'Charset directory',
    description: 'Per charset id: disk file + offset of the CHAR block in MONKEY.001.',
  },
  DOBJ: {
    tag: 'DOBJ',
    shortName: 'Object directory',
    description: 'Per object id: owner (actor that has it), state, and class flags. Updated as the game plays.',
  },
  DLFL: {
    tag: 'DLFL',
    shortName: 'LFLF offset table',
    description: 'Absolute offsets of every LFLF block inside MONKEY.001 — lets the engine seek to a room without walking the whole file.',
  },

  // -------------------------------------------------------------------
  // Resource file — MONKEY.001 / MONKEY2.001
  // -------------------------------------------------------------------

  LECF: {
    tag: 'LECF',
    shortName: 'LucasArts container',
    description: 'Top-level container of MONKEY.001. Holds the LOFF offset table followed by every LFLF.',
  },
  LOFF: {
    tag: 'LOFF',
    shortName: 'Room offsets',
    description: 'Lookup table mapping room ids to the absolute byte offset of their LFLF inside MONKEY.001.',
  },
  LFLF: {
    tag: 'LFLF',
    shortName: 'Per-room bundle',
    description: 'Container for one room\'s ROOM block plus any global scripts, sounds, costumes, and charsets that ship on the same "disk".',
  },

  // -------- Inside ROOM --------

  ROOM: {
    tag: 'ROOM',
    shortName: 'Room data',
    description: 'Container for one room: geometry, palette, background image, walkable areas, objects, entry/exit scripts.',
  },
  RMHD: {
    tag: 'RMHD',
    shortName: 'Room header',
    description: 'Room width, height, and number of objects in this room.',
  },
  CYCL: {
    tag: 'CYCL',
    shortName: 'Color cycling',
    description: 'Animation effects done by rotating palette entries (water shimmer, candle flicker, fire).',
  },
  TRNS: {
    tag: 'TRNS',
    shortName: 'Transparent color',
    description: 'Which palette index acts as "transparent" when compositing actors and objects over the background.',
  },
  EPAL: {
    tag: 'EPAL',
    shortName: 'EGA palette',
    description: 'Legacy 16-color EGA palette. Present but unused in the VGA versions we target.',
  },
  BOXD: {
    tag: 'BOXD',
    shortName: 'Walk boxes',
    description: 'Convex polygons defining the floor regions an actor can walk on — the graph used for pathfinding.',
  },
  BOXM: {
    tag: 'BOXM',
    shortName: 'Walk-box matrix',
    description: 'Connectivity matrix: which walk boxes are adjacent. Pathfinding traverses this graph.',
  },
  CLUT: {
    tag: 'CLUT',
    shortName: 'VGA palette',
    description: 'The 256-entry RGB color lookup table for this room. Every indexed pixel maps through here.',
  },
  SCAL: {
    tag: 'SCAL',
    shortName: 'Scaling slots',
    description: 'Y-scaled actor sizing — makes characters smaller as they walk "into" the screen, larger as they approach the camera.',
  },

  // -------- Room image (RMIM) --------

  RMIM: {
    tag: 'RMIM',
    shortName: 'Room image',
    description: 'Container for the room\'s background bitmap and its z-plane masks.',
  },
  RMIH: {
    tag: 'RMIH',
    shortName: 'Room image header',
    description: 'Header for the room background — most importantly the number of z-planes that follow.',
  },
  SMAP: {
    tag: 'SMAP',
    shortName: 'Strip map (bitmap)',
    description: 'The background image itself: divided into 8-pixel-wide vertical strips, each strip RLE/Huffman-style compressed independently.',
  },

  // -------- Objects (OBIM / OBCD) --------

  OBIM: {
    tag: 'OBIM',
    shortName: 'Object image',
    description: 'One object\'s visual: header plus one or more IM-frames (e.g. a chest with closed/open states).',
  },
  IMHD: {
    tag: 'IMHD',
    shortName: 'Image header',
    description: 'Position, dimensions, and number of states/frames for an object image.',
  },
  OBCD: {
    tag: 'OBCD',
    shortName: 'Object code+name',
    description: 'One object\'s interactive side: header, verb script (action handlers), and display name.',
  },
  CDHD: {
    tag: 'CDHD',
    shortName: 'Code header',
    description: 'Object id, position, dimensions, and parent-object id within its OBCD container.',
  },
  VERB: {
    tag: 'VERB',
    shortName: 'Verb script',
    description: 'SCUMM bytecode handlers for verbs aimed at this object — what happens when you Look At / Pick Up / Use.',
  },
  OBNA: {
    tag: 'OBNA',
    shortName: 'Object name',
    description: 'The display name the engine shows when the cursor hovers over this object.',
  },

  // -------- Room scripts --------

  EXCD: {
    tag: 'EXCD',
    shortName: 'Exit script',
    description: 'SCUMM bytecode that runs as the player leaves this room.',
  },
  ENCD: {
    tag: 'ENCD',
    shortName: 'Entry script',
    description: 'SCUMM bytecode that runs as the player enters this room.',
  },
  NLSC: {
    tag: 'NLSC',
    shortName: 'Local-script count',
    description: 'How many LSCR blocks follow — the number of scripts local to this room.',
  },
  LSCR: {
    tag: 'LSCR',
    shortName: 'Local script',
    description: 'A SCUMM bytecode script scoped to this room (id + bytecode body).',
  },

  // -------- Per-LFLF leaves (alongside ROOM) --------

  SCRP: {
    tag: 'SCRP',
    shortName: 'Global script',
    description: 'A SCUMM bytecode script callable from anywhere in the game (cutscenes, recurring routines).',
  },
  SOUN: {
    tag: 'SOUN',
    shortName: 'Sound',
    description: 'One sound resource — typically iMUSE MIDI for music, raw samples or speech for effects/voice.',
  },
  COST: {
    tag: 'COST',
    shortName: 'Costume',
    description: 'An actor\'s animation data: limbs × frames × commands. The hairy decoder of the project.',
  },
  CHAR: {
    tag: 'CHAR',
    shortName: 'Character set',
    description: 'A bitmap font used for dialogue and the verb interface.',
  },
};

/**
 * Look up a block description by tag. Handles the IM00..IM0F pattern
 * (image-data sub-blocks of RMIM or OBIM) by synthesizing a BlockInfo
 * with the same explanation for the whole family.
 */
export function describeBlock(tag: string): BlockInfo | undefined {
  const direct = CATALOG[tag];
  if (direct) return direct;

  if (/^IM[0-9A-F]{2}$/.test(tag)) {
    return {
      tag,
      shortName: 'Image data',
      description: 'One frame/state of a room or object image. Contains the SMAP (bitmap) and any ZPxx z-plane masks for this state.',
    };
  }

  if (/^ZP[0-9A-F]{2}$/.test(tag)) {
    return {
      tag,
      shortName: 'Z-plane mask',
      description: 'Per-strip bitmap describing which pixels actors should be drawn behind — used for actor occlusion against the background.',
    };
  }

  return undefined;
}

export const BLOCK_CATALOG: Readonly<Record<string, BlockInfo>> = CATALOG;
