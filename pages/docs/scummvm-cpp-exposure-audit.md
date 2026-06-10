# ScummVM C++ Source — Direct Exposure Audit

**Scope:** All Claude session transcripts for the project, across both directory names it
has had — `~/.claude/projects/<…>-webscumm` and
`~/.claude/projects/<…>-grogvm` (the directory was renamed; treated here
as **one project**, ≈30 `.jsonl` files + subagent logs).

**Question answered:** Where did Claude have *direct exposure to actual ScummVM (or other
emulator) C++ source code* — either pulled via a tool or pasted by the user? Documentation, wiki
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
  and **(2) two sessions where the user pasted snippets**.
- The session that fetched source (`ecc31fd3`) is the one whose feedback created the
  `feedback-no-scummvm-source` memory; the user interrupted ("Stop") the moment verbatim code came
  back.

---

## A. Confirmed direct C++ exposure

### A1 — session `ecc31fd3-c2b8-4c3e-b9f4-fc6589d4159d`

This is the session that established the "don't copy ScummVM source" policy.

| # | Timestamp (UTC) | Channel | Source file / function | What was returned | Disposition |
|---|---|---|---|---|---|
| 1 | 2026-05-27T17:11:43 | **WebFetch** (tool_use) | `engines/scumm/script_v5.cpp` | prompt: *"Extract the C++ source for these specific opcode handlers"* | fetch issued |
| 2 | 2026-05-27T17:12:16 | **WebFetch result** (tool_result) | `ScummEngine_v5::o5_isLess` (0x44), `o5_isGreater` (0x78), `o5_isLessEqual` (0x38, incl. ScummVM `WORKAROUND` comments), `o5_isGreaterEqual` (0x04), `o5_isEqual` (0x48), … | **VERBATIM C++ function bodies** in ```` ```cpp ```` blocks | **Full direct exposure** |
| 3 | 2026-05-27T17:12:47 | the user's message | — | **"Stop"** (interrupted) | the user halted use |
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

**How it was used:** Immediately after the verbatim opcode bodies arrived (item 2) the user issued
"Stop" (item 3). The `costume.cpp` prose was used to reason about the COST anim-record byte
layout. This session's pushback is recorded as the
`feedback-no-scummvm-source` memory (`originSessionId: ecc31fd3…`).

### A2 — session `496f1c96-971f-463b-b53b-c82b8f06381c`

| # | Timestamp (UTC) | Channel | Source / functions | What was provided | How used |
|---|---|---|---|---|---|
| 1 | 2026-05-30T09:46:15 | **User paste** (user message) | `ScummEngine_v2::o2_cutscene()`, `o2_endCutscene()`, `o2_cursorCommand()` | **Full verbatim C++ function bodies.** Preamble: *"This is all I could find. Mind that I'm not sure they all belong to v5, you'll need to derive it empirically."* | Used to derive cutscene / cursor-command opcode semantics for the TS reimplementation |

### A3 — session `5eee9037-b879-463a-95cd-878685d1a8a5`

| # | Timestamp (UTC) | Channel | Source / functions | What was provided | How used |
|---|---|---|---|---|---|
| 1 | 2026-05-30T13:47:15 | **User paste** (user message) | `ClassicCostumeLoader::costumeDecodeData(Actor *a, int frame, uint usemask)` | **Full verbatim C++ body.** Preamble: *"Access to code only happens through me and it's the last resort. You cannot copy it verbatim but you can use it for understanding. I'm going to find a way to release this under a compatible license."* | Claude replied *"I won't reproduce the code — just the semantics I'm deriving"* and restated the algorithm (16-bit LE limb mask, per-limb frameIndex + extra byte) in its own words |
| 2 | 2026-05-30T13:52:08 | **User paste** (queued user message) | `ClassicCostumeLoader::loadCostume(int id)` | **Full verbatim C++ body** (`byte *ptr = _vm->getResourceAddress(rtCostume, id)` …) | Used to correct the costume-loading / format-byte logic in the TS engine |

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
| `496f1c96` | User paste | `script_v2.cpp` (`o2_cutscene`, `o2_endCutscene`, `o2_cursorCommand`) | **Yes** — full bodies |
| `5eee9037` | User paste | `costume.cpp` (`costumeDecodeData`, `loadCostume`) | **Yes** — full bodies |

*Function/file names and timestamps are taken directly from the JSONL transcripts; actual source text is intentionally omitted from this report.*

---

## D. Post-audit code comparison — did any exposure leak into GrogVM source?

**Method:** Every GrogVM source file under `src/engine/` and `src/app/` was read and
compared against the four exposure events above, checking for verbatim transcription,
structural copying, ScummVM-specific identifiers, and suspiciously close functional
correspondence.

**Bottom line: No ScummVM C++ source code leaked into the GrogVM codebase.**

The four exposure events each receive a detailed verdict below; the cross-cutting
evidence is summarised at the end.

---

### D1. Comparison opcodes (`script_v5.cpp` — session `ecc31fd3`)

**Exposure:** Full verbatim C++ bodies for `o5_isLess`, `o5_isGreater`,
`o5_isLessEqual`, `o5_isGreaterEqual`, `o5_isEqual` were returned by WebFetch.
The user issued "Stop" immediately upon seeing them.

**GrogVM code** (`src/engine/vm/opcodes/index.ts`):

```typescript
defineJumpIf('isEqual', 'isEqual', [0x48, 0xc8], (a, b) => a !== b);
defineJumpIf('isNotEqual', 'isNotEqual', [0x08, 0x88], (a, b) => a === b);
defineJumpIf('isGE', 'isGE', [0x04, 0x84], (a, b) => a > b);
defineJumpIf('isLess', 'isLess', [0x44, 0xc4], (a, b) => a <= b);
defineJumpIf('isGreater', 'isGreater', [0x78, 0xf8], (a, b) => a >= b);
defineJumpIf('lessOrEqual', 'isLE', [0x38, 0xb8], (a, b) => a < b);
```

**Verdict: No similarity.** ScummVM's handlers are individual virtual methods on
`ScummEngine_v5` working on a stack machine (`pop()`, `push()`, `fetchScriptByte()`).
GrogVM uses a declarative `defineJumpIf` factory with inverted predicates ("jump when
FALSE" semantics), variable-based operands, and a central dispatch table — an
abstraction that does not exist in ScummVM. The exposure was interrupted before any
derivative work could happen.

---

### D2. `cursorCommand` / Cutscene opcodes (`script_v2.cpp` — session `496f1c96`)

**Exposure:** Full verbatim C++ bodies for `o2_cutscene()`, `o2_endCutscene()`,
`o2_cursorCommand()` were pasted by the user.

**GrogVM code** (`src/engine/vm/opcodes/index.ts`):
- `cutScene` (opcode 0x40) delegates to `vm.beginCutscene()`
- `endCutScene` (opcode 0xC0) delegates to `vm.endCutscene()`
- `cursorCommand` (opcode 0x2C) uses a sub-action switch (0x01–0x08 toggles,
  0x0A–0x0E cursor-image/colors)

**Verdict: No copying.** The sub-action values (0x01 = cursorOn, 0x02 = cursorOff,
etc.) are **format-mandated constants** defined by the SCUMM opcode specification
(GrogVM documents them in `pages/docs/scumm/opcodes.md` and
`opcode-reference.md`), not implementation choices from ScummVM. The
implementation architecture is entirely different: GrogVM uses
`defineOp({ decode, exec, format })` with a separate operand reader, while ScummVM
uses imperative `fetchScriptByte()` / `switch` inside a class method. The
cutscene stack and override machinery are documented independently in
`pages/docs/scumm/cutscenes.md`.

---

### D3. Costume animation decoding (`costume.cpp` — session `5eee9037`)

**Exposure:** Full verbatim C++ bodies for
`ClassicCostumeLoader::costumeDecodeData` and
`ClassicCostumeLoader::loadCostume` were pasted. Claude responded "I won't
reproduce the code — just the semantics I'm deriving."

**GrogVM code:** `src/engine/graphics/costume-anim.ts` (`startAnim`),
`src/engine/graphics/costume-loader.ts` (`loadCostume`).

Key structural differences:

| Aspect | ScummVM C++ | GrogVM TypeScript |
|--------|-------------|-------------------|
| State model | Mutable class fields on `Actor` | Immutable `AnimState` objects with readonly fields |
| Architecture | Member functions modifying `this` | Pure functions (`startAnim`, `stepAnim`, `currentLimbPicture`) returning new state |
| Mask variable | `usemask` | `mask` |
| LE read style | `READ_LE_UINT16(r)` macro | Inline `payload[r]! | (payload[r+1]! << 8)` |
| Extra byte read | `extra = *r++` C pointer | `const extra = payload[r]!; r += 1;` |
| Function API | `costumeDecodeData(Actor *a, int frame, uint usemask)` | `startAnim(state, animId, header, payload)` |

The mask-iteration idiom (`mask << 1`, `mask & 0x8000`) is unavoidable given the
format (iterate a 16-bit mask MSB-first) and appears identically in any C-like
implementation — it is not a ScummVM signature.

The comment `// partial usemask updates aren't modelled` at
`costume-anim.ts:159` actually documents a **deliberate divergence**: GrogVM does
NOT implement ScummVM's partial-limb-update feature.

The format documentation (`pages/docs/scumm/cost.md`, `costume-anim.md`)
explicitly credits two public third-party sources (the "Costume spec" from
scumm.mixnmojo.com and the ScummVM wiki) and notes that all format claims were
**verified against real MI1/MI2 game data**.

**`loadCostume`** (`costume-loader.ts`) resolves via GrogVM's own
`IndexFile`/`RoomOffsetTable` structured resource system — completely different
from ScummVM's `_vm->getResourceAddress(rtCostume, id)`.

**Verdict: No copying.** Different API, different variable names, different LE
read style, different state-management paradigm. The derivation chain is
fully documented.

---

### D4. Cross-cutting evidence

The entire `src/engine/` tree was searched for ScummVM-specific identifiers:

| Pattern | Hits in code |
|---------|--------------|
| `_vm->` / `this->_vm` | **0** |
| `READ_LE_UINT16` / `WRITE_LE_UINT16` | **0** |
| `getResourceAddress` / `getResourceSize` | **0** |
| `_scriptPointer` / `_scriptOrgPointer` | **0** (one explanatory comment) |
| `pop()` / `push()` (stack ops) | Only in `expression.ts` — the expression mini-VM, unrelated to opcode dispatch |
| `usemask` as a variable | **0** (once in a comment at costume-anim.ts:159) |
| `o5_` / `o2_` function names in code | **0** (appear in 5 explanatory comments only) |
| `ScummEngine` / `ClassicCostumeLoader` | **0** |

The `o5_` references in comments (e.g. `// (o5_cursorCommand)`) are engineering
notes explaining semantic differences from the original — they reproduce function
*names*, not code.

---

### D5. Conclusion

**No ScummVM C++ source code leaked into the GrogVM codebase.** All four exposure
events are accounted for and the resulting GrogVM code shows:

1. **No verbatim transcription** — different variable names, function signatures,
   code organisation, and a radically different architecture (declarative
   `defineOp` factory vs. imperative virtual methods; immutable state objects vs.
   mutable class fields; variable-based operand system vs. stack machine).
2. **No structural copying** — no ScummVM identifiers, macros, or idioms appear
   in the code. Where the format dictates constants (opcode values, sub-action
   codes, command byte values), GrogVM uses the same numbers because those are
   **format specifications**, not implementation choices.
3. **Transparent derivation chain** — the `pages/docs/scumm/` directory provides
   thorough, independently-written documentation of the SCUMM binary format,
   explicitly citing public third-party specs and real-game-data verification.
