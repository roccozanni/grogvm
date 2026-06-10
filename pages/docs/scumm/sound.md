# SCUMM v5 sound — `SOUN` resources and sound-gated waits

What MI1's `SOUN` resources contain, and the one place sound timing leaks
into game logic: cutscenes and transitions pace themselves by busy-waiting
on sound completion, so the interpreter has to know how long each sound
plays. This note is the data and that behavior; how GrogVM *times* sounds
to satisfy it is [engine/audio.md](../engine/audio.md).

## 1. Sound-gated waits

The canonical pacing idiom (g#57, g#107, g#108, g#122, g#131, g#143,
room-1 ENCD, …):

```
startSound N
breakHere
isSoundRunning g0 = sound N
equalZero g0 -> -10     ; g0 != 0 (still running) → loop back to breakHere
<loadRoom / startSound next / putActorInRoom / …>
```

`equalZero` jumps when the value is **non-zero**, so this is "yield each
game-frame, re-poll, fall through when the sound ends." For the transition
to be paced at all, the interpreter must report `isSoundRunning` truthfully
for the sound's real length — which means knowing that length.

The two distinct loop shapes:

- **`equalZero -> -10`** (jump **back** to `breakHere`) — a real wait
  gate: hold until the sound ends. These are what must hold.
- **`equalZero -> 2`** (jump **forward** over the `startSound`) — "start
  it unless it's already running." Not a wait.

`VAR_MUSIC_TIMER` (14) is a *separate* clock — auto-incremented per jiffy,
polled by the credits cutscene — unrelated to `isSoundRunning`. There is no
`wait`-for-sound opcode; all sound waits are `isSoundRunning` polls.

## 2. The `SOUN` resource formats

`SOUN` blocks live in `MONKEY.001`, indexed by the `DSOU` lane
(`{room, offset}` per sound id); resolve one exactly like a global script.
The top-level `SOUN` block uses the **inclusive** size convention (header
included); **everything nested below it is payload-only (exclusive)**.

MI1 (CD-DOS-VGA) has 105 `SOUN` blocks in three timing-relevant shapes.

### `SOU ` container → device renditions

A `SOU ` block holds one or more renditions of the same sound for
different hardware, the first listed being the primary one:

- **`SBL `** — digitized PCM. Its `AUdt` chunk wraps a **Creative Voice
  (VOC) block-1**: a type byte (`0x01`), a 24-bit LE length, a
  **time-constant**, a codec byte (`0x00` = 8-bit unsigned PCM), then the
  samples. The sample rate is encoded *in* the time-constant —
  `rate = 1e6 / (256 - tc)` — so it is per-sound, not fixed. (MI1's `AUhd`
  payload is a constant `00 00 80` of unclear meaning; MI1's SBL sounds
  carry `tc = 110` → ~6849 Hz. Playback length = `sampleBytes / rate`.)
- **`ROL `/`ADL `/`SPK `** — standard MIDI (Roland MT-32 / AdLib /
  PC-speaker). `MThd` gives ticks-per-quarter (`division`, 480 in MI1);
  the length is each `MTrk`'s delta-times summed against the tempo map
  (`FF 51 03` Set-Tempo events; default 500000 µs/quarter).

### 24-byte CD-audio trigger

Sound ids **100–129** are not `SOU ` containers but 24-byte commands
(`0x18 …`) that trigger a redbook **CD track**:

- **byte 16** = CD track number (1–24).
- **byte 17** = loop flag: `0x01` one-shot, `0xff` looping.

The track audio is **not** in `MONKEY.001` — it ships as separate
`TrackN.*` files (the IT CD-DOS-VGA rip uses FLAC `TrackN.fla`, the EN rip
MP3 `TrackN.mp3`; the original pressing had true redbook CD sessions). A
trigger's playback length is therefore that track file's length. The IT and
EN encodes agree to within a couple of frames (same music).

MI2 has no external track files — its sounds are all `SOU ` containers
(SBL/MIDI in `MONKEY2.001`), so the CD-trigger shape doesn't appear.

## 3. Which sounds gate

Every MI1 *wait-gated* sound is one of: an SBL effect (#28, ~2.7 s), a MIDI
piece (#50, ~4.8 s), or a **one-shot** CD track (#104–107 = track 6, the
~12.5 s "Il Viaggio" voyage theme; #117 = track 7). No wait-gate ever polls
a looping sound, so none can hang. Looping CD music (byte 17 = `0xff`)
plays until explicitly stopped and never gates a wait.

## 4. Beyond timing — the audio payload

Beyond the timing above, a `SOUN` also fully describes its *audio* — the
SBL samples, the MIDI note stream for each device, the iMUSE control data
(`soundKludge` / `VAR_SOUNDRESULT`; 0 MI1 uses, loud-halts). Synthesizing
it is output-backend territory — see
[engine/audio.md](../engine/audio.md) §4.
