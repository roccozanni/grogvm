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
import { startWalk } from '../../actor/walk';
import { startAnim } from '../../graphics/costume-anim';
import { pickObject } from '../../object/hittest';
import { evalExpression } from '../expression';
import { SENTENCE_CLEAR_VERB } from '../sentence';
import { VAR_CURRENT_LIGHTS, VAR_CURSORSTATE, VAR_HAVE_MSG, VAR_OVERRIDE, VAR_USERPUT } from '../vars';
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

// ─── 0x1D / 0x9D  ifClassOfIs ────────────────────────────────────────
// `opcode object[p16] {class[v16]}... 0xFF target[16]`. Conditional
// branch: `unless (object matches every listed class) goto target`.
// Each class value carries the class in its low 7 bits and a polarity
// in bit 0x80 (set = "must be IN this class", clear = "must NOT be"),
// the same encoding `actorSetClass` (0x5D) writes. Class N occupies bit
// N-1 of `vm.objectClasses` (classes are 1-based). The read side of the
// class system — previously `objectClasses` was write-only. MI1 uses it
// heavily (e.g. the door script checks the object's class before acting).
function ifClassOfIsHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const classes = readWordVararg(slot, vm.vars);
  const delta = readI16(slot);
  const mask = vm.objectClasses.get(obj) ?? 0;
  let cond = true;
  for (const c of classes) {
    const cls = c & 0x7f;
    const wantIn = (c & 0x80) !== 0;
    const inClass = cls > 0 && (mask & (1 << (cls - 1))) !== 0;
    if (inClass !== wantIn) cond = false;
  }
  if (!cond) slot.pc += delta;
  vm.annotate(
    `ifClassOfIs obj=${obj} [${classes.join(',')}] → ${cond ? 'continue' : `jump ${delta}`}`,
  );
}
register(0x1d, ifClassOfIsHandler);
register(0x9d, ifClassOfIsHandler);

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
  // Cursor / userput state are COUNTERS (see o5_cursorCommand): hard
  // on/off set 1/0, the "soft" variants increment/decrement so a
  // cutscene's soft-off nests and a soft-on only re-shows the cursor if
  // it was up before. `state`/`userput` are mirrored into
  // VAR_CURSORSTATE / VAR_USERPUT at the end (matching the original's
  // `if (version >= 4)` tail), so a script polling them right after this
  // opcode sees the live value.
  switch (action) {
    case 0x01: // SO_CURSOR_ON
      vm.cursor.state = 1;
      vm.annotate('cursorCommand cursorOn');
      break;
    case 0x02: // SO_CURSOR_OFF
      vm.cursor.state = 0;
      vm.annotate('cursorCommand cursorOff');
      break;
    case 0x03: // SO_USERPUT_ON
      vm.cursor.userput = 1;
      vm.annotate('cursorCommand userputOn');
      break;
    case 0x04: // SO_USERPUT_OFF
      vm.cursor.userput = 0;
      vm.annotate('cursorCommand userputOff');
      break;
    case 0x05: // SO_CURSOR_SOFT_ON
      vm.cursor.state++;
      vm.annotate('cursorCommand cursorSoftOn');
      break;
    case 0x06: // SO_CURSOR_SOFT_OFF
      vm.cursor.state--;
      vm.annotate('cursorCommand cursorSoftOff');
      break;
    case 0x07: // SO_USERPUT_SOFT_ON
      vm.cursor.userput++;
      vm.annotate('cursorCommand userputSoftOn');
      break;
    case 0x08: // SO_USERPUT_SOFT_OFF
      vm.cursor.userput--;
      vm.annotate('cursorCommand userputSoftOff');
      break;
    case 0x0a: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      const ch = readVarOrByte(subop, 2, slot, vm.vars);
      vm.annotate(`cursorCommand setCursorImage cur=${cur} char=${ch} (stub)`);
      break;
    }
    case 0x0b: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      const x = readVarOrByte(subop, 2, slot, vm.vars);
      const y = readVarOrByte(subop, 3, slot, vm.vars);
      vm.annotate(`cursorCommand setCursorHotspot cur=${cur} (${x},${y}) (stub)`);
      break;
    }
    case 0x0c: {
      const cur = readVarOrByte(subop, 1, slot, vm.vars);
      vm.annotate(`cursorCommand initCursor cur=${cur} (stub)`);
      break;
    }
    case 0x0d: {
      const charset = readVarOrByte(subop, 1, slot, vm.vars);
      vm.currentCharset = charset;
      vm.annotate(`cursorCommand initCharset charset=${charset}`);
      break;
    }
    case 0x0e: {
      // charsetColor: word-vararg list of CLUT indices, terminated by 0xFF.
      const colors = readWordVararg(slot, vm.vars);
      vm.annotate(`cursorCommand charsetColor [${colors.join(',')}] (stub)`);
      break;
    }
    default:
      throw new Error(
        `cursorCommand: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
  // o5_cursorCommand tail (version >= 4): publish the counters.
  vm.vars.writeGlobal(VAR_CURSORSTATE, vm.cursor.state);
  vm.vars.writeGlobal(VAR_USERPUT, vm.cursor.userput);
});

// ─── 0x98  systemOps ─────────────────────────────────────────────────
// Restart / pause / quit. Layout: u8 subop (1 restart, 2 pause, 3
// quit). We record the request as VM state rather than acting on it —
// a script-triggered restart or quit must NOT kill the inspector
// mid-debug. The shell reads `vm.systemRequest` and decides what to do
// (the inspector simply surfaces it). Sub-op 3 (quit) is what the
// copy-protection script invokes after the "wrong code" message.
register(0x98, (vm, slot) => {
  const sub = readU8(slot);
  const request = sub === 1 ? 'restart' : sub === 2 ? 'pause' : sub === 3 ? 'quit' : null;
  if (request) vm.systemRequest = request;
  vm.annotate(`systemOps ${request ?? `subop=0x${sub.toString(16)}`}`);
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
  // A script-set roomScroll (roomOps 0x01) overrides the default
  // full-width bounds.
  const min = vm.roomScroll ? vm.roomScroll.min : Math.min(halfScreen, room.width);
  const max = vm.roomScroll ? vm.roomScroll.max : Math.max(min, room.width - halfScreen);
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
// Lock the camera to track an actor. Per the SCUMM v5 engine, following
// an actor that is in a DIFFERENT room than the current one switches to
// that room (startScene) — this is how MI1's boot enters the opening
// lookout: it putActorInRoom(ego, 38) then actorFollowCamera(ego), and
// the follow triggers the room load. Per-tick camera panning still
// isn't wired; we snap to the actor's X.
function actorFollowCameraHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    if (actor.room > 0 && actor.room !== vm.currentRoom) {
      vm.enterRoom(actor.room);
    }
    // Snap once now, then track per tick (vm.moveCameraFollow).
    vm.cameraFollowActor = actor.id;
    setCameraTo(vm, actor.x);
  }
  vm.annotate(`actorFollowCamera ${id} → room=${vm.currentRoom} camera.x=${vm.camera.x}`);
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

// ─── 0x70 / 0xF0  lights ─────────────────────────────────────────────
// Set the room lighting mode. Layout: arg1 (var-or-byte via bit 0x80),
// then two raw bytes arg2/arg3. The third arg selects the mode: when
// it's 0, arg1 becomes `VAR_CURRENT_LIGHTS` (the room-lit bit-flags —
// see LIGHTMODE_* in vars.ts). Non-zero arg3 is the flashlight variant
// (arg2 = flashlight strip extent); we don't model the flashlight gfx,
// but still consume the operands and trigger a redraw so the script
// stays aligned. The boot seeds VAR_CURRENT_LIGHTS to a lit default, so
// most rooms never need this — it's used by the few dark rooms.
register(0x70, lightsHandler);
register(0xf0, lightsHandler);
function lightsHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const arg1 = readVarOrByte(opcode, 1, slot, vm.vars);
  const arg2 = readU8(slot);
  const arg3 = readU8(slot);
  if (arg3 === 0) {
    vm.vars.writeGlobal(VAR_CURRENT_LIGHTS, arg1);
    vm.annotate(`lights g9=${arg1}`);
  } else {
    // Flashlight mode — not modeled visually yet.
    vm.annotate(`lights flashlight w=${arg2} mode=${arg3}`);
  }
}

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
      // Control codes 0x01–0x03 are 2-byte (0xFF + code); 0x04 and up
      // carry a 2-byte argument (var/string/object/verb id) → 4-byte
      // total. Mirrors decodeScummString's length rule exactly so the
      // PC-advancing reader and the display decoder never disagree.
      if (code >= 4) slot.pc += 2;
      continue;
    }
    slot.pc++;
  }
  throw new Error('SCUMM string: missing 0x00 terminator');
}

function printHandler(actor: number, vm: Vm, slot: ScriptSlot): void {
  const ops: string[] = [];
  // The speaking actor (printEgo / print actor=0 → ego). When this is a
  // real actor and the script gives no explicit SO_AT / SO_COLOR, it's
  // an actor talking: default to the actor's talk color and position the
  // text above the actor (the SCUMM talk default), not the system
  // bottom-centre fallback.
  const speaker = actorOrNull(vm, actor);
  const speakerId = actor === 0 ? vm.vars.readGlobal(VAR_EGO) : actor;
  // System prints (no speaker — actor 255, credits/narrator) inherit the
  // sticky `_string[0]` state so a bare `print` reuses the last set
  // position/colour/centre (the MI1 credits depend on this). Actor talk
  // starts fresh — its position/colour come from the actor, not the
  // persisted state.
  const isSystem = speaker === null;
  const st = vm.printState;
  let atX: number | null = isSystem ? st.x : null;
  let atY: number | null = isSystem ? st.y : null;
  let color = isSystem ? st.color : 0x0f; // SCUMM default ink (white-ish)
  let colorSet = isSystem ? st.colorSet : false;
  let center = isSystem ? st.center : false;
  let overhead = isSystem ? st.overhead : false;
  let clipped: number | null = isSystem ? st.clipped : null;
  while (true) {
    const sub = readU8(slot);
    if (sub === 0xff) break;
    const action = sub & 0x0f;
    switch (action) {
      case 0x00: {
        // SO_AT — absolute screen position for the text anchor. In
        // SCUMM this also clears the overhead flag (an explicit anchor
        // overrides "above the actor").
        atX = readVarOrWord(sub, 1, slot, vm.vars);
        atY = readVarOrWord(sub, 2, slot, vm.vars);
        overhead = false;
        ops.push(`at(${atX},${atY})`);
        break;
      }
      case 0x01: {
        // SO_COLOR — ink (CLUT index) for the text glyph.
        color = readVarOrByte(sub, 1, slot, vm.vars);
        colorSet = true;
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
        // Split into sentence pages at \xff\x03; the first shows now, the
        // rest are queued and advanced by the talk timer (see queueTalkPages).
        const pages = decodeScummStringPages(buf, vm, slot);
        const text = pages[0] ?? '';
        const preview = Array.from(buf)
          .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
          .join('');
        // Commit the dialog to the VM so the shell renders it.
        // Empty strings count as "clear" — some scripts use a 0-byte
        // print to dismiss the previous bubble.
        // Persist the (possibly subop-updated) string state for system
        // prints so the next bare `print` inherits it. Done regardless
        // of whether the text is empty — a 0-byte clear still leaves the
        // position/colour set for what follows.
        if (isSystem) {
          st.x = atX;
          st.y = atY;
          st.color = color;
          st.colorSet = colorSet;
          st.center = center;
          st.overhead = overhead;
          st.clipped = clipped;
        }
        // Route by channel: system prints (no speaker — signs, narrator,
        // credits) go to the persistent `systemText` slot; real-actor
        // talk goes to the transient `activeDialog` slot. Keeping them
        // separate stops actor speech from clobbering an on-screen sign
        // (and vice-versa) — both can be visible at once. The talk timer
        // (VAR_HAVE_MSG / talkDelay) is driven identically for both so
        // wait-for-message pacing is unchanged.
        if (text.length === 0) {
          if (isSystem) vm.systemText = null;
          else vm.activeDialog = null;
          vm.endTalk();
        } else {
          // Actor talk (valid speaker, no explicit SO_AT) defaults to
          // the actor's talk color and positions above the actor,
          // centred — like the original. Explicit SO_AT / SO_COLOR /
          // system messages (actor 255 → no speaker) keep their values
          // and the bottom-centre fallback.
          const isTalk = speaker !== null && atX === null;
          const dlg = {
            actorId: speakerId,
            text,
            x: atX,
            y: atY,
            color: colorSet ? color : (speaker?.talkColor ?? color),
            center: center || isTalk,
            overhead: overhead || isTalk,
            clipped,
          };
          if (isSystem) vm.systemText = dlg;
          else vm.activeDialog = dlg;
          // Pace the conversation: mark the message as "being said" so
          // a following wait-for-message holds until it's read.
          vm.beginTalk(text);
          // Queue any further sentence pages (\xff\x03-separated); the
          // talk timer flips to each in turn before the message clears.
          vm.queueTalkPages(pages.slice(1), dlg, isSystem);
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
  // print (just set position/color for a later print, or clear). The
  // MI1 credits use exactly this to prime the sticky state for the
  // following bare prints — so persist it on this path too.
  if (isSystem) {
    st.x = atX;
    st.y = atY;
    st.color = color;
    st.colorSet = colorSet;
    st.center = center;
    st.overhead = overhead;
    st.clipped = clipped;
  }
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
    // The original clears VAR_OVERRIDE here; abortCutscene() sets it
    // back to 1 if the player actually skips, so the override code can
    // tell "ran to completion" (0) from "was aborted" (1).
    vm.vars.writeGlobal(VAR_OVERRIDE, 0);
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

// ─── 0x0B / 0x4B / 0x8B / 0xCB  getVerbEntryPoint ────────────────────
// `opcode result object[p16] verb[p16]`. Result var ← the script entry
// offset for `verb` on `object`, or 0 when the object has no such verb.
// Scripts (e.g. MI1's inventory script #9) use it as a boolean "does
// this object respond to this verb?" — so we return 1 when the verb is
// present, 0 otherwise. (We keep per-verb bytecode slices, not raw
// offsets; the truthiness is what callers test. NB: the exact-verb
// query does NOT take the 0xFF default-verb fallback.)
function getVerbEntryPointHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const verb = readVarOrWord(opcode, 2, slot, vm.vars);
  const has = vm.loadedRoom?.objects.get(obj)?.verbs.has(verb) ?? false;
  const entry = has ? 1 : 0;
  writeRef(dest, entry, slot, vm.vars);
  vm.annotate(`getVerbEntryPoint obj=${obj} verb=${verb} → ${entry}`);
}
for (const op of [0x0b, 0x4b, 0x8b, 0xcb]) register(op, getVerbEntryPointHandler);

// ─── 0xAB  saveRestoreVerbs ──────────────────────────────────────────
// `opcode sub-opcode start[p8] end[p8] mode[p8]` — bulk verb-slot
// juggling over the id range [start, end]. The cutscene start script
// (#18) SAVEs the command + inventory verb ranges so the bar vanishes
// for the cutscene; the end script (#19) RESTOREs them.
//   sub 0x01 save:    hide each verb in range, remembering its prior
//                     `state` in `vm.savedVerbStates` (skip ones with
//                     no slot, or already saved).
//   sub 0x02 restore: bring saved verbs in range back to their prior
//                     state and forget the saved entry.
//   sub 0x03 delete:  remove verbs in range outright (`state=deleted`).
// `mode` is the original engine's per-save id; MI1's save/restore are
// range-symmetric, so we match purely on the id range (the saved-state
// map is itself keyed by verb id), which keeps the bar hide/restore
// exact without modelling save-slot ids.
function saveRestoreVerbsHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const sub = readU8(slot);
  const start = readVarOrByte(sub, 1, slot, vm.vars);
  const end = readVarOrByte(sub, 2, slot, vm.vars);
  const mode = readVarOrByte(sub, 3, slot, vm.vars);
  const action = sub & 0x1f;
  for (const verb of vm.verbs.values()) {
    if (verb.id < start || verb.id > end) continue;
    if (action === 0x01) {
      // save + hide — don't overwrite an existing save or re-hide.
      if (verb.state === 'off' || vm.savedVerbStates.has(verb.id)) continue;
      vm.savedVerbStates.set(verb.id, verb.state);
      verb.state = 'off';
    } else if (action === 0x02) {
      const prev = vm.savedVerbStates.get(verb.id);
      if (prev !== undefined) {
        verb.state = prev;
        vm.savedVerbStates.delete(verb.id);
      }
    } else if (action === 0x03) {
      verb.state = 'deleted';
      vm.savedVerbStates.delete(verb.id);
    }
  }
  vm.annotate(`saveRestoreVerbs sub=0x${sub.toString(16)} [${start}..${end}] mode=${mode}`);
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
// drawObject's only top-level operand is `object[p16]` (mode bit 0x80);
// it has no second param at this level (the rest is a 0xFF-terminated
// subop list). So it owns exactly 0x05 / 0x85 — NOT all eight high-bit
// variants. The low5=0x05 family is non-orthogonal: 0x25 / 0x65 / 0xa5 /
// 0xe5 are `pickupObject` (see below), and registering drawObject across
// the whole family silently swallowed them.
register(0x05, drawObjectHandler);
register(0x85, drawObjectHandler);

// ─── 0x25 / 0x65 / 0xa5 / 0xe5  pickupObject ─────────────────────────
// `opcode object[p16] room[p8]`. Picks an object up into Ego's
// inventory: SCUMM ties inventory membership to ownership, so we set
// the object's owner to `VAR_EGO`, mark it state 1 (the "carried"
// image variant), and drop it from the room's draw queue. The inventory
// strip repaints from `vm.objectOwners`.
//
// `room == 0` means "the current room" (the arg only matters for
// loading an object's image from a room it isn't currently in — we
// resolve images lazily, so we just record it in the trace).
//
// Deferred vs. the original: the untouchable-class flag and
// `runInventoryScript` (VAR_INVENTORY_SCRIPT) — neither is needed to
// own/count an item, and the inventory UI script isn't wired yet.
function pickupObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const ego = vm.vars.readGlobal(VAR_EGO);
  // Snapshot the name BEFORE dropping the object from the room, so a
  // carried item keeps its label after leaving its pickup room.
  vm.captureInventoryName(obj, room);
  vm.objectOwners.set(obj, ego);
  vm.objectStates.set(obj, 1);
  vm.objectDrawQueue.delete(obj);
  // Refresh the inventory display (lays the item into the verb slots).
  vm.runInventoryScript(1);
  vm.annotate(`pickupObject obj=${obj} room=${room} → owner ${ego}`);
}
for (const op of [0x25, 0x65, 0xa5, 0xe5]) register(op, pickupObjectHandler);

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

// ─── 0x34 / 0x74 / 0xb4 / 0xf4  getDist ──────────────────────────────
// `opcode result objA[p16] objB[p16]`. Result var ← the distance
// between two objects/actors. Each id resolves actor-or-object the same
// way `faceActor` does (id within the actor table → actor position,
// else a room object's CDHD position). Distance is SCUMM's Chebyshev
// metric `max(|dx|, |dy|)`; an unresolvable id yields 0xFF ("far").
// MI1's sentence script #2 uses it as a proximity gate (e.g. open the
// door only once ego is close enough).
function objActPos(vm: Vm, id: number): { x: number; y: number } | null {
  if (id > 0 && id <= vm.actors.capacity) {
    const a = vm.actors.get(id);
    return { x: a.x, y: a.y };
  }
  const obj = vm.loadedRoom?.objects.get(id);
  return obj ? { x: obj.cdhd.x * 8, y: obj.cdhd.y * 8 } : null;
}
function getDistHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const a = readVarOrWord(opcode, 1, slot, vm.vars);
  const b = readVarOrWord(opcode, 2, slot, vm.vars);
  const pa = objActPos(vm, a);
  const pb = objActPos(vm, b);
  const dist =
    pa && pb ? Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y)) : 0xff;
  writeRef(dest, dist, slot, vm.vars);
  vm.annotate(`getDist ${a},${b} → ${dist}`);
}
for (const op of [0x34, 0x74, 0xb4, 0xf4]) register(op, getDistHandler);

// ─── 0x15 / 0x55 / 0x95 / 0xd5  actorFromPos ─────────────────────────
// `opcode result x[p16] y[p16]`. Returns the actor under room-space
// coords `(x, y)`, or 0 when none. (This is 0x15 — NOT findInventory,
// which is 0x3D; an earlier pass mislabeled it AND read the coords as
// bytes. Per the opcode reference the params are words, p16, like
// findObject.) MI1 boot's #23 hits 0xd5 (both-var form) when polling
// whether a click landed on an actor.
//
// Backed by vm.actorFromPos, which hit-tests against each actor's
// last-drawn bounds (SCUMM's gfx-usage-bit equivalent). Returns 0 when
// no actor is on screen — the correct answer during the credits/intro
// cutscenes (no clicks, nothing drawn yet).
function actorFromPosHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const x = readVarOrWord(opcode, 1, slot, vm.vars);
  const y = readVarOrWord(opcode, 2, slot, vm.vars);
  const id = vm.actorFromPos(x, y);
  writeRef(dest, id, slot, vm.vars);
  vm.annotate(`actorFromPos(${x},${y}) → ${id}`);
}
register(0x15, actorFromPosHandler);
register(0x55, actorFromPosHandler);
register(0x95, actorFromPosHandler);
register(0xd5, actorFromPosHandler);

// ─── 0x31 / 0xb1  getInventoryCount ──────────────────────────────────
// `opcode result actor[p8]`. Result var ← how many objects the given
// actor owns (its inventory size). actor's var-mode is bit 0x80, so the
// family is just 0x31 / 0xb1. MI1's intro reads this inside an
// `expression` (nested via the 0x06 subop) on the way into room 33.
function getInventoryCountHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const actor = readVarOrByte(opcode, 1, slot, vm.vars);
  const count = vm.inventoryCount(actor);
  writeRef(dest, count, slot, vm.vars);
  vm.annotate(`getInventoryCount actor=${actor} → ${count}`);
}
register(0x31, getInventoryCountHandler);
register(0xb1, getInventoryCountHandler);

// ─── 0x3d / 0x7d / 0xbd / 0xfd  findInventory ────────────────────────
// `opcode result owner[p8] index[p8]`. Result var ← the `index`-th
// (1-based) object owned by `owner`, in pickup order; 0 when out of
// range. owner's mode bit is 0x80, index's is 0x40. Used to walk an
// actor's inventory (e.g. to lay out the inventory strip).
function findInventoryHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const owner = readVarOrByte(opcode, 1, slot, vm.vars);
  const index = readVarOrByte(opcode, 2, slot, vm.vars);
  const obj = vm.findInventory(owner, index);
  writeRef(dest, obj, slot, vm.vars);
  vm.annotate(`findInventory owner=${owner} index=${index} → ${obj}`);
}
register(0x3d, findInventoryHandler);
register(0x7d, findInventoryHandler);
register(0xbd, findInventoryHandler);
register(0xfd, findInventoryHandler);

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

// ─── walkActorToActor / putActorInRoom (non-orthogonal low5=0x0D) ─────
// These two opcodes SHARE the low 5 bits — **bit 0x20 selects which**:
//   bit 0x20 clear → walkActorToActor (0x0D/0x4D/0x8D/0xCD)
//   bit 0x20 set   → putActorInRoom   (0x2D/0x6D/0xAD/0xED)
// (We previously registered all 8 as walkActorToActor, which silently
// turned MI1's `putActorInRoom(ego, 38)` at the end of the boot into a
// no-op — that's the opcode that puts Guybrush in the lookout room.)
//
// walkActorToActor: walker[p8] (bit 0x80) walkee[p8] (bit 0x40) dist[8].
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
for (const op of [0x0d, 0x4d, 0x8d, 0xcd]) register(op, walkToActorHandler);

// putActorInRoom: actor[p8] (bit 0x80) room[p8] (bit 0x40). Assigns the
// actor to a room — does NOT load it (that happens when the camera
// follows the actor, or via loadRoom).
function putActorInRoomHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) actor.room = room;
  vm.annotate(`putActorInRoom actor=${id} room=${room}`);
}
for (const op of [0x2d, 0x6d, 0xad, 0xed]) register(op, putActorInRoomHandler);

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

// ─── walkActorToObject (0x36/0x76/0xB6/0xF6) ─────────────────────────
// `actor[p8] (bit 0x80) object[p16] (bit 0x40)`. Walk the actor to the
// object's CDHD walk-to point. Shares low5=0x16 with getRandomNumber
// (0x16) and getActorMoving (0x56) — bit 0x20 selects this op. (MI1's
// lookout dialog #203 uses 0xB6 to walk Guybrush to the lookout NPC.)
function walkToObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const objId = readVarOrWord(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  const obj = vm.loadedRoom?.objects.get(objId);
  if (actor && obj) {
    startWalk(vm, actor, { x: obj.cdhd.walkX, y: obj.cdhd.walkY });
  }
  vm.annotate(`walkActorToObject actor=${id} obj=${objId}`);
}
for (const op of [0x36, 0x76, 0xb6, 0xf6]) register(op, walkToObjectHandler);

// ─── faceActor (0x09/0x49/0x89/0xC9) ─────────────────────────────────
// `actor[p8] (bit 0x80) object[p16] (bit 0x40)`. Turn the actor to face
// a target (an actor, or a room object). We pick the cardinal facing
// from the dx/dy to the target — enough for the right costume frame.
// Shares low5=0x09 with setOwnerOf (0x29); bit 0x20 selects.
function faceActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const targetId = readVarOrWord(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    let tx: number | null = null;
    let ty = 0;
    const ta =
      targetId > 0 && targetId <= vm.actors.capacity ? vm.actors.get(targetId) : null;
    if (ta && ta.room === actor.room) {
      tx = ta.x;
      ty = ta.y;
    } else {
      const obj = vm.loadedRoom?.objects.get(targetId);
      if (obj) {
        tx = obj.cdhd.x * 8;
        ty = obj.cdhd.y * 8;
      }
    }
    if (tx !== null) {
      const dx = tx - actor.x;
      const dy = ty - actor.y;
      actor.facing =
        Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
    }
  }
  vm.annotate(`faceActor actor=${id} target=${targetId}`);
}
for (const op of [0x09, 0x49, 0x89, 0xc9]) register(op, faceActorHandler);

// ─── setOwnerOf (0x29/0x69/0xA9/0xE9) ────────────────────────────────
// `object[p16] (bit 0x80) owner[p8] (bit 0x40)`. Records who owns an
// object (0 = nobody / in the room). Read back by getObjectOwner.
function setOwnerOfHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const owner = readVarOrByte(opcode, 2, slot, vm.vars);
  // Taking ownership (owner != 0) puts the object in an inventory; grab
  // its name now while the room that owns its OBNA is still resolvable.
  if (owner !== 0) vm.captureInventoryName(obj, 0);
  vm.objectOwners.set(obj, owner);
  vm.annotate(`setOwnerOf obj=${obj} owner=${owner}`);
}
for (const op of [0x29, 0x69, 0xa9, 0xe9]) register(op, setOwnerOfHandler);

// ─── startObject (0x37/0x77/0xB7/0xF7) ───────────────────────────────
// `object[p16] (bit 0x80) script[p8] (bit 0x40) args[v16]`. Runs the
// object's OBCD verb script — exactly what vm.startVerbScript does
// (resolve the verb bytecode + start a labelled slot). (low5=0x17 is
// shared with `and`/`or`; bit 0x20 selects startObject.) All four
// param-mode variants exist — the script id is var-mode in 0x77/0xf7.
function startObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const objId = readVarOrWord(opcode, 1, slot, vm.vars);
  const verbId = readVarOrByte(opcode, 2, slot, vm.vars);
  const args = readWordVararg(slot, vm.vars);
  vm.startVerbScript(objId, verbId, args);
  vm.annotate(`startObject obj=${objId} script=${verbId} args=[${args.join(',')}]`);
}
for (const op of [0x37, 0x77, 0xb7, 0xf7]) register(op, startObjectHandler);

// ─── loadRoomWithEgo (0x24/0xA4) ─────────────────────────────────────
// `object[p16] (bit 0x80) room[p8] x[16] y[16]`. Enter `room`, place ego
// at `object`'s walk-to point there, and — when x != -1 — start ego
// walking toward (x, y). The intro cutscene uses this to move Guybrush
// between scenes. (low5=0x04 shared with isGreaterEqual/isLess; bit
// 0x20 selects this op, so only 0x24/0xA4 are loadRoomWithEgo.)
function loadRoomWithEgoHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const objId = readVarOrWord(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const x = readI16(slot);
  const y = readI16(slot);
  vm.enterRoom(room);
  const ego = actorOrNull(vm, 0);
  if (ego) {
    ego.room = room;
    const obj = vm.loadedRoom?.objects.get(objId);
    if (obj) {
      ego.x = obj.cdhd.walkX;
      ego.y = obj.cdhd.walkY;
    }
    if (x !== -1) startWalk(vm, ego, { x, y });
  }
  vm.annotate(`loadRoomWithEgo obj=${objId} room=${room} (${x},${y})`);
}
register(0x24, loadRoomWithEgoHandler);
register(0xa4, loadRoomWithEgoHandler);

// ─── 0x01 / 0x21 / 0x41 / 0x61 / 0x81 / 0xA1 / 0xC1 / 0xE1  putActor ─
// Place actor at (x, y) (no walk, instant). Per SCUMM's `o5_putActor`,
// the actor KEEPS its existing room (`a->putActor(x, y, a->_room)`) —
// it does NOT move to the current room. This matters at boot: MI1 does
// putActorInRoom(ego, 38) then putActor(ego, x, y), and putActor must
// not clobber room 38 back to the (still-0) current room, or the
// following actorFollowCamera won't load the lookout.
function putActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const x = readVarOrWord(opcode, 2, slot, vm.vars);
  const y = readVarOrWord(opcode, 3, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) actorPut(actor, x, y, actor.room);
  vm.annotate(`putActor actor=${id} (${x},${y}) room=${actor?.room ?? 0}`);
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
// actor = bit 0x80, anim = bit 0x40 → variants 0x11/0x51/0x91/0xD1.
// (0x31 getInventoryCount and 0x71 getActorCostume share low5=0x11 but
// are different opcodes — not registered here.)
register(0x11, animateActorHandler);
register(0x51, animateActorHandler);
register(0x91, animateActorHandler);
register(0xd1, animateActorHandler);

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
        // setImage: the verb shows object `obj`'s sprite (from the
        // current room) instead of text. Stored on the slot; the verb
        // bar composites the object image.
        getOrCreateVerb(vm, verbId).image = { obj, room: vm.currentRoom };
        subops.push(`setImage(${obj})`);
        break;
      }
      case 0x02: {
        // setVerbName: NUL-terminated string. May contain `0xFF NN`
        // SCUMM control sequences (color shifts, var/object/verb-name
        // substitutions) whose 2-byte arguments can themselves contain a
        // 0x00 — so we must use the escape-aware reader, not a naive scan
        // for the next 0x00 (which would stop on an argument byte and
        // misalign the PC). MI1's sentence-line verb (#100) builds its
        // name entirely from these substitution codes.
        const nameBytes = readScummString(slot);
        const v = getOrCreateVerb(vm, verbId);
        v.name = decodeScummString(nameBytes);
        v.image = null; // text verb — drop any prior image binding
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
        // which preserves it for later `on`. (The active verb lives in a
        // game global now — g107 — managed by the verb-input script, so
        // there's no engine-side selection to clear here.)
        vm.verbs.delete(verbId);
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
          image: null,
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
        // setImageInRoom: the verb shows object `a`'s sprite, loaded
        // from room `b` (which may not be the current room — MI1's
        // inventory slots draw from the UI room 99). Stored for the
        // verb bar to composite.
        const a = readVarOrWord(sub, 1, slot, vm.vars);
        const b = readVarOrByte(sub, 2, slot, vm.vars);
        getOrCreateVerb(vm, verbId).image = { obj: a, room: b };
        subops.push(`setImageInRoom(obj=${a},room=${b})`);
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
      image: null,
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
function decodeScummString(payload: Uint8Array, vm?: Vm, slot?: ScriptSlot): string {
  const out: number[] = [];
  let i = 0;
  while (i < payload.length) {
    const b = payload[i]!;
    if (b === 0xff) {
      const code = payload[i + 1] ?? 0;
      if (code === 0x01) out.push(0x0a); // newline
      else if (code >= 0x04) expandSubstitution(code, payload, i, vm, slot, out);
      // 0x01–0x03 are 2-byte sequences (FF + code); the rest are 4-byte.
      i += code >= 0x04 ? 4 : 2;
      continue;
    }
    out.push(b);
    i++;
  }
  return String.fromCharCode(...out);
}

function pushAscii(out: number[], s: string): void {
  for (let k = 0; k < s.length; k++) out.push(s.charCodeAt(k));
}

/**
 * Append the expansion of a `0xFF NN` string substitution control code
 * (NN >= 0x04) to `out`. The 2-byte little-endian argument at
 * `payload[i+2..i+3]` is a var reference (SCUMM `readVar`), so resolving
 * it needs the executing slot + vm; when either is absent (e.g. decoding
 * a static verb name) the code is dropped, matching the prior behaviour.
 *
 * Implemented substitutions, per the SCUMM v5 string-code layout:
 *   0x04 int-var  → the variable's value, in decimal
 *   0x07 string   → the contents of string resource `id`
 *   0x08 obj/verb → the object's or verb's display name
 * Deferred (argument consumed, nothing emitted): 0x06 var-name, 0x09
 * sound, 0x0A actor name (actor names aren't modelled yet), 0x0E
 * mid-string colour (needs rich text — the dialog renderer paints one
 * colour per message today).
 */
function expandSubstitution(
  code: number,
  payload: Uint8Array,
  i: number,
  vm: Vm | undefined,
  slot: ScriptSlot | undefined,
  out: number[],
): void {
  if (!vm || !slot) return;
  const word = (payload[i + 2] ?? 0) | ((payload[i + 3] ?? 0) << 8);
  let value: number;
  try {
    value = derefRead(word, slot, vm.vars);
  } catch {
    return; // unresolvable ref (e.g. OOB local index) — emit nothing
  }
  if (code === 0x04) {
    pushAscii(out, String(value));
  } else if (code === 0x07) {
    const buf = vm.strings.get(value);
    if (buf) pushAscii(out, decodeScummString(buf));
  } else if (code === 0x08) {
    const name = vm.objectName(value) ?? vm.verbs.get(value)?.name;
    if (name) pushAscii(out, name);
  }
}

/**
 * Decode a SCUMM string into **sentence pages**, split at the `\xff\x03`
 * "wait" control code. The original engine shows the text up to a
 * `\xff\x03`, waits out its talk delay, then displays the next chunk —
 * MI1's dialog is full of these (e.g. "Yikes!\xff\x03Non dovresti…").
 * Each page is decoded like {@link decodeScummString} (`\xff\x01` →
 * newline; other control codes stripped). Empty pages are dropped.
 * A string with no `\xff\x03` yields a single page == decodeScummString.
 */
function decodeScummStringPages(payload: Uint8Array, vm?: Vm, slot?: ScriptSlot): string[] {
  const pages: number[][] = [[]];
  let i = 0;
  while (i < payload.length) {
    const b = payload[i]!;
    if (b === 0xff) {
      const code = payload[i + 1] ?? 0;
      if (code === 0x01) pages[pages.length - 1]!.push(0x0a); // newline
      else if (code === 0x03) pages.push([]); // wait → start a new page
      else if (code >= 0x04) expandSubstitution(code, payload, i, vm, slot, pages[pages.length - 1]!);
      // 0x02 (keep-text) is consumed + dropped.
      i += code >= 0x04 ? 4 : 2;
      continue;
    }
    pages[pages.length - 1]!.push(b);
    i++;
  }
  return pages.map((p) => String.fromCharCode(...p)).filter((p) => p.length > 0);
}

// ─── 0xCC  pseudoRoom ────────────────────────────────────────────────
// Register "pseudo-room" mappings — alias room numbers that share a
// real room's resources (used in MI1 for music-track selection).
// Layout: byte `id` (the real room), then a 0x00-terminated sequence
// of alias bytes. Each alias `j` with the high bit set maps pseudo
// room `j & 0x7F → id`; aliases without the high bit are ignored
// (matches the original's `_resourceMapper` fill). `enterRoom` reads
// the map to translate a requested id to its physical room.
register(0xcc, (vm, slot) => {
  const id = readU8(slot);
  const mapped: number[] = [];
  while (true) {
    const j = readU8(slot);
    if (j === 0) break;
    if (j >= 0x80) {
      const alias = j & 0x7f;
      vm.pseudoRooms.set(alias, id);
      mapped.push(alias);
    }
  }
  vm.annotate(`pseudoRoom realRoom=${id} aliases=[${mapped.join(',')}]`);
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
      // roomScroll: minX, maxX (both var-or-word) — the camera-centre
      // scroll bounds for this room. Each is floored at half-screen
      // (160) so the viewport never shows past a room edge.
      const a = readVarOrWord(subop, 1, slot, vm.vars);
      const b = readVarOrWord(subop, 2, slot, vm.vars);
      const min = Math.max(160, a);
      const max = Math.max(min, b);
      vm.roomScroll = { min, max };
      vm.annotate(`roomOps roomScroll min=${min} max=${max}`);
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
      // byte for the slot arg (param mode for `d`). Writes directly
      // into the live room CLUT so the compositor picks it up next
      // frame; a no-op when no room is loaded. The CLUT is re-decoded
      // on the next room load, so this mutation is correctly transient.
      const r = readVarOrWord(subop, 1, slot, vm.vars);
      const g = readVarOrWord(subop, 2, slot, vm.vars);
      const b = readVarOrWord(subop, 3, slot, vm.vars);
      const sub2 = readU8(slot);
      const idx = readVarOrByte(sub2, 1, slot, vm.vars);
      const pal = vm.loadedRoom?.palette;
      if (pal && idx >= 0 && idx < 256) {
        pal[idx * 3] = r & 0xff;
        pal[idx * 3 + 1] = g & 0xff;
        pal[idx * 3 + 2] = b & 0xff;
      }
      vm.annotate(`roomOps setPalColor (${r},${g},${b}) → slot ${idx}`);
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
