/**
 * SCUMM v5 system-variable index table — the **single source of truth**.
 *
 * These are the engine-reserved global variable indices for SCUMM v5
 * (Monkey Island 1 / 2). Scripts read and write them by index; the
 * engine gives several of them special meaning (timers, input state,
 * the per-frame driver script ids, …).
 *
 * This table is the *complete authoritative list* — provided so we
 * stop guessing indices empirically. **Not all are wired into the
 * engine yet.** A constant existing here only means "this index has
 * this meaning"; search for its use to see whether the engine acts on
 * it. Wire each one when a script actually needs it.
 *
 * ## Reconciliation notes (earlier empirical guesses vs. this table)
 *
 * A few indices the engine already touches were named by reverse-
 * engineering before this table existed. The truth:
 *
 *   - **52 is `VAR_CURSORSTATE`** (engine-managed cursor state), not a
 *     "left button down" var. An earlier hack pulsed index 52 on
 *     left-press believing MI1 boot #23 polled it to enter the title
 *     menu — but #23 idle-spins regardless and the menu actually
 *     appears from the music-timer gate (g14 > 5700). The pulse drove
 *     nothing and clobbered the var, so it was removed; the VM no
 *     longer writes 52. Clicks route through vm.handleSceneClick /
 *     handleVerbClick instead.
 *   - **14 is `VAR_MUSIC_TIMER`.** The credits cutscene waits on it,
 *     which is why auto-incrementing index 14 each tick is correct.
 *   - **15 / 16 are `VAR_ACTOR_RANGE_MIN` / `_MAX`**, NOT timers.
 *     They must not auto-increment (the old code did; fixed).
 *   - The real general-purpose timers are **`VAR_TMR_1..3` = 11..13**
 *     plus `VAR_TIMER` = 46, `VAR_TIMER_NEXT` = 19, `VAR_TIMER_TOTAL`
 *     = 47.
 *   - `bootGame` seeds indices 17/18/19/21 as "screen w/h / game id /
 *     charset" — those names are wrong (17/18 = camera min/max X,
 *     19 = `VAR_TIMER_NEXT`, 21 = `VAR_VIRT_MOUSE_Y`). The seeds are
 *     load-bearing scaffolding against uninitialised reads; a proper
 *     pass to seed the *right* indices is deferred (see boot.ts).
 */

export const VAR_KEYPRESS = 0;
export const VAR_EGO = 1;
export const VAR_CAMERA_POS_X = 2;
export const VAR_HAVE_MSG = 3;
export const VAR_ROOM = 4;
export const VAR_OVERRIDE = 5;
export const VAR_MACHINE_SPEED = 6;
export const VAR_ME = 7;
export const VAR_NUM_ACTOR = 8;
export const VAR_CURRENT_LIGHTS = 9;
export const VAR_CURRENTDRIVE = 10;
export const VAR_TMR_1 = 11;
export const VAR_TMR_2 = 12;
export const VAR_TMR_3 = 13;
export const VAR_MUSIC_TIMER = 14;
export const VAR_ACTOR_RANGE_MIN = 15;
export const VAR_ACTOR_RANGE_MAX = 16;
export const VAR_CAMERA_MIN_X = 17;
export const VAR_CAMERA_MAX_X = 18;
export const VAR_TIMER_NEXT = 19;
export const VAR_VIRT_MOUSE_X = 20;
export const VAR_VIRT_MOUSE_Y = 21;
export const VAR_ROOM_RESOURCE = 22;
export const VAR_LAST_SOUND = 23;
export const VAR_CUTSCENEEXIT_KEY = 24;
export const VAR_TALK_ACTOR = 25;
export const VAR_CAMERA_FAST_X = 26;
export const VAR_SCROLL_SCRIPT = 27;
export const VAR_ENTRY_SCRIPT = 28;
export const VAR_ENTRY_SCRIPT2 = 29;
export const VAR_EXIT_SCRIPT = 30;
export const VAR_EXIT_SCRIPT2 = 31;
export const VAR_VERB_SCRIPT = 32;
export const VAR_SENTENCE_SCRIPT = 33;
export const VAR_INVENTORY_SCRIPT = 34;
export const VAR_CUTSCENE_START_SCRIPT = 35;
export const VAR_CUTSCENE_END_SCRIPT = 36;
export const VAR_CHARINC = 37;
export const VAR_WALKTO_OBJ = 38;
export const VAR_DEBUGMODE = 39;
export const VAR_HEAPSPACE = 40;
export const VAR_RESTART_KEY = 42;
export const VAR_PAUSE_KEY = 43;
export const VAR_MOUSE_X = 44;
export const VAR_MOUSE_Y = 45;
export const VAR_TIMER = 46;
export const VAR_TIMER_TOTAL = 47;
export const VAR_SOUNDCARD = 48;
export const VAR_VIDEOMODE = 49;
export const VAR_MAINMENU_KEY = 50;
export const VAR_FIXEDDISK = 51;
export const VAR_CURSORSTATE = 52;
export const VAR_USERPUT = 53;
export const VAR_V5_TALK_STRING_Y = 54;
export const VAR_SOUNDRESULT = 56;
export const VAR_TALKSTOP_KEY = 57;
export const VAR_FADE_DELAY = 59;
export const VAR_NOSUBTITLES = 60;
export const VAR_SOUNDPARAM = 64;
export const VAR_SOUNDPARAM2 = 65;
export const VAR_SOUNDPARAM3 = 66;
/** 1 = keyboard, 2 = joystick, 3 = mouse. */
export const VAR_INPUTMODE = 67;
export const VAR_MEMORY_PERFORMANCE = 68;
export const VAR_VIDEO_PERFORMANCE = 69;
export const VAR_ROOM_FLAG = 70;
export const VAR_GAME_LOADED = 71;
export const VAR_NEW_ROOM = 72;
