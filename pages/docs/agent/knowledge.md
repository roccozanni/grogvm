---
title: Where Knowledge Lives — Lab Notebook → Docs
description: The pipeline that keeps the project's memory honest — findings land in PROGRESS.md while fresh, wrap sessions drain the facts into these docs, git keeps the journey, and code comments stay a last resort.
---

# Where Knowledge Lives — Lab Notebook → Docs

A reverse-engineering project produces knowledge faster than code, and
knowledge is the easier of the two to lose — it evaporates in chat
scrollback, rots in comments, or gets reconstructed from memory later, which
is how wrong claims are born. Every finding runs through one pipeline to one
durable home.

## At a glance

```
 while coding                on "wrap"                 durable home
 ────────────                ─────────                 ────────────
 finding (root cause,        re-read Current,          pages/docs/
 opcode semantics,       →   extract the FACTS,    →     scumm/   what the original does
 the why) lands in           route them by kind,         engine/  what GrogVM does
 PROGRESS.md Current         verify the claims           agent/   how the work is done
 as a lab note —                  │
 captured FRESH                   └→ then trim the note from PROGRESS.md

                             failed hypotheses, dead ends, blow-by-blow
                             → git history only, never the docs
```

## The lab notebook

`PROGRESS.md` is a lean tracker. **Next** is the work ahead as one-liners,
broken into tasks only when started. **Current** is what's in flight *and*
the lab notebook — each finding captured *as it happens*, with the exact
numbers, semantics, and *why*, because those notes are the source material
for doc updates (reconstructing from memory later is how bad claims get in).
A finding stays in Current only until it's written into the right doc, then
it's removed. Open limitations and bugs are the exception: they live in
`PROGRESS.md` only, never in these docs, which describe what *is*, not what's
broken this week.

## Wrapping a session

Wrapping is draining the session's lab notes into their durable homes while
fresh — not a chat status summary:

1. Re-read what this session added to Current.
2. Extract only the **facts** — settled conclusions (root cause, format
   layout, opcode semantics, the why), never the failed hypotheses or
   blow-by-blow; git keeps those.
3. Route by kind: SCUMM format/behaviour → `scumm/`; GrogVM implementation
   → `engine/`; methodology → `agent/`; an open limitation stays in
   `PROGRESS.md`.
4. **Verify any "we do / we defer X" claim against the code first** — these
   go stale silently (one audit found five already false); a stale
   limitation is worse than none.
5. Once a finding lives in a doc, remove it from `PROGRESS.md`.

Wrapping edits files but never commits — that stays the human's
([the contract](collaboration.md)).

## Doc conventions

These pages are the durable knowledge base *and* a public website:

- **Prose for humans, compact** — narrative woven into existing sections,
  not bullet dumps; a fact earns the words it needs and no more.
- **The pyramid template** — a doc over ~150 lines opens with `## At a
  glance` (one ASCII diagram plus a few lines of mental model), and the long
  format/behaviour docs close with a numbered `## Pitfalls cheat-sheet` (§
  pointers). Each section keeps a narrative spine; fine-grained or
  MI1-specific detail demotes into a labeled `**Fine print:**` block. `> ⚠️`
  is reserved for genuine traps and corrections-to-circulating-notes, not
  emphasis. ASCII diagrams cover flows, state machines, and screen geometry
  too — not just byte layouts.
- **New facts at the right altitude** — extend the spine or fine-print of
  the section the fact belongs to; never append a bold paragraph in arrival
  order.
- **Facts, not theories or journals** — settled conclusions only; no
  "BREAKTHROUGH/REVERTED" narration, no phases or temporary state ("deferred
  until", "not yet wired"). The docs are timeless.
- **No fragile code pointers** — no source paths, symbol names, line
  numbers, or scratch scripts; they rot on the first refactor. SCUMM's own
  opcode/routine names (`adjustXYToBeInBox`) and a few coarse engine
  references are fine. This `agent/` section alone may name repo files
  (`PROGRESS.md`, `AGENTS.md`) and npm scripts — still no source paths.
- **No exact test counts** — describe a suite qualitatively.
- **Index titles** (docs landing page) — descriptive Title-Case with the
  on-disk resource in parens where one applies (`Background Bitmaps
  (SMAP)`, pairs joined ` + `); no tag for behaviour/subsystem docs mapping
  to no single block.

## Code comments: a last resort

The knowledge home is these docs, not comments — and docs are updated in
wrap sessions, not while coding (a fact found while coding goes to
`PROGRESS.md` Current, never into a comment). LLM sessions over-comment by
default; the bar is deliberately high.

**Default: none.** Before writing one: *would a competent reader, with the
relevant doc open, plausibly break this code without it?* If no, don't. To
explain the change you just made or why it's correct — that's commit-message
content, addressed to the reviewer, not a comment.

**Module headers: 1–3 lines** — what the module is, plus a doc link when one
covers it; no design essays or API tours. A module whose filename says it
needs none.

**The four kinds worth keeping** (1–2 lines, rare): **traps** — code that
looks wrong but is correct (a constant pinned to game data, an order
dependency, a deliberate original-engine quirk; state the constraint, not
the story); **corrections at point of use** — where code diverges from
circulating notes (one line + doc link); **why-nots** — the obvious
alternative is wrong for a reason the code can't show; **one-line JSDoc** —
only when a signature alone is ambiguous (units, coordinate space,
ownership).

**Never:** restating the code or name; narrating history (git keeps it);
design rationale (→ `engine/`); TODO/FIXME (→ `PROGRESS.md`); section banners
except as pure navigation in long files. Trimming a comment that carries a
real undocumented fact: move the fact to `PROGRESS.md` Current first, then
trim. One lenient zone — the per-game id tables in the integration
playthroughs, where id labels and mechanic notes *are* the knowledge home
for walkthrough facts.

`AGENTS.md` at the repo root is the operational counterpart — the repo map,
tooling APIs, and gotchas, the precise-path material these pages avoid by
convention.
