/**
 * Save / restore — a self-describing, versioned JSON snapshot of the VM's
 * runtime state; nothing reconstructable from the game files is stored,
 * EXCEPT each live slot's bytecode (round-tripped verbatim so a mid-stream
 * PC resumes exactly). RNG state is deliberately absent — the original
 * never saved it either.
 *
 * Two fields hold only the delta from a fresh boot rather than the full
 * live state: the object class/state/owner maps store just the entries
 * scripts changed from the index seed (re-seeded on restore via
 * `vm.applyObjectSeed`), and each actor's anim keeps only its active limbs
 * (the 16-slot inactive default is rebuilt). See pages/docs/engine/session.md.
 */

import type { Actor, Facing, WalkLeg } from '../actor/actor';
import { DEFAULT_ACTOR_COUNT } from '../actor/actor';
import { makeInactiveLimbs } from '../graphics/costume-anim';
import type { AnimState, LimbPlayback } from '../graphics/costume-anim';
import type { Sentence } from './sentence';
import type { SoundSnapshot } from '../sound/backend';
import type { ActiveDialog, VerbSlot, Vm } from './vm';

/**
 * Held at 1 until MI1 is fully playable — until then the snapshot shape may
 * break freely and old saves are simply rejected; do not bump per change.
 */
export const SAVE_VERSION = 1;

interface SlotSnapshot {
  readonly status: 'dead' | 'running' | 'yielded';
  readonly scriptId: number;
  readonly label: string;
  readonly pc: number;
  readonly room: number;
  /** base64 of the 25-entry Int32 locals array. */
  readonly locals: string;
  readonly overridePc: number | null;
  readonly delayRemaining: number;
  readonly freezeCount: number;
  readonly freezeResistant: boolean;
  /** base64 of the slot's bytecode — only present for non-dead slots. */
  readonly bytecode: string;
}

interface ActorSnapshot {
  readonly id: number;
  readonly room: number;
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
  readonly costume: number;
  readonly facing: Facing;
  readonly visible: boolean;
  readonly talkColor: number;
  readonly name: string;
  readonly scale: number;
  readonly width: number;
  readonly ignoreBoxes: boolean;
  readonly walkBox: number;
  readonly forceClip: number;
  readonly walkSpeedX: number;
  readonly walkSpeedY: number;
  readonly walkTarget: { x: number; y: number } | null;
  readonly walkPath: ReadonlyArray<{ x: number; y: number }>;
  readonly walkPathIdx: number;
  readonly walkLeg: WalkLeg | null;
  readonly isMoving: boolean;
  readonly walkFrame: number;
  readonly standFrame: number;
  readonly initFrame: number;
  readonly talkStartFrame: number;
  readonly talkStopFrame: number;
  readonly anim: AnimSnapshot;
}

/**
 * An {@link AnimState} with only its active limbs retained, as
 * `[limbIndex, playback]` pairs; the inactive limbs (all-default, the bulk
 * of a 16-slot array) are rebuilt on restore.
 */
interface AnimSnapshot {
  readonly animId: number;
  readonly stopped: number;
  readonly activeLimbs: ReadonlyArray<[number, LimbPlayback]>;
}

export interface SaveState {
  readonly version: number;
  /** Game id this save was taken from (sanity check on restore). */
  readonly game: string;
  /** Free-form caption (room name, location) the shell may show. */
  readonly label?: string;
  /** Epoch ms when saved; stamped by the shell (engine has no clock). */
  readonly savedAt: number;

  // ── Variable banks ──────────────────────────────────────────────
  readonly globals: string; // base64 Int32
  readonly roomVars: string; // base64 Int32
  readonly bits: string; // base64 Uint8 (packed)

  // ── Scripts ─────────────────────────────────────────────────────
  readonly slots: ReadonlyArray<SlotSnapshot>;

  // ── Object / inventory / class state ────────────────────────────
  readonly strings: ReadonlyArray<[number, string]>; // id → base64 bytes
  readonly objectStates: ReadonlyArray<[number, number]>;
  readonly objectOwners: ReadonlyArray<[number, number]>;
  readonly inventoryNames: ReadonlyArray<[number, string]>;
  /** `setObjectName` ($54) renames. */
  readonly objectNameOverrides: ReadonlyArray<[number, string]>;
  readonly objectClasses: ReadonlyArray<[number, number]>;
  readonly objectDrawQueue: ReadonlyArray<number>;
  readonly objectDrawPositions: ReadonlyArray<[number, { x: number; y: number }]>;
  readonly drawnBoxes: ReadonlyArray<{ left: number; top: number; right: number; bottom: number; color: number }>;
  readonly shakeEnabled: boolean;
  /** Active-sound timing map, delegated to the audio backend. */
  readonly sound: SoundSnapshot;

  // ── Room / camera ───────────────────────────────────────────────
  readonly currentRoom: number;
  /**
   * Runtime walk-box flag overrides (box id → flags) — saved because a
   * restore does not re-run the entry script that set them.
   */
  readonly boxFlags: ReadonlyArray<[number, number]>;
  /**
   * Whether `createBoxMatrix` rebuilt the routing matrix in this room; the
   * matrix itself is recomputed from the restored box flags on restore.
   */
  readonly boxMatrixRebuilt: boolean;
  readonly pseudoRooms: ReadonlyArray<[number, number]>;
  readonly uiPaletteOverrides: ReadonlyArray<[number, [number, number, number]]>;
  readonly camera: { x: number };
  readonly roomScroll: { min: number; max: number } | null;
  readonly cameraFollowActor: number;
  readonly screen: { top: number; bottom: number };
  readonly screenEffect: { switchRoomEffect: number; switchRoomEffect2: number; requestFadeIn: boolean };

  // ── Cursor / charset / system ───────────────────────────────────
  readonly cursor: { state: number; userput: number };
  readonly currentCharset: number;
  readonly charsetColorMap: ReadonlyArray<number>;
  readonly systemRequest: 'restart' | 'pause' | 'quit' | null;

  // ── Verbs ───────────────────────────────────────────────────────
  readonly verbs: ReadonlyArray<VerbSlot>;
  readonly savedVerbStates: ReadonlyArray<[number, VerbSlot['state']]>;

  // ── Sentence / cutscene ─────────────────────────────────────────
  readonly sentenceStack: ReadonlyArray<Sentence>;
  readonly cutsceneStack: ReadonlyArray<{ room: number; callerSlot: number; args: ReadonlyArray<number> }>;

  // ── Dialog / text ───────────────────────────────────────────────
  readonly activeDialog: ActiveDialog | null;
  readonly systemTexts: ReadonlyArray<ActiveDialog>;
  readonly printState: {
    x: number | null;
    y: number | null;
    color: number;
    colorSet: boolean;
    center: boolean;
    overhead: boolean;
    clipped: number | null;
  };
  readonly talkDelay: number;
  readonly talkQueue: { pages: string[]; dlg: ActiveDialog | null; system: boolean };

  // ── Actors ──────────────────────────────────────────────────────
  readonly actorCapacity: number;
  readonly actors: ReadonlyArray<ActorSnapshot>;
}

export class SaveStateError extends Error {
  constructor(detail: string) {
    super(`Save-state error: ${detail}`);
    this.name = 'SaveStateError';
  }
}

// ── base64 ⇄ bytes (browser + Node, no Buffer dependency) ──────────

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function i32ToB64(arr: Int32Array): string {
  return bytesToB64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

/** Decode base64 → Int32Array. The decoded byte buffer is freshly
 *  allocated (offset 0), so the Int32 view is always 4-byte aligned. */
function b64ToI32(s: string): Int32Array {
  const bytes = b64ToBytes(s);
  return new Int32Array(bytes.buffer, 0, bytes.byteLength >> 2);
}

/** Pack a live anim, keeping only its active (non-default) limbs. */
function packAnim(a: AnimState): AnimSnapshot {
  const activeLimbs: [number, LimbPlayback][] = [];
  a.limbs.forEach((l, i) => {
    if (l.active) activeLimbs.push([i, { ...l }]);
  });
  return { animId: a.animId, stopped: a.stopped, activeLimbs };
}

/** Rebuild a full anim, filling the unsaved limbs with the inactive default. */
function unpackAnim(s: AnimSnapshot): AnimState {
  const limbs = makeInactiveLimbs();
  for (const [i, l] of s.activeLimbs) limbs[i] = { ...l };
  return { animId: s.animId, stopped: s.stopped, limbs };
}

/**
 * The entries of `live` that differ from the boot `seed` (an absent seed
 * key reads as the map's default, so any live key not in the seed is a
 * runtime change and is kept). Seed-identical entries are dropped and
 * re-derived on restore by {@link Vm.applyObjectSeed}.
 */
function diffFromSeed(
  live: ReadonlyMap<number, number>,
  seed: ReadonlyMap<number, number>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [id, v] of live) if (v !== seed.get(id)) out.push([id, v]);
  return out;
}

// ── snapshot ───────────────────────────────────────────────────────

/** Capture the full live state of `vm` as a serializable {@link SaveState}. */
export function snapshotVm(vm: Vm, meta?: { game?: string; label?: string; savedAt?: number }): SaveState {
  const slots: SlotSnapshot[] = vm.slots.map((s) => ({
    status: s.status,
    scriptId: s.scriptId,
    label: s.label,
    pc: s.pc,
    room: s.room,
    locals: i32ToB64(s.locals),
    overridePc: s.overridePc,
    delayRemaining: s.delayRemaining,
    freezeCount: s.freezeCount,
    freezeResistant: s.freezeResistant,
    bytecode: s.status === 'dead' ? '' : bytesToB64(s.bytecode),
  }));

  const actors: ActorSnapshot[] = [];
  for (const a of vm.actors.all()) {
    actors.push({
      id: a.id,
      room: a.room,
      x: a.x,
      y: a.y,
      elevation: a.elevation,
      costume: a.costume,
      facing: a.facing,
      visible: a.visible,
      talkColor: a.talkColor,
      name: a.name,
      scale: a.scale,
      width: a.width,
      ignoreBoxes: a.ignoreBoxes,
      walkBox: a.walkBox,
      forceClip: a.forceClip,
      walkSpeedX: a.walkSpeedX,
      walkSpeedY: a.walkSpeedY,
      walkTarget: a.walkTarget ? { ...a.walkTarget } : null,
      walkPath: a.walkPath.map((p) => ({ ...p })),
      walkPathIdx: a.walkPathIdx,
      walkLeg: a.walkLeg ? { ...a.walkLeg } : null,
      isMoving: a.isMoving,
      walkFrame: a.walkFrame,
      standFrame: a.standFrame,
      initFrame: a.initFrame,
      talkStartFrame: a.talkStartFrame,
      talkStopFrame: a.talkStopFrame,
      anim: packAnim(a.anim),
    });
  }

  const tq = vm.snapshotTalkQueue();

  return {
    version: SAVE_VERSION,
    game: meta?.game ?? '',
    ...(meta?.label !== undefined ? { label: meta.label } : {}),
    savedAt: meta?.savedAt ?? 0,

    globals: i32ToB64(vm.vars.globals),
    roomVars: i32ToB64(vm.vars.roomVars),
    bits: bytesToB64(vm.vars.snapshotBits()),

    slots,

    strings: [...vm.strings].map(([id, bytes]) => [id, bytesToB64(bytes)]),
    objectStates: diffFromSeed(vm.objectStates, vm.objectSeed.states),
    objectOwners: diffFromSeed(vm.objectOwners, vm.objectSeed.owners),
    inventoryNames: [...vm.inventoryNames],
    objectNameOverrides: [...vm.objectNameOverrides],
    objectClasses: diffFromSeed(vm.objectClasses, vm.objectSeed.classes),
    objectDrawQueue: [...vm.objectDrawQueue],
    objectDrawPositions: [...vm.objectDrawPositions].map(([id, p]) => [id, { ...p }]),
    drawnBoxes: vm.drawnBoxes.map((b) => ({ ...b })),
    shakeEnabled: vm.shakeEnabled,
    sound: vm.audio.serialize(),

    currentRoom: vm.currentRoom,
    boxFlags: [...vm.boxFlagOverrides],
    boxMatrixRebuilt: vm.boxMatrixOverride !== null,
    pseudoRooms: [...vm.pseudoRooms],
    uiPaletteOverrides: [...vm.uiPaletteOverrides].map(([i, rgb]) => [i, [rgb[0], rgb[1], rgb[2]]]),
    camera: { x: vm.camera.x },
    roomScroll: vm.roomScroll ? { ...vm.roomScroll } : null,
    cameraFollowActor: vm.cameraFollowActor,
    screen: { top: vm.screen.top, bottom: vm.screen.bottom },
    screenEffect: { ...vm.screenEffect },

    cursor: { state: vm.cursor.state, userput: vm.cursor.userput },
    currentCharset: vm.currentCharset,
    charsetColorMap: [...vm.charsetColorMap],
    systemRequest: vm.systemRequest,

    verbs: [...vm.verbs.values()].map((v) => ({ ...v, image: v.image ? { ...v.image } : null })),
    savedVerbStates: [...vm.savedVerbStates],

    sentenceStack: vm.sentenceStack.map((s) => ({ ...s })),
    cutsceneStack: vm.cutsceneStack.map((f) => ({ room: f.room, callerSlot: f.callerSlot, args: [...f.args] })),

    activeDialog: vm.activeDialog ? { ...vm.activeDialog } : null,
    systemTexts: vm.systemTexts.map((d) => ({ ...d })),
    printState: { ...vm.printState },
    talkDelay: vm.talkDelay,
    talkQueue: { pages: [...tq.pages], dlg: tq.dlg ? { ...tq.dlg } : null, system: tq.system },

    actorCapacity: vm.actors.capacity,
    actors,
  };
}

// ── restore ──────────────────────────────────────────────────────────

/**
 * Load `state` into `vm`, replacing its entire runtime state. `vm` must
 * be a freshly {@link bootGame}-ed VM for the **same game** (so its
 * resolvers and MAXS sizes match the save). The VM is reset first, then
 * every saved field is applied and the current room's resources are
 * reloaded (without re-running its entry script).
 */
export function restoreVm(vm: Vm, state: SaveState): void {
  if (state.version !== SAVE_VERSION) {
    throw new SaveStateError(`unsupported save version ${state.version} (expected ${SAVE_VERSION})`);
  }

  // Clean slate — every field not in the save returns to its default.
  vm.reset();

  // Variables.
  vm.vars.globals.set(b64ToI32(state.globals).subarray(0, vm.vars.globals.length));
  vm.vars.roomVars.set(b64ToI32(state.roomVars).subarray(0, vm.vars.roomVars.length));
  vm.vars.restoreBits(b64ToBytes(state.bits));

  // Script slots.
  for (let i = 0; i < vm.slots.length; i++) {
    const slot = vm.slots[i]!;
    const snap = state.slots[i];
    slot.kill();
    if (!snap || snap.status === 'dead') continue;
    slot.status = snap.status;
    slot.scriptId = snap.scriptId;
    slot.label = snap.label;
    slot.bytecode = b64ToBytes(snap.bytecode);
    slot.pc = snap.pc;
    slot.room = snap.room;
    slot.locals.set(b64ToI32(snap.locals).subarray(0, slot.locals.length));
    slot.overridePc = snap.overridePc;
    slot.delayRemaining = snap.delayRemaining;
    slot.freezeCount = snap.freezeCount;
    slot.freezeResistant = snap.freezeResistant;
  }

  // Object / inventory / class state. The class/state/owner maps store only
  // the diff from the index seed, so re-derive the seed first, then layer it.
  vm.applyObjectSeed();
  for (const [id, b64] of state.strings) vm.strings.set(id, b64ToBytes(b64));
  for (const [id, v] of state.objectStates) vm.objectStates.set(id, v);
  for (const [id, v] of state.objectOwners) vm.objectOwners.set(id, v);
  for (const [id, name] of state.inventoryNames) vm.inventoryNames.set(id, name);
  for (const [id, name] of state.objectNameOverrides)
    vm.objectNameOverrides.set(id, name);
  for (const [id, v] of state.objectClasses) vm.objectClasses.set(id, v);
  for (const id of state.objectDrawQueue) vm.objectDrawQueue.add(id);
  for (const [id, p] of state.objectDrawPositions) vm.objectDrawPositions.set(id, { ...p });
  vm.drawnBoxes.length = 0;
  for (const b of state.drawnBoxes) vm.drawnBoxes.push({ ...b });
  vm.shakeEnabled = state.shakeEnabled;
  // Pass the resolver so an output backend can rebuild its real voices —
  // resolveSound survives reset(), so the renditions are available now,
  // before the room reload below.
  vm.audio.restore(state.sound, (id) => vm.getSoundResource(id));

  // currentRoom + pseudoRooms + UI overrides + box flags must be set BEFORE
  // the room-resource reload below, so the CLUT overrides re-apply over the
  // freshly-decoded palette.
  vm.currentRoom = state.currentRoom;
  for (const [box, flags] of state.boxFlags) vm.boxFlagOverrides.set(box, flags);
  for (const [k, v] of state.pseudoRooms) vm.pseudoRooms.set(k, v);
  for (const [i, rgb] of state.uiPaletteOverrides) vm.uiPaletteOverrides.set(i, [rgb[0], rgb[1], rgb[2]]);
  vm.camera.x = state.camera.x;
  vm.roomScroll = state.roomScroll ? { ...state.roomScroll } : null;
  vm.cameraFollowActor = state.cameraFollowActor;
  vm.screen.top = state.screen.top;
  vm.screen.bottom = state.screen.bottom;
  vm.screenEffect.switchRoomEffect = state.screenEffect.switchRoomEffect;
  vm.screenEffect.switchRoomEffect2 = state.screenEffect.switchRoomEffect2;
  vm.screenEffect.requestFadeIn = state.screenEffect.requestFadeIn;

  // Cursor / charset / system.
  vm.cursor.state = state.cursor.state;
  vm.cursor.userput = state.cursor.userput;
  vm.currentCharset = state.currentCharset;
  vm.charsetColorMap = state.charsetColorMap ? [...state.charsetColorMap] : [];
  vm.systemRequest = state.systemRequest;

  // Verbs.
  for (const v of state.verbs) vm.verbs.set(v.id, { ...v, image: v.image ? { ...v.image } : null });
  for (const [id, s] of state.savedVerbStates) vm.savedVerbStates.set(id, s);

  // Sentence / cutscene.
  for (const s of state.sentenceStack) vm.sentenceStack.push({ ...s });
  for (const f of state.cutsceneStack) vm.cutsceneStack.push({ room: f.room, callerSlot: f.callerSlot, args: [...f.args] });

  // Dialog / text.
  vm.activeDialog = state.activeDialog ? { ...state.activeDialog } : null;
  vm.systemTexts = state.systemTexts.map((d) => ({ ...d }));
  vm.printState = { ...state.printState };
  vm.talkDelay = state.talkDelay;
  vm.restoreTalkQueue({
    pages: state.talkQueue.pages,
    dlg: state.talkQueue.dlg ? { ...state.talkQueue.dlg } : null,
    system: state.talkQueue.system,
  });

  // Actors.
  for (const snap of state.actors) {
    if (snap.id < 1 || snap.id > vm.actors.capacity) continue;
    const a = vm.actors.get(snap.id);
    applyActorSnapshot(a, snap);
  }

  // Finally, reload the current room's resources (bg/palette/scripts)
  // without re-running its ENCD — the restored slots already cover it.
  vm.reloadCurrentRoomResources();
  if (state.boxMatrixRebuilt) vm.rebuildBoxMatrix();
}

function applyActorSnapshot(a: Actor, snap: ActorSnapshot): void {
  a.room = snap.room;
  a.x = snap.x;
  a.y = snap.y;
  a.elevation = snap.elevation;
  a.costume = snap.costume;
  a.facing = snap.facing;
  a.visible = snap.visible;
  a.talkColor = snap.talkColor;
  a.name = snap.name;
  a.scale = snap.scale;
  a.width = snap.width;
  a.ignoreBoxes = snap.ignoreBoxes;
  a.walkBox = snap.walkBox;
  a.forceClip = snap.forceClip;
  a.walkSpeedX = snap.walkSpeedX;
  a.walkSpeedY = snap.walkSpeedY;
  a.walkTarget = snap.walkTarget ? { ...snap.walkTarget } : null;
  a.walkPath = snap.walkPath.map((p) => ({ ...p }));
  a.walkPathIdx = snap.walkPathIdx;
  a.walkLeg = snap.walkLeg ? { ...snap.walkLeg } : null;
  a.isMoving = snap.isMoving;
  a.walkFrame = snap.walkFrame;
  a.standFrame = snap.standFrame;
  a.initFrame = snap.initFrame;
  a.talkStartFrame = snap.talkStartFrame;
  a.talkStopFrame = snap.talkStopFrame;
  a.anim = unpackAnim(snap.anim);
  a.drawBounds = null; // transient render output — recomputed next frame
}

/** Default actor capacity, re-exported so callers needn't reach into actor.ts. */
export { DEFAULT_ACTOR_COUNT };

/** A typed view of a snapshot's limb playback — re-exported for tests. */
export type { LimbPlayback };
