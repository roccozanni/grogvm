# Audio Timing — the `AudioBackend` Seam

GrogVM has no sound synthesizer yet, and the first thing it needs from
"audio" isn't output at all — it's **timing**. Cutscenes and room
transitions pace themselves by busy-waiting on sound completion (the
`isSoundRunning` poll-loop idiom — see [sound.md](../scumm/sound.md) §1),
so the engine has to know **how long each sound plays** and report
`isSoundRunning` truthfully for that span. This note is how that's wired;
the SOUN resource formats the durations come from live in the SCUMM
reference doc.

The old stub returned `isSoundRunning → 0`, so every sound-gated loop fell
through on the tick the sound started — the cutscene collapsed (the "Le tre
prove" title flash, every sound-gated room change). Returning a constant
`1` would hang forever. The fix is to time each sound and report its
real running state.

## 1. The seam

The VM talks to an **`AudioBackend`** (`src/engine/sound/backend.ts`) for
everything sound-related; the backend owns the active-sound map and is the
single authority `isSoundRunning` polls. It's the timing analogue of the
`Renderer` / `Clock` seams — except the sound opcodes (`startSound`,
`isSoundRunning`, …) execute *inside* the VM, so the backend is reachable
from the VM as `vm.audio` (wired through `bootGame`, like the resolvers)
rather than read after the fact by the session.

**`SilentTimingBackend`** is the only backend for now: it tracks each
playing sound's remaining jiffies, drains them in `vm.tick()`'s per-jiffy
`beginTick` (next to the music-timer increment), and drops a sound at zero
— so `isRunning` flips false exactly when the real sound would have ended.
**No audio output**: it's silent by design. A real-output backend
(`WebAudioBackend`) will implement the same interface in a later phase; the
silent one ships everywhere meanwhile, including web play.

The backend owns the active-sound map, so savestate delegates to its
`serialize` / `restore` (mirroring the `drawnBoxes` precedent) and stays
backend-agnostic.

## 2. Resolving a sound's duration

`vm.getSoundResource(id)` resolves a sound id to a `SoundResource`
(`{ durationJiffies, looping }`), cached per id since SOUN data is
immutable. It loads the SOUN block bytes (`loadSound`) and hands them to
**`parseSound`**, which dispatches on the SOUN shape (see
[sound.md](../scumm/sound.md) §2) and times the primary rendition:

- **`SBL `** (digitized) — `sblDurationJiffies`: sample bytes ÷ the rate
  decoded from the VOC time-constant.
- **`ROL `/`ADL `/`SPK `** (MIDI) — `midiDurationJiffies`: the longest
  `MTrk`'s delta-times integrated against the tempo map.
- **24-byte CD trigger** — the track number + loop flag are read from the
  command; a one-shot's length comes from the CD-track map (below), a
  looping trigger reports `isRunning` true until stopped and never gates.

A missing resolver, an unresolvable id, or an unrecognized payload yields a
non-gating **0-jiffy** resource, so a busy-wait can never hang on it.

## 3. CD-track durations — read at load time

A CD trigger's real length is the redbook track's length, which lives in
the external `TrackN.{fla,mp3}` files, **not** in `MONKEY.001`. So — like
the other resources — the durations are read **once at load time**, not
lazily: the boot caller discovers the track files, reads just each file's
header (a partial ~2 KB read — the FLAC STREAMINFO or the MP3 Xing/Info
frame, never the multi-MB body), and hands the VM a plain `track → jiffies`
map (`cdTrackDurations`). `parseSound` looks a CD trigger up in that map; an
absent track leaves the sound non-gating.

`audioDurationJiffies` dispatches by content — FLAC (`fLaC` magic) via
STREAMINFO `totalSamples / sampleRate`, else MP3 via the Xing/Info frame
count (`frames × samplesPerFrame / sampleRate`, with a CBR
`bytes × 8 / bitrate` fallback). The two environments differ only in how
the header bytes are obtained:

- **node** — a partial `fs` read (`bootScummV5` → `readCdTrackDurations`).
- **browser** — a partial `File.slice` over the File System Access handle
  (`loadSessionGame`).

No track audio is ever fully loaded for timing.

## 4. Out of scope (later phase)

Real audio **output** — the `WebAudioBackend`: AdLib/MT-32 MIDI synthesis,
SBL sample playback, CD redbook, the iMUSE engine and its `soundKludge` /
`VAR_SOUNDRESULT` queries — all land later behind this same `AudioBackend`
interface. The `SoundResource` descriptor is the extension point: a real
backend reads the same parsed sounds, adding format / raw-bytes / rate.
