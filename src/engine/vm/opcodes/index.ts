/**
 * Seed opcode set for Phase 5.
 *
 * The goal is *not* to be comprehensive — it's to provide just enough
 * dispatch for the boot script to start executing and for any branch
 * we can reach to behave correctly. Anything we haven't written halts
 * the VM cleanly via the dispatcher's default-fail path.
 *
 * Opcodes are listed in family order. Each entry registers one or
 * more byte values (the base opcode plus parameter-mode variants).
 *
 * # Convention
 *
 * - Handlers consume their parameters from the slot's bytecode and
 *   advance `slot.pc` past them.
 * - Param-mode bits in the opcode byte select *value* parameters
 *   (immediate vs var-ref). The **destination** parameter of a write
 *   opcode (e.g. `setVar`'s first param) is always a raw var-ref
 *   word — no mode bit consulted.
 * - Every handler calls `vm.annotate(...)` with a short mnemonic so
 *   the trace ring and halt panel can render something meaningful.
 */

import {
  putActor as actorPut,
  setActorCostume as actorSetCostume,
  type Actor,
} from '../../actor/actor';
import { startAnim } from '../../graphics/costume-anim';
import { pickObject } from '../../object/hittest';
import { findPath } from '../../pathfinding/grid';
import { evalExpression } from '../expression';
import { SENTENCE_CLEAR_VERB } from '../sentence';
import { VAR_HAVE_MSG } from '../vars';
import {
  derefRead,
  formatRefLabel,
  isVarParam,
  readDestRef,
  readI16,
  readU8,
  readValue,
  readVarOrByte,
  readVarOrWord,
  readVarRef,
  readVarRefWithRef,
  readWordVararg,
  writeRef,
} from '../params';
import type { ScriptSlot } from '../slot';
import type { OpcodeHandler, Vm, VerbSlot } from '../vm';

/**
 * Resolve an actor id to the table slot. SCUMM v5 convention: an
 * `id` of 0 passed to an actor opcode is the **ego shorthand** —
 * resolve via `VAR_EGO` (global #1, the actor id of the player
 * character). MI1 boot uses `putActor 0 (320, 72)` to place Guybrush
 * at the title-menu position; without the ego resolution this is a
 * no-op and the title screen has no visible actor.
 *
 * Returns null for out-of-range or fully-unresolved ids (covers the
 * pre-boot state where VAR_EGO is still 0).
 */
function actorOrNull(vm: Vm, id: number): Actor | null {
  let resolved = id;
  if (resolved === 0) resolved = vm.vars.readGlobal(VAR_EGO);
  if (resolved <= 0) return null;
  if (resolved > vm.actors.capacity) return null;
  return vm.actors.get(resolved);
}

/** Global variable holding the current ego (player-character) actor id. */
const VAR_EGO = 1;

/**
 * Set up an actor's walk: store the target, compute a waypoint
 * path through the current room's walkable mask (or straight-line
 * fall-back if there's no mask), and flip isMoving on.
 *
 * The actor's `ignoreBoxes` flag bypasses pathfinding — used for
 * cutscene movement that can cross non-walkable regions.
 */
function startWalk(vm: Vm, actor: Actor, target: { x: number; y: number }): void {
  actor.walkTarget = target;
  actor.walkPath = [];
  actor.walkPathIdx = 0;
  actor.isMoving = true;

  const mask = vm.loadedRoom?.walkableMask;
  if (!mask || mask.length === 0 || actor.ignoreBoxes) {
    // No pathfinding context — actor walks the straight line via
    // stepWalk's walkTarget fall-back.
    return;
  }
  const room = vm.loadedRoom!;
  const path = findPath(mask, room.width, room.height, { x: actor.x, y: actor.y }, target);
  if (path.waypoints.length === 0) return;
  // The first waypoint is the snapped start position — drop it so
  // we don't make the actor "teleport" to the box edge before
  // walking. Keep all the rest, including the (possibly snapped)
  // final waypoint.
  const trimmed = path.waypoints.slice(1);
  actor.walkPath = trimmed;
  actor.walkPathIdx = 0;
}

const handlers = new Map<number, OpcodeHandler>();

function register(opcode: number, handler: OpcodeHandler): void {
  if (handlers.has(opcode)) {
    throw new Error(`opcode 0x${opcode.toString(16)} registered twice`);
  }
  handlers.set(opcode, handler);
}

// ─── 0x00  stopObjectCode ────────────────────────────────────────────
// End the current script. Kills the slot.
register(0x00, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0xA0  stopObjectCode (alias) ────────────────────────────────────
// Same opcode family, used by some scripts in MI1. Conservatively
// register it too — both forms appear in descumm output.
register(0xa0, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0x80  breakHere ─────────────────────────────────────────────────
// Yield to the scheduler. No parameters.
register(0x80, (vm, slot) => {
  vm.annotate('breakHere');
  slot.yield_();
});

// ─── 0x18  jumpRelative ──────────────────────────────────────────────
// Unconditional jump. Operand is a signed 16-bit displacement applied
// to the PC after reading it (i.e. relative to the byte AFTER the
// displacement word).
register(0x18, (vm, slot) => {
  const delta = readI16(slot);
  slot.pc += delta;
  vm.annotate(`jump ${delta >= 0 ? '+' : ''}${delta}`);
});

// ─── 0x1A  setVar ────────────────────────────────────────────────────
// Two params: dest var-ref word (always raw), value (immediate or var
// ref based on bit-7 of the opcode byte). Variant 0x9A has bit-7 set
// → source is a var ref.
function makeSetVar(label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot, vm.vars);
    const value = readValue(slot, vm.vars, isVarParam(opcode, 1));
    writeRef(dest, value, slot, vm.vars);
    vm.annotate(`${label} 0x${dest.toString(16)} = ${value}`);
  };
}
register(0x1a, makeSetVar('setVar'));
register(0x9a, makeSetVar('setVar'));

// ─── 0x46 / 0xC6  inc / dec ──────────────────────────────────────────
// Single var-ref param. In v5 these are *separate* opcodes — bit 7 is
// not a param-mode flag here, it selects increment vs decrement.
register(0x46, (vm, slot) => {
  const ref = readDestRef(slot, vm.vars);
  const cur = readValueAtRef(ref, slot, vm);
  writeRef(ref, cur + 1, slot, vm.vars);
  vm.annotate(`inc 0x${ref.toString(16)}`);
});
register(0xc6, (vm, slot) => {
  const ref = readDestRef(slot, vm.vars);
  const cur = readValueAtRef(ref, slot, vm);
  writeRef(ref, cur - 1, slot, vm.vars);
  vm.annotate(`dec 0x${ref.toString(16)}`);
});

function readValueAtRef(ref: number, slot: ScriptSlot, vm: Vm): number {
  return derefRead(ref, slot, vm.vars);
}

// ─── 0x5A / 0xDA  addVar ─────────────────────────────────────────────
function makeAddSub(sign: 1 | -1, label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot, vm.vars);
    const operand = readValue(slot, vm.vars, isVarParam(opcode, 1));
    const cur = derefRead(dest, slot, vm.vars);
    writeRef(dest, cur + sign * operand, slot, vm.vars);
    vm.annotate(`${label} 0x${dest.toString(16)} ${sign === 1 ? '+=' : '-='} ${operand}`);
  };
}
register(0x5a, makeAddSub(1, 'add'));
register(0xda, makeAddSub(1, 'add'));
register(0x3a, makeAddSub(-1, 'sub'));
register(0xba, makeAddSub(-1, 'sub'));

// ─── Conditional branches ───────────────────────────────────────────
// All comparison opcodes follow the wiki's `unless (value OP var)
// goto target` form — the operand order in the byte stream is `var`
// first then `value`, and the **jump fires when the named condition
// is FALSE**. In other words: the body that follows the comparison
// runs when the relation holds; the jump skips (or repeats, for
// backward deltas) the body when it doesn't.
//
// In code below `a = var` (read first), `b = value` (read second).
// `jumpWhen(a, b)` returns the negated form so the helper can stay
// uniform across the family.

function makeJumpIf(
  label: string,
  jumpWhen: (a: number, b: number) => boolean,
): OpcodeHandler {
  return (vm, slot, opcode) => {
    const { ref, value: a } = readVarRefWithRef(slot, vm.vars);
    const b = readValue(slot, vm.vars, isVarParam(opcode, 1));
    const delta = readI16(slot);
    const taken = jumpWhen(a, b);
    if (taken) slot.pc += delta;
    vm.annotate(
      `${label}(${formatRefLabel(ref)}=${a}, ${b}) → ${taken ? `jump ${delta >= 0 ? '+' : ''}${delta}` : 'continue'}`,
    );
  };
}

// 0x48 / 0xC8 — isEqual: unless (value == var) goto → jump when a != b
register(0x48, makeJumpIf('isEqual', (a, b) => a !== b));
register(0xc8, makeJumpIf('isEqual', (a, b) => a !== b));

// 0x08 / 0x88 — isNotEqual: unless (value != var) goto → jump when a == b
register(0x08, makeJumpIf('isNotEqual', (a, b) => a === b));
register(0x88, makeJumpIf('isNotEqual', (a, b) => a === b));

// 0x04 / 0x84 — isGreaterEqual: unless (value >= var) goto
//                              → jump when value < var → jump when a > b
register(0x04, makeJumpIf('isGE', (a, b) => a > b));
register(0x84, makeJumpIf('isGE', (a, b) => a > b));

// 0x44 / 0xC4 — isLess: unless (value < var) goto
//                       → jump when value >= var → jump when a <= b
register(0x44, makeJumpIf('isLess', (a, b) => a <= b));
register(0xc4, makeJumpIf('isLess', (a, b) => a <= b));

// 0x78 / 0xF8 — isGreater: unless (value > var) goto
//                          → jump when value <= var → jump when a >= b
register(0x78, makeJumpIf('isGreater', (a, b) => a >= b));
register(0xf8, makeJumpIf('isGreater', (a, b) => a >= b));

// 0x38 / 0xB8 — lessOrEqual: unless (value <= var) goto
//                            → jump when value > var → jump when a < b
register(0x38, makeJumpIf('isLE', (a, b) => a < b));
register(0xb8, makeJumpIf('isLE', (a, b) => a < b));

// ─── 0x28  equalZero / 0xA8  notEqualZero ────────────────────────────
// Test a single var against 0, conditional jump.
register(0x28, (vm, slot) => {
  const a = readVarRef(slot, vm.vars);
  const delta = readI16(slot);
  if (a !== 0) slot.pc += delta;
  vm.annotate(`equalZero(${a}) → ${a === 0 ? 'continue' : `jump ${delta}`}`);
});
register(0xa8, (vm, slot) => {
  const a = readVarRef(slot, vm.vars);
  const delta = readI16(slot);
  if (a === 0) slot.pc += delta;
  vm.annotate(`notEqualZero(${a}) → ${a !== 0 ? 'continue' : `jump ${delta}`}`);
});

// ─── 0x26 / 0xA6  setVarRange ────────────────────────────────────────
// Initialise a contiguous run of variables from inline literals.
// Layout: dest var-ref (u16 LE), count u8, then `count` values. Values
// are u8 when bit 7 of the opcode is clear (0x26), u16 LE when set
// (0xA6). The dest is the *starting* index — successive values write
// into dest+0, dest+1, … with whatever scope bits the dest carries.
function makeSetVarRange(asWord: boolean): OpcodeHandler {
  return (vm, slot) => {
    const dest = readDestRef(slot, vm.vars);
    const count = readU8(slot);
    for (let i = 0; i < count; i++) {
      const v = asWord ? readI16(slot) : readU8(slot);
      // Increment the *index* portion of the ref while preserving the
      // scope flag bits (locals=0x8000, bit-vars=0x4000).
      writeRef(dest + i, v, slot, vm.vars);
    }
    vm.annotate(`setVarRange dest=0x${dest.toString(16)} count=${count}`);
  };
}
register(0x26, makeSetVarRange(false));
register(0xa6, makeSetVarRange(true));

// ─── 0x2C  cursorCommand ─────────────────────────────────────────────
// Multi-subop opcode controlling cursor visibility, userput
// enable/disable, the active cursor image / hotspot, and the active
// charset. Bits 0..4 of the subop select the action; bits 5..7 select
// per-arg parameter modes (var-ref vs direct byte) the same way as on
// the main opcode byte.
//
// The visibility / userput / charset subops mutate VM state (Phase 7
// — drives the cursor overlay + verb bar). The cursor-image /
// hotspot / initCursor subops still stub: those rely on a charset-
// glyph-as-cursor decoder we haven't built yet. Default crosshair
// covers the playable goal.
register(0x2c, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  switch (action) {
    case 0x01:
      vm.cursor.visible = true;
      vm.annotate('cursorCommand cursorOn');
      return;
    case 0x02:
      vm.cursor.visible = false;
      vm.annotate('cursorCommand cursorOff');
      return;
    case 0x03:
      vm.cursor.userput = true;
      vm.annotate('cursorCommand userputOn');
      return;
    case 0x04:
      vm.cursor.userput = false;
      vm.annotate('cursorCommand userputOff');
      return;
    case 0x05:
      // Soft subops are the cutscene-friendly variants — same end
      // state on cursor.visible, separate hard/soft tracking can land
      // when the cutscene module needs it.
      vm.cursor.visible = true;
      vm.annotate('cursorCommand cursorSoftOn');
      return;
    case 0x06:
      vm.cursor.visible = false;
      vm.annotate('cursorCommand cursorSoftOff');
      return;
    case 0x07:
      vm.cursor.userput = true;
      vm.annotate('cursorCommand userputSoftOn');
      return;
    case 0x08:
      vm.cursor.userput = false;
      vm.annotate('cursorCommand userputSoftOff');
      return;
    case 0x0a: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      const ch = readVarOrByte(subop, 2, slot, vm.vars);
      vm.annotate(`cursorCommand setCursorImage cur=${cur} char=${ch} (stub)`);
      return;
    }
    case 0x0b: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      const x = readVarOrByte(subop, 2, slot, vm.vars);
      const y = readVarOrByte(subop, 3, slot, vm.vars);
      vm.annotate(`cursorCommand setCursorHotspot cur=${cur} (${x},${y}) (stub)`);
      return;
    }
    case 0x0c: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      vm.annotate(`cursorCommand initCursor cur=${cur} (stub)`);
      return;
    }
    case 0x0d: {
      const charset = readVarOrByte(subop, 1, slot, vm.vars);
      vm.currentCharset = charset;
      vm.annotate(`cursorCommand initCharset charset=${charset}`);
      return;
    }
    case 0x0e: {
      // charsetColor: word-vararg list of CLUT indices, terminated by 0xFF.
      const colors = readWordVararg(slot, vm.vars);
      vm.annotate(`cursorCommand charsetColor [${colors.join(',')}] (stub)`);
      return;
    }
    default:
      throw new Error(
        `cursorCommand: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
});

// ─── 0x98  systemOps ─────────────────────────────────────────────────
// Restart / pause / quit. Layout: u8 subop selecting the action.
// Phase 6: stub all three — we don't want a script-triggered restart
// or quit to kill the inspector mid-debug. Sub-op 0x03 (quit) is what
// the copy-protection script invokes after the "wrong code" message.
register(0x98, (vm, slot) => {
  const sub = readU8(slot);
  const label = sub === 1 ? 'restart' : sub === 2 ? 'pause' : sub === 3 ? 'quit' : `subop=0x${sub.toString(16)}`;
  vm.annotate(`systemOps ${label} (stub)`);
});

// ─── 0x12 / 0x92  panCameraTo ────────────────────────────────────────
// ─── 0x32 / 0xB2  setCameraAt ────────────────────────────────────────
// Camera position is the CENTRE of the viewport (SCUMM v5 convention)
// — for a 320-wide screen the visible room slice is `[x-160, x+160)`.
// `setCameraAt` snaps the camera to the target X; `panCameraTo` smooth-
// scrolls there in the original engine. We snap both for now — the
// boot uses these so dialog text can resolve its on-screen position
// correctly even before a real pan animation lands.
function setCameraTo(vm: Vm, x: number): void {
  // Clamp to the loaded room's valid range (camera centre can't go
  // past the room edges). If no room is loaded, store the raw value.
  const room = vm.loadedRoom;
  if (!room) {
    vm.camera.x = x;
    return;
  }
  const halfScreen = 160;
  const min = Math.min(halfScreen, room.width);
  const max = Math.max(min, room.width - halfScreen);
  vm.camera.x = Math.max(min, Math.min(max, x));
}

function makeCameraOp(label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const v = readVarOrWord(opcode, 1, slot, vm.vars);
    setCameraTo(vm, v);
    vm.annotate(`${label} ${v} → camera.x=${vm.camera.x}`);
  };
}
register(0x12, makeCameraOp('panCameraTo'));
register(0x92, makeCameraOp('panCameraTo'));
register(0x32, makeCameraOp('setCameraAt'));
register(0xb2, makeCameraOp('setCameraAt'));

// ─── 0x52 / 0xD2  actorFollowCamera ──────────────────────────────────
// Lock the camera to track an actor. Per-tick follow logic isn't
// wired yet (the camera doesn't pan on actor walk); for now we just
// snap the camera to the actor's current X so static-screen scenes
// look right.
function actorFollowCameraHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    setCameraTo(vm, actor.x);
  }
  vm.annotate(`actorFollowCamera ${id} → camera.x=${vm.camera.x} (snap-only)`);
}
register(0x52, actorFollowCameraHandler);
register(0xd2, actorFollowCameraHandler);

// ─── 0x1C / 0x9C  startSound ─────────────────────────────────────────
// ─── 0x3C / 0xBC  stopSound ──────────────────────────────────────────
// ─── 0x02 / 0x82  startMusic ─────────────────────────────────────────
// ─── 0x20         stopMusic  (no params) ─────────────────────────────
// All audio opcodes are silent stubs for Phase 6 — sound lifts to a
// real implementation in Phase 9 (iMUSE + AdLib).
function makeSoundOp(label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const id = readVarOrByte(opcode, 1, slot, vm.vars);
    vm.annotate(`${label} id=${id} (stub)`);
  };
}
register(0x1c, makeSoundOp('startSound'));
register(0x9c, makeSoundOp('startSound'));
register(0x3c, makeSoundOp('stopSound'));
register(0xbc, makeSoundOp('stopSound'));

// ─── 0x7C / 0xFC  isSoundRunning ─────────────────────────────────────
// `opcode result sound[p8]`. Audio is stubbed (Phase 9), so nothing is
// ever playing — always write 0. Scripts poll this in loops; returning
// 0 lets them proceed instead of waiting forever.
function isSoundRunningHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const sound = readVarOrByte(opcode, 1, slot, vm.vars);
  writeRef(dest, 0, slot, vm.vars);
  vm.annotate(`isSoundRunning ${sound} → 0 (stub)`);
}
register(0x7c, isSoundRunningHandler);
register(0xfc, isSoundRunningHandler);

// ─── 0x62 / 0xE2  stopScript ─────────────────────────────────────────
// `opcode script[p8]`. Kill every slot running the given global script
// id. Script 0 = "stop the current script" in the original; we treat
// 0 as a no-op (the caller keeps running) since the common use is
// stopping *another* script.
function stopScriptHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const scriptId = readVarOrByte(opcode, 1, slot, vm.vars);
  if (scriptId !== 0) {
    for (const s of vm.slots) {
      if (s.status !== 'dead' && s.scriptId === scriptId) s.kill();
    }
  }
  vm.annotate(`stopScript #${scriptId}`);
}
register(0x62, stopScriptHandler);
register(0xe2, stopScriptHandler);

// ─── 0x30  matrixOp ──────────────────────────────────────────────────
// `opcode sub-opcode [box[p8] val[p8]]` — manipulate walk-box flags /
// scale / rebuild the box matrix. Sub-opcodes: $01 setBoxFlags,
// $02/$03 setBoxScale, $04 createBoxMatrix (no args). We use grid A*
// over the walkable mask rather than the box matrix, and don't apply
// per-box flags yet, so this consumes operands and no-ops. Note: box
// flags (locked/invisible boxes) aren't honoured until the pathfinder
// reads them.
function matrixOpHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const sub = readU8(slot);
  if (sub === 0x04) {
    vm.annotate('matrixOp createBoxMatrix (stub)');
    return;
  }
  const box = readVarOrByte(sub, 1, slot, vm.vars);
  const val = readVarOrByte(sub, 2, slot, vm.vars);
  vm.annotate(`matrixOp sub=0x${sub.toString(16)} box=${box} val=${val} (stub)`);
}
register(0x30, matrixOpHandler);
register(0x02, makeSoundOp('startMusic'));
register(0x82, makeSoundOp('startMusic'));
register(0x20, (vm) => {
  vm.annotate('stopMusic (stub)');
});

// ─── 0x72 / 0xF2  loadRoom ───────────────────────────────────────────
// Switch the engine to a new room. Layout: room id (var-or-byte via
// bit 0x80 of opcode). The actual transition logic lives in
// `vm.enterRoom`: run previous room's EXCD, swap loadedRoom, run new
// room's ENCD.
function loadRoomHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const roomId = readVarOrByte(opcode, 1, slot, vm.vars);
  vm.enterRoom(roomId);
  const lr = vm.loadedRoom;
  if (lr) {
    vm.annotate(`loadRoom ${roomId} (${lr.width}×${lr.height})`);
  } else if (vm.lastRoomLoadError) {
    vm.annotate(`loadRoom ${roomId} (no data: ${vm.lastRoomLoadError})`);
  } else {
    vm.annotate(`loadRoom ${roomId} (no resolver)`);
  }
}
register(0x72, loadRoomHandler);
register(0xf2, loadRoomHandler);

// ─── 0x14 / 0x94 / 0xD8  print / printEgo ────────────────────────────
// Print a string into an actor's text slot. Layout: actor (var-or-byte
// via bit 0x80 of opcode), then a *non-looped* sequence of subops —
// subop 0x0F (print text) is terminal: it reads a NUL-terminated string
// (with `0xFF NN` SCUMM control codes embedded) and the opcode ends.
//
// 0xD8 `printEgo` is the same except actor is implicit ("ego" = the
// current player actor). We treat both as stubs for Phase 6 — the
// dialog renderer lands when verb UI ships.
function readScummString(slot: ScriptSlot): Uint8Array {
  // Reads bytes until 0x00 terminator. SCUMM strings can contain `0xFF NN`
  // escape sequences where NN is a control byte; some control codes
  // (var substitution / show-string / show-name / show-verb) take an
  // additional 2-byte argument. We need to consume those without
  // mistaking the inner bytes for the 0x00 terminator.
  const start = slot.pc;
  while (slot.pc < slot.bytecode.length) {
    const b = slot.bytecode[slot.pc];
    if (b === 0x00) {
      slot.pc++;
      return slot.bytecode.slice(start, slot.pc - 1);
    }
    if (b === 0xff) {
      slot.pc++; // escape
      const code = slot.bytecode[slot.pc++]!;
      // Control codes 4..9 carry a 2-byte argument (var/string/object/verb id).
      if (code >= 4 && code <= 9) slot.pc += 2;
      continue;
    }
    slot.pc++;
  }
  throw new Error('SCUMM string: missing 0x00 terminator');
}

function printHandler(actor: number, vm: Vm, slot: ScriptSlot): void {
  const ops: string[] = [];
  let atX: number | null = null;
  let atY: number | null = null;
  let color = 0x0f; // SCUMM default ink (white-ish in MI1 palettes)
  let center = false;
  let overhead = false;
  let clipped: number | null = null;
  while (true) {
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x0f;
    switch (action) {
      case 0x00: {
        // SO_AT — absolute screen position for the text anchor.
        atX = readVarOrWord(sub, 1, slot, vm.vars);
        atY = readVarOrWord(sub, 2, slot, vm.vars);
        ops.push(`at(${atX},${atY})`);
        break;
      }
      case 0x01: {
        // SO_COLOR — ink (CLUT index) for the text glyph.
        color = readVarOrByte(sub, 1, slot, vm.vars);
        ops.push(`color(${color})`);
        break;
      }
      case 0x02: {
        // SO_CLIPPED — max x boundary; line-wrap caps here.
        clipped = readVarOrWord(sub, 1, slot, vm.vars);
        ops.push(`clipped(${clipped})`);
        break;
      }
      case 0x04:
        center = true;
        ops.push('center');
        break;
      case 0x06:
        // SO_LEFT — explicit left-anchored (resets any prior `center`).
        center = false;
        ops.push('left');
        break;
      case 0x07:
        overhead = true;
        ops.push('overhead');
        break;
      case 0x08: {
        // SO_SAY_VOICE — reads a word arg. We have no audio yet so
        // ignore the value beyond consuming the bytes.
        const a = readVarOrWord(sub, 1, slot, vm.vars);
        ops.push(`voice(${a})`);
        break;
      }
      case 0x0f: {
        // SO_TEXTSTRING — read NUL-terminated text and exit the opcode.
        const buf = readScummString(slot);
        const text = decodeScummString(buf);
        const preview = Array.from(buf)
          .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
          .join('');
        // Commit the dialog to the VM so the shell renders it.
        // Empty strings count as "clear" — some scripts use a 0-byte
        // print to dismiss the previous bubble.
        if (text.length === 0) {
          vm.activeDialog = null;
        } else {
          vm.activeDialog = {
            actorId: actor,
            text,
            x: atX,
            y: atY,
            color,
            center,
            overhead,
            clipped,
          };
        }
        vm.annotate(`print actor=${actor} [${ops.join(',')}] "${preview}"`);
        return;
      }
      default:
        throw new Error(
          `print: unknown subop 0x${action.toString(16)} (raw=0x${sub.toString(16)})`,
        );
    }
  }
  // No text-string subop → the script issued a "configure-only"
  // print (just set position/color for a later print, or clear).
  vm.annotate(`print actor=${actor} [${ops.join(',')}] (no text)`);
}

function printOpcode(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const actor = readVarOrByte(opcode, 1, slot, vm.vars);
  printHandler(actor, vm, slot);
}
register(0x14, printOpcode);
register(0x94, printOpcode);
register(0xd8, (vm, slot) => {
  // printEgo — actor is implicit (the player character)
  printHandler(0, vm, slot);
});

// ─── 0x58  beginOverride / endOverride ───────────────────────────────
// Mark a cutscene as "skippable" — the player can hit Escape to abort
// to a fixed continuation point. Layout for `flag=1` (begin):
//   0x58 0x01 0x18 dlo dhi   — beginOverride + flag + EMBEDDED jump
//                              opcode + i16 delta giving the skip
//                              target relative to the byte after the
//                              delta. The 3 embedded bytes look like a
//                              normal `jump` instruction so the script
//                              can be disassembled cleanly, but they
//                              MUST be consumed by `beginOverride`
//                              itself — dispatching them as a real
//                              jump would unconditionally skip the
//                              cutscene body (which is exactly what
//                              we saw before this fix).
// For `flag=0` (end): nothing more to read.
//
// We don't yet wire input → escape, so the captured target is recorded
// for later but normal execution falls through into the body.
register(0x58, (vm, slot) => {
  const flag = readU8(slot);
  if (flag !== 0) {
    // Consume the embedded jump pattern. The opcode byte is informational
    // (always 0x18 in MI1's bytecode) — we read the i16 delta and
    // compute the absolute override target.
    const jumpOp = readU8(slot);
    const delta = readI16(slot);
    const overrideTarget = slot.pc + delta;
    // Stash on the slot itself so future Escape handling has somewhere
    // to read it from. The opcode byte goes into the annotation for
    // diagnostics in case the format ever differs.
    slot.overridePc = overrideTarget;
    vm.annotate(`beginOverride target=0x${overrideTarget.toString(16)} (op=0x${jumpOp.toString(16)})`);
  } else {
    slot.overridePc = null;
    vm.annotate('endOverride');
  }
});

// ─── 0x40  cutscene / 0xC0  endCutscene ──────────────────────────────
// cutscene reads a word-vararg arg list (passed to VAR_CUTSCENE_START_
// SCRIPT) and freezes every other script; endCutscene thaws them and
// runs VAR_CUTSCENE_END_SCRIPT. MI1's credits are wrapped in one — the
// start/end scripts (#18/#19) hide and restore the cursor + user input.
register(0x40, (vm, slot) => {
  const args = readWordVararg(slot, vm.vars);
  vm.beginCutscene(args, slot.slotIndex);
  vm.annotate(`cutscene [${args.join(',')}]`);
});
register(0xc0, (vm) => {
  vm.endCutscene();
  vm.annotate('endCutscene');
});

// ─── 0x60 / 0xE0  freezeScripts ──────────────────────────────────────
// Layout: flag (var-or-byte via bit 0x80). flag == 0 thaws ALL scripts;
// otherwise freeze every other slot (resistant ones too when
// flag >= 0x80). Freezing is cumulative (per-slot count).
function freezeScriptsHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const flag = readVarOrByte(opcode, 1, slot, vm.vars);
  if (flag === 0) {
    vm.unfreezeAllScripts();
  } else {
    vm.freezeScripts(flag >= 0x80, slot.slotIndex);
  }
  vm.annotate(`freezeScripts flag=${flag}`);
}
register(0x60, freezeScriptsHandler);
register(0xe0, freezeScriptsHandler);

// ─── 0x68 / 0xE8  isScriptRunning ────────────────────────────────────
// Result var = 1 if a slot currently holds the given script id (any
// status except dead), 0 otherwise. Layout: result var-ref u16,
// script id (var-or-byte via opcode bit 7).
function isScriptRunningHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const scriptId = readVarOrByte(opcode, 1, slot, vm.vars);
  const running = vm.slots.some((s) => s.status !== 'dead' && s.scriptId === scriptId);
  writeRef(dest, running ? 1 : 0, slot, vm.vars);
  vm.annotate(`isScriptRunning #${scriptId} → ${running ? 1 : 0}`);
}
register(0x68, isScriptRunningHandler);
register(0xe8, isScriptRunningHandler);

// ─── 0x16 / 0x96  getRandomNumber ────────────────────────────────────
// Result var = random integer in [0, max] (inclusive). Real SCUMM
// uses a deterministic LCG so save states reproduce; for now we use
// `Math.random()` — good enough for the boot's idle-timer scripts.
// Phase 8 (save states) will swap in a seedable PRNG.
function getRandomNrHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const max = readVarOrByte(opcode, 1, slot, vm.vars);
  const v = Math.floor(Math.random() * (max + 1));
  writeRef(dest, v, slot, vm.vars);
  vm.annotate(`getRandomNumber max=${max} → ${v}`);
}
register(0x16, getRandomNrHandler);
register(0x96, getRandomNrHandler);

// ─── 0x07 / 0x47 / 0x87 / 0xC7  setState ─────────────────────────────
// Set an object's state byte. State drives which OBIM image variant
// gets composited (open/closed door, etc.) and is consulted by
// `ifState`. We track it in `vm.objectStates`; the renderer will read
// it once we have the object compositor.
function setStateHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const state = readVarOrByte(opcode, 2, slot, vm.vars);
  vm.objectStates.set(obj, state);
  vm.annotate(`setState obj=${obj} state=${state}`);
}
register(0x07, setStateHandler);
register(0x47, setStateHandler);
register(0x87, setStateHandler);
register(0xc7, setStateHandler);

// ─── 0x0F / 0x8F  getObjectState ─────────────────────────────────────
// `opcode result object[p16]`. Result var ← the object's current state
// (0 if never set). Mirror of setState; rooms read it on entry to
// branch on door open/closed etc.
function getObjectStateHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const state = vm.objectStates.get(obj) ?? 0;
  writeRef(dest, state, slot, vm.vars);
  vm.annotate(`getObjectState obj=${obj} → ${state}`);
}
register(0x0f, getObjectStateHandler);
register(0x8f, getObjectStateHandler);

// ─── 0x10 / 0x90  getObjectOwner ─────────────────────────────────────
// `opcode result object[p16]`. Result var ← the object's owner actor
// id (0 = nobody / still in the room). Mirror of setOwnerOf.
function getObjectOwnerHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const owner = vm.objectOwners.get(obj) ?? 0;
  writeRef(dest, owner, slot, vm.vars);
  vm.annotate(`getObjectOwner obj=${obj} → ${owner}`);
}
register(0x10, getObjectOwnerHandler);
register(0x90, getObjectOwnerHandler);

// ─── 0xAB  saveRestoreVerbs ──────────────────────────────────────────
// `opcode sub-opcode start[p8] end[p8] mode[p8]` — save / restore /
// delete verb slots in a range. Used for menu/UI verb juggling. We
// don't persist verb save-slots yet, so consume the operands and
// no-op (the verbs themselves stay as verbOps left them).
function saveRestoreVerbsHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const sub = readU8(slot);
  const start = readVarOrByte(sub, 1, slot, vm.vars);
  const end = readVarOrByte(sub, 2, slot, vm.vars);
  const mode = readVarOrByte(sub, 3, slot, vm.vars);
  vm.annotate(`saveRestoreVerbs sub=0x${sub.toString(16)} [${start}..${end}] mode=${mode} (stub)`);
}
register(0xab, saveRestoreVerbsHandler);

// ─── 0x5D / 0xDD  actorSetClass ──────────────────────────────────────
// Layout: `object[p16] classes[v16]...` (no jump). The object inherits
// each listed class. Per-class value: 0 clears ALL classes; otherwise
// the low 7 bits are the class number (1-based) and bit 0x80 selects
// set (1) vs clear (0) — derived from MI1 room 1's ENCD, which toggles
// class 32 (Untouchable) on/off as `32` and `0x80|32`. Class N → bit
// N-1 of the object's mask. (Distinct opcode from ifClassOfIs 0x1D,
// which is the same family + bit 0x40 and carries a jump target.)
function actorSetClassHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const classes = readWordVararg(slot, vm.vars);
  for (const v of classes) {
    if (v === 0) {
      vm.objectClasses.set(obj, 0);
      continue;
    }
    const classNum = v & 0x7f;
    const bit = (1 << (classNum - 1)) >>> 0;
    const cur = vm.objectClasses.get(obj) ?? 0;
    const next = (v & 0x80) !== 0 ? cur | bit : cur & ~bit;
    vm.objectClasses.set(obj, next >>> 0);
  }
  vm.annotate(`actorSetClass obj=${obj} [${classes.join(',')}]`);
}
register(0x5d, actorSetClassHandler);
register(0xdd, actorSetClassHandler);

// ─── 0x05 / 0x25 / 0x45 / … drawObject ───────────────────────────────
// Place an object on screen. Layout: obj (var-or-word), then a loop
// of subops terminated by 0xFF (same shape as verbOps/actorOps).
//   0x01: at(x, y) — two var-or-word args
//   0x02: setImage(state) — one var-or-word arg
// Other actions appear as `subop & 0x1f == 0` no-op slots in MI1
// scripts — likely "use defaults" markers; we accept them silently
// rather than halting, since they consume no further bytes.
//
// We're a stub until the object compositor lands; honour the byte
// shape and update object state on `setImage`.
function drawObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const ops: string[] = [];
  while (true) {
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x1f;
    switch (action) {
      case 0x00:
        // "use defaults" — silent no-op; just keep the object's
        // current state and enqueue it for drawing below.
        ops.push('default');
        break;
      case 0x01: {
        const x = readVarOrWord(sub, 1, slot, vm.vars);
        const y = readVarOrWord(sub, 2, slot, vm.vars);
        // Phase 6 doesn't support object reposition yet — we draw at
        // the IMHD-recorded position. Recording the args here so the
        // trace is useful; ignored at composite time.
        ops.push(`at(${x},${y})`);
        break;
      }
      case 0x02: {
        const state = readVarOrWord(sub, 1, slot, vm.vars);
        // setImage(0) = "hide". Anything else sets the state; the
        // compositor picks IMxx where xx == state.
        vm.objectStates.set(obj, state);
        ops.push(`setImage(${state})`);
        break;
      }
      default:
        throw new Error(
          `drawObject: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  }
  // Queue for the next compose. If the object's state is 0 (or never
  // set), the compositor will skip it; the queue membership matters
  // for "explicit redraw" semantics, not visibility.
  vm.objectDrawQueue.add(obj);
  vm.annotate(`drawObject obj=${obj} [${ops.join(',')}]`);
}
register(0x05, drawObjectHandler);
register(0x25, drawObjectHandler);
register(0x45, drawObjectHandler);
register(0x65, drawObjectHandler);
register(0x85, drawObjectHandler);
register(0xa5, drawObjectHandler);
register(0xc5, drawObjectHandler);
register(0xe5, drawObjectHandler);

// ─── 0x35 / 0x75 / 0xb5 / 0xf5  findObject ───────────────────────────
// Identify the topmost object at room coords `(x, y)`. Writes the
// object id to `dest` (or 0 when nothing is hit). Variants encode the
// parameter modes for x / y in bits 7 / 6 (bit 5 is part of the base
// opcode pattern, not a mode).
//
// When no room is loaded, returns 0 — matches the original engine's
// behaviour and matters for scripts like MI1 #23 that poll for clicks
// while in the post-credits room-0 state.
function findObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const x = readVarOrWord(opcode, 1, slot, vm.vars);
  const y = readVarOrWord(opcode, 2, slot, vm.vars);
  let objId = 0;
  if (vm.loadedRoom) {
    const hit = pickObject({
      objects: vm.loadedRoom.objects,
      drawQueue: vm.objectDrawQueue,
      x,
      y,
    });
    if (hit !== null) objId = hit;
  }
  writeRef(dest, objId, slot, vm.vars);
  vm.annotate(`findObject(${x},${y}) → ${objId}`);
}
register(0x35, findObjectHandler);
register(0x75, findObjectHandler);
register(0xb5, findObjectHandler);
register(0xf5, findObjectHandler);

// ─── 0x15 / 0x55 / 0x95 / 0xd5  findInventory ────────────────────────
// Identify the inventory object at screen coords `(x, y)`. Same
// bytecode shape as findObject (`dest, x, y`), but searches the
// inventory grid instead of room objects. Used by scripts polling
// for clicks on the inventory area (below the verb bar in MI1).
//
// Stub returning 0 — the inventory subsystem hasn't landed yet, so
// "no inventory under cursor" is always the correct answer. Without
// this stub, MI1 boot's script #23 halts on 0xd5 after a click misses
// any room object.
function findInventoryHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const x = readVarOrWord(opcode, 1, slot, vm.vars);
  const y = readVarOrWord(opcode, 2, slot, vm.vars);
  writeRef(dest, 0, slot, vm.vars);
  vm.annotate(`findInventory(${x},${y}) → 0 (stub: no inventory)`);
}
register(0x15, findInventoryHandler);
register(0x55, findInventoryHandler);
register(0x95, findInventoryHandler);
register(0xd5, findInventoryHandler);

// ─── 0x06 / 0x86  getActorElevation ──────────────────────────────────
// ─── getActor* read family ───────────────────────────────────────────
// `opcode result actor[pN]` — write an actor property to a result var.
// IMPORTANT: bits 5-6 of the opcode SELECT THE OPERATION (this family
// is non-orthogonal), bit 7 is the actor's var-mode:
//   0x03 getActorRoom (p8)   0x23 getActorY (p16)
//   0x43 getActorX (p16)     0x63 getActorFacing (p8)
//   0x06 getActorElevation (p8)
// Invalid actor ids (0 sentinel / out of range) write 0 — the
// original engine's "no actor" fallback.
function makeActorReadOp(
  label: string,
  read: (a: Actor) => number,
  word = false,
): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot, vm.vars);
    const id = word
      ? readVarOrWord(opcode, 1, slot, vm.vars)
      : readVarOrByte(opcode, 1, slot, vm.vars);
    const actor = actorOrNull(vm, id);
    const value = actor ? read(actor) : 0;
    writeRef(dest, value, slot, vm.vars);
    vm.annotate(`${label} actor=${id} → ${value}`);
  };
}
register(0x06, makeActorReadOp('getActorElevation', (a) => a.elevation));
register(0x86, makeActorReadOp('getActorElevation', (a) => a.elevation));
register(0x03, makeActorReadOp('getActorRoom', (a) => a.room));
register(0x83, makeActorReadOp('getActorRoom', (a) => a.room));
register(0x23, makeActorReadOp('getActorY', (a) => a.y, true));
register(0xa3, makeActorReadOp('getActorY', (a) => a.y, true));
register(0x43, makeActorReadOp('getActorX', (a) => a.x, true));
register(0xc3, makeActorReadOp('getActorX', (a) => a.x, true));
// getActorWalkBox (0x7B/0xFB) — same non-orthogonal low-5-bits family
// as multiply/getActorScale/divide. Returns the walk box the actor
// stands in. STUB: returns 0 ("no box") until we wire box-containment
// against the actor's position; enough to load rooms whose entry
// scripts query it. p8 actor.
register(0x7b, makeActorReadOp('getActorWalkBox', () => 0));
register(0xfb, makeActorReadOp('getActorWalkBox', () => 0));

// ─── 0x0D / 0x2D … walkActorToActor ──────────────────────────────────
// Walk actor to where another actor is standing, stopping at `dist`
// pixels short. Layout (per the SCUMM v5 wiki):
//   actor[p8]   — var-or-byte, mode via bit 0x80 of opcode
//   walkee[p8]  — var-or-byte, mode via bit 0x40
//   distance[8] — **always** direct u8 (no mode bit)
// Phase 6: stores the walk intent on the actor (target = walkee's
// position) and flips isMoving = true. Real path stepping lands with
// the walk/pathfinding sub-phase.
function walkToActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const otherId = readVarOrByte(opcode, 2, slot, vm.vars);
  const dist = readU8(slot);
  const actor = actorOrNull(vm, id);
  const other = actorOrNull(vm, otherId);
  if (actor && other) {
    startWalk(vm, actor, { x: other.x, y: other.y });
  }
  vm.annotate(`walkActorToActor actor=${id} other=${otherId} dist=${dist}`);
}
for (const op of [0x0d, 0x2d, 0x4d, 0x6d, 0x8d, 0xad, 0xcd, 0xed]) {
  register(op, walkToActorHandler);
}

// ─── 0x1E / 0x3E / 0x5E / 0x7E / 0x9E / 0xBE / 0xDE / 0xFE  walkActorTo ─
// Walk an actor to (x, y). Records the intent on the actor; the walk
// step itself lands with pathfinding.
function walkToHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const x = readVarOrWord(opcode, 2, slot, vm.vars);
  const y = readVarOrWord(opcode, 3, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    startWalk(vm, actor, { x, y });
  }
  vm.annotate(`walkActorTo actor=${id} (${x},${y})`);
}
for (const op of [0x1e, 0x3e, 0x5e, 0x7e, 0x9e, 0xbe, 0xde, 0xfe]) {
  register(op, walkToHandler);
}

// ─── 0x01 / 0x21 / 0x41 / 0x61 / 0x81 / 0xA1 / 0xC1 / 0xE1  putActor ─
// Place actor at (x, y) in the **current** room (no walk, instant).
// Mirrors SCUMM's `putActor` — the actor's room is the VM's current
// room, NOT a parameter.
function putActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const x = readVarOrWord(opcode, 2, slot, vm.vars);
  const y = readVarOrWord(opcode, 3, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) actorPut(actor, x, y, vm.currentRoom);
  vm.annotate(`putActor actor=${id} (${x},${y}) room=${vm.currentRoom}`);
}
for (const op of [0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1]) {
  register(op, putActorHandler);
}

// ─── 0x11 / 0x91  animateActor ───────────────────────────────────────
// Kick off a named anim id on the actor. Anim playback itself is the
// deferred costume-anim decoder; for now we record the intent so the
// compositor can read the current anim id.
function animateActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const animId = readVarOrByte(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    // Need the costume header + payload to decode the anim record.
    // If the costume isn't loaded (id 0 / unknown), the actor's anim
    // state stays where it is; SCUMM scripts often pre-set anim
    // before setCostume, which the engine treats as a deferred
    // assignment that fires once the costume binds.
    const costume = vm.getCostume(actor.costume);
    if (costume) {
      actor.anim = startAnim(actor.anim, animId, costume.header, costume.payload);
    } else {
      actor.anim = { ...actor.anim, animId };
    }
  }
  vm.annotate(`animateActor actor=${id} anim=${animId}`);
}
register(0x11, animateActorHandler);
register(0x91, animateActorHandler);

// ─── 0x13 / 0x53 / 0x93 / 0xD3  actorOps ─────────────────────────────
// Configure an actor's costume, walk speed, animation frames, talk
// color, scale, etc. Layout: actor id (var-or-byte via opcode bit 7),
// then a loop of subops terminated by 0xFF. v5 has up to ~24 subop
// actions; most are init-and-forget parameter sets that don't need a
// real actor table connection yet.
function actorOpsHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  const ops: string[] = [];
  while (true) {
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x1f;
    switch (action) {
      case 0x00: {
        readVarOrByte(sub, 1, slot, vm.vars); // dummy arg consumed
        ops.push(`dummy`);
        break;
      }
      case 0x01: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        if (actor) actorSetCostume(actor, c);
        ops.push(`setCostume(${c})`);
        break;
      }
      case 0x02: {
        const x = readVarOrByte(sub, 1, slot, vm.vars);
        const y = readVarOrByte(sub, 2, slot, vm.vars);
        if (actor) {
          actor.walkSpeedX = x;
          actor.walkSpeedY = y;
        }
        ops.push(`setWalkSpeed(${x},${y})`);
        break;
      }
      case 0x03: {
        // setSound — Phase 9 audio. Consume args for now.
        readVarOrByte(sub, 1, slot, vm.vars);
        readVarOrByte(sub, 2, slot, vm.vars);
        ops.push('setSound');
        break;
      }
      case 0x04: {
        // setWalkFrame — needs costume-anim integration. Consume + ignore for now.
        readVarOrByte(sub, 1, slot, vm.vars);
        ops.push('setWalkFrame');
        break;
      }
      case 0x05: {
        readVarOrByte(sub, 1, slot, vm.vars); // talk start
        readVarOrByte(sub, 2, slot, vm.vars); // talk stop
        ops.push('setTalkFrame');
        break;
      }
      case 0x06: {
        readVarOrByte(sub, 1, slot, vm.vars); // stand frame
        ops.push('setStandFrame');
        break;
      }
      case 0x07: {
        readVarOrByte(sub, 1, slot, vm.vars);
        readVarOrByte(sub, 2, slot, vm.vars);
        readVarOrByte(sub, 3, slot, vm.vars);
        ops.push('set07');
        break;
      }
      case 0x08:
        // SO_DEFAULT — initActor: clear state but keep id. We zero
        // costume, anim, facing, position; the script will set what
        // it cares about in subsequent subops.
        if (actor) {
          actor.costume = 0;
          actor.facing = 'S';
          actor.elevation = 0;
          actor.visible = true;
          actor.walkTarget = null;
          actor.walkPath = [];
          actor.walkPathIdx = 0;
          actor.isMoving = false;
          // setActorCostume resets anim via the same EMPTY_ANIM_STATE
          // sentinel we use everywhere else; let it do the work.
          actorSetCostume(actor, 0);
        }
        ops.push('init');
        break;
      case 0x09: {
        const e = readVarOrWord(sub, 1, slot, vm.vars);
        if (actor) actor.elevation = e;
        ops.push(`setElevation(${e})`);
        break;
      }
      case 0x0a:
        // setDefaultAnim — costume-anim integration deferred.
        ops.push('setDefaultAnim');
        break;
      case 0x0b: {
        readVarOrByte(sub, 1, slot, vm.vars); // palette slot
        readVarOrByte(sub, 2, slot, vm.vars); // color
        ops.push('setPalette');
        break;
      }
      case 0x0c: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        if (actor) actor.talkColor = c;
        ops.push(`setTalkColor(${c})`);
        break;
      }
      case 0x0d: {
        // setActorName — NUL-terminated string. We don't store names
        // on the actor struct yet (no field). Capture for the trace.
        const start = slot.pc;
        while (slot.pc < slot.bytecode.length && slot.bytecode[slot.pc] !== 0) slot.pc++;
        if (slot.pc >= slot.bytecode.length) throw new Error('actorOps setActorName: missing 0x00 terminator');
        const name = String.fromCharCode(...slot.bytecode.subarray(start, slot.pc));
        slot.pc++;
        ops.push(`setName(${JSON.stringify(name)})`);
        break;
      }
      case 0x0e: {
        readVarOrByte(sub, 1, slot, vm.vars); // init frame
        ops.push('setInitFrame');
        break;
      }
      case 0x0f:
        // observed in MI1 boot following setCostume — wiki doesn't
        // list this subop; treated as no-arg no-op for now.
        ops.push('subop0F');
        break;
      case 0x10: {
        readVarOrByte(sub, 1, slot, vm.vars); // width
        ops.push('setWidth');
        break;
      }
      case 0x11: {
        const sx = readVarOrByte(sub, 1, slot, vm.vars);
        const sy = readVarOrByte(sub, 2, slot, vm.vars);
        if (actor) actor.scale = sx; // store x scale only — y scale typically matches
        ops.push(`setScale(${sx},${sy})`);
        break;
      }
      case 0x12:
        ops.push('setNeverZClip');
        break;
      case 0x13: {
        readVarOrByte(sub, 1, slot, vm.vars); // z-plane
        ops.push('setAlwaysZClip');
        break;
      }
      case 0x14:
        if (actor) actor.ignoreBoxes = true;
        ops.push('setIgnoreBoxes');
        break;
      case 0x15:
        if (actor) actor.ignoreBoxes = false;
        ops.push('setFollowBoxes');
        break;
      case 0x16: {
        readVarOrByte(sub, 1, slot, vm.vars); // anim speed
        ops.push('setAnimSpeed');
        break;
      }
      case 0x17: {
        readVarOrByte(sub, 1, slot, vm.vars); // shadow mode
        ops.push('setShadowMode');
        break;
      }
      default:
        throw new Error(
          `actorOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  }
  vm.annotate(`actorOps actor=${id} [${ops.join(',')}]`);
}
register(0x13, actorOpsHandler);
register(0x53, actorOpsHandler);
register(0x93, actorOpsHandler);
register(0xd3, actorOpsHandler);

// ─── 0x7A / 0xFA  verbOps ────────────────────────────────────────────
// Configure a verb slot — visibility, position, image, name, color,
// shortcut key. Layout: verb id (var-or-byte via opcode bit 7), then
// a loop of subops terminated by 0xFF. Verb subops use the same
// "bits 0..4 select action, bits 7/6/5 select per-arg mode" pattern.
//
// Subops mutate `vm.verbs` — the verb-bar renderer iterates that map
// each frame. Image-based verb sprites (subop 0x01 setImage) and
// string-resource names (subop 0x14 setNameStr) remain stubs: those
// need an object-image / string-resource hand-off that hasn't landed.
// Both are rare in MI1's verb bar (which uses plain text names).
function verbOpsHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const verbId = readVarOrByte(opcode, 1, slot, vm.vars);
  const subops: string[] = [];
  while (true) {
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x1f;
    switch (action) {
      case 0x01: {
        const obj = readVarOrWord(sub, 1, slot, vm.vars);
        // setImage replaces the verb's text with an object sprite —
        // we don't render image-based verbs yet, so just ensure the
        // slot exists.
        getOrCreateVerb(vm, verbId);
        subops.push(`setImage(${obj})`);
        break;
      }
      case 0x02: {
        // setVerbName: NUL-terminated string. May contain `0xFF NN`
        // SCUMM control sequences (color shifts, var substitutions);
        // we decode those out so the verb bar shows plain text.
        const start = slot.pc;
        while (slot.pc < slot.bytecode.length && slot.bytecode[slot.pc] !== 0) slot.pc++;
        if (slot.pc >= slot.bytecode.length) throw new Error('verbOps setVerbName: missing 0x00 terminator');
        const nameBytes = slot.bytecode.subarray(start, slot.pc);
        slot.pc++;
        const v = getOrCreateVerb(vm, verbId);
        v.name = decodeScummString(nameBytes);
        subops.push(`setName("${v.name}")`);
        break;
      }
      case 0x03: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId).color = c;
        subops.push(`setColor(${c})`);
        break;
      }
      case 0x04: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId).hiColor = c;
        subops.push(`setHiColor(${c})`);
        break;
      }
      case 0x05: {
        const x = readVarOrWord(sub, 1, slot, vm.vars);
        const y = readVarOrWord(sub, 2, slot, vm.vars);
        const v = getOrCreateVerb(vm, verbId);
        v.x = x;
        v.y = y;
        subops.push(`setXY(${x},${y})`);
        break;
      }
      case 0x06:
        getOrCreateVerb(vm, verbId).state = 'on';
        subops.push('on');
        break;
      case 0x07:
        getOrCreateVerb(vm, verbId).state = 'off';
        subops.push('off');
        break;
      case 0x08:
        // `delete` removes the slot entirely — distinct from `off`,
        // which preserves it for later `on`.
        vm.verbs.delete(verbId);
        // If the deleted verb was armed, clear the selection.
        if (vm.currentVerb === verbId) vm.currentVerb = null;
        subops.push('delete');
        break;
      case 0x09:
        // `new` creates a fresh slot in the 'on' state. If the slot
        // exists it's reset to defaults (matches v5 semantics — scripts
        // call `new` before re-configuring).
        vm.verbs.set(verbId, {
          id: verbId,
          name: '',
          color: 0,
          hiColor: 0,
          dimColor: 0,
          backColor: 0,
          x: 0,
          y: 0,
          key: 0,
          centered: false,
          state: 'on',
        });
        subops.push('new');
        break;
      case 0x10: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId).dimColor = c;
        subops.push(`setDimColor(${c})`);
        break;
      }
      case 0x11:
        getOrCreateVerb(vm, verbId).state = 'dim';
        subops.push('setDim');
        break;
      case 0x12: {
        const k = readVarOrByte(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId).key = k;
        subops.push(`setKey(${k})`);
        break;
      }
      case 0x13:
        getOrCreateVerb(vm, verbId).centered = true;
        subops.push('setCenter');
        break;
      case 0x14: {
        // String-resource-driven name. We don't have string resources
        // wired through yet; leave the slot's name untouched.
        const s = readVarOrWord(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId);
        subops.push(`setNameStr(${s})`);
        break;
      }
      case 0x16: {
        const a = readVarOrWord(sub, 1, slot, vm.vars);
        const b = readVarOrByte(sub, 2, slot, vm.vars);
        getOrCreateVerb(vm, verbId);
        subops.push(`assignObj(obj=${a},room=${b})`);
        break;
      }
      case 0x17: {
        const c = readVarOrByte(sub, 1, slot, vm.vars);
        getOrCreateVerb(vm, verbId).backColor = c;
        subops.push(`setBackColor(${c})`);
        break;
      }
      default:
        throw new Error(
          `verbOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  }
  vm.annotate(`verbOps verb=${verbId} [${subops.join(',')}]`);
}
register(0x7a, verbOpsHandler);
register(0xfa, verbOpsHandler);

function getOrCreateVerb(vm: Vm, id: number): VerbSlot {
  let v = vm.verbs.get(id);
  if (!v) {
    v = {
      id,
      name: '',
      color: 0,
      hiColor: 0,
      dimColor: 0,
      backColor: 0,
      x: 0,
      y: 0,
      key: 0,
      centered: false,
      state: 'off',
    };
    vm.verbs.set(id, v);
  }
  return v;
}

/**
 * Decode a SCUMM v5 NUL-terminated string into a plain display string.
 * Control sequences `0xFF NN [args]` are mostly stripped, except:
 *   - `0xFF 0x01` (newline) → ASCII `\n` so the text renderer wraps
 *     to a new line. Credits + verb names rely on this for multi-line
 *     layout.
 *   - `0xFF 0x02` (keep-text) — currently stripped; we don't yet
 *     accumulate text across prints. Carries through visually because
 *     each `print` overwrites the previous dialog.
 *
 * Layout per the SCUMM v5 wiki:
 *   0xFF 0x01 — newline (2-byte)
 *   0xFF 0x02 — keep-text (2-byte)
 *   0xFF 0x03 — wait (2-byte)
 *   0xFF 0x04 NN NN — insert int-var
 *   0xFF 0x06 NN NN — var-name
 *   0xFF 0x07 NN NN — string-resource
 *   0xFF 0x08 NN NN — object/verb name
 *   0xFF 0x09 NN NN — sound
 *   0xFF 0x0A NN NN — actor name
 *   0xFF 0x0E NN NN — colour change
 */
function decodeScummString(payload: Uint8Array): string {
  const out: number[] = [];
  let i = 0;
  while (i < payload.length) {
    const b = payload[i]!;
    if (b === 0xff) {
      const code = payload[i + 1] ?? 0;
      if (code === 0x01) out.push(0x0a); // newline
      // 0x01–0x03 are 2-byte sequences (FF + code); the rest are 4-byte.
      i += code >= 0x04 ? 4 : 2;
      continue;
    }
    out.push(b);
    i++;
  }
  return String.fromCharCode(...out);
}

// ─── 0xCC  pseudoRoom ────────────────────────────────────────────────
// Register "pseudo-room" mappings — additional resource entries that
// alias an existing room id (used in MI1 for music-track selection
// against the iMUSE engine). Layout: byte `id`, then a sequence of
// bytes terminated by 0x00. We have no resource manager that consumes
// these mappings yet, so we honour the byte shape and stub.
register(0xcc, (vm, slot) => {
  const id = readU8(slot);
  const aliases: number[] = [];
  while (true) {
    const j = readU8(slot);
    if (j === 0) break;
    aliases.push(j);
  }
  vm.annotate(`pseudoRoom id=${id} aliases=[${aliases.map((a) => '0x' + a.toString(16)).join(',')}] (stub)`);
});

// ─── 0x33 / 0x73 / 0xB3 / 0xF3  roomOps ──────────────────────────────
// Multi-subop opcode for room-level effects: scrolling, screen
// transitions, palette manipulation, shake, save/load string. For
// Phase 6 every subop is a silent stub — we honour the parameter
// shapes (so PC advances correctly) but don't mutate engine state.
// Most subops are visual-only and only matter once we have a frame
// compositor; the boot script issues them but doesn't depend on their
// observable effects to proceed.
function roomOpsHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  switch (action) {
    case 0x01: {
      // roomScroll: minX, maxX (both var-or-word)
      const a = readVarOrWord(subop, 1, slot, vm.vars);
      const b = readVarOrWord(subop, 2, slot, vm.vars);
      vm.annotate(`roomOps roomScroll min=${a} max=${b} (stub)`);
      return;
    }
    case 0x03: {
      // setScreen: top, bottom — the playable viewport vertical
      // bounds. Rows [top, bottom) host the camera view; the
      // remainder is verb / inventory UI. The inspector reads this to
      // draw the viewport-indicator rectangle so the user can see
      // exactly what the player would see on a real screen.
      const a = readVarOrWord(subop, 1, slot, vm.vars);
      const b = readVarOrWord(subop, 2, slot, vm.vars);
      vm.screen.top = a;
      vm.screen.bottom = b;
      vm.annotate(`roomOps setScreen top=${a} bottom=${b}`);
      return;
    }
    case 0x04: {
      // setPalColor: red, green, blue, slot. v5 reads a second subop
      // byte for the slot arg (param mode for `d`).
      const r = readVarOrWord(subop, 1, slot, vm.vars);
      const g = readVarOrWord(subop, 2, slot, vm.vars);
      const b = readVarOrWord(subop, 3, slot, vm.vars);
      const sub2 = readU8(slot);
      const idx = readVarOrByte(sub2, 1, slot, vm.vars);
      vm.annotate(`roomOps setPalColor (${r},${g},${b}) → slot ${idx} (stub)`);
      return;
    }
    case 0x05:
      vm.annotate('roomOps shakeOn (stub)');
      return;
    case 0x06:
      vm.annotate('roomOps shakeOff (stub)');
      return;
    case 0x08: {
      // roomIntensity: a, b, c (all var-or-byte)
      const a = readVarOrByte(subop, 1, slot, vm.vars);
      const b = readVarOrByte(subop, 2, slot, vm.vars);
      const c = readVarOrByte(subop, 3, slot, vm.vars);
      vm.annotate(`roomOps roomIntensity ${a},${b},${c} (stub)`);
      return;
    }
    case 0x09: {
      // saveLoad: a, b (var-or-byte)
      const a = readVarOrByte(subop, 1, slot, vm.vars);
      const b = readVarOrByte(subop, 2, slot, vm.vars);
      vm.annotate(`roomOps saveLoad ${a},${b} (stub)`);
      return;
    }
    case 0x0a: {
      // screenEffect: effect (var-or-word)
      const e = readVarOrWord(subop, 1, slot, vm.vars);
      vm.annotate(`roomOps screenEffect ${e} (stub)`);
      return;
    }
    case 0x0b: {
      // setRGBRoomIntensity (colorIntensityRange): rs, gs, bs (3 words)
      // then a second subop reads two bytes (lo, hi).
      const rs = readVarOrWord(subop, 1, slot, vm.vars);
      const gs = readVarOrWord(subop, 2, slot, vm.vars);
      const bs = readVarOrWord(subop, 3, slot, vm.vars);
      const sub2 = readU8(slot);
      const lo = readVarOrByte(sub2, 1, slot, vm.vars);
      const hi = readVarOrByte(sub2, 2, slot, vm.vars);
      vm.annotate(`roomOps setRGBRoomIntensity (${rs},${gs},${bs}) ${lo}..${hi} (stub)`);
      return;
    }
    case 0x0d: {
      // saveString: a, b (var-or-byte, then NUL-terminated string)
      const a = readVarOrByte(subop, 1, slot, vm.vars);
      const start = slot.pc;
      while (slot.pc < slot.bytecode.length && slot.bytecode[slot.pc] !== 0) slot.pc++;
      if (slot.pc >= slot.bytecode.length) throw new Error('roomOps saveString: missing 0x00 terminator');
      slot.pc++;
      vm.annotate(`roomOps saveString slot=${a} len=${slot.pc - start - 1} (stub)`);
      return;
    }
    case 0x0e: {
      // loadString: a, then NUL-terminated string
      const a = readVarOrByte(subop, 1, slot, vm.vars);
      const start = slot.pc;
      while (slot.pc < slot.bytecode.length && slot.bytecode[slot.pc] !== 0) slot.pc++;
      if (slot.pc >= slot.bytecode.length) throw new Error('roomOps loadString: missing 0x00 terminator');
      slot.pc++;
      vm.annotate(`roomOps loadString slot=${a} len=${slot.pc - start - 1} (stub)`);
      return;
    }
    default:
      throw new Error(
        `roomOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
}
register(0x33, roomOpsHandler);
register(0x73, roomOpsHandler);
register(0xb3, roomOpsHandler);
register(0xf3, roomOpsHandler);

// ─── 0x0A  startScript ───────────────────────────────────────────────
// Spawn a global script in a free slot. Layout: scriptId (var-or-byte
// via bit 0x80) then a word-vararg list of locals (terminated 0xFF).
// Bit 0x20 flags the new slot as freeze-resistant; bit 0x40 flags it
// as recursive (allowing re-entry while another instance runs).
//
// All eight opcode variants (0x0A/0x2A/0x4A/0x6A/0x8A/0xAA/0xCA/0xEA)
// share the family; the high bits select param mode + flags.
register(0x0a, startScriptHandler);
register(0x2a, startScriptHandler);
register(0x4a, startScriptHandler);
register(0x6a, startScriptHandler);
register(0x8a, startScriptHandler);
register(0xaa, startScriptHandler);
register(0xca, startScriptHandler);
register(0xea, startScriptHandler);
function startScriptHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const scriptId = readVarOrByte(opcode, 1, slot, vm.vars);
  const args = readWordVararg(slot, vm.vars);

  // Bit 0x20 = freeze-resistant (skipped by a normal freezeScripts).
  // Bit 0x40 = recursive (re-entry allowed) — not honoured yet.
  // Resolution (global DSCR vs room-local LSCR) lives in startScriptById.
  const freezeResistant = (opcode & 0x20) !== 0;
  const child = vm.startScriptById(scriptId, { args, freezeResistant });
  vm.annotate(`startScript #${scriptId} slot=${child.slotIndex} args=[${args.join(',')}]`);
}

// ─── 0x19  doSentence ────────────────────────────────────────────────
// Enqueue a (verb, objectA, objectB) sentence for the sentence-script
// driver, OR clear the queue when verb == 0xFE. Layout: verb (var-or-
// byte via bit 0x80), then — only when not clearing — objectA and
// objectB (each var-or-word via bits 0x40 / 0x20). The clear form
// carries no object operands, matching the original engine's early
// return. The eight family variants share param-mode bits.
function doSentenceHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const verb = readVarOrByte(opcode, 1, slot, vm.vars);
  if (verb === SENTENCE_CLEAR_VERB) {
    vm.clearSentence();
    vm.annotate('doSentence clear');
    return;
  }
  const objectA = readVarOrWord(opcode, 2, slot, vm.vars);
  const objectB = readVarOrWord(opcode, 3, slot, vm.vars);
  vm.pushSentence({ verb, objectA, objectB });
  vm.annotate(`doSentence verb=${verb} objA=${objectA} objB=${objectB}`);
}
register(0x19, doSentenceHandler);
register(0x39, doSentenceHandler);
register(0x59, doSentenceHandler);
register(0x79, doSentenceHandler);
register(0x99, doSentenceHandler);
register(0xb9, doSentenceHandler);
register(0xd9, doSentenceHandler);
register(0xf9, doSentenceHandler);

// ─── 0xAE  wait ──────────────────────────────────────────────────────
// Yield until a condition is satisfied. The subop byte selects the
// condition (low 5 bits) and — for SO_WAIT_FOR_ACTOR — its 0x80 bit
// selects var-vs-direct for the actor operand. Confirmed empirically:
// MI1's sentence script (#2) emits `AE 81 <varref>` = wait-for-actor
// on a var-supplied actor id (e.g. `01 00` = VAR_EGO — wait for
// Guybrush to finish walking). See scratch/scan-wait.ts.
//
// Mechanism: if the condition isn't met we rewind PC to the 0xAE byte
// and yield, so the next tick re-runs the opcode and re-checks — the
// original engine's `_scriptPointer = _scriptOrgPointer; breakHere()`.
const SO_WAIT_FOR_ACTOR = 0x01;
const SO_WAIT_FOR_MESSAGE = 0x02;
const SO_WAIT_FOR_CAMERA = 0x03;
const SO_WAIT_FOR_SENTENCE = 0x04;

function waitHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const opcodeStart = slot.pc - 1; // the 0xAE byte itself
  const subop = readU8(slot);

  let shouldWait: boolean;
  let detail: string;
  switch (subop & 0x1f) {
    case SO_WAIT_FOR_ACTOR: {
      const actorId = readVarOrByte(subop, 1, slot, vm.vars);
      const actor = actorOrNull(vm, actorId);
      shouldWait = actor?.isMoving ?? false;
      detail = `actor ${actorId}`;
      break;
    }
    case SO_WAIT_FOR_MESSAGE:
      // Waits while a message is on screen. VAR_HAVE_MSG isn't driven
      // by the dialog renderer yet (per-char reveal / talk timing), so
      // this reads 0 and never blocks until that lands.
      shouldWait = vm.vars.readGlobal(VAR_HAVE_MSG) !== 0;
      detail = 'message';
      break;
    case SO_WAIT_FOR_CAMERA:
      // Camera is snap-only (no smooth pan yet) — it has always
      // "arrived", so this never blocks.
      shouldWait = false;
      detail = 'camera';
      break;
    case SO_WAIT_FOR_SENTENCE:
      shouldWait = vm.sentenceStack.length > 0;
      detail = 'sentence';
      break;
    default:
      throw new Error(`wait: unknown subop 0x${subop.toString(16)}`);
  }

  if (shouldWait) {
    slot.pc = opcodeStart; // re-run + re-check next tick
    slot.yield_();
    vm.annotate(`wait ${detail} → yield`);
  } else {
    vm.annotate(`wait ${detail} → ready`);
  }
}
register(0xae, waitHandler);

// ─── 0x0C  resourceRoutines ──────────────────────────────────────────
// Load / nuke / lock / unlock a resource (script, sound, costume,
// room, charset). All resource data lives in the .000/.001 files,
// which we map into memory once at boot — there's nothing to load on
// demand. We honour the parameter shapes (so the PC advances right)
// and otherwise no-op.
register(0x0c, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  // Most subops take exactly one var-or-byte arg (a resource id).
  // The two exceptions: subop 0x11 (clearHeap) takes none, and
  // subop 0x14 (loadFlObject) takes two args (object id + room).
  const single = (label: string) => {
    const id = readVarOrByte(subop, 1, slot, vm.vars);
    vm.annotate(`resourceRoutines ${label} id=${id} (stub)`);
  };
  switch (action) {
    case 0x01: single('loadScript'); return;
    case 0x02: single('loadSound'); return;
    case 0x03: single('loadCostume'); return;
    case 0x04: single('loadRoom'); return;
    case 0x05: single('nukeScript'); return;
    case 0x06: single('nukeSound'); return;
    case 0x07: single('nukeCostume'); return;
    case 0x08: single('nukeRoom'); return;
    case 0x09: single('lockScript'); return;
    case 0x0a: single('lockSound'); return;
    case 0x0b: single('lockCostume'); return;
    case 0x0c: single('lockRoom'); return;
    case 0x0d: single('unlockScript'); return;
    case 0x0e: single('unlockSound'); return;
    case 0x0f: single('unlockCostume'); return;
    case 0x10: single('unlockRoom'); return;
    case 0x11:
      vm.annotate('resourceRoutines clearHeap (stub)');
      return;
    case 0x12: single('loadCharset'); return;
    case 0x13: single('nukeCharset'); return;
    case 0x14: {
      const obj = readVarOrByte(subop, 1, slot, vm.vars);
      const room = readVarOrByte(subop, 2, slot, vm.vars);
      vm.annotate(`resourceRoutines loadFlObject obj=${obj} room=${room} (stub)`);
      return;
    }
    default:
      throw new Error(
        `resourceRoutines: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
});

// ─── 0x27  stringOps ─────────────────────────────────────────────────
// Multi-subop opcode that manages SCUMM's engine-owned string table:
// load a literal, copy one string into another, get/set a single
// character, allocate an empty buffer. Subop high bits select per-arg
// modes (same convention as cursorCommand).
//
// We store strings on `vm.strings`, a Map<number, Uint8Array>. Text-
// output opcodes (which display these) land later; for the boot
// script we just need correct mutation semantics and clean PC advance.
register(0x27, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  switch (action) {
    case 0x01: {
      // loadString: resId (var-or-byte), then NUL-terminated ASCII.
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const start = slot.pc;
      while (slot.pc < slot.bytecode.length && slot.bytecode[slot.pc] !== 0) {
        slot.pc++;
      }
      const end = slot.pc;
      if (slot.pc >= slot.bytecode.length) {
        throw new Error('stringOps loadString: missing 0x00 terminator');
      }
      slot.pc++; // consume the terminator
      const text = slot.bytecode.slice(start, end);
      vm.strings.set(id, text);
      vm.annotate(`stringOps loadString id=${id} len=${text.length}`);
      return;
    }
    case 0x02: {
      // copyString: destId, srcId — duplicate the buffer.
      const dest = readVarOrByte(subop, 1, slot, vm.vars);
      const src = readVarOrByte(subop, 2, slot, vm.vars);
      const srcBuf = vm.strings.get(src);
      vm.strings.set(dest, srcBuf ? new Uint8Array(srcBuf) : new Uint8Array(0));
      vm.annotate(`stringOps copyString ${src}→${dest}`);
      return;
    }
    case 0x03: {
      // setStringChar: id, index, char
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const idx = readVarOrByte(subop, 2, slot, vm.vars);
      const ch = readVarOrByte(subop, 3, slot, vm.vars);
      const buf = vm.strings.get(id);
      if (buf && idx >= 0 && idx < buf.length) buf[idx] = ch & 0xff;
      vm.annotate(`stringOps setStringChar id=${id}[${idx}] = 0x${(ch & 0xff).toString(16)}`);
      return;
    }
    case 0x04: {
      // getStringChar: dest var = string[id][index]
      const destRef = readDestRef(slot, vm.vars);
      const id = readVarOrByte(subop, 2, slot, vm.vars);
      const idx = readVarOrByte(subop, 3, slot, vm.vars);
      const buf = vm.strings.get(id);
      const ch = buf && idx >= 0 && idx < buf.length ? buf[idx]! : 0;
      writeRef(destRef, ch, slot, vm.vars);
      vm.annotate(`stringOps getStringChar id=${id}[${idx}] → 0x${ch.toString(16)}`);
      return;
    }
    case 0x05: {
      // createString: allocate an empty buffer of `size` bytes for id.
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const size = readVarOrByte(subop, 2, slot, vm.vars);
      vm.strings.set(id, new Uint8Array(size));
      vm.annotate(`stringOps createString id=${id} size=${size}`);
      return;
    }
    default:
      throw new Error(
        `stringOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
});

// ─── 0xAC  expression ────────────────────────────────────────────────
// Stack-based mini-VM embedded in the bytecode stream. The full subop
// grammar (push imm / push var / + - * / and the 0xFF terminator)
// lives in `expression.ts`; we just hand control off here.
register(0xac, (vm, slot) => {
  evalExpression(slot, vm.vars, vm);
  vm.annotate('expression');
});

// ─── 0x2E  delay ─────────────────────────────────────────────────────
// 3-byte immediate (24-bit LE tick count). Holds the slot yielded
// for `ticks` ticks — the tick driver decrements `slot.delayRemaining`
// each tick and only resumes when it reaches 0. Critical for cutscene
// pacing: MI1's credits emit `print "Card text"; delay 120` so each
// card holds for ~2 sec at 60Hz before the next print overwrites it.
register(0x2e, (vm, slot) => {
  const a = readU8(slot);
  const b = readU8(slot);
  const c = readU8(slot);
  const ticks = a | (b << 8) | (c << 16);
  slot.delayRemaining = ticks;
  slot.yield_();
  vm.annotate(`delay ${ticks}`);
});

export const SEED_OPCODES: ReadonlyMap<number, OpcodeHandler> = handlers;
