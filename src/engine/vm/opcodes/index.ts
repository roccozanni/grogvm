/**
 * SCUMM v5 opcode handlers. Dispatch/encoding conventions:
 * pages/docs/scumm/opcodes.md; per-opcode layouts:
 * pages/docs/scumm/opcode-reference.md. Operand layouts must stay in
 * sync with disasm.ts.
 */

import {
  putActor as actorPut,
  setActorCostume as actorSetCostume,
  DEFAULT_SCALE,
  DEFAULT_WALK_FRAME,
  DEFAULT_STAND_FRAME,
  DEFAULT_INIT_FRAME,
  DEFAULT_TALK_START_FRAME,
  DEFAULT_TALK_STOP_FRAME,
  type Actor,
} from '../../actor/actor';
import { startWalk, startActorChore, applyStandPose, reapplyChoreForFacing, FACING_FROM_OLD, rescaleActorForPosition, effectiveBoxes } from '../../actor/walk';
import { clampPointToBoxes, findBoxAtOrNearest } from '../../pathfinding/boxes';
import { pickObject } from '../../object/hittest';
import { evalExpression } from '../expression';
import { SENTENCE_CLEAR_VERB } from '../sentence';
import { VAR_CURRENT_LIGHTS, VAR_CURSORSTATE, VAR_HAVE_MSG, VAR_LAST_SOUND, VAR_OVERRIDE, VAR_USERPUT, VAR_WALKTO_OBJ } from '../vars';
import {
  derefRead,
  formatRefLabel,
  isVarParam,
  readDestRef,
  readI16,
  readU8,
  readU16,
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
 * Actor id 0 is the SCUMM ego shorthand — resolved via VAR_EGO.
 * Null for out-of-range or still-unresolved ids (pre-boot VAR_EGO=0).
 */
function actorOrNull(vm: Vm, id: number): Actor | null {
  let resolved = id;
  if (resolved === 0) resolved = vm.vars.readGlobal(VAR_EGO);
  if (resolved <= 0) return null;
  if (resolved > vm.actors.capacity) return null;
  return vm.actors.get(resolved);
}

const VAR_EGO = 1;

const handlers = new Map<number, OpcodeHandler>();

function register(opcode: number, handler: OpcodeHandler): void {
  if (handlers.has(opcode)) {
    throw new Error(`opcode 0x${opcode.toString(16)} registered twice`);
  }
  handlers.set(opcode, handler);
}

// ─── 0x00  stopObjectCode ────────────────────────────────────────────
register(0x00, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0xA0  stopObjectCode (alias) ────────────────────────────────────
register(0xa0, (vm, slot) => {
  vm.annotate('stopObjectCode');
  slot.kill();
});

// ─── 0x80  breakHere ─────────────────────────────────────────────────
register(0x80, (vm, slot) => {
  vm.annotate('breakHere');
  slot.yield_();
});

// ─── 0x18  jumpRelative ──────────────────────────────────────────────
register(0x18, (vm, slot) => {
  const delta = readI16(slot);
  slot.pc += delta;
  vm.annotate(`jump ${delta >= 0 ? '+' : ''}${delta}`);
});

// ─── 0x1A  setVar ────────────────────────────────────────────────────
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

// ─── 0x1B / 0x9B  multiply  ·  0x5B / 0xDB  divide ───────────────────
// Arithmetic matches the expression mini-VM: signed 32-bit multiply,
// truncating division, loud halt on divide-by-zero.
function makeMulDiv(op: 'mul' | 'div', label: string): OpcodeHandler {
  return (vm, slot, opcode) => {
    const dest = readDestRef(slot, vm.vars);
    const operand = readValue(slot, vm.vars, isVarParam(opcode, 1));
    const cur = derefRead(dest, slot, vm.vars);
    let result: number;
    if (op === 'mul') {
      result = Math.imul(cur, operand);
    } else {
      if (operand === 0) throw new Error(`${label}: divide by zero`);
      result = (cur / operand) | 0;
    }
    writeRef(dest, result, slot, vm.vars);
    vm.annotate(`${label} 0x${dest.toString(16)} ${op === 'mul' ? '*=' : '/='} ${operand}`);
  };
}
register(0x1b, makeMulDiv('mul', 'multiply'));
register(0x9b, makeMulDiv('mul', 'multiply'));
register(0x5b, makeMulDiv('div', 'divide'));
register(0xdb, makeMulDiv('div', 'divide'));

// ─── 0x3F / 0x7F / 0xBF / 0xFF  drawBox ──────────────────────────────
// Fills persist in vm.drawnBoxes (re-applied each frame, cleared on room
// change) — SCUMM paints the virtual screen, which persists until the
// next room redraw.
function drawBoxHandler(vm: Vm, slot: ScriptSlot): void {
  const left = readU16(slot);
  const top = readU16(slot);
  const modeByte = readU8(slot);
  const right = readU16(slot);
  const bottom = readU16(slot);
  const color = readVarOrByte(modeByte, 1, slot, vm.vars);
  vm.drawnBoxes.push({ left, top, right, bottom, color });
  vm.annotate(`drawBox (${left},${top})-(${right},${bottom}) color=${color}`);
}
register(0x3f, drawBoxHandler);
register(0x7f, drawBoxHandler);
register(0xbf, drawBoxHandler);
register(0xff, drawBoxHandler);

// ─── Conditional branches ───────────────────────────────────────────
// `unless (value OP var) goto target` (opcodes.md §3): operands arrive
// var-then-value and the jump fires when the condition is FALSE — the
// inverted predicates below are correct.

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

register(0x48, makeJumpIf('isEqual', (a, b) => a !== b));
register(0xc8, makeJumpIf('isEqual', (a, b) => a !== b));

register(0x08, makeJumpIf('isNotEqual', (a, b) => a === b));
register(0x88, makeJumpIf('isNotEqual', (a, b) => a === b));

register(0x04, makeJumpIf('isGE', (a, b) => a > b));
register(0x84, makeJumpIf('isGE', (a, b) => a > b));

register(0x44, makeJumpIf('isLess', (a, b) => a <= b));
register(0xc4, makeJumpIf('isLess', (a, b) => a <= b));

register(0x78, makeJumpIf('isGreater', (a, b) => a >= b));
register(0xf8, makeJumpIf('isGreater', (a, b) => a >= b));

register(0x38, makeJumpIf('isLE', (a, b) => a < b));
register(0xb8, makeJumpIf('isLE', (a, b) => a < b));

// ─── 0x28  equalZero / 0xA8  notEqualZero ────────────────────────────
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
// Class values share actorSetClass's encoding (low 7 bits = class,
// bit 0x80 = polarity). Class N occupies bit N-1 of the mask (1-based).
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
function makeSetVarRange(asWord: boolean): OpcodeHandler {
  return (vm, slot) => {
    const dest = readDestRef(slot, vm.vars);
    const count = readU8(slot);
    for (let i = 0; i < count; i++) {
      const v = asWord ? readI16(slot) : readU8(slot);
      writeRef(dest + i, v, slot, vm.vars);
    }
    vm.annotate(`setVarRange dest=0x${dest.toString(16)} count=${count}`);
  };
}
register(0x26, makeSetVarRange(false));
register(0xa6, makeSetVarRange(true));

// ─── 0x2C  cursorCommand ─────────────────────────────────────────────
register(0x2c, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  // Cursor/userput are COUNTERS (o5_cursorCommand): hard on/off set 1/0,
  // the soft variants nest via ++/-- ; both are mirrored into
  // VAR_CURSORSTATE / VAR_USERPUT after the switch (the original's
  // version >= 4 tail).
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
    case 0x0a:
    case 0x0b:
    case 0x0c:
      throw new Error(
        `cursorCommand: cursor-image subop 0x${action.toString(16).padStart(2, '0')} not implemented (no MI1 use)`,
      );
    case 0x0d: {
      const charset = readVarOrByte(subop, 1, slot, vm.vars);
      vm.currentCharset = charset;
      vm.annotate(`cursorCommand initCharset charset=${charset}`);
      break;
    }
    case 0x0e: {
      // charsetColor → SCUMM's _charsetColorMap: the text renderer maps
      // glyph pixel values through it (see pages/docs/scumm/char.md).
      const colors = readWordVararg(slot, vm.vars);
      vm.charsetColorMap = colors;
      vm.annotate(`cursorCommand charsetColor [${colors.join(',')}]`);
      break;
    }
    default:
      throw new Error(
        `cursorCommand: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${subop.toString(16)})`,
      );
  }
  vm.vars.writeGlobal(VAR_CURSORSTATE, vm.cursor.state);
  vm.vars.writeGlobal(VAR_USERPUT, vm.cursor.userput);
});

// ─── 0x98  systemOps ─────────────────────────────────────────────────
// Recorded as vm.systemRequest rather than acted on — a script-issued
// restart/quit must not kill the inspector; the shell decides.
register(0x98, (vm, slot) => {
  const sub = readU8(slot);
  const request = sub === 1 ? 'restart' : sub === 2 ? 'pause' : sub === 3 ? 'quit' : null;
  if (request) vm.systemRequest = request;
  vm.annotate(`systemOps ${request ?? `subop=0x${sub.toString(16)}`}`);
});

// ─── 0x12 / 0x92  panCameraTo ────────────────────────────────────────
// ─── 0x32 / 0xB2  setCameraAt ────────────────────────────────────────
// Camera x is the CENTRE of the viewport — the visible slice is
// [x-160, x+160).
function panCameraToHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const v = readVarOrWord(opcode, 1, slot, vm.vars);
  // panCameraTo detaches actor-follow — otherwise moveCameraFollow
  // re-snaps every frame; room 64's dig cutscene re-engages it with an
  // explicit actorFollowCamera at the end.
  vm.cameraFollowActor = 0;
  vm.cameraDest = vm.clampCameraX(v);
  vm.annotate(`panCameraTo ${v} → dest=${vm.cameraDest}`);
}

function setCameraAtHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const v = readVarOrWord(opcode, 1, slot, vm.vars);
  vm.cameraDest = null; // an explicit snap cancels any in-progress pan
  vm.moveCameraTo(vm.clampCameraX(v));
  vm.annotate(`setCameraAt ${v} → camera.x=${vm.camera.x}`);
}
register(0x12, panCameraToHandler);
register(0x92, panCameraToHandler);
register(0x32, setCameraAtHandler);
register(0xb2, setCameraAtHandler);

// ─── 0x52 / 0xD2  actorFollowCamera ──────────────────────────────────
// Following an actor in a DIFFERENT room switches rooms (SCUMM
// startScene) — this is how MI1's boot enters the opening lookout.
function actorFollowCameraHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    if (actor.room > 0 && actor.room !== vm.currentRoom) {
      vm.enterRoom(actor.room);
    }
    // Snap now, then track per tick; re-engaging cancels a scripted pan.
    vm.cameraFollowActor = actor.id;
    vm.cameraDest = null;
    vm.moveCameraTo(vm.clampCameraX(actor.x));
  }
  vm.annotate(`actorFollowCamera ${id} → room=${vm.currentRoom} camera.x=${vm.camera.x}`);
}
register(0x52, actorFollowCameraHandler);
register(0xd2, actorFollowCameraHandler);

// ─── 0x1C / 0x9C  startSound ─────────────────────────────────────────
// ─── 0x3C / 0xBC  stopSound ──────────────────────────────────────────
// ─── 0x02 / 0x82  startMusic ─────────────────────────────────────────
// ─── 0x20         stopMusic  (no params) ─────────────────────────────
// Routed through the audio timing backend — see pages/docs/scumm/sound.md.
function startSoundHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  vm.audio.startSound(id, vm.getSoundResource(id));
  vm.vars.writeGlobal(VAR_LAST_SOUND, id);
  vm.annotate(`startSound ${id}`);
}
function stopSoundHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  vm.audio.stopSound(id);
  vm.annotate(`stopSound ${id}`);
}
register(0x1c, startSoundHandler);
register(0x9c, startSoundHandler);
register(0x3c, stopSoundHandler);
register(0xbc, stopSoundHandler);

// ─── 0x7C / 0xFC  isSoundRunning ─────────────────────────────────────
// Timing authority for script busy-wait pacing — see
// pages/docs/scumm/sound.md (a constant 0 collapses cutscene holds).
function isSoundRunningHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const sound = readVarOrByte(opcode, 1, slot, vm.vars);
  const running = vm.audio.isRunning(sound) ? 1 : 0;
  writeRef(dest, running, slot, vm.vars);
  vm.annotate(`isSoundRunning ${sound} → ${running}`);
}
register(0x7c, isSoundRunningHandler);
register(0xfc, isSoundRunningHandler);

// ─── 0x62 / 0xE2  stopScript ─────────────────────────────────────────
// Script 0 stops the CURRENT script (o5_stopScript) — NOT a no-op; #4's
// sentence-line guard relies on aborting itself here.
function stopScriptHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const scriptId = readVarOrByte(opcode, 1, slot, vm.vars);
  if (scriptId === 0) {
    slot.kill();
    vm.annotate('stopScript #0 (self)');
    return;
  }
  for (const s of vm.slots) {
    if (s.status !== 'dead' && s.scriptId === scriptId) s.kill();
  }
  vm.annotate(`stopScript #${scriptId}`);
}
register(0x62, stopScriptHandler);
register(0xe2, stopScriptHandler);

// ─── 0x30  matrixOp ──────────────────────────────────────────────────
// createBoxMatrix is a no-op (the walkable mask is rebuilt on every
// setBoxFlags); setBoxScale halts loudly — no MI1 use, box scale comes
// from the SCAL slots at load.
function matrixOpHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const sub = readU8(slot);
  if (sub === 0x04) {
    vm.annotate('matrixOp createBoxMatrix (no-op — mask rebuilt on setBoxFlags)');
    return;
  }
  const box = readVarOrByte(sub, 1, slot, vm.vars);
  const val = readVarOrByte(sub, 2, slot, vm.vars);
  const action = sub & 0x1f;
  if (action === 0x01) {
    vm.setBoxFlags(box, val);
    vm.annotate(`matrixOp setBoxFlags box=${box} flags=0x${val.toString(16)}`);
    return;
  }
  throw new Error(
    `matrixOp: subop 0x${action.toString(16).padStart(2, '0')} (setBoxScale) not implemented (no MI1 use)`,
  );
}
register(0x30, matrixOpHandler);
function startMusicHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  vm.audio.startMusic(id, vm.getSoundResource(id));
  vm.vars.writeGlobal(VAR_LAST_SOUND, id);
  vm.annotate(`startMusic ${id}`);
}
register(0x02, startMusicHandler);
register(0x82, startMusicHandler);
register(0x20, (vm) => {
  vm.audio.stopMusic();
  vm.annotate('stopMusic');
});

// ─── 0x4C  soundKludge ───────────────────────────────────────────────
// Zero MI1 uses — registered only so the halt names the opcode.
register(0x4c, () => {
  throw new Error('soundKludge (0x4C) not implemented (no MI1 use; audio is Phase 9)');
});

// ─── 0x72 / 0xF2  loadRoom ───────────────────────────────────────────
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
// arg3 = 0 → arg1 becomes VAR_CURRENT_LIGHTS; non-zero = flashlight
// variant (not modelled — operands still consumed so the stream stays
// aligned). See pages/docs/scumm/lighting.md.
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
    vm.annotate(`lights flashlight w=${arg2} mode=${arg3}`);
  }
}

// ─── 0x14 / 0x94 / 0xD8  print / printEgo ────────────────────────────

// Reads to the 0x00 terminator, consuming `0xFF NN` escapes — codes >= 4
// carry a 2-byte arg that may itself contain 0x00, so a naive scan
// truncates. The length rule must match decodeScummString exactly.
function readScummString(slot: ScriptSlot): Uint8Array {
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
      if (code >= 4) slot.pc += 2;
      continue;
    }
    slot.pc++;
  }
  throw new Error('SCUMM string: missing 0x00 terminator');
}

/** Developer debug-print channel — suppressed on screen; real narrator
 *  text is actor 255 (see pages/docs/scumm/char.md). */
const DEBUG_PRINT_ACTOR = 253;

function printHandler(actor: number, vm: Vm, slot: ScriptSlot): void {
  const ops: string[] = [];
  // A real speaker with no explicit SO_AT/SO_COLOR is actor talk: default
  // to the actor's talk color, centred above the actor (SCUMM talk default).
  const speaker = actorOrNull(vm, actor);
  const speakerId = actor === 0 ? vm.vars.readGlobal(VAR_EGO) : actor;
  // Debug prints still parse subops/text (to advance the PC) but never
  // render — see pages/docs/scumm/char.md on actor 253.
  const isDebug = actor === DEBUG_PRINT_ACTOR;
  // System prints (no speaker) inherit the sticky _string[0] state so a
  // bare `print` reuses the last position/colour/centre — the MI1 credits
  // depend on this. Actor talk starts fresh.
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
        // SO_AT also clears overhead — an explicit anchor overrides
        // "above the actor" (SCUMM).
        atX = readVarOrWord(sub, 1, slot, vm.vars);
        atY = readVarOrWord(sub, 2, slot, vm.vars);
        overhead = false;
        ops.push(`at(${atX},${atY})`);
        break;
      }
      case 0x01: {
        color = readVarOrByte(sub, 1, slot, vm.vars);
        colorSet = true;
        ops.push(`color(${color})`);
        break;
      }
      case 0x02: {
        clipped = readVarOrWord(sub, 1, slot, vm.vars);
        ops.push(`clipped(${clipped})`);
        break;
      }
      case 0x04:
        center = true;
        ops.push('center');
        break;
      case 0x06:
        center = false;
        ops.push('left');
        break;
      case 0x07:
        overhead = true;
        ops.push('overhead');
        break;
      case 0x08: {
        // SO_SAY_VOICE — one word arg (CD voice id); consumed, no output.
        const a = readVarOrWord(sub, 1, slot, vm.vars);
        ops.push(`voice(${a})`);
        break;
      }
      case 0x0f: {
        const buf = readScummString(slot);
        if (isDebug) return;
        // Pages split at \xff\x03: the first shows now, the rest queue on
        // the talk timer. keepText (\xff\x02) persists past the timer.
        const { pages, keepText } = decodeScummStringPages(buf, vm, slot);
        const text = pages[0] ?? '';
        const preview = Array.from(buf)
          .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
          .join('');
        // Persist the sticky state even for an empty (= "clear") print —
        // a 0-byte clear still leaves position/colour set for what follows.
        if (isSystem) {
          st.x = atX;
          st.y = atY;
          st.color = color;
          st.colorSet = colorSet;
          st.center = center;
          st.overhead = overhead;
          st.clipped = clipped;
        }
        // System prints go to the persistent systemText slot, actor talk
        // to the transient activeDialog — both can be on screen at once.
        // Empty string = dismiss the previous bubble.
        if (text.length === 0) {
          if (isSystem) vm.clearSystemText();
          else vm.activeDialog = null;
          vm.endTalk();
        } else {
          const isTalk = speaker !== null && atX === null;
          // Talk ink resolves LIVE at render time (colorFromActor) — a
          // helper script may set talkColor after this print.
          const colorFromActor = !colorSet && speaker !== null;
          const dlg = {
            actorId: speakerId,
            text,
            x: atX,
            y: atY,
            color: colorSet ? color : (speaker?.talkColor ?? color),
            colorFromActor,
            center: center || isTalk,
            overhead: overhead || isTalk,
            clipped,
            keepText,
          };
          if (isSystem) vm.addSystemText(dlg);
          else vm.activeDialog = dlg;
          // Mark the message "being said" so wait-for-message holds.
          vm.beginTalk(text);
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
  // Configure-only print (no text subop) — the MI1 credits prime the
  // sticky state this way, so persist it on this path too.
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
  printHandler(0, vm, slot);
});

// ─── 0x58  beginOverride / endOverride ───────────────────────────────
// begin (flag=1) must consume its embedded jump bytes (0x18 + i16 delta)
// itself — dispatching them as a real jump would unconditionally skip
// the cutscene body. ESC machinery: pages/docs/scumm/cutscenes.md.
register(0x58, (vm, slot) => {
  const flag = readU8(slot);
  if (flag !== 0) {
    const jumpOp = readU8(slot);
    const delta = readI16(slot);
    const overrideTarget = slot.pc + delta;
    slot.overridePc = overrideTarget;
    vm.vars.writeGlobal(VAR_OVERRIDE, 0);
    vm.annotate(`beginOverride target=0x${overrideTarget.toString(16)} (op=0x${jumpOp.toString(16)})`);
  } else {
    slot.overridePc = null;
    vm.annotate('endOverride');
  }
});

// ─── 0x40  cutscene / 0xC0  endCutscene ──────────────────────────────
// See pages/docs/scumm/cutscenes.md for the bracket machinery.
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
// Result ∈ [0, max] INCLUSIVE; entropy is injectable via vm.randomInt
// (seeded under test for reproducible playthroughs).
function getRandomNrHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const max = readVarOrByte(opcode, 1, slot, vm.vars);
  const v = vm.randomInt(max);
  writeRef(dest, v, slot, vm.vars);
  vm.annotate(`getRandomNumber max=${max} → ${v}`);
}
register(0x16, getRandomNrHandler);
register(0x96, getRandomNrHandler);

// ─── 0x07 / 0x47 / 0x87 / 0xC7  setState ─────────────────────────────
// Mirrors SCUMM's putState + mark-dirty: queue the object for redraw
// (pages/docs/scumm/objects.md §7).
function setStateHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const state = readVarOrByte(opcode, 2, slot, vm.vars);
  vm.objectStates.set(obj, state);
  if (vm.loadedRoom?.objects.has(obj)) vm.objectDrawQueue.add(obj);
  vm.annotate(`setState obj=${obj} state=${state}`);
}
register(0x07, setStateHandler);
register(0x47, setStateHandler);
register(0x87, setStateHandler);
register(0xc7, setStateHandler);

// ─── 0x0F / 0x8F  getObjectState ─────────────────────────────────────
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
// Room objects with no explicit owner read 15 (OF_OWNER_ROOM) — see
// pages/docs/scumm/objects.md §7a.
function getObjectOwnerHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const owner = vm.getObjectOwner(obj);
  writeRef(dest, owner, slot, vm.vars);
  vm.annotate(`getObjectOwner obj=${obj} → ${owner}`);
}
register(0x10, getObjectOwnerHandler);
register(0x90, getObjectOwnerHandler);

// ─── 0x0B / 0x4B / 0x8B / 0xCB  getVerbEntryPoint ────────────────────
// Returns 1/0, not a real offset (we keep per-verb bytecode slices;
// callers only test truthiness). Must match the exact verb OR the 0xFF
// default-verb entry — room exits depend on it (opcode-reference.md).
function getVerbEntryPointHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const verb = readVarOrWord(opcode, 2, slot, vm.vars);
  // findObjectCode (not loadedRoom) so carried inventory items answer
  // too — inventory script #9 gates `startObject item 91` on this.
  const verbs = vm.findObjectCode(obj)?.verbs;
  const has = verbs ? (verbs.has(verb) || verbs.has(0xff)) : false;
  const entry = has ? 1 : 0;
  writeRef(dest, entry, slot, vm.vars);
  vm.annotate(`getVerbEntryPoint obj=${obj} verb=${verb} → ${entry}`);
}
for (const op of [0x0b, 0x4b, 0x8b, 0xcb]) register(op, getVerbEntryPointHandler);

// ─── 0xAB  saveRestoreVerbs ──────────────────────────────────────────
// `mode` (the original's per-save id) is deliberately unused — MI1's
// save/restore are range-symmetric and savedVerbStates is keyed by
// verb id.
function saveRestoreVerbsHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const sub = readU8(slot);
  const start = readVarOrByte(sub, 1, slot, vm.vars);
  const end = readVarOrByte(sub, 2, slot, vm.vars);
  const mode = readVarOrByte(sub, 3, slot, vm.vars);
  const action = sub & 0x1f;
  for (const verb of vm.verbs.values()) {
    if (verb.id < start || verb.id > end) continue;
    if (action === 0x01) {
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
// Value encoding per opcode-reference.md; class N occupies bit N-1 of
// the mask (classes are 1-based).
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

// ─── 0x05 / 0x85  drawObject ─────────────────────────────────────────
// Exactly ONE subop byte — NOT a 0xFF-terminated list (opcodes.md §5).
// Owns only 0x05/0x85: 0x25/0x65/0xA5/0xE5 are pickupObject.
function drawObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  // Always sets the object's state (1 unless SO_IMAGE overrides) — its
  // job is to make the object visible (objects.md "drawObject always
  // sets state"; room 58's reveals depend on the flip from 0).
  const ops: string[] = [];
  let state = 1;
  const sub = readU8(slot);
  switch (sub & 0x1f) {
    case 0x01: {
      const x = readVarOrWord(sub, 1, slot, vm.vars);
      const y = readVarOrWord(sub, 2, slot, vm.vars);
      // SO_AT operands are STRIP units on BOTH axes → (x*8, y*8); room
      // 58's vertical forest tiling breaks if y is read as pixels
      // (objects.md §7).
      vm.objectDrawPositions.set(obj, { x: x * 8, y: y * 8 });
      ops.push(`at(${x * 8},${y * 8})`);
      break;
    }
    case 0x02: {
      // setImage(0) = "hide"; anything else selects IMxx where xx == state.
      state = readVarOrWord(sub, 1, slot, vm.vars);
      ops.push(`setImage(${state})`);
      break;
    }
    default:
      // Bare redraw — shows state 1 (set below).
      ops.push('draw');
      break;
  }
  vm.objectStates.set(obj, state);
  // Same-box eviction emulates SCUMM's strip overwrite (our queue is
  // retained-mode — objects.md). Eviction must ALSO revert the overdrawn
  // object's state to 0: room 31's rat-hole loop (#207) re-picks among
  // state-0 frames and spins forever without the reset.
  const drawn = vm.loadedRoom?.objects.get(obj);
  if (drawn) {
    // Compare effective (SO_AT-overridden) boxes — forest tiles share an
    // IMHD origin, so an IMHD-only match would evict repositioned siblings.
    const box = (id: number, imhd: { x: number; y: number; width: number; height: number }) => {
      const p = vm.objectDrawPositions.get(id);
      return { x: p?.x ?? imhd.x, y: p?.y ?? imhd.y, width: imhd.width, height: imhd.height };
    };
    const b = box(obj, drawn.imhd);
    for (const otherId of [...vm.objectDrawQueue]) {
      if (otherId === obj) continue;
      const other = vm.loadedRoom?.objects.get(otherId);
      if (!other) continue;
      const o = box(otherId, other.imhd);
      if (o.x === b.x && o.y === b.y && o.width === b.width && o.height === b.height) {
        vm.objectDrawQueue.delete(otherId);
        vm.objectStates.set(otherId, 0);
      }
    }
  }
  // Re-insert at the end so the freshest frame draws last (on top).
  vm.objectDrawQueue.delete(obj);
  vm.objectDrawQueue.add(obj);
  vm.annotate(`drawObject obj=${obj} [${ops.join(',')}]`);
}
register(0x05, drawObjectHandler);
register(0x85, drawObjectHandler);

// ─── 0x25 / 0x65 / 0xa5 / 0xe5  pickupObject ─────────────────────────
// Four steps, all required (objects.md "pickupObject is four steps"):
// own to ego, state 1 + DRAW (the state-1 image is the eraser patch over
// the baked-in room item), mark Untouchable, refresh inventory.
// `room == 0` means the current room.
function pickupObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const ego = vm.vars.readGlobal(VAR_EGO);
  // Snapshot the name BEFORE the object leaves its room context.
  vm.captureInventoryName(obj, room);
  vm.objectOwners.set(obj, ego);
  vm.objectStates.set(obj, 1);
  vm.objectClasses.set(obj, ((vm.objectClasses.get(obj) ?? 0) | (1 << 31)) >>> 0);
  vm.objectDrawQueue.add(obj);
  vm.runInventoryScript(1);
  vm.annotate(`pickupObject obj=${obj} room=${room} → owner ${ego}`);
}
for (const op of [0x25, 0x65, 0xa5, 0xe5]) register(op, pickupObjectHandler);

// ─── 0x35 / 0x75 / 0xb5 / 0xf5  findObject ───────────────────────────
// Returns 0 when no room is loaded (original behaviour) — #23 polls
// clicks in the post-credits room-0 state.
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
      // Untouchable class (32, bit 31) → not hit-testable (objects.md §7a).
      isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
      // The hotspot follows a SO_AT reposition (objects.md §7).
      getObjectPosition: (id) => vm.objectDrawPositions.get(id),
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
// SCUMM's Chebyshev metric max(|dx|, |dy|); an unresolvable id yields
// 0xFF ("far").
function objActPos(vm: Vm, id: number): { x: number; y: number } | null {
  if (id > 0 && id <= vm.actors.capacity) {
    const a = vm.actors.get(id);
    return { x: a.x, y: a.y };
  }
  // A held item resolves to its HOLDER's position (SCUMM WIO_INVENTORY,
  // objects.md) — getDist(ego, heldItem) must be 0. Owner codes ≥ the
  // actor table (e.g. OF_OWNER_ROOM 15) aren't actors → room branch.
  const owner = vm.getObjectOwner(id);
  if (owner >= 1 && owner <= vm.actors.capacity) {
    const holder = vm.actors.get(owner);
    return holder.room === vm.currentRoom ? { x: holder.x, y: holder.y } : null;
  }
  const obj = vm.loadedRoom?.objects.get(id);
  if (!obj) return null;
  // The WALK-TO point, not the image top-left, shifted by any SO_AT
  // displacement — must mirror walkActorToObject (objects.md "Distance
  // uses the walk-to point").
  const pos = vm.objectDrawPositions.get(id);
  return {
    x: obj.cdhd.walkX + (pos ? pos.x - obj.imhd.x : 0),
    y: obj.cdhd.walkY + (pos ? pos.y - obj.imhd.y : 0),
  };
}
function getDistHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const a = readVarOrWord(opcode, 1, slot, vm.vars);
  const b = readVarOrWord(opcode, 2, slot, vm.vars);
  let pa = objActPos(vm, a);
  let pb = objActPos(vm, b);
  // Mirror getObjActToObjActDist: clamp the OBJECT's point into the boxes
  // the ACTOR can stand in, so a gate to an object in a locked box passes
  // once the ego is as close as the open boxes allow (room 36 guard dogs).
  const room = vm.loadedRoom;
  if (room && pa && pb) {
    const eff = effectiveBoxes(vm, room.walkBoxes);
    const aIsActor = a > 0 && a <= vm.actors.capacity;
    const bIsActor = b > 0 && b <= vm.actors.capacity;
    if (aIsActor && !bIsActor) pb = clampPointToBoxes(eff, pb.x, pb.y);
    else if (bIsActor && !aIsActor) pa = clampPointToBoxes(eff, pa.x, pa.y);
  }
  const dist =
    pa && pb ? Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y)) : 0xff;
  writeRef(dest, dist, slot, vm.vars);
  vm.annotate(`getDist ${a},${b} → ${dist}`);
}
for (const op of [0x34, 0x74, 0xb4, 0xf4]) register(op, getDistHandler);

// ─── 0x15 / 0x55 / 0x95 / 0xd5  actorFromPos ─────────────────────────
// Hit-tests each actor's last-drawn bounds (vm.actorFromPos — SCUMM's
// gfx-usage-bit equivalent); 0 when none.
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
// `index` is 1-based, in pickup order; 0 when out of range.
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

// ─── getActor* read family ───────────────────────────────────────────
// Bits 5-6 SELECT the operation (non-orthogonal — opcodes.md §1).
// Invalid actor ids write 0 (the original's "no actor" fallback).
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
// getActorFacing returns the old-direction integer (0=W 1=E 2=S 3=N),
// NOT an angle — scripts feed it into animateActor's 244-251 direction
// pseudo-anims (e.g. #35's `animateActor (getActorFacing(ego)+248)`).
register(0x63, makeActorReadOp('getActorFacing', (a) => FACING_FROM_OLD.indexOf(a.facing)));
register(0xe3, makeActorReadOp('getActorFacing', (a) => FACING_FROM_OLD.indexOf(a.facing)));
register(0x71, makeActorReadOp('getActorCostume', (a) => a.costume));
register(0xf1, makeActorReadOp('getActorCostume', (a) => a.costume));
register(0x6c, makeActorReadOp('getActorWidth', (a) => a.width));
register(0xec, makeActorReadOp('getActorWidth', (a) => a.width));
// getActorWalkBox (0x7B/0xFB) — must be real, not a stub: room 29's
// reveal (#200) loops `while (getActorWalkBox(ego) < 5)`; a constant 0
// hangs it and the entry cover never lifts.
function getActorWalkBoxHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const dest = readDestRef(slot, vm.vars);
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  const boxes = vm.loadedRoom?.walkBoxes ?? [];
  // Prefer the stored _walkbox (SCUMM getActorWalkbox); position lookup
  // only when unassigned, so a never-placed actor still yields a real box.
  const box =
    actor && actor.walkBox >= 0
      ? (boxes.find((b) => b.id === actor.walkBox) ?? null)
      : actor
        ? findBoxAtOrNearest(boxes, actor.x, actor.y)
        : null;
  const value = box ? box.id : 0;
  writeRef(dest, value, slot, vm.vars);
  vm.annotate(`getActorWalkBox actor=${id} → ${value}`);
}
register(0x7b, getActorWalkBoxHandler);
register(0xfb, getActorWalkBoxHandler);

// getActorMoving (0x56/0xD6) — scripts only test zero/non-zero, so
// 1-while-walking / 0-at-rest is faithful to SCUMM's _moving mask.
register(0x56, makeActorReadOp('getActorMoving', (a) => (a.isMoving ? 1 : 0)));
register(0xd6, makeActorReadOp('getActorMoving', (a) => (a.isMoving ? 1 : 0)));

// ─── walkActorToActor (0x0D/0x4D/0x8D/0xCD) ──────────────────────────
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

// ─── putActorInRoom (0x2D/0x6D/0xAD/0xED) ────────────────────────────
// Assigns the room only — does NOT load it (the load happens when the
// camera follows the actor, or via loadRoom).
function putActorInRoomHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) actor.room = room;
  vm.annotate(`putActorInRoom actor=${id} room=${room}`);
}
for (const op of [0x2d, 0x6d, 0xad, 0xed]) register(op, putActorInRoomHandler);

// ─── putActorAtObject (0x0E / 0x4E / 0x8E / 0xCE) ─────────────────────
// Snap (no walk) onto the object's walk-to point, keeping the actor's
// room; (240,120) is o5_putActorAtObject's object-not-found fallback.
function putActorAtObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const objId = readVarOrWord(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    const walk = objectWalkPoint(vm, objId);
    const x = walk ? walk.x : 240;
    const y = walk ? walk.y : 120;
    actorPut(actor, x, y, actor.room);
    // Rescale now so a just-placed idle actor renders at floor scale
    // immediately, not one stale frame later.
    rescaleActorForPosition(vm, actor);
  }
  vm.annotate(`putActorAtObject actor=${id} obj=${objId}`);
}
for (const op of [0x0e, 0x4e, 0x8e, 0xce]) register(op, putActorAtObjectHandler);

// ─── 0x1E / 0x3E / 0x5E / 0x7E / 0x9E / 0xBE / 0xDE / 0xFE  walkActorTo ─
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
function walkToObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const objId = readVarOrWord(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  const target = objActPos(vm, objId);
  if (actor && target) {
    startWalk(vm, actor, target);
  }
  vm.annotate(`walkActorToObject actor=${id} obj=${objId}`);
}
for (const op of [0x36, 0x76, 0xb6, 0xf6]) register(op, walkToObjectHandler);

// ─── faceActor (0x09/0x49/0x89/0xC9) ─────────────────────────────────
// Low5=0x09 is shared with setOwnerOf (0x29) — bit 0x20 selects.
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
        const pos = vm.objectDrawPositions.get(targetId);
        tx = obj.cdhd.x * 8 + (pos ? pos.x - obj.imhd.x : 0);
        ty = obj.cdhd.y * 8 + (pos ? pos.y - obj.imhd.y : 0);
      }
    }
    if (tx !== null) {
      const dx = tx - actor.x;
      const dy = ty - actor.y;
      actor.facing =
        Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'S' : 'N';
      // Turn in place only when idle — a walking actor's pose is walk-driven.
      if (!actor.isMoving) applyStandPose(vm, actor);
    }
  }
  vm.annotate(`faceActor actor=${id} target=${targetId}`);
}
for (const op of [0x09, 0x49, 0x89, 0xc9]) register(op, faceActorHandler);

// ─── setOwnerOf (0x29/0x69/0xA9/0xE9) ────────────────────────────────
function setOwnerOfHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const owner = readVarOrByte(opcode, 2, slot, vm.vars);
  // Grab the name now, while the room owning its OBNA is still resolvable.
  if (owner !== 0) vm.captureInventoryName(obj, 0);
  vm.objectOwners.set(obj, owner);
  vm.annotate(`setOwnerOf obj=${obj} owner=${owner}`);
}
for (const op of [0x29, 0x69, 0xa9, 0xe9]) register(op, setOwnerOfHandler);

// ─── setObjectName (0x54/0xD4) ───────────────────────────────────────
// The name is a NUL-terminated SCUMM string — must be consumed via
// readScummString or the next byte decodes as a bogus opcode.
function setObjectNameHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const obj = readVarOrWord(opcode, 1, slot, vm.vars);
  const name = decodeScummString(readScummString(slot), vm, slot);
  vm.setObjectName(obj, name);
  vm.annotate(`setObjectName obj=${obj} name="${name}"`);
}
for (const op of [0x54, 0xd4]) register(op, setObjectNameHandler);

// ─── startObject (0x37/0x77/0xB7/0xF7) ───────────────────────────────
// Runs the object's OBCD verb script NESTED, like startScript
// (opcodes.md §6) — the inventory icons rely on the ordering.
function startObjectHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const objId = readVarOrWord(opcode, 1, slot, vm.vars);
  const verbId = readVarOrByte(opcode, 2, slot, vm.vars);
  const args = readWordVararg(slot, vm.vars);
  const child = vm.startVerbScript(objId, verbId, args);
  if (child) vm.runScriptNested(child);
  vm.annotate(`startObject obj=${objId} script=${verbId} args=[${args.join(',')}]`);
}
for (const op of [0x37, 0x77, 0xb7, 0xf7]) register(op, startObjectHandler);

// Placement point for loadRoomWithEgo / putActorAtObject: the walk-to
// point clamped into the boxes (adjustXYToBeInBox) — placement is instant.
// walkActorToObject deliberately doesn't clamp; its pathfinder copes.
function objectWalkPoint(vm: Vm, objId: number): { x: number; y: number } | null {
  const target = objActPos(vm, objId);
  if (!target) return null;
  return clampPointToBoxes(vm.loadedRoom?.walkBoxes ?? [], target.x, target.y);
}

// ─── loadRoomWithEgo (0x24/0x64/0xA4/0xE4) ───────────────────────────
function loadRoomWithEgoHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const objId = readVarOrWord(opcode, 1, slot, vm.vars);
  const room = readVarOrByte(opcode, 2, slot, vm.vars);
  const x = readI16(slot);
  const y = readI16(slot);
  // VAR_WALKTO_OBJ = the entry object: the new room's ENCD branches on it
  // (room 58's maze fires its entry walk off it after the first
  // breakHere), so it must survive the room change.
  vm.vars.writeGlobal(VAR_WALKTO_OBJ, objId);
  vm.enterRoom(room);
  const ego = actorOrNull(vm, 0);
  if (ego) {
    ego.room = room;
    // Runs AFTER the ENCD's first slice (SO_AT has repositioned the entry
    // object) but BEFORE its post-breakHere entry walk.
    const walk = objectWalkPoint(vm, objId);
    if (walk) {
      ego.x = walk.x;
      ego.y = walk.y;
    }
    // Rescale so ego renders at floor scale on the first frame.
    rescaleActorForPosition(vm, ego);
    // x == -1 means no explicit walk — the ENCD's entry walk takes over.
    if (x !== -1) startWalk(vm, ego, { x, y });
    // o5_loadRoomWithEgo re-snaps and re-engages camera follow — without
    // it a wide room entered after a detaching panCameraTo stays pinned
    // at the old camera X.
    vm.cameraFollowActor = ego.id;
    vm.cameraDest = null;
    vm.moveCameraTo(vm.clampCameraX(ego.x));
  }
  vm.annotate(`loadRoomWithEgo obj=${objId} room=${room} (${x},${y})`);
}
register(0x24, loadRoomWithEgoHandler);
register(0x64, loadRoomWithEgoHandler);
register(0xa4, loadRoomWithEgoHandler);
register(0xe4, loadRoomWithEgoHandler);

// ─── 0x01 / 0x21 / 0x41 / 0x61 / 0x81 / 0xA1 / 0xC1 / 0xE1  putActor ─
// KEEPS the actor's existing room (o5_putActor) — boot does
// putActorInRoom(ego, 38) then putActor, and clobbering the room here
// breaks the lookout load.
function putActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const x = readVarOrWord(opcode, 2, slot, vm.vars);
  const y = readVarOrWord(opcode, 3, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (actor) {
    actorPut(actor, x, y, actor.room);
    // Rescale now so a just-placed idle actor renders at floor scale.
    rescaleActorForPosition(vm, actor);
  }
  vm.annotate(`putActor actor=${id} (${x},${y}) room=${actor?.room ?? 0}`);
}
for (const op of [0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1]) {
  register(op, putActorHandler);
}

// ─── 0x11 / 0x91  animateActor ───────────────────────────────────────
// Operand is a CHORE number; 244-255 are direction pseudo-anims that
// re-point the playing chore rather than switch it — see
// pages/docs/scumm/costume-anim.md.
function animateActorHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const id = readVarOrByte(opcode, 1, slot, vm.vars);
  const anim = readVarOrByte(opcode, 2, slot, vm.vars);
  const actor = actorOrNull(vm, id);
  if (!actor) {
    vm.annotate(`animateActor actor=${id} anim=${anim} (no actor)`);
    return;
  }
  if (anim >= 244) {
    // Pseudo-anim: direction in the low 2 bits, no frame data.
    actor.facing = FACING_FROM_OLD[anim & 3]!;
    if (anim >= 252) {
      // 252-255: stop walking, then stand facing the requested direction.
      actor.isMoving = false;
      actor.walkTarget = null;
      applyStandPose(vm, actor);
    } else if (!actor.isMoving) {
      // 244-251: re-point the playing chore to the new facing — don't
      // switch chores; a walking actor's chore is walk-loop-driven.
      reapplyChoreForFacing(vm, actor);
    }
  } else {
    // startActorChore no-ops without a loaded costume.
    startActorChore(vm, actor, anim);
  }
  vm.annotate(`animateActor actor=${id} anim=${anim}`);
}
// Low5=0x11 is shared: 0x31 getInventoryCount and 0x71/0xF1
// getActorCostume are different ops — animateActor owns 0x11/0x51/0x91/0xD1.
register(0x11, animateActorHandler);
register(0x51, animateActorHandler);
register(0x91, animateActorHandler);
register(0xd1, animateActorHandler);

// ─── 0x13 / 0x53 / 0x93 / 0xD3  actorOps ─────────────────────────────
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
        if (actor) {
          actorSetCostume(actor, c);
          // SCUMM starts the init chore on costume set — the default idle
          // until a script plays another chore; some inits are multi-frame
          // loops (SCUMM-Bar pirates), so skipping this freezes them.
          if (c > 0) startActorChore(vm, actor, actor.initFrame);
        }
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
        // setSound takes ONE var-or-byte arg, not two — room 64's #200
        // encodes `03 3b ff`; a second read swallows the 0xFF terminator.
        readVarOrByte(sub, 1, slot, vm.vars);
        ops.push('setSound');
        break;
      }
      case 0x04: {
        const f = readVarOrByte(sub, 1, slot, vm.vars);
        if (actor) actor.walkFrame = f;
        ops.push(`setWalkFrame(${f})`);
        break;
      }
      case 0x05: {
        const start = readVarOrByte(sub, 1, slot, vm.vars); // talk start
        const stop = readVarOrByte(sub, 2, slot, vm.vars); // talk stop
        if (actor) {
          actor.talkStartFrame = start;
          actor.talkStopFrame = stop;
        }
        ops.push(`setTalkFrame(${start},${stop})`);
        break;
      }
      case 0x06: {
        const f = readVarOrByte(sub, 1, slot, vm.vars); // stand frame
        if (actor) actor.standFrame = f;
        ops.push(`setStandFrame(${f})`);
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
        // SO_DEFAULT = initActor(0): clear state but keep id. Facing is
        // deliberately NOT reset — only the game-start initActor(1)
        // touches _facing; room 60's teaching machine sets facing E
        // before init and its costume only has side-view art.
        if (actor) {
          actor.costume = 0;
          actor.elevation = 0;
          actor.visible = true;
          actor.walkTarget = null;
          actor.walkPath = [];
          actor.walkPathIdx = 0;
          actor.isMoving = false;
          // initActor resets ignoreBoxes — this is what un-sticks the flag
          // after an ESC-skipped cutscene that never ran its own
          // followBoxes (a stuck flag freezes perspective scaling).
          actor.ignoreBoxes = false;
          // _walkbox → unassigned, so a reused slot doesn't carry a stale
          // box into the next scene (room-51 cannon actor).
          actor.walkBox = -1;
          actor.scale = DEFAULT_SCALE;
          // forceClip 0 = "not forced" — depth falls back to the NeverClip
          // class / box mask; a stale alwaysZclip would otherwise survive a
          // plain init (room-51 Fettucini brothers).
          actor.forceClip = 0;
          // SCUMM initActor chore-frame defaults.
          actor.walkFrame = DEFAULT_WALK_FRAME;
          actor.standFrame = DEFAULT_STAND_FRAME;
          actor.initFrame = DEFAULT_INIT_FRAME;
          actor.talkStartFrame = DEFAULT_TALK_START_FRAME;
          actor.talkStopFrame = DEFAULT_TALK_STOP_FRAME;
          // setActorCostume(0) resets anim state via the shared sentinel.
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
        // setDefaultAnim — no args; not modelled.
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
        // NUL-terminated SCUMM string — decode like setObjectName so 0xFF
        // escapes aren't mistaken for the terminator.
        const name = decodeScummString(readScummString(slot), vm, slot);
        if (actor) actor.name = name;
        ops.push(`setName(${JSON.stringify(name)})`);
        break;
      }
      case 0x0e: {
        const f = readVarOrByte(sub, 1, slot, vm.vars); // init frame
        if (actor) actor.initFrame = f;
        ops.push(`setInitFrame(${f})`);
        break;
      }
      case 0x0f:
        // No-arg no-op subop, seen in MI1 boot after setCostume.
        ops.push('subop0F');
        break;
      case 0x10: {
        const w = readVarOrByte(sub, 1, slot, vm.vars);
        if (actor) actor.width = w;
        ops.push(`setWidth(${w})`);
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
        // neverZclip CLEARS the forced clip (_forceClip = 0) — depth then
        // comes from the NeverClip class / box mask, NOT "always in front".
        if (actor) actor.forceClip = 0;
        ops.push('setNeverZClip');
        break;
      case 0x13: {
        // alwaysZclip k — clipped behind z-plane k (and above).
        const plane = readVarOrByte(sub, 1, slot, vm.vars);
        if (actor) actor.forceClip = plane;
        ops.push(`setAlwaysZClip(${plane})`);
        break;
      }
      case 0x14:
        // SCUMM also resets _forceClip here — matters for a bare
        // {ignoreBoxes} that would otherwise inherit a stale alwaysZclip.
        if (actor) {
          actor.ignoreBoxes = true;
          actor.forceClip = 0;
        }
        ops.push('setIgnoreBoxes');
        break;
      case 0x15:
        // followBoxes resets _forceClip too: room 28's cook patrol restores
        // with followBoxes and no zclip op — without the reset the cook
        // keeps the ENCD's alwaysZclip and hides behind the table.
        if (actor) {
          actor.ignoreBoxes = false;
          actor.forceClip = 0;
        }
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
      case 0x18: {
        // SO_TEXT_OFFSET (talk-text anchor) — two WORD args, not bytes;
        // consumed only (no renderer consumer).
        readVarOrWord(sub, 1, slot, vm.vars); // talk pos x
        readVarOrWord(sub, 2, slot, vm.vars); // talk pos y
        ops.push('setTalkPos');
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
        getOrCreateVerb(vm, verbId).image = { obj, room: vm.currentRoom };
        subops.push(`setImage(${obj})`);
        break;
      }
      case 0x02: {
        // Escape-aware read: 0xFF-code arguments can contain 0x00, so a
        // naive scan-to-NUL misaligns the PC (the sentence-line verb #100
        // builds its name entirely from substitution codes).
        const nameBytes = readScummString(slot);
        const v = getOrCreateVerb(vm, verbId);
        v.name = decodeScummString(nameBytes, vm, slot);
        v.image = null; // text verb — drop any prior image binding
        // Do NOT re-capture the charset: SCUMM fixes it at SO_VERB_NEW.
        // Verb #100 is renamed every frame under the dialogue charset and
        // would wrongly enlarge to it.
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
        // delete removes the slot; off preserves it for a later on.
        vm.verbs.delete(verbId);
        subops.push('delete');
        break;
      case 0x09: {
        // SO_VERB_NEW: the verb starts OFF (curmode 0) — creating it on
        // made the dialog reply verbs flicker during setup. NAME and
        // POSITION are NOT reset; colours stay at our 0 = default sentinel.
        const existing = vm.verbs.get(verbId);
        vm.verbs.set(verbId, {
          id: verbId,
          name: existing?.name ?? '', // untouched by SO_VERB_NEW
          color: 0,
          hiColor: 0,
          dimColor: 0,
          backColor: existing?.backColor ?? 0, // untouched
          x: existing?.x ?? 0, // untouched
          y: existing?.y ?? 0,
          key: 0,
          charset: vm.currentCharset,
          centered: false,
          image: null,
          state: 'off', // curmode 0
        });
        subops.push('new');
        break;
      }
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
        // Name from a stringOps buffer. The insult-duel menus loadString
        // it via a nested startScript right before this, so the buffer is
        // already populated — copy it now, like the inline-name path.
        const s = readVarOrWord(sub, 1, slot, vm.vars);
        const v = getOrCreateVerb(vm, verbId);
        const buf = vm.strings.get(s);
        if (buf) {
          v.name = decodeScummString(buf, vm, slot);
          v.image = null; // text verb — drop any prior image binding
        }
        subops.push(`setNameStr(${s})`);
        break;
      }
      case 0x16: {
        // setImageInRoom — the sprite may come from a non-current room
        // (MI1's inventory slots draw from UI room 99).
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
      charset: vm.currentCharset,
      centered: false,
      image: null,
      state: 'off',
    };
    vm.verbs.set(id, v);
  }
  return v;
}

/**
 * Decode a SCUMM v5 string to display text: `0xFF 0x01` → newline,
 * codes >= 0x04 expand via expandSubstitution, the rest are stripped.
 * Codes 0x01-0x03 are 2-byte sequences, >= 0x04 are 4-byte.
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
      i += code >= 0x04 ? 4 : 2;
      continue;
    }
    // 0xFE is a second escape introducer: `FE 01` is a newline, while a
    // BARE 0x01 is a literal glyph (pages/docs/scumm/char.md) — the
    // verb-panel arrows break if either is mishandled.
    if (b === 0xfe && (payload[i + 1] ?? 0) === 0x01) {
      out.push(0x0a);
      i += 2;
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
 * Expand a `0xFF NN` (NN >= 0x04) substitution into `out`. Codes 0x04
 * int / 0x05 verb-name / 0x06 obj-or-actor-name read their id from a
 * VAR (the 2-byte arg is a var ref); 0x07 string takes the LITERAL
 * string id (SCUMM convertMessageToString). 0x09/0x0E are consumed but
 * emit nothing; without vm/slot the code is dropped.
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
  if (code === 0x07) {
    const buf = vm.strings.get(word);
    if (buf) pushAscii(out, decodeScummString(buf, vm, slot));
    return;
  }
  let value: number;
  try {
    value = derefRead(word, slot, vm.vars);
  } catch {
    return; // unresolvable ref (e.g. OOB local index) — emit nothing
  }
  if (code === 0x04) {
    pushAscii(out, String(value));
  } else if (code === 0x05) {
    const name = vm.verbs.get(value)?.name;
    if (name) pushAscii(out, name);
  } else if (code === 0x06) {
    const name = vm.objectName(value);
    if (name) pushAscii(out, name);
  }
}

/**
 * Split a SCUMM string into talk pages at `\xff\x03` (wait) and flag
 * keepText (`\xff\x02`). Empty pages are dropped.
 */
function decodeScummStringPages(
  payload: Uint8Array,
  vm?: Vm,
  slot?: ScriptSlot,
): { pages: string[]; keepText: boolean } {
  const pages: number[][] = [[]];
  let keepText = false;
  let i = 0;
  while (i < payload.length) {
    const b = payload[i]!;
    if (b === 0xff) {
      const code = payload[i + 1] ?? 0;
      if (code === 0x01) pages[pages.length - 1]!.push(0x0a); // newline
      else if (code === 0x02) keepText = true; // keep-text: persist past the talk timer
      else if (code === 0x03) pages.push([]); // wait → start a new page
      else if (code >= 0x04) expandSubstitution(code, payload, i, vm, slot, pages[pages.length - 1]!);
      i += code >= 0x04 ? 4 : 2;
      continue;
    }
    pages[pages.length - 1]!.push(b);
    i++;
  }
  return {
    pages: pages.map((p) => String.fromCharCode(...p)).filter((p) => p.length > 0),
    keepText,
  };
}

// ─── 0xCC  pseudoRoom ────────────────────────────────────────────────
// Alias key is the RAW byte, high bit kept (opcode-reference.md);
// applyRoomResources tries the literal room first, then this alias.
register(0xcc, (vm, slot) => {
  const id = readU8(slot);
  const mapped: number[] = [];
  while (true) {
    const j = readU8(slot);
    if (j === 0) break;
    if (j >= 0x80) {
      vm.pseudoRooms.set(j, id);
      mapped.push(j);
    }
  }
  vm.annotate(`pseudoRoom realRoom=${id} aliases=[${mapped.join(',')}]`);
});

// SCUMM's darkenPalette/colorIntensityRange: each channel of [start..end]
// becomes base*scale/255, clamped at 255 — scales > 255 BRIGHTEN (room
// 29's reveal uses 500/900). Scaling from the BASE palette, not the live
// one, is what makes a fade-out → fade-in restore exactly.
function scalePaletteRange(
  vm: Vm,
  rScale: number,
  gScale: number,
  bScale: number,
  start: number,
  end: number,
): void {
  const live = vm.loadedRoom?.palette;
  const base = vm.basePalette;
  if (!live || !base) return;
  const scales = [rScale, gScale, bScale];
  for (let i = Math.max(0, start); i <= end && i < 256; i++) {
    for (let k = 0; k < 3; k++) {
      live[i * 3 + k] = Math.min(255, Math.floor((base[i * 3 + k]! * scales[k]!) / 255));
    }
  }
}

// ─── 0x33 / 0x73 / 0xB3 / 0xF3  roomOps ──────────────────────────────
function roomOpsHandler(vm: Vm, slot: ScriptSlot, _opcode: number): void {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  switch (action) {
    case 0x01: {
      // roomScroll: camera-centre bounds, each floored at half-screen
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
      // setScreen: playable viewport rows [top, bottom); the rest is
      // verb/inventory UI.
      const a = readVarOrWord(subop, 1, slot, vm.vars);
      const b = readVarOrWord(subop, 2, slot, vm.vars);
      vm.screen.top = a;
      vm.screen.bottom = b;
      vm.annotate(`roomOps setScreen top=${a} bottom=${b}`);
      return;
    }
    case 0x04: {
      // setPalColor: r, g, b, then a SECOND subop byte carrying the slot
      // arg's param mode.
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
      } else if (!pal && idx >= 0 && idx < 256) {
        // Boot UI/credit palette scripts run before any room — persist as
        // an override re-applied on each room load (Vm.uiPaletteOverrides).
        vm.uiPaletteOverrides.set(idx, [r & 0xff, g & 0xff, b & 0xff]);
      }
      vm.annotate(`roomOps setPalColor (${r},${g},${b}) → slot ${idx}`);
      return;
    }
    case 0x05:
      vm.shakeEnabled = true;
      vm.annotate('roomOps shakeOn');
      return;
    case 0x06:
      vm.shakeEnabled = false;
      vm.annotate('roomOps shakeOff');
      return;
    case 0x08: {
      // roomIntensity: scale, start, end (all var-or-byte) — one scale for
      // all three channels; base-palette semantics in scalePaletteRange.
      const scale = readVarOrByte(subop, 1, slot, vm.vars);
      const start = readVarOrByte(subop, 2, slot, vm.vars);
      const end = readVarOrByte(subop, 3, slot, vm.vars);
      scalePaletteRange(vm, scale, scale, scale, start, end);
      vm.annotate(`roomOps roomIntensity scale=${scale} range=${start}..${end}`);
      return;
    }
    case 0x09:
      throw new Error('roomOps: saveLoad (subop 0x09) not implemented (no MI1 use)');
    case 0x0a: {
      // screenEffect: low byte = fade-in effect, high byte = fade-out;
      // operand 0 = "fade the current room in NOW" trigger. See
      // pages/docs/scumm/screen-effect.md.
      const e = readVarOrWord(subop, 1, slot, vm.vars);
      if (e === 0) {
        vm.screenEffect.requestFadeIn = true;
        vm.annotate('roomOps screenEffect fadeIn (effect unchanged)');
      } else {
        vm.screenEffect.switchRoomEffect = e & 0xff;
        vm.screenEffect.switchRoomEffect2 = (e >> 8) & 0xff;
        vm.annotate(`roomOps screenEffect in=${e & 0xff} out=${(e >> 8) & 0xff}`);
      }
      return;
    }
    case 0x0b: {
      // setRGBRoomIntensity: rs, gs, bs (3 words), then a SECOND subop
      // byte carrying the range args lo, hi (var-or-byte).
      const rs = readVarOrWord(subop, 1, slot, vm.vars);
      const gs = readVarOrWord(subop, 2, slot, vm.vars);
      const bs = readVarOrWord(subop, 3, slot, vm.vars);
      const sub2 = readU8(slot);
      const lo = readVarOrByte(sub2, 1, slot, vm.vars);
      const hi = readVarOrByte(sub2, 2, slot, vm.vars);
      scalePaletteRange(vm, rs, gs, bs, lo, hi);
      vm.annotate(`roomOps setRGBRoomIntensity (${rs},${gs},${bs}) ${lo}..${hi}`);
      return;
    }
    case 0x0d:
      throw new Error('roomOps: saveString (subop 0x0D) not implemented (no MI1 use)');
    case 0x0e:
      throw new Error('roomOps: loadString (subop 0x0E) not implemented (no MI1 use)');
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

  // Bit 0x20 = freeze-resistant; bit 0x40 (recursive) is not honoured.
  const freezeResistant = (opcode & 0x20) !== 0;
  const child = vm.startScriptById(scriptId, { args, freezeResistant });
  // startScript 0 is a no-op (opcodes.md §6).
  if (!child) {
    vm.annotate(`startScript #${scriptId} (no-op: script 0)`);
    return;
  }
  // Runs the child NESTED, to its first breakHere/stop, before the
  // caller's next opcode (opcodes.md §6) — scripts rely on the ordering.
  vm.runScriptNested(child);
  vm.annotate(`startScript #${scriptId} slot=${child.slotIndex} args=[${args.join(',')}]`);
}

// ─── 0x42 / 0xC2  chainScript ────────────────────────────────────────
// Kill first, then start — the chained script reuses the freed slot and
// dispatch falls through to it (opcodes.md §6).
register(0x42, chainScriptHandler);
register(0xc2, chainScriptHandler);
function chainScriptHandler(vm: Vm, slot: ScriptSlot, opcode: number): void {
  const scriptId = readVarOrByte(opcode, 1, slot, vm.vars);
  const args = readWordVararg(slot, vm.vars);

  // Carry the dying slot's freeze-resistance (SCUMM passes it through).
  const freezeResistant = slot.freezeResistant;
  slot.kill();
  const child = vm.startScriptById(scriptId, { args, freezeResistant });
  vm.annotate(
    child
      ? `chainScript #${scriptId} slot=${child.slotIndex} args=[${args.join(',')}]`
      : `chainScript #${scriptId} (no-op: script 0)`,
  );
}

// ─── 0x19  doSentence ────────────────────────────────────────────────
// The 0xFE clear form carries NO object operands (the original's early
// return). See pages/docs/scumm/input.md for the sentence machinery.
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
// Unmet condition → rewind PC to the 0xAE byte and yield, re-checking
// next tick (the original's `_scriptPointer = _scriptOrgPointer`).
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
      shouldWait = vm.vars.readGlobal(VAR_HAVE_MSG) !== 0;
      detail = 'message';
      break;
    case SO_WAIT_FOR_CAMERA:
      // Blocks only while a scripted pan is in flight (cameraDest set).
      shouldWait = vm.cameraDest !== null;
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
// All resources are mapped at boot — nothing to load on demand; consume
// the operand shapes and no-op.
register(0x0c, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
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
register(0x27, (vm, slot) => {
  const subop = readU8(slot);
  const action = subop & 0x1f;
  switch (action) {
    case 0x01: {
      // loadString: the literal can embed 0xFF escapes whose 2-byte args
      // may contain 0x00 — readScummString finds the true terminator (a
      // naive scan broke the copy-protection quiz #154).
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const text = readScummString(slot);
      vm.strings.set(id, text);
      vm.annotate(`stringOps loadString id=${id} len=${text.length}`);
      return;
    }
    case 0x02: {
      const dest = readVarOrByte(subop, 1, slot, vm.vars);
      const src = readVarOrByte(subop, 2, slot, vm.vars);
      const srcBuf = vm.strings.get(src);
      vm.strings.set(dest, srcBuf ? new Uint8Array(srcBuf) : new Uint8Array(0));
      vm.annotate(`stringOps copyString ${src}→${dest}`);
      return;
    }
    case 0x03: {
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const idx = readVarOrByte(subop, 2, slot, vm.vars);
      const ch = readVarOrByte(subop, 3, slot, vm.vars);
      const buf = vm.strings.get(id);
      if (buf && idx >= 0 && idx < buf.length) buf[idx] = ch & 0xff;
      vm.annotate(`stringOps setStringChar id=${id}[${idx}] = 0x${(ch & 0xff).toString(16)}`);
      return;
    }
    case 0x04: {
      // getStringChar: the result consumes no mask bit — id takes 0x80,
      // index 0x40 (opcodes.md §5; off-by-one broke the insult matcher).
      const destRef = readDestRef(slot, vm.vars);
      const id = readVarOrByte(subop, 1, slot, vm.vars);
      const idx = readVarOrByte(subop, 2, slot, vm.vars);
      const buf = vm.strings.get(id);
      const ch = buf && idx >= 0 && idx < buf.length ? buf[idx]! : 0;
      writeRef(destRef, ch, slot, vm.vars);
      vm.annotate(`stringOps getStringChar id=${id}[${idx}] → 0x${ch.toString(16)}`);
      return;
    }
    case 0x05: {
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
register(0xac, (vm, slot) => {
  evalExpression(slot, vm.vars, vm);
  vm.annotate('expression');
});

// ─── 0x2E  delay ─────────────────────────────────────────────────────
register(0x2e, (vm, slot) => {
  const a = readU8(slot);
  const b = readU8(slot);
  const c = readU8(slot);
  const ticks = a | (b << 8) | (c << 16);
  slot.delayRemaining = ticks;
  slot.yield_();
  vm.annotate(`delay ${ticks}`);
});

// ─── 0x2B  delayVariable ─────────────────────────────────────────────
register(0x2b, (vm, slot) => {
  const ticks = readVarRef(slot, vm.vars);
  slot.delayRemaining = ticks;
  slot.yield_();
  vm.annotate(`delayVariable ${ticks}`);
});

export const SEED_OPCODES: ReadonlyMap<number, OpcodeHandler> = handlers;
