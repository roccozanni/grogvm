---
title: How We Collaborate — The Working Contract
description: GrogVM is built by a human and an AI agent in tight, reviewed loops — plan first, engine-faithful always, honest about uncertainty, and the human holds the commit button.
---

# How We Collaborate — The Working Contract

GrogVM is built **by a human and an AI agent, together**: the human sets
direction, reviews every plan, verifies in the browser, and owns every
commit; the agent disassembles, implements, drives the engine headless, and
writes these docs. This section is the method — and the agent's normative
briefing, paired with the operational `AGENTS.md` at the repo root. Its
siblings: [where knowledge lives](knowledge.md),
[how claims get verified](verification.md).

## What the project is for

Learning — understanding the SCUMM v5 engine (MI1 CD/VGA, MI2 DOS) by
rebuilding it, not shipping a ScummVM alternative. So: clarity beats
performance; work proceeds in small runnable steps, each landing something
visible and tested; and **debug/inspection UI is permanent, never
scaffolding** — the engine doubles as a learning tool, so removing
inspection degrades the point.

## Plan first, implement second

Significant work starts as a written plan — **Goal**, **Definition of
done**, **Tasks**, **Design notes**, **Out of scope** — in `PROGRESS.md`,
reviewed before any code is touched. Only the active work is detailed;
everything further out stays a one-liner, because speculative breakdowns rot
before they're reached.

## Engine-faithful, no shortcuts

Every change is the final, SCUMM-faithful solution: confirm the real
mechanism *first* — disassemble the original, drive the engine to the
moment, observe the original running — before editing, and when the faithful
fix and a quick workaround disagree, faithful wins. If faithful needs a
bigger refactor, raise the tradeoff openly. An approximation may ship, but
only **surfaced and tracked in `PROGRESS.md`**, never buried. Two boundary
rules: **ScummVM's source is never consulted, in any form** (claims ground
in the games' bytecode and observed original behaviour — see
[verification](verification.md)); and long-circulating reverse-engineering
notes are cited neutrally, divergences explained without judgment.

## Honest uncertainty

"My hypothesis is X — refresh and tell me what you see" is welcome;
iterating empirically on a hard problem is the norm. A claim is either
verified or labeled a hypothesis — confident-sounding guesses are not.

## Surgical edits

Changes stay focused on the thing being changed; "while I'm here" rewrites
of working code need to be asked for.

## Code style

Architectural rules travel with the
[architecture](../engine/architecture.md); the working-style rules:

- **Test-first** — tests land in the same edit, against synthetic fixtures
  (the engine core is headless-testable).
- **No back-compat shims, feature flags, or premature abstraction** — three
  similar lines beat a misfit helper; trust internal callers, validate at
  the boundary; new serialized fields are required, old saves invalidated by
  policy.
- **Comments are a last resort** — see [where knowledge lives](knowledge.md).
- **No emojis** in code or commits (docs may use ⚠️ sparingly, for real
  warnings).

## The human holds the commit button

Work lands on `main`, and **only the human commits**, after confirming in
their own browser. The agent never commits or branches unasked, and never
launches a browser or dev server to "verify" itself — in-browser
confirmation is the human's half of the loop, rendering real pixels headless
is the agent's. Commit messages carry no assistant attribution.

## A work session, end to end

1. Read `PROGRESS.md` — the work ahead lives under **Next**.
2. Write the plan; wait for review.
3. Implement in order, types green and tests passing at each step.
4. Verify together — headless evidence plus in-browser confirmation (unit
   tests can't catch "this looks wrong").
5. On "commit": update `PROGRESS.md` first (what shipped, the decisions, the
   fresh lab notes), then commit.

Sessions *wrap* rather than stop — draining the fresh lab notes into the
docs, the pipeline in [where knowledge lives](knowledge.md).
