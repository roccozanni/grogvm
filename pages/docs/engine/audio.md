# Audio Timing — the `AudioBackend` Seam

GrogVM's audio is silent — by design, because the first thing the engine
needs from "audio" isn't output at all: it's **timing**. Cutscenes and room
transitions pace themselves by busy-waiting on sound completion (the
`isSoundRunning` poll-loop idiom — see [sound.md](../scumm/sound.md) §1),
so the engine has to know **how long each sound plays** and report
`isSoundRunning` truthfully for that span. This note is how that's wired;
the SOUN resource formats the durations come from live in the SCUMM
reference doc.

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

The shipped implementation is a **silent timing backend**: it tracks each
playing sound's remaining jiffies, drains them in the per-jiffy tick
prologue (next to the music-timer increment), and drops a sound at zero —
so `isSoundRunning` flips false exactly when the real sound would have
ended. **No audio output** — it's silent by design, and it ships
everywhere, including web play.

The backend owns the active-sound map, so the save state delegates that
map's serialization and restore to the backend itself — the save format
stays backend-agnostic.

## 2. Resolving a sound's duration

A sound id resolves to a small descriptor — duration in jiffies plus a
looping flag — cached per id, since SOUN data is immutable. The parser
dispatches on the SOUN shape (see [sound.md](../scumm/sound.md) §2) and
times the primary rendition:

- **`SBL `** (digitized) — sample bytes ÷ the rate decoded from the VOC
  time-constant.
- **`ROL `/`ADL `/`SPK `** (MIDI) — the longest `MTrk`'s delta-times
  integrated against the tempo map.
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
map. The CD-trigger parse looks the track up in that map; an absent track
leaves the sound non-gating.

The duration probe dispatches by content — FLAC (`fLaC` magic) via
STREAMINFO `totalSamples / sampleRate`, else MP3 via the Xing/Info frame
count (`frames × samplesPerFrame / sampleRate`, with a CBR
`bytes × 8 / bitrate` fallback). The two environments differ only in how
the header bytes are obtained: a partial file read in Node, a partial
`File.slice` over the File System Access handle in the browser. No track
audio is ever fully loaded for timing.

## 4. What the seam leaves to a real-output backend

Real audio **output** — AdLib/MT-32 MIDI synthesis, SBL sample playback,
CD redbook, the iMUSE engine and its `soundKludge` / `VAR_SOUNDRESULT`
queries — belongs behind this same `AudioBackend` interface. The sound
descriptor is the extension point: an output backend reads the same parsed
sounds, adding format / raw-bytes / rate.
