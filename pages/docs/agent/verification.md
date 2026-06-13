---
title: Verification — Behaviour, Not Bookkeeping
description: How claims earn trust in GrogVM — disassemble the original's bytecode, drive the real game headless, render real pixels, treat the original engine as the only oracle, and track every known approximation explicitly.
---

# Verification — Behaviour, Not Bookkeeping

The central rule: **a claim is trusted only once the real outcome has been
observed.** A visual bug means rendering real pixels — bookkeeping can be
perfectly consistent while the screen is wrong (scale, box, and frame all
check out while the actor's eyes have vanished). Behaviour means reproducing
the real flow — booting and driving the game to the moment — not simulating
around it. And any statement about SCUMM grounds in primary sources, never
recollection.

## The instruments

**Static — the disassembler.** A tested, read-only SCUMM v5 disassembler
answers "what does this script actually do", the first step of nearly every
investigation. Its decode tables are defined once, in the same registry the
executing dispatcher reads, so reader and executor can't disagree on operand
sizes, and a corpus test pins zero misalignments across every script. Even
it isn't axiomatic: a doubtful encoding is verified against real bytecode —
does everything downstream still align? — not against the engine's beliefs.
CLI: `npm run disgrogate`.

**Dynamic — the harness.** The [test harness](../engine/harness.md) loads,
boots, and drives the real game headless through the genuine input path on a
seeded RNG, and renders the full screen to a PNG through the engine's own
pipeline (`npm run mugshot`). A behaviour question is answered by a driven
reproduction, not a thought experiment.

**The oracle — the original engine.** What SCUMM *should* do is established
by observing it: the original release in the browser, reference-playthrough
screenshots, DOSBox/ScummVM captures. Two guards: **provenance first** —
confirm an external recording is the right *version* before tuning against
it (sampled/remastered ports masquerade as DOS originals); and **ScummVM's
source is never consulted, in any form** — claims ground in bytecode plus
observed behaviour, the clean-room half of [the contract](collaboration.md).

## The regression net

Each game grows a from-boot playthrough — one seeded VM driven through the
game's own solution beat by beat, the last green beat marking the frontier;
its design (headless, deterministic, failure localized to one beat) is
documented with [the harness](../engine/harness.md). A fixed bug's guard
doesn't live there, though: once the root cause is pinned it becomes a
synthetic unit test capturing the mechanism, independent of any game data.

## Knowing what we don't know: divergence tiers

Every reimplementation diverges somewhere; the discipline is knowing *how*
each divergence would announce itself.

- **Tier 1 — loud.** The VM halts on an unknown opcode rather than guessing
  past it; even known-but-unimplemented paths with zero uses in the target
  game halt loudly by name. A freeze that points at its own cause is a
  feature.
- **Tier 2 — silent, self-flagged.** Known approximations — behaviour that
  works for everything observed but isn't yet the confirmed original
  mechanism. They live as a hand-curated checklist in `PROGRESS.md`, each
  prioritized by likelihood-of-biting × severity and describing exactly what
  would look wrong if it fired. (An approximation may ship; burying it may
  not.)
- **Tier 3 — unknown unknowns.** Divergences not yet noticed at all. Only
  differential observation against the running original surfaces them —
  which is why reference playthroughs and screenshot batches keep being
  collected even when nothing seems wrong.

## Symptom-level nets

Some bug classes are cheaper to catch by symptom than by cause. The debug
panel's **hang watchdog** fires when several consecutive clicks each produce
no progress — no room change, no talk, no committed sentence, no walk. It
fingerprints *progress-only* signals, ignoring state that always churns
(every click transiently spawns the verb-redraw script; the music timer
ticks variables constantly), and names the room and the script it suspects —
turning a whole class of input-misroute and wait-forever hangs into an
immediate pointer.

## Probes, and when they grow up

Investigation produces throwaway scripts; they live in a gitignored scratch
directory, never in the test suites. Before writing one, reach for the
committed building blocks — the harness to drive and render, the
disassembler to read, the resource inspectors for static dossiers. A probe
that proves reusable graduates to a committed, npm-run command-line tool: a
thin front-end over a tested engine module, never an owner of behaviour.
