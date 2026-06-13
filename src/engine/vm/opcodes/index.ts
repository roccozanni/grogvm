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
  DEFAULT_WALK_SPEED_X,
  DEFAULT_WALK_SPEED_Y,
  type Actor,
} from '../../actor/actor';
import { startWalk, startActorChore, applyStandPose, reapplyChoreForFacing, FACING_FROM_OLD, rescaleActorForPosition, effectiveBoxes } from '../../actor/walk';
import { clampPointToBoxes, findBoxAtOrNearest } from '../../pathfinding/boxes';
import { pickObject } from '../../object/hittest';
import { evalExpression } from '../expression';
import { SENTENCE_CLEAR_VERB } from '../sentence';
import { VAR_CURRENT_LIGHTS, VAR_CURSORSTATE, VAR_HAVE_MSG, VAR_LAST_SOUND, VAR_OVERRIDE, VAR_USERPUT, VAR_WALKTO_OBJ } from '../vars';
import { derefRead, writeRef } from '../params';
import type { ScriptSlot } from '../slot';
import type { OpcodeHandler, Vm, VerbSlot } from '../vm';
import { buildSeedOpcodes, defineOp, defineRawOp } from './registry';
import { renderBytes, type OperandReader, type Val } from './operands';

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

// ─── 0x00 / 0xA0  stopObjectCode ─────────────────────────────────────
defineOp({
  name: 'stopObjectCode',
  opcodes: [0x00, 0xa0],
  decode: () => ({}),
  exec(vm, slot) {
    vm.annotate('stopObjectCode');
    slot.kill();
  },
  format: () => 'stopObjectCode',
});

// ─── 0x80  breakHere ─────────────────────────────────────────────────
defineOp({
  name: 'breakHere',
  opcodes: [0x80],
  decode: () => ({}),
  exec(vm, slot) {
    vm.annotate('breakHere');
    slot.yield_();
  },
  format: () => 'breakHere',
});

// ─── 0x18  jumpRelative ──────────────────────────────────────────────
defineOp({
  name: 'jump',
  opcodes: [0x18],
  decode: (r) => ({ delta: r.i16() }),
  exec(vm, slot, d) {
    slot.pc += d.delta;
    vm.annotate(`jump ${d.delta >= 0 ? '+' : ''}${d.delta}`);
  },
  format: (d) => `jump ${d.delta}`,
});

// ─── 0x1A / 0x9A  setVar ─────────────────────────────────────────────
defineOp({
  name: 'setVar',
  opcodes: [0x1a, 0x9a],
  decode: (r, op) => ({ dest: r.dest(), value: r.p16(op, 1) }),
  exec(vm, slot, d) {
    writeRef(d.dest.ref, d.value.value, slot, vm.vars);
    vm.annotate(`setVar 0x${d.dest.ref.toString(16)} = ${d.value.value}`);
  },
  format: (d) => `move ${d.dest} = ${d.value}`,
});

// ─── 0x46 / 0xC6  inc / dec ──────────────────────────────────────────
function defineIncDec(name: string, opcode: number, delta: 1 | -1): void {
  defineOp({
    name,
    opcodes: [opcode],
    decode: (r) => ({ dest: r.dest() }),
    exec(vm, slot, d) {
      const cur = derefRead(d.dest.ref, slot, vm.vars);
      writeRef(d.dest.ref, cur + delta, slot, vm.vars);
      vm.annotate(`${delta === 1 ? 'inc' : 'dec'} 0x${d.dest.ref.toString(16)}`);
    },
    format: (d) => `${name} ${d.dest}`,
  });
}
defineIncDec('increment', 0x46, 1);
defineIncDec('decrement', 0xc6, -1);

// ─── 0x5A/0xDA add · 0x3A/0xBA sub · 0x1B/0x9B mul · 0x5B/0xDB div ───
// Arithmetic matches the expression mini-VM: signed 32-bit multiply,
// truncating division, loud halt on divide-by-zero.
function defineArith(
  name: string,
  traceLabel: string,
  opcodes: number[],
  apply: (cur: number, operand: number) => number,
  annotateOp: string,
): void {
  defineOp({
    name,
    opcodes,
    decode: (r, op) => ({ dest: r.dest(), operand: r.p16(op, 1) }),
    exec(vm, slot, d) {
      const cur = derefRead(d.dest.ref, slot, vm.vars);
      writeRef(d.dest.ref, apply(cur, d.operand.value), slot, vm.vars);
      vm.annotate(`${traceLabel} 0x${d.dest.ref.toString(16)} ${annotateOp} ${d.operand.value}`);
    },
    format: (d) => `${name} ${d.dest} val=${d.operand}`,
  });
}
defineArith('add', 'add', [0x5a, 0xda], (cur, v) => cur + v, '+=');
defineArith('subtract', 'sub', [0x3a, 0xba], (cur, v) => cur - v, '-=');
defineArith('multiply', 'multiply', [0x1b, 0x9b], (cur, v) => Math.imul(cur, v), '*=');
defineArith('divide', 'divide', [0x5b, 0xdb], (cur, v) => {
  if (v === 0) throw new Error('divide: divide by zero');
  return (cur / v) | 0;
}, '/=');

// ─── 0x3F / 0x7F / 0xBF / 0xFF  drawBox ──────────────────────────────
// Fills persist in vm.drawnBoxes (re-applied each frame, cleared on room
// change) — SCUMM paints the virtual screen, which persists until the
// next room redraw. The colour's param mode rides a SECOND mode byte
// between the corner pairs, not the main opcode.
defineOp({
  name: 'drawBox',
  opcodes: [0x3f, 0x7f, 0xbf, 0xff],
  decode: (r) => {
    const left = r.u16();
    const top = r.u16();
    const modeByte = r.u8();
    const right = r.u16();
    const bottom = r.u16();
    return { left, top, right, bottom, color: r.p8(modeByte, 1) };
  },
  exec(vm, slot, d) {
    vm.drawnBoxes.push({
      left: d.left,
      top: d.top,
      right: d.right,
      bottom: d.bottom,
      color: d.color.value,
    });
    vm.annotate(`drawBox (${d.left},${d.top})-(${d.right},${d.bottom}) color=${d.color.value}`);
  },
  format: (d) => `drawBox ${d.left},${d.top},${d.right},${d.bottom} color=${d.color}`,
});

// ─── Conditional branches ───────────────────────────────────────────
// `unless (value OP var) goto target` (opcodes.md §3): operands arrive
// var-then-value and the jump fires when the condition is FALSE — the
// inverted predicates below are correct.

function defineJumpIf(
  name: string,
  traceLabel: string,
  opcodes: number[],
  jumpWhen: (a: number, b: number) => boolean,
): void {
  defineOp({
    name,
    opcodes,
    decode: (r, op) => ({ a: r.variable(), b: r.p16(op, 1), delta: r.i16() }),
    exec(vm, slot, d) {
      const taken = jumpWhen(d.a.value, d.b.value);
      if (taken) slot.pc += d.delta;
      vm.annotate(
        `${traceLabel}(${d.a.label}=${d.a.value}, ${d.b.value}) → ${taken ? `jump ${d.delta >= 0 ? '+' : ''}${d.delta}` : 'continue'}`,
      );
    },
    format: (d) => `${name} var=${d.a} val=${d.b} -> ${d.delta}`,
  });
}

defineJumpIf('isEqual', 'isEqual', [0x48, 0xc8], (a, b) => a !== b);
defineJumpIf('isNotEqual', 'isNotEqual', [0x08, 0x88], (a, b) => a === b);
defineJumpIf('isGE', 'isGE', [0x04, 0x84], (a, b) => a > b);
defineJumpIf('isLess', 'isLess', [0x44, 0xc4], (a, b) => a <= b);
defineJumpIf('isGreater', 'isGreater', [0x78, 0xf8], (a, b) => a >= b);
defineJumpIf('lessOrEqual', 'isLE', [0x38, 0xb8], (a, b) => a < b);

// ─── 0x28  equalZero / 0xA8  notEqualZero ────────────────────────────
function defineZeroTest(name: string, opcode: number, jumpWhen: (a: number) => boolean): void {
  defineOp({
    name,
    opcodes: [opcode],
    decode: (r) => ({ a: r.variable(), delta: r.i16() }),
    exec(vm, slot, d) {
      const taken = jumpWhen(d.a.value);
      if (taken) slot.pc += d.delta;
      vm.annotate(`${name}(${d.a.value}) → ${taken ? `jump ${d.delta}` : 'continue'}`);
    },
    format: (d) => `${name} ${d.a} -> ${d.delta}`,
  });
}
defineZeroTest('equalZero', 0x28, (a) => a !== 0);
defineZeroTest('notEqualZero', 0xa8, (a) => a === 0);

// ─── 0x1D / 0x9D  ifClassOfIs ────────────────────────────────────────
// Class values share actorSetClass's encoding (low 7 bits = class,
// bit 0x80 = polarity). Class N occupies bit N-1 of the mask (1-based).
defineOp({
  name: 'ifClassOfIs',
  opcodes: [0x1d, 0x9d],
  decode: (r, op) => ({ obj: r.p16(op, 1), classes: r.varargs(), delta: r.i16() }),
  exec(vm, slot, d) {
    const mask = vm.objectClasses.get(d.obj.value) ?? 0;
    let cond = true;
    for (const cv of d.classes) {
      const c = cv.value;
      const cls = c & 0x7f;
      const wantIn = (c & 0x80) !== 0;
      const inClass = cls > 0 && (mask & (1 << (cls - 1))) !== 0;
      if (inClass !== wantIn) cond = false;
    }
    if (!cond) slot.pc += d.delta;
    vm.annotate(
      `ifClassOfIs obj=${d.obj.value} [${d.classes.map((c) => c.value).join(',')}] → ${cond ? 'continue' : `jump ${d.delta}`}`,
    );
  },
  format: (d) => `ifClassOfIs val=${d.obj} classes=[${d.classes.join(',')}] -> ${d.delta}`,
});

// ─── 0x26 / 0xA6  setVarRange ────────────────────────────────────────
defineOp({
  name: 'setVarRange',
  opcodes: [0x26, 0xa6],
  decode: (r, op) => {
    const dest = r.dest();
    const count = r.u8();
    const vals: number[] = [];
    for (let i = 0; i < count; i++) vals.push(op & 0x80 ? r.i16() : r.u8());
    return { dest, count, vals };
  },
  exec(vm, slot, d) {
    for (let i = 0; i < d.count; i++) {
      writeRef(d.dest.ref + i, d.vals[i]!, slot, vm.vars);
    }
    vm.annotate(`setVarRange dest=0x${d.dest.ref.toString(16)} count=${d.count}`);
  },
  format: (d) => `setVarRange ${d.dest} n=${d.count} [${d.vals}]`,
});

// ─── 0x2C  cursorCommand ─────────────────────────────────────────────
const CURSOR_TOGGLE_NAMES: Record<number, string> = {
  0x01: 'cursorOn', 0x02: 'cursorOff', 0x03: 'userputOn', 0x04: 'userputOff',
  0x05: 'cursorSoftOn', 0x06: 'cursorSoftOff', 0x07: 'userputSoftOn', 0x08: 'userputSoftOff',
};
defineOp({
  name: 'cursorCommand',
  opcodes: [0x2c],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    switch (action) {
      case 0x01: case 0x02: case 0x03: case 0x04:
      case 0x05: case 0x06: case 0x07: case 0x08:
        return { action, args: [], colors: null };
      case 0x0a:
        return { action, args: [r.p8(sub, 1), r.p8(sub, 2)], colors: null };
      case 0x0b:
        return { action, args: [r.p8(sub, 1), r.p8(sub, 2), r.p8(sub, 3)], colors: null };
      case 0x0c:
      case 0x0d:
        return { action, args: [r.p8(sub, 1)], colors: null };
      case 0x0e:
        return { action, args: [], colors: r.varargs() };
      default:
        throw new Error(
          `cursorCommand: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  },
  exec(vm, slot, d) {
    // Cursor/userput are COUNTERS (o5_cursorCommand): hard on/off set 1/0,
    // the soft variants nest via ++/-- ; both are mirrored into
    // VAR_CURSORSTATE / VAR_USERPUT after the switch (the original's
    // version >= 4 tail).
    switch (d.action) {
      case 0x01:
        vm.cursor.state = 1;
        break;
      case 0x02:
        vm.cursor.state = 0;
        break;
      case 0x03:
        vm.cursor.userput = 1;
        break;
      case 0x04:
        vm.cursor.userput = 0;
        break;
      case 0x05:
        vm.cursor.state++;
        break;
      case 0x06:
        vm.cursor.state--;
        break;
      case 0x07:
        vm.cursor.userput++;
        break;
      case 0x08:
        vm.cursor.userput--;
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        throw new Error(
          `cursorCommand: cursor-image subop 0x${d.action.toString(16).padStart(2, '0')} not implemented (no MI1 use)`,
        );
      case 0x0d:
        vm.currentCharset = d.args[0]!.value;
        vm.annotate(`cursorCommand initCharset charset=${d.args[0]!.value}`);
        break;
      default: {
        // charsetColor → SCUMM's _charsetColorMap: the text renderer maps
        // glyph pixel values through it (see pages/docs/scumm/char.md).
        const colors = d.colors!.map((c) => c.value);
        vm.charsetColorMap = colors;
        vm.annotate(`cursorCommand charsetColor [${colors.join(',')}]`);
      }
    }
    if (CURSOR_TOGGLE_NAMES[d.action]) {
      vm.annotate(`cursorCommand ${CURSOR_TOGGLE_NAMES[d.action]}`);
    }
    vm.vars.writeGlobal(VAR_CURSORSTATE, vm.cursor.state);
    vm.vars.writeGlobal(VAR_USERPUT, vm.cursor.userput);
  },
  format: (d) => {
    if (CURSOR_TOGGLE_NAMES[d.action]) return `cursorCommand ${CURSOR_TOGGLE_NAMES[d.action]}`;
    if (d.action === 0x0a) return `cursorCommand cursorImage ${d.args[0]},${d.args[1]}`;
    if (d.action === 0x0b) return `cursorCommand hotspot ${d.args[0]},${d.args[1]},${d.args[2]}`;
    if (d.action === 0x0c) return `cursorCommand setCursor=${d.args[0]}`;
    if (d.action === 0x0d) return `cursorCommand charsetSet=${d.args[0]}`;
    return `cursorCommand charsetColors [${d.colors!.join(',')}]`;
  },
});

// ─── 0x98  systemOps ─────────────────────────────────────────────────
// Recorded as vm.systemRequest rather than acted on — a script-issued
// restart/quit must not kill the inspector; the shell decides.
defineOp({
  name: 'systemOps',
  opcodes: [0x98],
  decode: (r) => ({ sub: r.u8() }),
  exec(vm, slot, d) {
    const request = d.sub === 1 ? 'restart' : d.sub === 2 ? 'pause' : d.sub === 3 ? 'quit' : null;
    if (request) vm.systemRequest = request;
    vm.annotate(`systemOps ${request ?? `subop=0x${d.sub.toString(16)}`}`);
  },
  format: (d) => `systemOps ${d.sub}`,
});

// ─── 0x12 / 0x92  panCameraTo ────────────────────────────────────────
// ─── 0x32 / 0xB2  setCameraAt ────────────────────────────────────────
// Camera x is the CENTRE of the viewport — the visible slice is
// [x-160, x+160).
defineOp({
  name: 'panCameraTo',
  opcodes: [0x12, 0x92],
  decode: (r, op) => ({ x: r.p16(op, 1) }),
  exec(vm, slot, d) {
    // panCameraTo detaches actor-follow — otherwise moveCameraFollow
    // re-snaps every frame; room 64's dig cutscene re-engages it with an
    // explicit actorFollowCamera at the end.
    vm.cameraFollowActor = 0;
    vm.cameraDest = vm.clampCameraX(d.x.value);
    vm.annotate(`panCameraTo ${d.x.value} → dest=${vm.cameraDest}`);
  },
  format: (d) => `panCameraTo x=${d.x}`,
});

defineOp({
  name: 'setCameraAt',
  opcodes: [0x32, 0xb2],
  decode: (r, op) => ({ x: r.p16(op, 1) }),
  exec(vm, slot, d) {
    vm.cameraDest = null; // an explicit snap cancels any in-progress pan
    vm.moveCameraTo(vm.clampCameraX(d.x.value));
    vm.annotate(`setCameraAt ${d.x.value} → camera.x=${vm.camera.x}`);
  },
  format: (d) => `setCameraAt x=${d.x}`,
});

// ─── 0x52 / 0xD2  actorFollowCamera ──────────────────────────────────
// Following an actor in a DIFFERENT room switches rooms (SCUMM
// startScene) — this is how MI1's boot enters the opening lookout.
defineOp({
  name: 'actorFollowCamera',
  opcodes: [0x52, 0xd2],
  decode: (r, op) => ({ a: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    if (actor) {
      if (actor.room > 0 && actor.room !== vm.currentRoom) {
        vm.enterRoom(actor.room);
      }
      // Snap now, then track per tick; re-engaging cancels a scripted pan.
      vm.cameraFollowActor = actor.id;
      vm.cameraDest = null;
      vm.moveCameraTo(vm.clampCameraX(actor.x));
    }
    vm.annotate(`actorFollowCamera ${d.a.value} → room=${vm.currentRoom} camera.x=${vm.camera.x}`);
  },
  format: (d) => `actorFollowCamera a=${d.a}`,
});

// ─── 0x1C / 0x9C  startSound ─────────────────────────────────────────
// ─── 0x3C / 0xBC  stopSound ──────────────────────────────────────────
// ─── 0x02 / 0x82  startMusic ─────────────────────────────────────────
// ─── 0x20         stopMusic  (no params) ─────────────────────────────
// Routed through the audio timing backend — see pages/docs/scumm/sound.md.
defineOp({
  name: 'startSound',
  opcodes: [0x1c, 0x9c],
  decode: (r, op) => ({ id: r.p8(op, 1) }),
  exec(vm, slot, d) {
    vm.audio.startSound(d.id.value, vm.getSoundResource(d.id.value));
    vm.vars.writeGlobal(VAR_LAST_SOUND, d.id.value);
    vm.annotate(`startSound ${d.id.value}`);
  },
  format: (d) => `startSound ${d.id}`,
});

defineOp({
  name: 'stopSound',
  opcodes: [0x3c, 0xbc],
  decode: (r, op) => ({ id: r.p8(op, 1) }),
  exec(vm, slot, d) {
    vm.audio.stopSound(d.id.value);
    vm.annotate(`stopSound ${d.id.value}`);
  },
  format: (d) => `stopSound ${d.id}`,
});

// ─── 0x7C / 0xFC  isSoundRunning ─────────────────────────────────────
// Timing authority for script busy-wait pacing — see
// pages/docs/scumm/sound.md (a constant 0 collapses cutscene holds).
defineOp({
  name: 'isSoundRunning',
  opcodes: [0x7c, 0xfc],
  decode: (r, op) => ({ dest: r.dest(), sound: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const running = vm.audio.isRunning(d.sound.value) ? 1 : 0;
    writeRef(d.dest.ref, running, slot, vm.vars);
    vm.annotate(`isSoundRunning ${d.sound.value} → ${running}`);
  },
  format: (d) => `isSoundRunning res=${d.dest} sound=${d.sound}`,
});

// ─── 0x62 / 0xE2  stopScript ─────────────────────────────────────────
// Script 0 stops the CURRENT script (o5_stopScript) — NOT a no-op; #4's
// sentence-line guard relies on aborting itself here.
defineOp({
  name: 'stopScript',
  opcodes: [0x62, 0xe2],
  decode: (r, op) => ({ script: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const scriptId = d.script.value;
    if (scriptId === 0) {
      slot.kill();
      vm.annotate('stopScript #0 (self)');
      return;
    }
    for (const s of vm.slots) {
      if (s.status !== 'dead' && s.scriptId === scriptId) s.kill();
    }
    vm.annotate(`stopScript #${scriptId}`);
  },
  format: (d) => `stopScript ${d.script}`,
});

// ─── 0x30 / 0xB0  matrixOp ───────────────────────────────────────────
// setBoxScale halts loudly — no MI1 use, box scale comes from the SCAL
// slots at load. createBoxMatrix keys on the subop's low five bits like
// every other subop, not the raw byte.
defineOp({
  name: 'matrixOp',
  opcodes: [0x30, 0xb0],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    if (action === 0x04) return { action, args: [] };
    if (action >= 0x01 && action <= 0x03) {
      return { action, args: [r.p8(sub, 1), r.p8(sub, 2)] };
    }
    throw new Error(
      `matrixOp: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
    );
  },
  exec(vm, slot, d) {
    if (d.action === 0x04) {
      vm.rebuildBoxMatrix();
      vm.annotate('matrixOp createBoxMatrix');
      return;
    }
    if (d.action === 0x01) {
      vm.setBoxFlags(d.args[0]!.value, d.args[1]!.value);
      vm.annotate(
        `matrixOp setBoxFlags box=${d.args[0]!.value} flags=0x${d.args[1]!.value.toString(16)}`,
      );
      return;
    }
    throw new Error(
      `matrixOp: subop 0x${d.action.toString(16).padStart(2, '0')} (setBoxScale) not implemented (no MI1 use)`,
    );
  },
  format: (d) => {
    if (d.action === 0x04) return 'matrixOp createBoxMatrix';
    if (d.action === 0x01) return `matrixOp setBoxFlags ${d.args[0]},${d.args[1]}`;
    return `matrixOp setBoxScale ${d.args[0]},${d.args[1]}`;
  },
});
defineOp({
  name: 'startMusic',
  opcodes: [0x02, 0x82],
  decode: (r, op) => ({ id: r.p8(op, 1) }),
  exec(vm, slot, d) {
    vm.audio.startMusic(d.id.value, vm.getSoundResource(d.id.value));
    vm.vars.writeGlobal(VAR_LAST_SOUND, d.id.value);
    vm.annotate(`startMusic ${d.id.value}`);
  },
  format: (d) => `startMusic ${d.id}`,
});

defineOp({
  name: 'stopMusic',
  opcodes: [0x20],
  decode: () => ({}),
  exec(vm) {
    vm.audio.stopMusic();
    vm.annotate('stopMusic');
  },
  format: () => 'stopMusic',
});

// ─── 0x4C  soundKludge ───────────────────────────────────────────────
// Zero MI1 uses — decoded so the stream stays aligned, halts loudly.
defineOp({
  name: 'soundKludge',
  opcodes: [0x4c],
  decode: (r) => ({ args: r.varargs() }),
  exec() {
    throw new Error('soundKludge (0x4C) not implemented (no MI1 use; audio is Phase 9)');
  },
  format: (d) => `soundKludge [${d.args.join(',')}]`,
});

// ─── 0x72 / 0xF2  loadRoom ───────────────────────────────────────────
defineOp({
  name: 'loadRoom',
  opcodes: [0x72, 0xf2],
  decode: (r, op) => ({ room: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const roomId = d.room.value;
    vm.enterRoom(roomId);
    const lr = vm.loadedRoom;
    if (lr) {
      vm.annotate(`loadRoom ${roomId} (${lr.width}×${lr.height})`);
    } else if (vm.lastRoomLoadError) {
      vm.annotate(`loadRoom ${roomId} (no data: ${vm.lastRoomLoadError})`);
    } else {
      vm.annotate(`loadRoom ${roomId} (no resolver)`);
    }
  },
  format: (d) => `loadRoom room=${d.room}`,
});

// ─── 0x70 / 0xF0  lights ─────────────────────────────────────────────
// arg3 = 0 → arg1 becomes VAR_CURRENT_LIGHTS; non-zero = flashlight
// variant (not modelled — operands still consumed so the stream stays
// aligned). See pages/docs/scumm/lighting.md.
defineOp({
  name: 'lights',
  opcodes: [0x70, 0xf0],
  decode: (r, op) => ({ arg1: r.p8(op, 1), arg2: r.u8(), arg3: r.u8() }),
  exec(vm, slot, d) {
    if (d.arg3 === 0) {
      vm.vars.writeGlobal(VAR_CURRENT_LIGHTS, d.arg1.value);
      vm.annotate(`lights g9=${d.arg1.value}`);
    } else {
      vm.annotate(`lights flashlight w=${d.arg2} mode=${d.arg3}`);
    }
  },
  format: (d) => `lights arg1=${d.arg1} arg2=${d.arg2} arg3=${d.arg3}`,
});

// ─── 0x14 / 0x94 / 0xD8  print / printEgo ────────────────────────────

/** Developer debug-print channel — suppressed on screen; real narrator
 *  text is actor 255 (see pages/docs/scumm/char.md). */
const DEBUG_PRINT_ACTOR = 253;

interface PrintBody {
  readonly subs: SubopItem[];
  readonly text: Uint8Array | null;
}

function decodePrintSubs(r: OperandReader): PrintBody {
  const subs: SubopItem[] = [];
  while (true) {
    const sub = r.u8();
    if (sub === 0xff) return { subs, text: null };
    const action = sub & 0x1f;
    switch (action) {
      case 0x00: // SO_AT
      case 0x03: // erase
        subs.push({ action, args: [r.p16(sub, 1), r.p16(sub, 2)], str: null });
        break;
      case 0x01: // color
        subs.push({ action, args: [r.p8(sub, 1)], str: null });
        break;
      case 0x02: // clipped/right
      case 0x08: // SO_SAY_VOICE — one word arg (CD voice id)
        subs.push({ action, args: [r.p16(sub, 1)], str: null });
        break;
      case 0x04: // center
      case 0x06: // left
      case 0x07: // overhead
        subs.push({ action, args: [], str: null });
        break;
      case 0x0f:
        // SO_TEXTSTRING ends the list itself — no 0xFF terminator follows.
        return { subs, text: r.scummString() };
      default:
        throw new Error(
          `print: unknown subop 0x${action.toString(16)} (raw=0x${sub.toString(16)})`,
        );
    }
  }
}

function execPrint(vm: Vm, slot: ScriptSlot, actor: number, d: PrintBody): void {
  const ops: string[] = [];
  // A real speaker with no explicit SO_AT/SO_COLOR is actor talk: default
  // to the actor's talk color, centred above the actor (SCUMM talk default).
  const speaker = actorOrNull(vm, actor);
  const speakerId = actor === 0 ? vm.vars.readGlobal(VAR_EGO) : actor;
  // Debug prints decode like any other (the PC must advance) but never
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
  for (const s of d.subs) {
    switch (s.action) {
      case 0x00:
        // SO_AT also clears overhead — an explicit anchor overrides
        // "above the actor" (SCUMM).
        atX = s.args[0]!.value;
        atY = s.args[1]!.value;
        overhead = false;
        ops.push(`at(${atX},${atY})`);
        break;
      case 0x01:
        color = s.args[0]!.value;
        colorSet = true;
        ops.push(`color(${color})`);
        break;
      case 0x02:
        clipped = s.args[0]!.value;
        ops.push(`clipped(${clipped})`);
        break;
      case 0x03:
        throw new Error('print: erase (subop 0x03) not implemented (no MI1 use)');
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
      default:
        // SO_SAY_VOICE — consumed, no output.
        ops.push(`voice(${s.args[0]!.value})`);
        break;
    }
  }
  if (d.text !== null) {
    const buf = d.text;
    if (isDebug) return;
    // Pages split at \xff\x03: the first shows now, the rest queue on
    // the talk timer. keepText (\xff\x02) persists past the timer.
    const { pages, keepText } = decodeScummStringPages(buf, vm, slot);
    const text = pages[0] ?? '';
    const preview = renderBytes(buf);
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
        charset: vm.currentCharset,
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

function formatPrintBody(d: PrintBody): string {
  const parts = d.subs.map((s) => {
    switch (s.action) {
      case 0x00: return `at ${s.args[0]},${s.args[1]}`;
      case 0x01: return `color=${s.args[0]}`;
      case 0x02: return `right=${s.args[0]}`;
      case 0x03: return `erase ${s.args[0]},${s.args[1]}`;
      case 0x04: return 'center';
      case 0x06: return 'left';
      case 0x07: return 'overhead';
      default: return `voice=${s.args[0]}`;
    }
  });
  if (d.text !== null) parts.push(`text="${renderBytes(d.text)}"`);
  return parts.join(' ');
}

defineOp({
  name: 'print',
  opcodes: [0x14, 0x94],
  decode: (r, op) => ({ actor: r.p8(op, 1), ...decodePrintSubs(r) }),
  exec(vm, slot, d) {
    execPrint(vm, slot, d.actor.value, d);
  },
  format: (d) => `print a=${d.actor} ${formatPrintBody(d)}`,
});

defineOp({
  name: 'printEgo',
  opcodes: [0xd8],
  decode: (r) => decodePrintSubs(r),
  exec(vm, slot, d) {
    execPrint(vm, slot, 0, d);
  },
  format: (d) => `printEgo ${formatPrintBody(d)}`,
});

// ─── 0x58  beginOverride / endOverride ───────────────────────────────
// begin (flag=1) must consume its embedded jump bytes (0x18 + i16 delta)
// itself — dispatching them as a real jump would unconditionally skip
// the cutscene body. ESC machinery: pages/docs/scumm/cutscenes.md.
defineOp({
  name: 'override',
  opcodes: [0x58],
  decode: (r) => {
    const flag = r.u8();
    if (flag === 0) return { flag, jumpOp: null, delta: 0 };
    return { flag, jumpOp: r.u8(), delta: r.i16() };
  },
  exec(vm, slot, d) {
    if (d.flag !== 0) {
      const overrideTarget = slot.pc + d.delta;
      slot.overridePc = overrideTarget;
      vm.vars.writeGlobal(VAR_OVERRIDE, 0);
      vm.annotate(`beginOverride target=0x${overrideTarget.toString(16)} (op=0x${d.jumpOp!.toString(16)})`);
    } else {
      slot.overridePc = null;
      vm.annotate('endOverride');
    }
  },
  format: (d) =>
    d.flag === 0 ? 'override END' : `override BEGIN (then jump ${d.delta})`,
});

// ─── 0x40  cutscene / 0xC0  endCutscene ──────────────────────────────
// See pages/docs/scumm/cutscenes.md for the bracket machinery.
defineOp({
  name: 'cutScene',
  opcodes: [0x40],
  decode: (r) => ({ args: r.varargs() }),
  exec(vm, slot, d) {
    const args = d.args.map((a) => a.value);
    vm.beginCutscene(args, slot.slotIndex);
    vm.annotate(`cutscene [${args.join(',')}]`);
  },
  format: (d) => `cutScene [${d.args.join(',')}]`,
});
defineOp({
  name: 'endCutScene',
  opcodes: [0xc0],
  decode: () => ({}),
  exec(vm) {
    vm.endCutscene();
    vm.annotate('endCutscene');
  },
  format: () => 'endCutScene',
});

// ─── 0x60 / 0xE0  freezeScripts ──────────────────────────────────────
defineOp({
  name: 'freezeScripts',
  opcodes: [0x60, 0xe0],
  decode: (r, op) => ({ flag: r.p8(op, 1) }),
  exec(vm, slot, d) {
    if (d.flag.value === 0) {
      vm.unfreezeAllScripts();
    } else {
      vm.freezeScripts(d.flag.value >= 0x80, slot.slotIndex);
    }
    vm.annotate(`freezeScripts flag=${d.flag.value}`);
  },
  format: (d) => `freezeScripts ${d.flag}`,
});

// ─── 0x68 / 0xE8  isScriptRunning ────────────────────────────────────
defineOp({
  name: 'isScriptRunning',
  opcodes: [0x68, 0xe8],
  decode: (r, op) => ({ dest: r.dest(), script: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const scriptId = d.script.value;
    const running = vm.slots.some((s) => s.status !== 'dead' && s.scriptId === scriptId);
    writeRef(d.dest.ref, running ? 1 : 0, slot, vm.vars);
    vm.annotate(`isScriptRunning #${scriptId} → ${running ? 1 : 0}`);
  },
  format: (d) => `getScriptRunning res=${d.dest} script=${d.script}`,
});

// ─── 0x16 / 0x96  getRandomNumber ────────────────────────────────────
// Result ∈ [0, max] INCLUSIVE; entropy is injectable via vm.randomInt
// (seeded under test for reproducible playthroughs).
defineOp({
  name: 'getRandomNumber',
  opcodes: [0x16, 0x96],
  decode: (r, op) => ({ dest: r.dest(), max: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const v = vm.randomInt(d.max.value);
    writeRef(d.dest.ref, v, slot, vm.vars);
    vm.annotate(`getRandomNumber max=${d.max.value} → ${v}`);
  },
  format: (d) => `getRandomNumber res=${d.dest} seed=${d.max}`,
});

// ─── 0x07 / 0x47 / 0x87 / 0xC7  setState ─────────────────────────────
// Mirrors SCUMM's putState + mark-dirty: queue the object for redraw
// (pages/docs/scumm/objects.md §7).
defineOp({
  name: 'setState',
  opcodes: [0x07, 0x47, 0x87, 0xc7],
  decode: (r, op) => ({ obj: r.p16(op, 1), state: r.p8(op, 2) }),
  exec(vm, slot, d) {
    vm.objectStates.set(d.obj.value, d.state.value);
    if (vm.loadedRoom?.objects.has(d.obj.value)) vm.objectDrawQueue.add(d.obj.value);
    vm.annotate(`setState obj=${d.obj.value} state=${d.state.value}`);
  },
  format: (d) => `setState obj=${d.obj} state=${d.state}`,
});

// ─── 0x0F / 0x8F  getObjectState ─────────────────────────────────────
defineOp({
  name: 'getObjectState',
  opcodes: [0x0f, 0x8f],
  decode: (r, op) => ({ dest: r.dest(), obj: r.p16(op, 1) }),
  exec(vm, slot, d) {
    const state = vm.objectStates.get(d.obj.value) ?? 0;
    writeRef(d.dest.ref, state, slot, vm.vars);
    vm.annotate(`getObjectState obj=${d.obj.value} → ${state}`);
  },
  format: (d) => `getObjectState res=${d.dest} obj=${d.obj}`,
});

// ─── 0x10 / 0x90  getObjectOwner ─────────────────────────────────────
// Room objects with no explicit owner read 15 (OF_OWNER_ROOM) — see
// pages/docs/scumm/objects.md §7a.
defineOp({
  name: 'getObjectOwner',
  opcodes: [0x10, 0x90],
  decode: (r, op) => ({ dest: r.dest(), obj: r.p16(op, 1) }),
  exec(vm, slot, d) {
    const owner = vm.getObjectOwner(d.obj.value);
    writeRef(d.dest.ref, owner, slot, vm.vars);
    vm.annotate(`getObjectOwner obj=${d.obj.value} → ${owner}`);
  },
  format: (d) => `getObjectOwner res=${d.dest} obj=${d.obj}`,
});

// ─── 0x0B / 0x4B / 0x8B / 0xCB  getVerbEntryPoint ────────────────────
// Returns 1/0, not a real offset (we keep per-verb bytecode slices;
// callers only test truthiness). Must match the exact verb OR the 0xFF
// default-verb entry — room exits depend on it (opcode-reference.md).
defineOp({
  name: 'getVerbEntryPoint',
  opcodes: [0x0b, 0x4b, 0x8b, 0xcb],
  decode: (r, op) => ({ dest: r.dest(), obj: r.p16(op, 1), verb: r.p16(op, 2) }),
  exec(vm, slot, d) {
    // findObjectCode (not loadedRoom) so carried inventory items answer
    // too — inventory script #9 gates `startObject item 91` on this.
    const verbs = vm.findObjectCode(d.obj.value)?.verbs;
    const has = verbs ? (verbs.has(d.verb.value) || verbs.has(0xff)) : false;
    const entry = has ? 1 : 0;
    writeRef(d.dest.ref, entry, slot, vm.vars);
    vm.annotate(`getVerbEntryPoint obj=${d.obj.value} verb=${d.verb.value} → ${entry}`);
  },
  format: (d) => `getVerbEntryPoint res=${d.dest} obj=${d.obj} verb=${d.verb}`,
});

// ─── 0xAB  saveRestoreVerbs ──────────────────────────────────────────
// `mode` (the original's per-save id) is deliberately unused — MI1's
// save/restore are range-symmetric and savedVerbStates is keyed by
// verb id.
defineOp({
  name: 'saveRestoreVerbs',
  opcodes: [0xab],
  decode: (r) => {
    const sub = r.u8();
    return { sub, start: r.p8(sub, 1), end: r.p8(sub, 2), mode: r.p8(sub, 3) };
  },
  exec(vm, slot, d) {
    const action = d.sub & 0x1f;
    const start = d.start.value;
    const end = d.end.value;
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
    vm.annotate(`saveRestoreVerbs sub=0x${d.sub.toString(16)} [${start}..${end}] mode=${d.mode.value}`);
  },
  format: (d) => `saveRestoreVerbs sub=${d.sub} ${d.start} ${d.end} ${d.mode}`,
});

// ─── 0x5D / 0xDD  actorSetClass ──────────────────────────────────────
// Value encoding per opcode-reference.md; class N occupies bit N-1 of
// the mask (classes are 1-based).
defineOp({
  name: 'actorSetClass',
  opcodes: [0x5d, 0xdd],
  decode: (r, op) => ({ obj: r.p16(op, 1), classes: r.varargs() }),
  exec(vm, slot, d) {
    const obj = d.obj.value;
    for (const cv of d.classes) {
      const v = cv.value;
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
    vm.annotate(`actorSetClass obj=${obj} [${d.classes.map((c) => c.value).join(',')}]`);
  },
  format: (d) => `actorSetClass obj=${d.obj} classes=[${d.classes.join(',')}]`,
});

// ─── 0x05 / 0x85  drawObject ─────────────────────────────────────────
// Exactly ONE subop byte — NOT a 0xFF-terminated list (opcodes.md §5).
// Owns only 0x05/0x85: 0x25/0x65/0xA5/0xE5 are pickupObject.
defineOp({
  name: 'drawObject',
  opcodes: [0x05, 0x85],
  decode: (r, op) => {
    const obj = r.p16(op, 1);
    const sub = r.u8();
    switch (sub & 0x1f) {
      case 0x01:
        return { obj, action: 0x01 as const, args: [r.p16(sub, 1), r.p16(sub, 2)] };
      case 0x02:
        return { obj, action: 0x02 as const, args: [r.p16(sub, 1)] };
      default:
        // Bare redraw — shows state 1 (set by exec).
        return { obj, action: 'draw' as const, args: [] };
    }
  },
  exec(vm, slot, d) {
    const obj = d.obj.value;
    // Always sets the object's state (1 unless SO_IMAGE overrides) — its
    // job is to make the object visible (objects.md "drawObject always
    // sets state"; room 58's reveals depend on the flip from 0).
    const ops: string[] = [];
    let state = 1;
    if (d.action === 0x01) {
      const x = d.args[0]!.value;
      const y = d.args[1]!.value;
      // SO_AT operands are STRIP units on BOTH axes → (x*8, y*8); room
      // 58's vertical forest tiling breaks if y is read as pixels
      // (objects.md §7).
      vm.objectDrawPositions.set(obj, { x: x * 8, y: y * 8 });
      ops.push(`at(${x * 8},${y * 8})`);
    } else if (d.action === 0x02) {
      // setImage(0) = "hide"; anything else selects IMxx where xx == state.
      state = d.args[0]!.value;
      ops.push(`setImage(${state})`);
    } else {
      ops.push('draw');
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
  },
  format: (d) => {
    if (d.action === 0x01) return `drawObject ${d.obj} at x=${d.args[0]} y=${d.args[1]}`;
    if (d.action === 0x02) return `drawObject ${d.obj} state=${d.args[0]}`;
    return `drawObject ${d.obj} draw`;
  },
});


// ─── 0x25 / 0x65 / 0xa5 / 0xe5  pickupObject ─────────────────────────
// Four steps, all required (objects.md "pickupObject is four steps"):
// own to ego, state 1 + DRAW (the state-1 image is the eraser patch over
// the baked-in room item), mark Untouchable, refresh inventory.
// `room == 0` means the current room.
defineOp({
  name: 'pickupObject',
  opcodes: [0x25, 0x65, 0xa5, 0xe5],
  decode: (r, op) => ({ obj: r.p16(op, 1), room: r.p8(op, 2) }),
  exec(vm, slot, d) {
    const obj = d.obj.value;
    const ego = vm.vars.readGlobal(VAR_EGO);
    // Snapshot the name BEFORE the object leaves its room context.
    vm.captureInventoryName(obj, d.room.value);
    vm.objectOwners.set(obj, ego);
    vm.objectStates.set(obj, 1);
    vm.objectClasses.set(obj, ((vm.objectClasses.get(obj) ?? 0) | (1 << 31)) >>> 0);
    vm.objectDrawQueue.add(obj);
    vm.runInventoryScript(1);
    vm.annotate(`pickupObject obj=${obj} room=${d.room.value} → owner ${ego}`);
  },
  format: (d) => `pickupObject obj=${d.obj} room=${d.room}`,
});

// ─── 0x35 / 0x75 / 0xb5 / 0xf5  findObject ───────────────────────────
// Returns 0 when no room is loaded (original behaviour) — #23 polls
// clicks in the post-credits room-0 state.
// x,y are var-or-BYTE (opcode-reference.md). MI1 only ever passes vars,
// so the immediate width has no corpus witness; the doc is the tiebreak.
defineOp({
  name: 'findObject',
  opcodes: [0x35, 0x75, 0xb5, 0xf5],
  decode: (r, op) => ({ dest: r.dest(), x: r.p8(op, 1), y: r.p8(op, 2) }),
  exec(vm, slot, d) {
    let objId = 0;
    if (vm.loadedRoom) {
      const hit = pickObject({
        objects: vm.loadedRoom.objects,
        x: d.x.value,
        y: d.y.value,
        // Untouchable class (32, bit 31) → not hit-testable (objects.md §7a).
        isUntouchable: (id) => ((vm.objectClasses.get(id) ?? 0) & (1 << 31)) !== 0,
        // Parent-chain gate reads live object states (objects.md §7a).
        getObjectState: (id) => vm.objectStates.get(id),
        // The hotspot follows a SO_AT reposition (objects.md §7).
        getObjectPosition: (id) => vm.objectDrawPositions.get(id),
      });
      if (hit !== null) objId = hit;
    }
    writeRef(d.dest.ref, objId, slot, vm.vars);
    vm.annotate(`findObject(${d.x.value},${d.y.value}) → ${objId}`);
  },
  format: (d) => `findObject res=${d.dest} x=${d.x} y=${d.y}`,
});

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
defineOp({
  name: 'getDist',
  opcodes: [0x34, 0x74, 0xb4, 0xf4],
  decode: (r, op) => ({ dest: r.dest(), a: r.p16(op, 1), b: r.p16(op, 2) }),
  exec(vm, slot, d) {
    const a = d.a.value;
    const b = d.b.value;
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
    writeRef(d.dest.ref, dist, slot, vm.vars);
    vm.annotate(`getDist ${a},${b} → ${dist}`);
  },
  format: (d) => `getDist res=${d.dest} objA=${d.a} objB=${d.b}`,
});

// ─── 0x15 / 0x55 / 0x95 / 0xd5  actorFromPos ─────────────────────────
// Hit-tests each actor's last-drawn bounds (vm.actorFromPos — SCUMM's
// gfx-usage-bit equivalent); 0 when none.
defineOp({
  name: 'actorFromPos',
  opcodes: [0x15, 0x55, 0x95, 0xd5],
  decode: (r, op) => ({ dest: r.dest(), x: r.p16(op, 1), y: r.p16(op, 2) }),
  exec(vm, slot, d) {
    const id = vm.actorFromPos(d.x.value, d.y.value);
    writeRef(d.dest.ref, id, slot, vm.vars);
    vm.annotate(`actorFromPos(${d.x.value},${d.y.value}) → ${id}`);
  },
  format: (d) => `actorFromPos res=${d.dest} x=${d.x} y=${d.y}`,
});

// ─── 0x31 / 0xb1  getInventoryCount ──────────────────────────────────
defineOp({
  name: 'getInventoryCount',
  opcodes: [0x31, 0xb1],
  decode: (r, op) => ({ dest: r.dest(), actor: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const count = vm.inventoryCount(d.actor.value);
    writeRef(d.dest.ref, count, slot, vm.vars);
    vm.annotate(`getInventoryCount actor=${d.actor.value} → ${count}`);
  },
  format: (d) => `getInventoryCount res=${d.dest} actor=${d.actor}`,
});

// ─── 0x3d / 0x7d / 0xbd / 0xfd  findInventory ────────────────────────
// `index` is 1-based, in pickup order; 0 when out of range.
defineOp({
  name: 'findInventory',
  opcodes: [0x3d, 0x7d, 0xbd, 0xfd],
  decode: (r, op) => ({ dest: r.dest(), owner: r.p8(op, 1), index: r.p8(op, 2) }),
  exec(vm, slot, d) {
    const obj = vm.findInventory(d.owner.value, d.index.value);
    writeRef(d.dest.ref, obj, slot, vm.vars);
    vm.annotate(`findInventory owner=${d.owner.value} index=${d.index.value} → ${obj}`);
  },
  format: (d) => `findInventory res=${d.dest} owner=${d.owner} index=${d.index}`,
});

// ─── getActor* read family ───────────────────────────────────────────
// Bits 5-6 SELECT the operation (non-orthogonal — opcodes.md §1).
// Invalid actor ids write 0 (the original's "no actor" fallback).
function defineActorRead(
  name: string,
  opcodes: number[],
  read: (a: Actor) => number,
  word = false,
): void {
  defineOp({
    name,
    opcodes,
    decode: (r, op) => ({ dest: r.dest(), a: word ? r.p16(op, 1) : r.p8(op, 1) }),
    exec(vm, slot, d) {
      const actor = actorOrNull(vm, d.a.value);
      const value = actor ? read(actor) : 0;
      writeRef(d.dest.ref, value, slot, vm.vars);
      vm.annotate(`${name} actor=${d.a.value} → ${value}`);
    },
    format: (d) => `${name} res=${d.dest} a=${d.a}`,
  });
}
defineActorRead('getActorElevation', [0x06, 0x86], (a) => a.elevation);
defineActorRead('getActorRoom', [0x03, 0x83], (a) => a.room);
defineActorRead('getActorY', [0x23, 0xa3], (a) => a.y, true);
defineActorRead('getActorX', [0x43, 0xc3], (a) => a.x, true);
// getActorFacing returns the old-direction integer (0=W 1=E 2=S 3=N),
// NOT an angle — scripts feed it into animateActor's 244-251 direction
// pseudo-anims (e.g. #35's `animateActor (getActorFacing(ego)+248)`).
defineActorRead('getActorFacing', [0x63, 0xe3], (a) => FACING_FROM_OLD.indexOf(a.facing));
defineActorRead('getActorCostume', [0x71, 0xf1], (a) => a.costume);
defineActorRead('getActorWidth', [0x6c, 0xec], (a) => a.width);
// getActorMoving (0x56/0xD6) — scripts only test zero/non-zero, so
// 1-while-walking / 0-at-rest is faithful to SCUMM's _moving mask.
defineActorRead('getActorMoving', [0x56, 0xd6], (a) => (a.isMoving ? 1 : 0));

// getActorWalkBox (0x7B/0xFB) — must be real, not a stub: room 29's
// reveal (#200) loops `while (getActorWalkBox(ego) < 5)`; a constant 0
// hangs it and the entry cover never lifts.
defineOp({
  name: 'getActorWalkBox',
  opcodes: [0x7b, 0xfb],
  decode: (r, op) => ({ dest: r.dest(), a: r.p8(op, 1) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
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
    writeRef(d.dest.ref, value, slot, vm.vars);
    vm.annotate(`getActorWalkBox actor=${d.a.value} → ${value}`);
  },
  format: (d) => `getActorWalkBox res=${d.dest} a=${d.a}`,
});

// ─── walkActorToActor (0x0D/0x4D/0x8D/0xCD) ──────────────────────────
defineOp({
  name: 'walkActorToActor',
  opcodes: [0x0d, 0x4d, 0x8d, 0xcd],
  decode: (r, op) => ({ a: r.p8(op, 1), other: r.p8(op, 2), dist: r.u8() }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    const other = actorOrNull(vm, d.other.value);
    if (actor && other) {
      startWalk(vm, actor, { x: other.x, y: other.y });
    }
    vm.annotate(`walkActorToActor actor=${d.a.value} other=${d.other.value} dist=${d.dist}`);
  },
  format: (d) => `walkActorToActor w=${d.a} we=${d.other} dist=${d.dist}`,
});

// ─── putActorInRoom (0x2D/0x6D/0xAD/0xED) ────────────────────────────
// Assigns the room only — does NOT load it (the load happens when the
// camera follows the actor, or via loadRoom).
defineOp({
  name: 'putActorInRoom',
  opcodes: [0x2d, 0x6d, 0xad, 0xed],
  decode: (r, op) => ({ a: r.p8(op, 1), room: r.p8(op, 2) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    if (actor) actor.room = d.room.value;
    vm.annotate(`putActorInRoom actor=${d.a.value} room=${d.room.value}`);
  },
  format: (d) => `putActorInRoom a=${d.a} room=${d.room}`,
});

// ─── putActorAtObject (0x0E / 0x4E / 0x8E / 0xCE) ─────────────────────
// Snap (no walk) onto the object's walk-to point, keeping the actor's
// room; (240,120) is o5_putActorAtObject's object-not-found fallback.
defineOp({
  name: 'putActorAtObject',
  opcodes: [0x0e, 0x4e, 0x8e, 0xce],
  decode: (r, op) => ({ a: r.p8(op, 1), obj: r.p16(op, 2) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    if (actor) {
      const walk = objectWalkPoint(vm, d.obj.value);
      const x = walk ? walk.x : 240;
      const y = walk ? walk.y : 120;
      actorPut(actor, x, y, actor.room);
      // Rescale now so a just-placed idle actor renders at floor scale
      // immediately, not one stale frame later.
      rescaleActorForPosition(vm, actor);
    }
    vm.annotate(`putActorAtObject actor=${d.a.value} obj=${d.obj.value}`);
  },
  format: (d) => `putActorAtObject a=${d.a} obj=${d.obj}`,
});

// ─── 0x1E / 0x3E / 0x5E / 0x7E / 0x9E / 0xBE / 0xDE / 0xFE  walkActorTo ─
defineOp({
  name: 'walkActorTo',
  opcodes: [0x1e, 0x3e, 0x5e, 0x7e, 0x9e, 0xbe, 0xde, 0xfe],
  decode: (r, op) => ({ a: r.p8(op, 1), x: r.p16(op, 2), y: r.p16(op, 3) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    if (actor) {
      startWalk(vm, actor, { x: d.x.value, y: d.y.value });
    }
    vm.annotate(`walkActorTo actor=${d.a.value} (${d.x.value},${d.y.value})`);
  },
  format: (d) => `walkActorTo a=${d.a} x=${d.x} y=${d.y}`,
});

// ─── walkActorToObject (0x36/0x76/0xB6/0xF6) ─────────────────────────
defineOp({
  name: 'walkActorToObject',
  opcodes: [0x36, 0x76, 0xb6, 0xf6],
  decode: (r, op) => ({ a: r.p8(op, 1), obj: r.p16(op, 2) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    const target = objActPos(vm, d.obj.value);
    if (actor && target) {
      startWalk(vm, actor, target);
    }
    vm.annotate(`walkActorToObject actor=${d.a.value} obj=${d.obj.value}`);
  },
  format: (d) => `walkActorToObject a=${d.a} obj=${d.obj}`,
});

// ─── faceActor (0x09/0x49/0x89/0xC9) ─────────────────────────────────
// Low5=0x09 is shared with setOwnerOf (0x29) — bit 0x20 selects.
function faceActorExec(vm: Vm, id: number, targetId: number): void {
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
defineOp({
  name: 'faceActor',
  opcodes: [0x09, 0x49, 0x89, 0xc9],
  decode: (r, op) => ({ a: r.p8(op, 1), target: r.p16(op, 2) }),
  exec(vm, slot, d) {
    faceActorExec(vm, d.a.value, d.target.value);
  },
  format: (d) => `faceActor a=${d.a} obj=${d.target}`,
});

// ─── setOwnerOf (0x29/0x69/0xA9/0xE9) ────────────────────────────────
defineOp({
  name: 'setOwnerOf',
  opcodes: [0x29, 0x69, 0xa9, 0xe9],
  decode: (r, op) => ({ obj: r.p16(op, 1), owner: r.p8(op, 2) }),
  exec(vm, slot, d) {
    // Grab the name now, while the room owning its OBNA is still resolvable.
    if (d.owner.value !== 0) vm.captureInventoryName(d.obj.value, 0);
    vm.objectOwners.set(d.obj.value, d.owner.value);
    // The inventory panel only re-lays when the inventory script runs, so
    // every owner change must refresh it — or a consumed item lingers in the
    // visible slots until something else scrolls the panel. Arg 0 = keep the
    // current page (the script clamps it), unlike pickupObject's snap-to-end.
    vm.runInventoryScript(0);
    vm.annotate(`setOwnerOf obj=${d.obj.value} owner=${d.owner.value}`);
  },
  format: (d) => `setOwnerOf obj=${d.obj} owner=${d.owner}`,
});

// ─── setObjectName (0x54/0xD4) ───────────────────────────────────────
// The name is a NUL-terminated SCUMM string — decoded escape-aware or
// the next byte decodes as a bogus opcode.
defineOp({
  name: 'setObjectName',
  opcodes: [0x54, 0xd4],
  decode: (r, op) => ({ obj: r.p16(op, 1), nameBytes: r.scummString() }),
  exec(vm, slot, d) {
    const name = decodeScummString(d.nameBytes, vm, slot);
    vm.setObjectName(d.obj.value, name);
    vm.annotate(`setObjectName obj=${d.obj.value} name="${name}"`);
  },
  format: (d) => `setObjectName obj=${d.obj} name="${renderBytes(d.nameBytes)}"`,
});

// ─── startObject (0x37/0x77/0xB7/0xF7) ───────────────────────────────
// Runs the object's OBCD verb script NESTED, like startScript
// (opcodes.md §6) — the inventory icons rely on the ordering.
defineOp({
  name: 'startObject',
  opcodes: [0x37, 0x77, 0xb7, 0xf7],
  decode: (r, op) => ({ obj: r.p16(op, 1), verb: r.p8(op, 2), args: r.varargs() }),
  exec(vm, slot, d) {
    const args = d.args.map((a) => a.value);
    const child = vm.startVerbScript(d.obj.value, d.verb.value, args);
    if (child) vm.runScriptNested(child);
    vm.annotate(`startObject obj=${d.obj.value} script=${d.verb.value} args=[${args.join(',')}]`);
  },
  format: (d) => `startObject obj=${d.obj} script=${d.verb} [${d.args.join(',')}]`,
});

/** OBCD `actorDir` → facing (NOT the costume old-dir order; see the
 *  loadRoomWithEgo comment for the four observed pins). */
const ACTOR_DIR_FACING: readonly ('E' | 'W' | 'N' | 'S')[] = ['E', 'W', 'N', 'S'];

// Placement point for loadRoomWithEgo / putActorAtObject: the walk-to
// point clamped into the boxes (adjustXYToBeInBox) — placement is instant.
// walkActorToObject deliberately doesn't clamp; its pathfinder copes.
function objectWalkPoint(vm: Vm, objId: number): { x: number; y: number } | null {
  const target = objActPos(vm, objId);
  if (!target) return null;
  return clampPointToBoxes(vm.loadedRoom?.walkBoxes ?? [], target.x, target.y);
}

// ─── loadRoomWithEgo (0x24/0x64/0xA4/0xE4) ───────────────────────────
defineOp({
  name: 'loadRoomWithEgo',
  opcodes: [0x24, 0x64, 0xa4, 0xe4],
  decode: (r, op) => ({
    obj: r.p16(op, 1),
    room: r.p8(op, 2),
    x: r.i16(),
    y: r.i16(),
  }),
  exec(vm, slot, d) {
    const objId = d.obj.value;
    const room = d.room.value;
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
        ego.walkLeg = null;
      }
      // Face the entry object's actorDir (OBCD byte 12) and stand. Without
      // this ego keeps his pre-transition walk facing. The byte's mapping is
      // the pairwise OPPOSITE of the costume old-dir table — all four codes
      // pinned by reference-playthrough screenshots: bar interior #315 (0)
      // rests E, jail #400 (1) rests W, cliff steps #486 (2) rests N, bar
      // doorway #428 (3) rests front (S).
      const entryObj = vm.loadedRoom?.objects.get(objId);
      if (entryObj) {
        ego.facing = ACTOR_DIR_FACING[entryObj.cdhd.actorDir & 3]!;
        applyStandPose(vm, ego);
      }
      // Rescale so ego renders at floor scale on the first frame.
      rescaleActorForPosition(vm, ego);
      // x == -1 means no explicit walk — the ENCD's entry walk takes over.
      if (d.x !== -1) startWalk(vm, ego, { x: d.x, y: d.y });
      // o5_loadRoomWithEgo re-snaps and re-engages camera follow — without
      // it a wide room entered after a detaching panCameraTo stays pinned
      // at the old camera X.
      vm.cameraFollowActor = ego.id;
      vm.cameraDest = null;
      vm.moveCameraTo(vm.clampCameraX(ego.x));
    }
    vm.annotate(`loadRoomWithEgo obj=${objId} room=${room} (${d.x},${d.y})`);
  },
  format: (d) => `loadRoomWithEgo obj=${d.obj} room=${d.room} x=${d.x} y=${d.y}`,
});

// ─── 0x01 / 0x21 / 0x41 / 0x61 / 0x81 / 0xA1 / 0xC1 / 0xE1  putActor ─
// KEEPS the actor's existing room (o5_putActor) — boot does
// putActorInRoom(ego, 38) then putActor, and clobbering the room here
// breaks the lookout load.
defineOp({
  name: 'putActor',
  opcodes: [0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1],
  decode: (r, op) => ({ a: r.p8(op, 1), x: r.p16(op, 2), y: r.p16(op, 3) }),
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    if (actor) {
      actorPut(actor, d.x.value, d.y.value, actor.room);
      // Rescale now so a just-placed idle actor renders at floor scale.
      rescaleActorForPosition(vm, actor);
    }
    vm.annotate(`putActor actor=${d.a.value} (${d.x.value},${d.y.value}) room=${actor?.room ?? 0}`);
  },
  format: (d) => `putActor a=${d.a} x=${d.x} y=${d.y}`,
});

// ─── 0x11 / 0x91  animateActor ───────────────────────────────────────
// Operand is a CHORE number; 244-255 are direction pseudo-anims that
// re-point the playing chore rather than switch it — see
// pages/docs/scumm/costume-anim.md.
// Low5=0x11 is shared: 0x31 getInventoryCount and 0x71/0xF1
// getActorCostume are different ops — animateActor owns 0x11/0x51/0x91/0xD1.
defineOp({
  name: 'animateActor',
  opcodes: [0x11, 0x51, 0x91, 0xd1],
  decode: (r, op) => ({ a: r.p8(op, 1), anim: r.p8(op, 2) }),
  exec(vm, slot, d) {
    const anim = d.anim.value;
    const actor = actorOrNull(vm, d.a.value);
    if (!actor) {
      vm.annotate(`animateActor actor=${d.a.value} anim=${anim} (no actor)`);
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
    vm.annotate(`animateActor actor=${d.a.value} anim=${anim}`);
  },
  format: (d) => `animateActor a=${d.a} anim=${d.anim}`,
});

// ─── 0x13 / 0x53 / 0x93 / 0xD3  actorOps ─────────────────────────────
const ACTOR_OPS_SHAPES: Record<number, 'none' | 'p8' | 'p8p8' | 'p8p8p8' | 'p16' | 'p16p16' | 'str'> = {
  0x00: 'p8', // dummy
  0x01: 'p8', // costume
  0x02: 'p8p8', // stepDist
  // setSound takes ONE var-or-byte arg, not two — room 64's #200
  // encodes `03 3b ff`; a second read swallows the 0xFF terminator.
  0x03: 'p8',
  0x04: 'p8', // walkFrame
  0x05: 'p8p8', // talkFrames
  0x06: 'p8', // standFrame
  0x07: 'p8p8p8',
  0x08: 'none', // init
  0x09: 'p16', // elevation
  0x0a: 'none', // animDefault
  0x0b: 'p8p8', // palette
  0x0c: 'p8', // talkColor
  0x0d: 'str', // name
  0x0e: 'p8', // initFrame
  0x0f: 'none',
  0x10: 'p8', // width
  0x11: 'p8p8', // scale
  0x12: 'none', // neverZclip
  0x13: 'p8', // alwaysZclip
  0x14: 'none', // ignoreBoxes
  0x15: 'none', // followBoxes
  0x16: 'p8', // animSpeed
  0x17: 'p8', // shadow
  // SO_TEXT_OFFSET (talk-text anchor) — two WORD args, not bytes.
  0x18: 'p16p16',
};

defineOp({
  name: 'actorOps',
  opcodes: [0x13, 0x53, 0x93, 0xd3],
  decode: (r, op) => {
    const a = r.p8(op, 1);
    const subs: SubopItem[] = [];
    while (true) {
      const sub = r.u8();
      if (sub === 0xff) break;
      const action = sub & 0x1f;
      const shape = ACTOR_OPS_SHAPES[action];
      switch (shape) {
        case 'none': subs.push({ action, args: [], str: null }); break;
        case 'p8': subs.push({ action, args: [r.p8(sub, 1)], str: null }); break;
        case 'p8p8': subs.push({ action, args: [r.p8(sub, 1), r.p8(sub, 2)], str: null }); break;
        case 'p8p8p8':
          subs.push({ action, args: [r.p8(sub, 1), r.p8(sub, 2), r.p8(sub, 3)], str: null });
          break;
        case 'p16': subs.push({ action, args: [r.p16(sub, 1)], str: null }); break;
        case 'p16p16': subs.push({ action, args: [r.p16(sub, 1), r.p16(sub, 2)], str: null }); break;
        // NUL-terminated SCUMM string — escape-aware, like setObjectName.
        case 'str': subs.push({ action, args: [], str: r.scummString() }); break;
        default:
          throw new Error(
            `actorOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
          );
      }
    }
    return { a, subs };
  },
  exec(vm, slot, d) {
    const actor = actorOrNull(vm, d.a.value);
    const ops: string[] = [];
    for (const s of d.subs) actorOpsApply(vm, slot, actor, s, ops);
    vm.annotate(`actorOps actor=${d.a.value} [${ops.join(',')}]`);
  },
  format: (d) => {
    const parts = d.subs.map((s) => {
      switch (s.action) {
        case 0x00: return `dummy(${s.args[0]})`;
        case 0x01: return `costume=${s.args[0]}`;
        case 0x02: return `stepDist ${s.args[0]},${s.args[1]}`;
        case 0x03: return `sound=${s.args[0]}`;
        case 0x04: return `walkFrame=${s.args[0]}`;
        case 0x05: return `talkFrames ${s.args[0]},${s.args[1]}`;
        case 0x06: return `standFrame=${s.args[0]}`;
        case 0x07: return `set07 ${s.args[0]},${s.args[1]},${s.args[2]}`;
        case 0x08: return 'init';
        case 0x09: return `elevation=${s.args[0]}`;
        case 0x0a: return 'animDefault';
        case 0x0b: return `palette ${s.args[0]},${s.args[1]}`;
        case 0x0c: return `talkColor=${s.args[0]}`;
        case 0x0d: return `name="${renderBytes(s.str!)}"`;
        case 0x0e: return `initFrame=${s.args[0]}`;
        case 0x0f: return 'subop0F';
        case 0x10: return `width=${s.args[0]}`;
        case 0x11: return `scale ${s.args[0]},${s.args[1]}`;
        case 0x12: return 'neverZclip';
        case 0x13: return `alwaysZclip=${s.args[0]}`;
        case 0x14: return 'ignoreBoxes';
        case 0x15: return 'followBoxes';
        case 0x16: return `animSpeed=${s.args[0]}`;
        case 0x17: return `shadow=${s.args[0]}`;
        default: return `talkPos ${s.args[0]},${s.args[1]}`;
      }
    });
    return `actorOps a=${d.a} {${parts.join('; ')}}`;
  },
});

function actorOpsApply(
  vm: Vm,
  slot: ScriptSlot,
  actor: Actor | null,
  s: SubopItem,
  ops: string[],
): void {
  switch (s.action) {
    case 0x00: {
      ops.push(`dummy`);
      break;
    }
    case 0x01: {
      const c = s.args[0]!.value;
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
      const x = s.args[0]!.value;
      const y = s.args[1]!.value;
      if (actor) {
        actor.walkSpeedX = x;
        actor.walkSpeedY = y;
      }
      ops.push(`setWalkSpeed(${x},${y})`);
      break;
    }
    case 0x03: {
      ops.push('setSound');
      break;
    }
    case 0x04: {
      const f = s.args[0]!.value;
      if (actor) actor.walkFrame = f;
      ops.push(`setWalkFrame(${f})`);
      break;
    }
    case 0x05: {
      const start = s.args[0]!.value; // talk start
      const stop = s.args[1]!.value; // talk stop
      if (actor) {
        actor.talkStartFrame = start;
        actor.talkStopFrame = stop;
      }
      ops.push(`setTalkFrame(${start},${stop})`);
      break;
    }
    case 0x06: {
      const f = s.args[0]!.value; // stand frame
      if (actor) actor.standFrame = f;
      ops.push(`setStandFrame(${f})`);
      break;
    }
    case 0x07: {
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
        // SCUMM initActor restores the default walk speed. Without this a slow
        // figure stays slow across an init: ego arrives on the overhead map as
        // the tiny (stepDist 1,1) walker, and room 25's ENCD inits him expecting
        // the speed to come back — so he'd crawl in the cannibal village.
        actor.walkSpeedX = DEFAULT_WALK_SPEED_X;
        actor.walkSpeedY = DEFAULT_WALK_SPEED_Y;
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
      const e = s.args[0]!.value;
      if (actor) actor.elevation = e;
      ops.push(`setElevation(${e})`);
      break;
    }
    case 0x0a:
      // setDefaultAnim — no args; not modelled.
      ops.push('setDefaultAnim');
      break;
    case 0x0b: {
      ops.push('setPalette');
      break;
    }
    case 0x0c: {
      const c = s.args[0]!.value;
      if (actor) actor.talkColor = c;
      ops.push(`setTalkColor(${c})`);
      break;
    }
    case 0x0d: {
      const name = decodeScummString(s.str!, vm, slot);
      if (actor) actor.name = name;
      ops.push(`setName(${JSON.stringify(name)})`);
      break;
    }
    case 0x0e: {
      const f = s.args[0]!.value; // init frame
      if (actor) actor.initFrame = f;
      ops.push(`setInitFrame(${f})`);
      break;
    }
    case 0x0f:
      // No-arg no-op subop, seen in MI1 boot after setCostume.
      ops.push('subop0F');
      break;
    case 0x10: {
      const w = s.args[0]!.value;
      if (actor) actor.width = w;
      ops.push(`setWidth(${w})`);
      break;
    }
    case 0x11: {
      const sx = s.args[0]!.value;
      const sy = s.args[1]!.value;
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
      const plane = s.args[0]!.value;
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
      ops.push('setAnimSpeed');
      break;
    }
    case 0x17: {
      ops.push('setShadowMode');
      break;
    }
    default: {
      // 0x18 SO_TEXT_OFFSET — consumed only (no renderer consumer).
      ops.push('setTalkPos');
      break;
    }
  }
}

// ─── 0x7A / 0xFA  verbOps ────────────────────────────────────────────
interface SubopItem {
  readonly action: number;
  readonly args: ReadonlyArray<Val>;
  readonly str: Uint8Array | null;
}

defineOp({
  name: 'verbOps',
  opcodes: [0x7a, 0xfa],
  decode: (r, op) => {
    const verb = r.p8(op, 1);
    const subs: SubopItem[] = [];
    while (true) {
      const sub = r.u8();
      if (sub === 0xff) break;
      const action = sub & 0x1f;
      switch (action) {
        case 0x01: // setImage
        case 0x14: // setNameStr
          subs.push({ action, args: [r.p16(sub, 1)], str: null });
          break;
        case 0x02:
          // Escape-aware read: 0xFF-code arguments can contain 0x00, so a
          // naive scan-to-NUL misaligns the PC (the sentence-line verb #100
          // builds its name entirely from substitution codes).
          subs.push({ action, args: [], str: r.scummString() });
          break;
        case 0x03: case 0x04: case 0x10: case 0x12: case 0x17:
          subs.push({ action, args: [r.p8(sub, 1)], str: null });
          break;
        case 0x05: // setXY
          subs.push({ action, args: [r.p16(sub, 1), r.p16(sub, 2)], str: null });
          break;
        case 0x06: case 0x07: case 0x08: case 0x09: case 0x11: case 0x13:
          subs.push({ action, args: [], str: null });
          break;
        case 0x16: // setImageInRoom
          subs.push({ action, args: [r.p16(sub, 1), r.p8(sub, 2)], str: null });
          break;
        default:
          throw new Error(
            `verbOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
          );
      }
    }
    return { verb, subs };
  },
  exec(vm, slot, d) {
    const verbId = d.verb.value;
    const subops: string[] = [];
    for (const s of d.subs) {
      switch (s.action) {
        case 0x01: {
          const obj = s.args[0]!.value;
          getOrCreateVerb(vm, verbId).image = { obj, room: vm.currentRoom };
          subops.push(`setImage(${obj})`);
          break;
        }
        case 0x02: {
          const v = getOrCreateVerb(vm, verbId);
          v.name = decodeScummString(s.str!, vm, slot);
          v.image = null; // text verb — drop any prior image binding
          // Do NOT re-capture the charset: SCUMM fixes it at SO_VERB_NEW.
          // Verb #100 is renamed every frame under the dialogue charset and
          // would wrongly enlarge to it.
          subops.push(`setName("${v.name}")`);
          break;
        }
        case 0x03:
          getOrCreateVerb(vm, verbId).color = s.args[0]!.value;
          subops.push(`setColor(${s.args[0]!.value})`);
          break;
        case 0x04:
          getOrCreateVerb(vm, verbId).hiColor = s.args[0]!.value;
          subops.push(`setHiColor(${s.args[0]!.value})`);
          break;
        case 0x05: {
          const v = getOrCreateVerb(vm, verbId);
          v.x = s.args[0]!.value;
          v.y = s.args[1]!.value;
          subops.push(`setXY(${v.x},${v.y})`);
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
        case 0x10:
          getOrCreateVerb(vm, verbId).dimColor = s.args[0]!.value;
          subops.push(`setDimColor(${s.args[0]!.value})`);
          break;
        case 0x11:
          getOrCreateVerb(vm, verbId).state = 'dim';
          subops.push('setDim');
          break;
        case 0x12:
          getOrCreateVerb(vm, verbId).key = s.args[0]!.value;
          subops.push(`setKey(${s.args[0]!.value})`);
          break;
        case 0x13:
          getOrCreateVerb(vm, verbId).centered = true;
          subops.push('setCenter');
          break;
        case 0x14: {
          // Name from a stringOps buffer. The insult-duel menus loadString
          // it via a nested startScript right before this, so the buffer is
          // already populated — copy it now, like the inline-name path.
          const sid = s.args[0]!.value;
          const v = getOrCreateVerb(vm, verbId);
          const buf = vm.strings.get(sid);
          if (buf) {
            v.name = decodeScummString(buf, vm, slot);
            v.image = null; // text verb — drop any prior image binding
          }
          subops.push(`setNameStr(${sid})`);
          break;
        }
        case 0x16: {
          // setImageInRoom — the sprite may come from a non-current room
          // (MI1's inventory slots draw from UI room 99).
          getOrCreateVerb(vm, verbId).image = { obj: s.args[0]!.value, room: s.args[1]!.value };
          subops.push(`setImageInRoom(obj=${s.args[0]!.value},room=${s.args[1]!.value})`);
          break;
        }
        default:
          getOrCreateVerb(vm, verbId).backColor = s.args[0]!.value;
          subops.push(`setBackColor(${s.args[0]!.value})`);
          break;
      }
    }
    vm.annotate(`verbOps verb=${verbId} [${subops.join(',')}]`);
  },
  format: (d) => {
    const parts = d.subs.map((s) => {
      switch (s.action) {
        case 0x01: return `image obj=${s.args[0]}`;
        case 0x02: return `name="${renderBytes(s.str!)}"`;
        case 0x03: return `color=${s.args[0]}`;
        case 0x04: return `hicolor=${s.args[0]}`;
        case 0x05: return `at ${s.args[0]},${s.args[1]}`;
        case 0x06: return 'on';
        case 0x07: return 'off';
        case 0x08: return 'delete';
        case 0x09: return 'new';
        case 0x10: return `dimcolor=${s.args[0]}`;
        case 0x11: return 'dim';
        case 0x12: return `key=${s.args[0]}`;
        case 0x13: return 'center';
        case 0x14: return `nameStr=${s.args[0]}`;
        case 0x16: return `assignObj obj=${s.args[0]} room=${s.args[1]}`;
        default: return `backColor=${s.args[0]}`;
      }
    });
    return `verbOps verb=${d.verb} ${parts.join(' ')}`;
  },
});

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
defineOp({
  name: 'pseudoRoom',
  opcodes: [0xcc],
  decode: (r) => {
    const id = r.u8();
    const aliases: number[] = [];
    while (true) {
      const j = r.u8();
      if (j === 0) break;
      aliases.push(j);
    }
    return { id, aliases };
  },
  exec(vm, slot, d) {
    const mapped: number[] = [];
    for (const j of d.aliases) {
      if (j >= 0x80) {
        vm.pseudoRooms.set(j, d.id);
        mapped.push(j);
      }
    }
    vm.annotate(`pseudoRoom realRoom=${d.id} aliases=[${mapped.join(',')}]`);
  },
  format: (d) => `pseudoRoom val=${d.id} [${d.aliases}]`,
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
defineOp({
  name: 'roomOps',
  opcodes: [0x33, 0x73, 0xb3, 0xf3],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    switch (action) {
      case 0x01: // roomScroll
      case 0x03: // setScreen
        return { action, args: [r.p16(sub, 1), r.p16(sub, 2)], str: null };
      case 0x02: // colorScale
      case 0x05: // shakeOn
      case 0x06: // shakeOff
      case 0x0c: // shadowPalette
        return { action, args: [], str: null };
      case 0x04: {
        // setPalColor: r, g, b, then a SECOND subop byte carrying the
        // slot arg's param mode — fewer operands desyncs the stream.
        const args = [r.p16(sub, 1), r.p16(sub, 2), r.p16(sub, 3)];
        const sub2 = r.u8();
        args.push(r.p8(sub2, 1));
        return { action, args, str: null };
      }
      case 0x08: // roomIntensity
        return { action, args: [r.p8(sub, 1), r.p8(sub, 2), r.p8(sub, 3)], str: null };
      case 0x09: // saveLoad
        return { action, args: [r.p8(sub, 1), r.p8(sub, 2)], str: null };
      case 0x0a: // screenEffect
        return { action, args: [r.p16(sub, 1)], str: null };
      case 0x0b: {
        // setRGBRoomIntensity: rs, gs, bs (3 words), then a SECOND subop
        // byte carrying the range args lo, hi (var-or-byte).
        const args = [r.p16(sub, 1), r.p16(sub, 2), r.p16(sub, 3)];
        const sub2 = r.u8();
        args.push(r.p8(sub2, 1), r.p8(sub2, 2));
        return { action, args, str: null };
      }
      case 0x0d: // saveString
      case 0x0e: // loadString
        return { action, args: [r.p8(sub, 1)], str: r.rawString() };
      case 0x10: // cycleSpeed
        return { action, args: [r.p8(0, 1), r.p8(0, 2)], str: null };
      default:
        throw new Error(
          `roomOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  },
  exec(vm, slot, d) {
    switch (d.action) {
      case 0x01: {
        // roomScroll: camera-centre bounds, each floored at half-screen
        // (160) so the viewport never shows past a room edge.
        const min = Math.max(160, d.args[0]!.value);
        const max = Math.max(min, d.args[1]!.value);
        vm.roomScroll = { min, max };
        vm.annotate(`roomOps roomScroll min=${min} max=${max}`);
        return;
      }
      case 0x03: {
        // setScreen: playable viewport rows [top, bottom); the rest is
        // verb/inventory UI.
        vm.screen.top = d.args[0]!.value;
        vm.screen.bottom = d.args[1]!.value;
        vm.annotate(`roomOps setScreen top=${d.args[0]!.value} bottom=${d.args[1]!.value}`);
        return;
      }
      case 0x04: {
        const [cr, cg, cb, slotArg] = d.args.map((a) => a!.value);
        const idx = slotArg!;
        const pal = vm.loadedRoom?.palette;
        if (pal && idx >= 0 && idx < 256) {
          pal[idx * 3] = cr! & 0xff;
          pal[idx * 3 + 1] = cg! & 0xff;
          pal[idx * 3 + 2] = cb! & 0xff;
        } else if (!pal && idx >= 0 && idx < 256) {
          // Boot UI/credit palette scripts run before any room — persist as
          // an override re-applied on each room load (Vm.uiPaletteOverrides).
          vm.uiPaletteOverrides.set(idx, [cr! & 0xff, cg! & 0xff, cb! & 0xff]);
        }
        vm.annotate(`roomOps setPalColor (${cr},${cg},${cb}) → slot ${idx}`);
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
        // roomIntensity: one scale for all three channels; base-palette
        // semantics in scalePaletteRange.
        const [scale, start, end] = d.args.map((a) => a!.value);
        scalePaletteRange(vm, scale!, scale!, scale!, start!, end!);
        vm.annotate(`roomOps roomIntensity scale=${scale} range=${start}..${end}`);
        return;
      }
      case 0x09:
        throw new Error('roomOps: saveLoad (subop 0x09) not implemented (no MI1 use)');
      case 0x0a: {
        // screenEffect: low byte = fade-in effect, high byte = fade-out;
        // operand 0 = "fade the current room in NOW" trigger. See
        // pages/docs/scumm/screen-effect.md.
        const e = d.args[0]!.value;
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
        const [rs, gs, bs, lo, hi] = d.args.map((a) => a!.value);
        scalePaletteRange(vm, rs!, gs!, bs!, lo!, hi!);
        vm.annotate(`roomOps setRGBRoomIntensity (${rs},${gs},${bs}) ${lo}..${hi}`);
        return;
      }
      case 0x0d:
        throw new Error('roomOps: saveString (subop 0x0D) not implemented (no MI1 use)');
      case 0x0e:
        throw new Error('roomOps: loadString (subop 0x0E) not implemented (no MI1 use)');
      default:
        throw new Error(
          `roomOps: subop 0x${d.action.toString(16).padStart(2, '0')} not implemented (no MI1 use)`,
        );
    }
  },
  format: (d) => {
    switch (d.action) {
      case 0x01: return `roomOps scroll ${d.args[0]},${d.args[1]}`;
      case 0x02: return 'roomOps colorScale';
      case 0x03: return `roomOps screen ${d.args[0]},${d.args[1]}`;
      case 0x04: return `roomOps setPalColor (${d.args[0]},${d.args[1]},${d.args[2]}) slot=${d.args[3]}`;
      case 0x05: return 'roomOps shakeOn';
      case 0x06: return 'roomOps shakeOff';
      case 0x08: return `roomOps roomIntensity ${d.args[0]},${d.args[1]},${d.args[2]}`;
      case 0x09: return `roomOps saveLoad ${d.args[0]},${d.args[1]}`;
      case 0x0a: return `roomOps fade effect=${d.args[0]}`;
      case 0x0b: return `roomOps setRGBRoomIntensity (${d.args[0]},${d.args[1]},${d.args[2]}) ${d.args[3]}..${d.args[4]}`;
      case 0x0c: return 'roomOps shadowPalette';
      case 0x0d: return `roomOps saveString ${d.args[0]} "${renderBytes(d.str!)}"`;
      case 0x0e: return `roomOps loadString ${d.args[0]} "${renderBytes(d.str!)}"`;
      default: return `roomOps cycleSpeed ${d.args[0]},${d.args[1]}`;
    }
  },
});

// ─── 0x0A  startScript ───────────────────────────────────────────────
defineOp({
  name: 'startScript',
  opcodes: [0x0a, 0x2a, 0x4a, 0x6a, 0x8a, 0xaa, 0xca, 0xea],
  // Bit 0x20 = freeze-resistant; bit 0x40 (recursive) is not honoured.
  decode: (r, op) => ({
    script: r.p8(op, 1),
    args: r.varargs(),
    freezeResistant: (op & 0x20) !== 0,
    recursive: (op & 0x40) !== 0,
  }),
  exec(vm, slot, d) {
    const scriptId = d.script.value;
    const args = d.args.map((a) => a.value);
    const child = vm.startScriptById(scriptId, { args, freezeResistant: d.freezeResistant });
    // startScript 0 is a no-op (opcodes.md §6).
    if (!child) {
      vm.annotate(`startScript #${scriptId} (no-op: script 0)`);
      return;
    }
    // Runs the child NESTED, to its first breakHere/stop, before the
    // caller's next opcode (opcodes.md §6) — scripts rely on the ordering.
    vm.runScriptNested(child);
    vm.annotate(`startScript #${scriptId} slot=${child.slotIndex} args=[${args.join(',')}]`);
  },
  format: (d) => {
    const flags = `${d.recursive ? '(recursive)' : ''}${d.freezeResistant ? '(freezeResist)' : ''}`;
    return `startScript${flags} ${d.script} [${d.args.join(',')}]`;
  },
});

// ─── 0x42 / 0xC2  chainScript ────────────────────────────────────────
// Kill first, then start — the chained script reuses the freed slot and
// dispatch falls through to it (opcodes.md §6).
defineOp({
  name: 'chainScript',
  opcodes: [0x42, 0xc2],
  decode: (r, op) => ({ script: r.p8(op, 1), args: r.varargs() }),
  exec(vm, slot, d) {
    const scriptId = d.script.value;
    const args = d.args.map((a) => a.value);
    // Carry the dying slot's freeze-resistance (SCUMM passes it through).
    const freezeResistant = slot.freezeResistant;
    slot.kill();
    const child = vm.startScriptById(scriptId, { args, freezeResistant });
    vm.annotate(
      child
        ? `chainScript #${scriptId} slot=${child.slotIndex} args=[${args.join(',')}]`
        : `chainScript #${scriptId} (no-op: script 0)`,
    );
  },
  format: (d) => `chainScript ${d.script} [${d.args.join(',')}]`,
});

// ─── 0x19  doSentence ────────────────────────────────────────────────
// The 0xFE clear form carries NO object operands (the original's early
// return) — the only v5 op whose length depends on an operand VALUE. A
// statically unknowable verb (var-mode) decodes as the full form, the
// overwhelmingly common shape.
defineOp({
  name: 'doSentence',
  opcodes: [0x19, 0x39, 0x59, 0x79, 0x99, 0xb9, 0xd9, 0xf9],
  decode: (r, op) => {
    const verb = r.p8(op, 1);
    if (verb.known && verb.value === SENTENCE_CLEAR_VERB) {
      return { verb, objA: null, objB: null };
    }
    return { verb, objA: r.p16(op, 2), objB: r.p16(op, 3) };
  },
  exec(vm, slot, d) {
    if (d.objA === null || d.objB === null) {
      vm.clearSentence();
      vm.annotate('doSentence clear');
      return;
    }
    vm.pushSentence({ verb: d.verb.value, objectA: d.objA.value, objectB: d.objB.value });
    vm.annotate(`doSentence verb=${d.verb.value} objA=${d.objA.value} objB=${d.objB.value}`);
  },
  format: (d) =>
    d.objA === null
      ? 'doSentence STOP'
      : `doSentence verb=${d.verb} objA=${d.objA} objB=${d.objB}`,
});

// ─── 0xAE  wait ──────────────────────────────────────────────────────
// Unmet condition → rewind PC to the 0xAE byte and yield, re-checking
// next tick (the original's `_scriptPointer = _scriptOrgPointer`).
const SO_WAIT_FOR_ACTOR = 0x01;
const SO_WAIT_FOR_MESSAGE = 0x02;
const SO_WAIT_FOR_CAMERA = 0x03;
const SO_WAIT_FOR_SENTENCE = 0x04;

defineOp({
  name: 'wait',
  opcodes: [0xae],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    if (action === SO_WAIT_FOR_ACTOR) return { action, actor: r.p8(sub, 1) };
    if (
      action === SO_WAIT_FOR_MESSAGE ||
      action === SO_WAIT_FOR_CAMERA ||
      action === SO_WAIT_FOR_SENTENCE
    ) {
      return { action, actor: null };
    }
    throw new Error(`wait: unknown subop 0x${sub.toString(16)}`);
  },
  exec(vm, slot, d, ctx) {
    let shouldWait: boolean;
    let detail: string;
    switch (d.action) {
      case SO_WAIT_FOR_ACTOR: {
        const actor = actorOrNull(vm, d.actor!.value);
        shouldWait = actor?.isMoving ?? false;
        detail = `actor ${d.actor!.value}`;
        break;
      }
      case SO_WAIT_FOR_MESSAGE:
        shouldWait = vm.vars.readGlobal(VAR_HAVE_MSG) !== 0;
        detail = 'message';
        break;
      case SO_WAIT_FOR_CAMERA:
        // Waits until the camera REACHES its destination — not merely "a pan
        // is armed". Room 28's camera script (#201) re-issues panCameraTo to
        // the camera's CURRENT position every frame, so an armed-pan check
        // deadlocks every waiter behind it (#220/#207/#210, the trio
        // conversation) whenever they once yield here; a reached-dest pan
        // must read as settled.
        shouldWait = vm.cameraDest !== null && vm.cameraDest !== vm.camera.x;
        detail = 'camera';
        break;
      default:
        shouldWait = vm.sentenceStack.length > 0;
        detail = 'sentence';
        break;
    }

    if (shouldWait) {
      slot.pc = ctx.startPc; // re-run + re-check next tick
      slot.yield_();
      vm.annotate(`wait ${detail} → yield`);
    } else {
      vm.annotate(`wait ${detail} → ready`);
    }
  },
  format: (d) => {
    if (d.action === SO_WAIT_FOR_ACTOR) return `wait forActor ${d.actor}`;
    if (d.action === SO_WAIT_FOR_MESSAGE) return 'wait forMessage';
    if (d.action === SO_WAIT_FOR_CAMERA) return 'wait forCamera';
    return 'wait forSentence';
  },
});

// ─── 0x0C  resourceRoutines ──────────────────────────────────────────
// All resources are mapped at boot — nothing to load on demand; consume
// the operand shapes and no-op. Subop 0x11 (clearHeap) takes NO arg,
// 0x14 (loadFlObject) takes TWO, every other subop exactly ONE.
const RESOURCE_SUB_NAMES: Record<number, string> = {
  0x01: 'loadScript', 0x02: 'loadSound', 0x03: 'loadCostume', 0x04: 'loadRoom',
  0x05: 'nukeScript', 0x06: 'nukeSound', 0x07: 'nukeCostume', 0x08: 'nukeRoom',
  0x09: 'lockScript', 0x0a: 'lockSound', 0x0b: 'lockCostume', 0x0c: 'lockRoom',
  0x0d: 'unlockScript', 0x0e: 'unlockSound', 0x0f: 'unlockCostume', 0x10: 'unlockRoom',
  0x12: 'loadCharset', 0x13: 'nukeCharset',
};
defineOp({
  name: 'resourceRoutines',
  opcodes: [0x0c],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    if (action === 0x11) return { action, args: [] };
    if (action === 0x14) return { action, args: [r.p8(sub, 1), r.p8(sub, 2)] };
    if (RESOURCE_SUB_NAMES[action]) return { action, args: [r.p8(sub, 1)] };
    throw new Error(
      `resourceRoutines: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
    );
  },
  exec(vm, slot, d) {
    if (d.action === 0x11) {
      vm.annotate('resourceRoutines clearHeap (stub)');
    } else if (d.action === 0x14) {
      vm.annotate(
        `resourceRoutines loadFlObject obj=${d.args[0]!.value} room=${d.args[1]!.value} (stub)`,
      );
    } else {
      vm.annotate(`resourceRoutines ${RESOURCE_SUB_NAMES[d.action]} id=${d.args[0]!.value} (stub)`);
    }
  },
  format: (d) => {
    if (d.action === 0x11) return 'resourceRoutines clearHeap';
    if (d.action === 0x14) return `resourceRoutines loadFlObject obj=${d.args[0]} room=${d.args[1]}`;
    return `resourceRoutines sub=0x${d.action.toString(16)} ${d.args[0]}`;
  },
});

// ─── 0x27  stringOps ─────────────────────────────────────────────────
defineOp({
  name: 'stringOps',
  opcodes: [0x27],
  decode: (r) => {
    const sub = r.u8();
    const action = sub & 0x1f;
    switch (action) {
      case 0x01:
        // loadString: the literal can embed 0xFF escapes whose 2-byte args
        // may contain 0x00 — the escape-aware scan finds the true
        // terminator (a naive scan broke the copy-protection quiz #154).
        return { action, dest: null, args: [r.p8(sub, 1)], str: r.scummString() };
      case 0x02:
      case 0x05:
        return { action, dest: null, args: [r.p8(sub, 1), r.p8(sub, 2)], str: null };
      case 0x03:
        return { action, dest: null, args: [r.p8(sub, 1), r.p8(sub, 2), r.p8(sub, 3)], str: null };
      case 0x04:
        // getStringChar: the result consumes no mask bit — id takes 0x80,
        // index 0x40 (opcodes.md §5; off-by-one broke the insult matcher).
        return { action, dest: r.dest(), args: [r.p8(sub, 1), r.p8(sub, 2)], str: null };
      default:
        throw new Error(
          `stringOps: unknown subop 0x${action.toString(16).padStart(2, '0')} (raw=0x${sub.toString(16)})`,
        );
    }
  },
  exec(vm, slot, d) {
    switch (d.action) {
      case 0x01: {
        const id = d.args[0]!.value;
        vm.strings.set(id, d.str!);
        vm.annotate(`stringOps loadString id=${id} len=${d.str!.length}`);
        return;
      }
      case 0x02: {
        const dest = d.args[0]!.value;
        const src = d.args[1]!.value;
        const srcBuf = vm.strings.get(src);
        vm.strings.set(dest, srcBuf ? new Uint8Array(srcBuf) : new Uint8Array(0));
        vm.annotate(`stringOps copyString ${src}→${dest}`);
        return;
      }
      case 0x03: {
        const id = d.args[0]!.value;
        const idx = d.args[1]!.value;
        const ch = d.args[2]!.value;
        const buf = vm.strings.get(id);
        if (buf && idx >= 0 && idx < buf.length) buf[idx] = ch & 0xff;
        vm.annotate(`stringOps setStringChar id=${id}[${idx}] = 0x${(ch & 0xff).toString(16)}`);
        return;
      }
      case 0x04: {
        const id = d.args[0]!.value;
        const idx = d.args[1]!.value;
        const buf = vm.strings.get(id);
        const ch = buf && idx >= 0 && idx < buf.length ? buf[idx]! : 0;
        writeRef(d.dest!.ref, ch, slot, vm.vars);
        vm.annotate(`stringOps getStringChar id=${id}[${idx}] → 0x${ch.toString(16)}`);
        return;
      }
      default: {
        const id = d.args[0]!.value;
        const size = d.args[1]!.value;
        vm.strings.set(id, new Uint8Array(size));
        vm.annotate(`stringOps createString id=${id} size=${size}`);
      }
    }
  },
  format: (d) => {
    switch (d.action) {
      case 0x01: return `stringOps loadString id=${d.args[0]} "${renderBytes(d.str!)}"`;
      case 0x02: return `stringOps copyString ${d.args[0]},${d.args[1]}`;
      case 0x03: return `stringOps writeChar ${d.args[0]},${d.args[1]},${d.args[2]}`;
      case 0x04: return `stringOps readChar res=${d.dest} ${d.args[0]},${d.args[1]}`;
      default: return `stringOps newString ${d.args[0]},${d.args[1]}`;
    }
  },
});

// ─── 0xAC  expression ────────────────────────────────────────────────
// The one raw (non-decoded) family: subop 0x06 EXECUTES a nested opcode
// mid-stream, so decode and execution can't be separated — the live side
// stays the streaming evaluator (expression.ts); the static side decodes
// the same subop shapes, recursing into `nested` for 0x06.
defineRawOp({
  name: 'expression',
  opcodes: [0xac],
  exec(vm, slot) {
    evalExpression(slot, vm.vars, vm);
    vm.annotate('expression');
  },
  disasm(r, _opcode, nested) {
    let out = `expression res=${r.dest().label}`;
    while (true) {
      const s = r.u8();
      if (s === 0xff) break;
      const lo = s & 0x1f;
      if (lo === 1) out += ` push(${r.p16(s, 1)})`;
      else if (lo === 6) out += ` [${nested(r.u8(), r)}]`;
      else out += ` op${lo}`;
    }
    return out;
  },
});

// ─── 0x2E  delay ─────────────────────────────────────────────────────
defineOp({
  name: 'delay',
  opcodes: [0x2e],
  decode: (r) => ({ ticks: r.u8() | (r.u8() << 8) | (r.u8() << 16) }),
  exec(vm, slot, d) {
    slot.delayRemaining = d.ticks;
    slot.yield_();
    vm.annotate(`delay ${d.ticks}`);
  },
  format: (d) => `delay ${d.ticks}`,
});

// ─── 0x2B  delayVariable ─────────────────────────────────────────────
defineOp({
  name: 'delayVariable',
  opcodes: [0x2b],
  decode: (r) => ({ ticks: r.variable() }),
  exec(vm, slot, d) {
    slot.delayRemaining = d.ticks.value;
    slot.yield_();
    vm.annotate(`delayVariable ${d.ticks.value}`);
  },
  format: (d) => `delayVariable ${d.ticks}`,
});

// ─── Decoded-but-unimplemented ops ───────────────────────────────────
// Zero MI1 uses each. The shape is in the registry so the disassembler
// can decode them and the halt names the op; execution stays a loud halt.
function defineUnimplemented<D>(
  name: string,
  opcodes: number[],
  decode: (r: OperandReader, op: number) => D,
  format: (d: D) => string,
): void {
  defineOp({
    name,
    opcodes,
    decode,
    exec() {
      throw new Error(`${name} (0x${opcodes[0]!.toString(16)}) not implemented (no MI1 use)`);
    },
    format,
  });
}

defineUnimplemented('and', [0x17, 0x97],
  (r, op) => ({ dest: r.dest(), val: r.p16(op, 1) }),
  (d) => `and ${d.dest} val=${d.val}`);
defineUnimplemented('or', [0x57, 0xd7],
  (r, op) => ({ dest: r.dest(), val: r.p16(op, 1) }),
  (d) => `or ${d.dest} val=${d.val}`);
defineUnimplemented('stopObjectScript', [0x6e, 0xee],
  (r, op) => ({ obj: r.p16(op, 1) }),
  (d) => `stopObjectScript ${d.obj}`);
defineUnimplemented('getStringWidth', [0x67, 0xe7],
  (r, op) => ({ dest: r.dest(), str: r.p8(op, 1) }),
  (d) => `getStringWidth res=${d.dest} str=${d.str}`);
defineUnimplemented('getClosestObjActor', [0x66, 0xe6],
  (r, op) => ({ dest: r.dest(), a: r.p16(op, 1) }),
  (d) => `getClosestObjActor res=${d.dest} a=${d.a}`);
defineUnimplemented('debug', [0x6b, 0xeb],
  (r, op) => ({ val: r.p16(op, 1) }),
  (d) => `debug ${d.val}`);
defineUnimplemented('isActorInBox', [0x1f, 0x5f, 0x9f, 0xdf],
  (r, op) => ({ a: r.p8(op, 1), box: r.p8(op, 2), delta: r.i16() }),
  (d) => `isActorInBox a=${d.a} box=${d.box} -> ${d.delta}`);
defineUnimplemented('getActorScale', [0x3b, 0xbb],
  (r, op) => ({ dest: r.dest(), a: r.p8(op, 1) }),
  (d) => `getActorScale res=${d.dest} a=${d.a}`);
defineUnimplemented('getAnimCounter', [0x22, 0xa2],
  (r, op) => ({ dest: r.dest(), a: r.p8(op, 1) }),
  (d) => `getAnimCounter res=${d.dest} a=${d.a}`);
defineUnimplemented('dummy', [0xa7], () => ({}), () => 'dummy');

export const SEED_OPCODES: ReadonlyMap<number, OpcodeHandler> = buildSeedOpcodes();
export { OPCODE_DEFS } from './registry';
