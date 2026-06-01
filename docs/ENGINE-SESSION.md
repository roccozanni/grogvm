# EngineSession — Phase 10, Task 1

The single object the shell holds to run a game. This doc is the **scope
contract** for Phase 10 Task 1 — read it before touching `engine/session/`.
Architecture rationale lives in `ARCHITECTURE.md` §5.9 and §11 (Q7, Q10); this
doc is the *task-level* detail: exact API, what moves, what does **not**, and
the test plan.

---

## 1. What this task is (and is not)

**Goal:** create `src/engine/session/` — a headless, fully unit-tested
`EngineSession` that wires the VM + the frame compositor + an injected
`Renderer` + an injected `Clock` into one object with a small control surface.
This is the seam every later Phase-10 surface (Play, Debug) is built on.

### In scope

- The `EngineSession` factory `createSession(game, renderer, clock, opts?)`.
- The `Clock` injection seam + a headless `ManualClock`.
- The game loop, ported off `requestAnimationFrame` onto the injected clock:
  throttle to a target rate, batch ticks for rates above the clock cadence,
  idle auto-pause, all-slots-dead pause, halt pause.
- Lifecycle: boot, reboot, snapshot, restore (preserving play/pause state).
- Debug drivers: `step` (one jiffy), `enterRoom` (warp + settle), `skipCutscene`
  (run until control returns).
- Frame production: compose the current VM state into an indexed framebuffer,
  `present()` it to the injected renderer, and emit a `FrameInfo` to `onFrame`
  subscribers.
- Engine-level input via `sendInput` (mouse position vars, button holds,
  Escape → `abortCutscene`).
- A `resize(width,height)` method on the `Renderer` interface (rooms change
  dimensions; the session calls it before presenting a differently-sized
  frame).
- Comprehensive headless tests (`MemoryRenderer` + `ManualClock`), gated on
  real MI1 data the same way `mi1-smoke.test.ts` / `savestate.test.ts` are.

### Explicitly NOT in scope (later tasks)

- **Do not rewire `vm-inspector.ts`.** See §2.
- **No UI / DOM / reactive core** — that's tasks 2–6. The session is headless.
- **No verb/sentence click dispatch.** `sendInput` handles only engine-level
  input. "A left click runs verb-input script #4 against the hovered object"
  is verb-bar logic that belongs to the **Play surface (task 5)**, which reads
  `session.vm` and drives the existing input-script path. `FrameInfo` and
  `session.vm` give task 5 everything it needs.
- **No overlay rendering** (cursor / verb bar / sentence / talk text). Those
  are drawn by the Play surface on separate canvases (task 5). The session
  produces only the 320×200-class *indexed game framebuffer* (room + actors +
  objects), exactly what `composeFrame` produces today.
- **No `RafClock`.** The browser clock (uses `requestAnimationFrame`) is
  shell-side and gets written in task 3/5. Engine stays DOM-free.

---

## 2. Why we do NOT touch `vm-inspector.ts` in this task

The current loop, lifecycle, idle-detection, save/load, warp, and skip logic
all live inside `src/shell/player/vm-inspector.ts` (a ~1900-line god-object).
The Phase-10 plan **deletes** that file in task 7; its panels are
re-implemented on the session + reactive core in tasks 5–6.

So rewiring the old inspector to consume the session would be **throwaway work
on a file already marked for deletion.** Instead:

- Task 1 builds the session as the **canonical** home of this logic, ported
  cleanly (clock-injected, no rAF) and proven by headless tests.
- The inspector is left **running on its own existing rAF loop**, unchanged.
  The app keeps working exactly as today.
- This means the loop logic is **temporarily duplicated** (inspector's rAF
  copy + the session's canonical copy). That is the deliberate, lesser evil —
  accepted until tasks 5–7 build the real surfaces on the session and delete
  the inspector. If you're a fresh session confused by "why are there two
  loops" — this is why.

---

## 3. The API

```ts
// engine/session/clock.ts
export interface Clock {
  /** Begin calling onTick(nowMs) repeatedly. nowMs is a monotonic
   *  millisecond timestamp (performance.now() in the browser; supplied
   *  by the test in ManualClock). */
  start(onTick: (nowMs: number) => void): void;
  stop(): void;
}

/** Headless clock: the test (or a Node driver) drives time by hand.
 *  No rAF, no Date.now — fully deterministic. */
export class ManualClock implements Clock {
  start(onTick: (nowMs: number) => void): void;
  stop(): void;
  /** Advance the clock by deltaMs and fire one onTick at the new time. */
  advance(deltaMs: number): void;
  get running(): boolean;
}
```

```ts
// engine/session/types.ts
export interface SessionGame {       // everything bootGame needs, bundled
  readonly resourceFile: ResourceFile;
  readonly index: IndexFile;
  readonly loff: RoomOffsetTable;
  readonly gameId: GameId;
}

export type InputEvent =
  | { type: 'move'; roomX: number; roomY: number }
  | { type: 'down'; button: 'left' | 'right'; roomX: number; roomY: number }
  | { type: 'up';   button: 'left' | 'right' }
  | { type: 'key';  key: string };   // 'Escape' → abortCutscene

export interface FrameInfo {
  readonly tickCount: number;
  readonly framed: boolean;             // true if a game frame ran (not just a jiffy)
  readonly width: number;
  readonly height: number;
  readonly roomId: number | null;
  readonly palette: Uint8Array;         // 768 B; room palette, else last-seen/default
  readonly transparentIndex: number | null;
  readonly framebuffer: Uint8Array;     // a COPY of the presented indexed frame (w*h)
  readonly compose: ComposeFrameResult; // actorsDrawn / skipped* diagnostics
  readonly halted: boolean;
}

export interface SessionStatus {
  readonly playing: boolean;
  readonly tickCount: number;
  readonly idleReason: string | null;   // set on auto-pause (idle / all-dead / loaded)
  readonly halted: boolean;
  readonly tickRateHz: number;
}

export interface EngineSession {
  readonly vm: Vm;                       // live VM (current after restore/reboot); Debug reads it

  // clock control (arms/disarms the injected clock; never calls rAF itself)
  play(): void;
  pause(): void;
  step(): FrameInfo;                     // advance exactly one jiffy, present, emit
  setRate(hz: number): void;

  sendInput(ev: InputEvent): void;

  snapshot(label?: string, savedAt?: number): SaveState;
  restore(state: SaveState): void;       // boots fresh + restores; preserves play/pause
  reboot(): void;                        // fresh boot of the same game

  // debug drivers
  enterRoom(roomId: number): void;       // warp + settle the entry script
  skipCutscene(): boolean;               // run until control returns; true if reached

  onFrame(cb: (f: FrameInfo) => void): () => void;  // subscribe; returns unsubscribe
  status(): SessionStatus;
  dispose(): void;
}

export function createSession(
  game: SessionGame,
  renderer: Renderer,
  clock: Clock,
  opts?: { bootParam?: number; tickRateHz?: number },
): EngineSession;
```

`session.vm` is a **getter** over a mutable internal reference: `restore` and
`reboot` swap the VM, and callers must always see the current one.

---

## 4. What gets ported from the inspector (semantics to preserve)

Port these *faithfully* (clean clock-injected versions; the inspector keeps its
rAF originals until deletion):

| Inspector source | Session home | Notes |
|---|---|---|
| `oneTick` | internal `runTick` | `vm.tick()` + `tickCount++`; bail on halt |
| `yieldFingerprint` | internal | slots(status/pc) + moving actors + anim cursors + last 3 trace mnemonics per slot |
| `checkIdleAndUpdateStreak` | internal | cutscene guard; `IDLE_STREAK_THRESHOLD = 10` |
| `scheduleNextTick` throttle/batch | clock callback | `minInterval = 1000/hz`; `batch = clamp(floor(elapsed/minInterval), 1, MAX_TICKS_PER_FRAME=64)` |
| all-dead pause | clock callback | `progressed = resumed \|\| ran>0 \|\| anyMoving \|\| delaying` |
| `bootFresh` | `reboot` | `bootGame(...).vm`, reset tracking |
| `loadSnapshot` (play-state preserving) | `restore` | was-playing → resume; else paused with an idle banner |
| `togglePlay` | `play` / `pause` | reset idle tracking on play |
| `skipCutscene` | `skipCutscene` | run until `idle && some verb.state==='on'`; cap `MAX_SKIP_TICKS=20000` |
| `warpToRoom` | `enterRoom` | `vm.enterRoom` + settle ≤400 ticks |
| `installVm` tracking reset | internal `adopt` | zero tickCount/idle/palette caches |
| `updateFrame` compose+present | internal `composeAndPresent` | `composeFrame` → `renderer.present`; emit `FrameInfo` |

Constants: `MAX_TICKS_PER_FRAME = 64`, `IDLE_STREAK_THRESHOLD = 10`,
`MAX_SKIP_TICKS = 20000`, `WARP_SETTLE_TICKS = 400`,
`MNEMONICS_PER_SLOT_IN_FINGERPRINT = 3`.

### Frame production detail

`composeAndPresent(framed)`:
1. `room = vm.loadedRoom`; `width = room?.width ?? 320`, `height = room?.height ?? 144`.
2. Grow the reusable framebuffer to `width*height` if needed; take a
   `subarray(0, w*h)`.
3. `composeFrame({ room, framebuffer, actors: vm.actors.inRoom(vm.currentRoom),
   getCostume: id=>vm.getCostume(id), objectDrawQueue: vm.objectDrawQueue,
   getObjectState: id=>vm.objectStates.get(id) ?? 1 })` — `composeFrame`
   already handles `room===null` (fills index 0).
4. If `width/height` changed since last present → `renderer.resize(w,h)`.
5. Room loaded → `setPalette(room.palette)`, `setTransparentIndex(room.transparentIndex)`.
   No room → present on a black palette (index 0 = black, transparent = null)
   so the backdrop is predictably black; cache `lastPalette` /
   `lastTransparentIndex` for `FrameInfo` (the shell overlays want colour
   continuity through the brief no-room interval — task 5).
6. `renderer.present(framebuffer)`.
7. Build `FrameInfo` (copy the framebuffer), notify `onFrame` subscribers.

### Input detail (`sendInput`)

- `move` / `down`: write `vm.mouseRoomX/Y` and the four cursor vars
  (`VAR_MOUSE_X=44`, `VAR_MOUSE_Y=45`, `VAR_VIRT_MOUSE_X=20`, `VAR_VIRT_MOUSE_Y=21`
  — import the names from `engine/vm/vars.ts`, do not hardcode).
- `down`/`up`: set/clear `vm.input.leftHold` / `rightHold`.
- `key` `'Escape'`: `vm.abortCutscene()`.
- That's the whole engine-level surface; verb dispatch is task 5.

---

## 5. Renderer.resize

Add to the `Renderer` interface (`engine/render/renderer.ts`):

```ts
/** Resize the backing surface to width×height native pixels. */
resize(width: number, height: number): void;
```

- `Canvas2DRenderer`: make `width`/`height` mutable; `resize` sets
  `canvas.width/height` (which resets the 2D context, so re-apply
  `imageSmoothingEnabled = false`) and updates the stored dims used by
  `present`'s size check.
- `MemoryRenderer`: record `width`/`height` (handy for assertions); `present`
  already accepts any size.
- Update the existing renderer tests for the new method.

---

## 6. Test plan (`engine/session/session.test.ts`)

Gate on real MI1 the same way the other integration tests do:
`const hasData = existsSync('games/MI1-IT-CD-DOS-VGA/MONKEY.000') && existsSync('games/MI1-IT-CD-DOS-VGA/MONKEY.001')`,
then `describe.skipIf(!hasData)`. Build the `SessionGame` from the parsed files.

Assertions (headless — `MemoryRenderer` + `ManualClock`):

1. **Boot + step presents a frame.** After `createSession`, `step()` N times
   reaches room 33 lit, no halt; `MemoryRenderer.presentCount > 0`,
   `framebuffer.length === width*height`, palette is non-grey, and the returned
   `FrameInfo` matches (`roomId`, dims, `compose.actorsDrawn ≥ 1`).
2. **Loop runs without spurious pause.** `play()` from boot, drive the
   `ManualClock` ~300 frames: `status().playing` stays true, `tickCount`
   grows, frames present, a room loads. (Proves the progress / cutscene-guard
   paths don't *mis*fire. NB: the *positive* idle auto-pause is hard to trigger
   headlessly for MI1 — room 33's ego idle animation keeps the yield
   fingerprint changing, so `checkIdle` never settles there and `skipCutscene`
   caps at `MAX_SKIP_TICKS`. The idle-pause code is ported faithfully; its
   positive trigger is exercised in-app via the Debug surface. `skipCutscene`
   is tested as a synchronous drive-through to interactive room 33.)
3. **Throttle.** `setRate(10)` then advance the clock by small deltas →
   fewer ticks than at 60 Hz for the same elapsed time.
4. **Snapshot/restore round-trip.** `snapshot()` → mutate/advance → `restore()`
   → `session.vm` is back in the saved room and re-`snapshot()` is byte-equal
   (mirror the savestate integration test, but through the session API). Verify
   `restore` preserves play state (was-playing resumes).
5. **sendInput.** `sendInput({type:'move',roomX,roomY})` sets `vm.mouseRoomX/Y`
   and the four vars; `down`/`up` toggle the holds; `key Escape` calls
   `abortCutscene` (assert via a cutscene-active fixture or that it returns
   without throwing when none active).
6. **dispose.** Stops the clock (`clock.running === false`) and disposes the
   renderer.

Pure unit tests for `ManualClock` (advance fires the callback; stop unsubss)
can live in the same file or `clock.test.ts`.

---

## 7. Definition of done

- `src/engine/session/{clock,types,session,index}.ts` exist; `index.ts`
  re-exports the public surface.
- `Renderer.resize` added + implemented in both renderers + their tests updated.
- `engine/session/session.test.ts` green (and skips cleanly without MI1 data).
- `pnpm vitest run` green; `tsc --noEmit` clean.
- `vm-inspector.ts` and the rest of the shell are **unchanged** and the app
  still runs identically (the session is additive this task).
- `PROGRESS.md` Phase 10 task 1 checked off with a one-line note pointing here.
