# Audio — the `AudioBackend` Seam and the Web Audio Output

GrogVM's audio splits in two: a **timing core** that runs in every
environment, and a **real-output backend** for the browser that layers
audible playback on top of it. The split exists because the first thing the
engine needs from "audio" isn't output at all: it's **timing**. Cutscenes
and room transitions pace themselves by busy-waiting on sound completion
(the `isSoundRunning` poll-loop idiom — see [sound.md](../scumm/sound.md)
§1), so the engine has to know **how long each sound plays** and report
`isSoundRunning` truthfully for that span — whether or not anything is
audible. The SOUN resource formats the durations come from live in the
SCUMM reference doc.

The two naive answers both fail: a stub that reports "not running" lets
every sound-gated loop fall through on the tick the sound starts — the
cutscene collapses (the "Le tre prove" title flash, every sound-gated room
change) — while a constant "running" hangs the wait forever. So each sound
is timed, and reports its real running state.

## 1. The seam

The VM talks to an injected **`AudioBackend`** for everything
sound-related; the backend owns the active-sound map and is the single
authority `isSoundRunning` polls. It's the timing analogue of the
renderer / clock seams — except the sound opcodes (`startSound`,
`isSoundRunning`, …) execute *inside* the VM, so the backend is wired
into the VM at boot (like the resource resolvers) rather than read after
the fact by the session.

Two implementations exist:

- A **silent timing backend** — the default everywhere, and the only one
  headless runs (tests, the walkthrough harness) ever see. It tracks each
  playing sound's remaining jiffies, drains them in the per-jiffy tick
  prologue (next to the music-timer increment), and drops a sound at zero —
  so `isSoundRunning` flips false exactly when the real sound would have
  ended.
- The **Web Audio backend** (§4), which the browser play surface injects.
  It *wraps* a silent timing backend and delegates every timing question to
  it, so gating, saves, and determinism are identical in both builds —
  audible output is strictly a side effect.

The backend owns the active-sound map, so the save state delegates that
map's serialization and restore to the backend itself — the save format
stays backend-agnostic.

## 2. The sound descriptor — timing + rendition

A sound id resolves to a small descriptor, cached per id (SOUN data is
immutable): a **duration** in jiffies, a **looping** flag, and the
**output rendition** — what a real-output backend should play.

The duration comes from the *first listed* (primary) rendition of the
sound's `SOU ` container (see [sound.md](../scumm/sound.md) §2):

- **`SBL `** (digitized) — sample bytes ÷ the rate decoded from the VOC
  time-constant.
- **`ROL `/`ADL `/`SPK `** (MIDI) — the longest `MTrk`'s delta-times
  integrated against the tempo map.
- **24-byte CD trigger** — the track number, loop flag, and start cue are
  read from the command; a one-shot's length is the track's remainder after
  the cue (track lengths from the CD-track map, §3), a looping trigger
  reports `isRunning` true until stopped and never gates.

The rendition is picked **independently of the timing**, by the hardware
preference of a SoundBlaster-equipped DOS machine: digitized `SBL` when
present, else `ADL`, then `ROL`, then `SPK`. The two can be different
blocks of the same sound — a `[ROL SBL …]` sound is timed by its ROL piece
but heard via its SBL sibling; renditions of one sound agree closely in
length, so the gate is unaffected.

**Fine print (MI1):** of the 105 SOUN blocks, 62 `SOU` containers carry an
SBL rendition, 28 are CD triggers, and 15 are ADL-only. `ROL` never appears
without an `SBL` sibling, so MT-32 synthesis buys no coverage. Every
wait-gated sound is digitized or CD, so gating never depends on a MIDI
rendition.

A missing resolver, an unresolvable id, or an unrecognized payload yields a
non-gating **0-jiffy** silent resource, so a busy-wait can never hang on it.

## 3. CD-track durations — read at load time

A CD trigger's real length is the redbook track's length, which lives in
the external `TrackN.{fla,mp3}` files, **not** in `MONKEY.001`. So — like
the other resources — the durations are read **once at load time**, not
lazily: the boot caller discovers the track files, reads just each file's
header (a partial ~2 KB read — the FLAC STREAMINFO or the MP3 Xing/Info
frame, never the multi-MB body), and hands the VM a plain `track → jiffies`
map. The CD-trigger parse looks the track up in that map; an absent track
leaves the sound non-gating.

The duration probe dispatches by content — FLAC (`fLaC` magic) via
STREAMINFO `totalSamples / sampleRate`, else MP3 via the Xing/Info frame
count (`frames × samplesPerFrame / sampleRate`, with a CBR
`bytes × 8 / bitrate` fallback). The two environments differ only in how
the header bytes are obtained: a partial file read in Node, a partial
`File.slice` over the File System Access handle in the browser. No track
audio is ever fully loaded for timing.

## 4. The Web Audio output backend

The browser backend renders the descriptor's rendition while the wrapped
timing core keeps answering the questions. One rule organizes everything:
**the virtual clock is the authority, playback is derived state.**

**Digitized (`SBL`) effects** play through Web Audio: the 8-bit unsigned
samples become a Float32 `AudioBuffer`, linear-resampled to the context
rate at decode time — the Web Audio spec only guarantees buffer rates down
to 8000 Hz and MI1's SBL sounds run ~6849 Hz — and cached per sound id.

**CD tracks** play through one `HTMLAudioElement` per active track,
streaming from the local `TrackN.{fla,mp3}` file over an object URL. The
element streams rather than decodes: a multi-minute track expanded by
`decodeAudioData` is hundreds of MB of PCM. Looping triggers use the
element's native `loop`.

**The media position is derived from the virtual clock**, never from when
playback physically began. Each CD voice counts the jiffies the timing core
advances it, and the element is *seeked* to `cue + elapsed` (loop-wrapped
against the track length) at every point playback (re)engages: when
`play()` first succeeds, on unmute, and on a once-a-second drift check with
a small tolerance. A start delayed by the file fetch, a late unmute, or a
stall therefore joins the music exactly where the script timeline says it
should be — which is what keeps the credits text and the title theme
aligned (their pacing shares one clock; see [sound.md](../scumm/sound.md)
§4).

**Output always starts muted.** Browsers refuse audible playback before a
user gesture, so the play surface ships a speaker toggle (highlighted while
muted — the lit button is the unmute cue) and the unmute click *is* the
gesture. Mute never stops playback: elements keep rolling silently
(`el.muted`, a zero master gain for PCM), so the timeline runs on schedule
from the first tick and unmuting joins mid-stream. Autoplay-policy
*detection* was tried and dropped — `navigator.getAutoplayPolicy` is
Firefox-only — and no preference is persisted: every session starts muted,
one click brings sound in at the right offset.

**A hidden tab freezes output with the VM clock.** Backgrounding the tab
stops the rAF-driven clock, so the backend pauses its elements and suspends
the context on `visibilitychange`: a background tab is silent, and
returning resumes both clocks from the same standstill — no drift, no
corrective seek. The drift check stays armed for stalls that aren't
visibility-shaped (load spikes), where snapping to the virtual position is
the intended behavior.

**Expired voices are swept, not trusted to end.** Whenever the timing core
drops a sound — natural expiry, an explicit stop, a cutscene skip
fast-forwarding virtual time — the per-jiffy sweep kills its voice. Output
can never outlive the virtual clock.

**What stays silent:** the MIDI renditions have no synthesizer, so an
ADL-only sound (15 effects in MI1, e.g. the lookout's revisit theme #98) is
timed but inaudible, as is iMUSE control data (`soundKludge`; 0 MI1 uses,
loud-halts). A restored save resumes inaudibly until the game next starts a
sound — the snapshot stores ids, not renditions; music returns on the next
room change.
