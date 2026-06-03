# ScummVM C++ Source — Direct Exposure Audit

**Scope:** All Claude session transcripts for the project, across both directory names it
has had — `~/.claude/projects/-Users-rocco-Developer-webscumm` and
`~/.claude/projects/-Users-rocco-Developer-grogvm` (the directory was renamed; treated here
as **one project**, ≈30 `.jsonl` files + subagent logs).

**Question answered:** Where did Claude have *direct exposure to actual ScummVM (or other
emulator) C++ source code* — either pulled via a tool or pasted by you? Documentation, wiki
prose, format specs, pseudocode, ASCII tables, and the project's own TypeScript are **not**
counted.

**Method:** Parsed every JSONL message, classified each text/tool_use/tool_result block, and
flagged (a) `WebFetch` of any `*.cpp/.h` URL and (b) any message containing genuine C++ source
syntax (`#include`, `namespace Scumm`, `Type ClassName::method(...) {`, `_vm->…`,
`READ_LE_UINT16`, verbatim opcode-handler bodies). Borderline blocks were read in full and
judged by hand.

**Bottom line:**
- All confirmed C++ exposure sits in **3 sessions**, all under the old `webscumm` directory
  name. No new C++ exposure appears in any post-rename (`grogvm`) session.
- **No local `.cpp`/`.h` file was ever `Read` or `cat`-ed** in any session.
- Two mechanisms only: **(1) one session's `WebFetch` of `raw.githubusercontent.com/scummvm/…`**,
  and **(2) two sessions where you pasted snippets yourself**.
- The session that fetched source (`ecc31fd3`) is the one whose feedback created the
  `feedback-no-scummvm-source` memory; you interrupted ("Stop") the moment verbatim code came
  back.

---

## A. Confirmed direct C++ exposure

### A1 — session `ecc31fd3-c2b8-4c3e-b9f4-fc6589d4159d`

This is the session that established the "don't copy ScummVM source" policy.

| # | Timestamp (UTC) | Channel | Source file / function | What was returned | Disposition |
|---|---|---|---|---|---|
| 1 | 2026-05-27T17:11:43 | **WebFetch** (tool_use) | `engines/scumm/script_v5.cpp` | prompt: *"Extract the C++ source for these specific opcode handlers"* | fetch issued |
| 2 | 2026-05-27T17:12:16 | **WebFetch result** (tool_result) | `ScummEngine_v5::o5_isLess` (0x44), `o5_isGreater` (0x78), `o5_isLessEqual` (0x38, incl. ScummVM `WORKAROUND` comments), `o5_isGreaterEqual` (0x04), `o5_isEqual` (0x48), … | **VERBATIM C++ function bodies** in ```` ```cpp ```` blocks | **Full direct exposure** |
| 3 | 2026-05-27T17:12:47 | your message | — | **"Stop"** (interrupted) | you halted use |
| 4 | 2026-05-28T12:53:24 | **WebFetch** (tool_use) | `engines/scumm/costume.cpp` | prompt explicitly: *"describe in PROSE … do not paste code blocks longer than 5 lines"* | fetch issued |
| 5 | 2026-05-28T12:53:34 | WebFetch result | `ClassicCostumeLoader::costumeDecodeData` | prose only; model said source "does not contain sufficient detail" | prose, ~no verbatim |
| 6 | 2026-05-28T12:54:11 | **WebFetch** (tool_use) | `engines/scumm/costume.cpp` (again) | prompt: describe `costumeDecodeData` logic in plain English | fetch issued |
| 7 | 2026-05-28T12:54:18 | WebFetch result | `costumeDecodeData` | prose description with **short verbatim fragments**: `mask <<= 1`, `READ_LE_UINT16(r)`, `if (usemask & 0x8000)`, `extra = *r++` | partial / fragmentary |
| 8 | 2026-05-28T12:55:21 | **WebFetch** (tool_use) | `engines/scumm/costume.cpp` (again) | prompt: what is `usemask`, where initialized | fetch issued |
| 9 | 2026-05-28T12:55:27 | WebFetch result | `costumeDecodeData` | prose; one verbatim fragment — the signature `costumeDecodeData(Actor *a, int frame, uint usemask)` | partial / fragmentary |

**Nature of the WebFetch channel:** Claude Code's `WebFetch` runs the page through a model
with the given prompt, so the result is whatever that model chose to emit. For `script_v5.cpp`
(item 2) the prompt asked for verbatim extraction and the result **did** contain full handler
bodies. For the three `costume.cpp` fetches the prompts deliberately asked for prose-only, so
only short fragments/identifiers/one signature surfaced.

**How it was used:** Immediately after the verbatim opcode bodies arrived (item 2) you issued
"Stop" (item 3). The `costume.cpp` prose was used to reason about the COST anim-record byte
layout. This session's pushback is recorded as the
`feedback-no-scummvm-source` memory (`originSessionId: ecc31fd3…`).

### A2 — session `496f1c96-971f-463b-b53b-c82b8f06381c`

| # | Timestamp (UTC) | Channel | Source / functions | What was provided | How used |
|---|---|---|---|---|---|
| 1 | 2026-05-30T09:46:15 | **Your paste** (user message) | `ScummEngine_v2::o2_cutscene()`, `o2_endCutscene()`, `o2_cursorCommand()` | **Full verbatim C++ function bodies.** Preamble: *"This is all I could find. Mind that I'm not sure they all belong to v5, you'll need to derive it empirically."* | Used to derive cutscene / cursor-command opcode semantics for the TS reimplementation |

### A3 — session `5eee9037-b879-463a-95cd-878685d1a8a5`

| # | Timestamp (UTC) | Channel | Source / functions | What was provided | How used |
|---|---|---|---|---|---|
| 1 | 2026-05-30T13:47:15 | **Your paste** (user message) | `ClassicCostumeLoader::costumeDecodeData(Actor *a, int frame, uint usemask)` | **Full verbatim C++ body.** Preamble: *"Access to code only happens through me and it's the last resort. You cannot copy it verbatim but you can use it for understanding. I'm going to find a way to release this under a compatible license."* | Claude replied *"I won't reproduce the code — just the semantics I'm deriving"* and restated the algorithm (16-bit LE limb mask, per-limb frameIndex + extra byte) in its own words |
| 2 | 2026-05-30T13:52:08 | **Your paste** (queued user message) | `ClassicCostumeLoader::loadCostume(int id)` | **Full verbatim C++ body** (`byte *ptr = _vm->getResourceAddress(rtCostume, id)` …) | Used to correct the costume-loading / format-byte logic in the TS engine |

---

## B. What was checked and ruled out (not C++ exposure)

Everything else screened as relevant was **documentation, not ScummVM engine source**, and is
excluded: the third-party "Ludde" MI1/MI2 costume-format write-up (pasted in `033cc04b` and
`ecc31fd3`), plain-text COST field tables, the project's own markdown docs (e.g. the `ZP##`
mask notes and a line-numbered header diagram), and all `WebFetch`es of `wiki.scummvm.org`,
`scummvm.org/old/docs/specs`, the Scummbler manual, the tonick blog, and `moddingwiki`. Three
further sessions (`57e2d736`, `c532815c`, `855ad9d1`) were read by hand because they mention
C++-style identifiers, but contain only Claude's own English discussion and the project's
TypeScript — no ScummVM source. The `2bf38804` session's matches are this audit's own search
output. **No local `.cpp/.h` file was ever opened** in any session.

---

## C. Summary of exposure events

| Session | Mechanism | Source files | Verbatim code? |
|---|---|---|---|
| `ecc31fd3` | Claude `WebFetch` | `script_v5.cpp` | **Yes** — full opcode-handler bodies |
| `ecc31fd3` | Claude `WebFetch` ×3 | `costume.cpp` | Fragments only (prose-constrained prompts) |
| `496f1c96` | Your paste | `script_v2.cpp` (`o2_cutscene`, `o2_endCutscene`, `o2_cursorCommand`) | **Yes** — full bodies |
| `5eee9037` | Your paste | `costume.cpp` (`costumeDecodeData`, `loadCostume`) | **Yes** — full bodies |

*Generated 2026-06-03. Function/file names and timestamps are taken directly from the JSONL transcripts; actual source text is intentionally omitted from this report.*
