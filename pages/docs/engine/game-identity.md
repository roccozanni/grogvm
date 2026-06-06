---
title: Game Identity & Variant Detection
description: How GrogVM tells one installed game from another — engine target by filename, specific release by hashing the index file — so two language variants of the same game can coexist.
---

# Game Identity & Variant Detection

GrogVM installs a game by pointing at a local folder. Two questions have to be
answered about that folder, and they are *different* questions:

1. **Which engine target is this?** — `MI1` or `MI2`: which game the VM should
   boot. This decides parsing and which scripts run.
2. **Which specific release is this?** — the English CD build, the Italian CD
   build, some other localization. This decides *identity*: whether it's a
   duplicate of something already installed, and which save slots belong to it.

Conflating the two is the trap. The English and Italian builds of *The Secret of
Monkey Island* are both engine target `MI1` — same opcodes, same object ids,
same scripts — yet they are different installs a player may want side by side.

## Engine target: by filename

The engine target is read from the directory's filenames. `MONKEY.000` +
`MONKEY.001` ⇒ `MI1`; `MONKEY2.000` + `MONKEY2.001` ⇒ `MI2`. This is enough to
boot, and it is all the VM ever needs — the localization is invisible to the
bytecode.

## Specific release: by hashing the index file

Filenames cannot tell English from Italian — both releases ship the identical
`MONKEY.000` / `MONKEY.001` names. **SCUMM v5 has no language or version field
in its data**, either: nothing in the index file says "Italian".

What *does* differ is incidental. The two `MONKEY.000` files are byte-for-byte
the same length, and differ only inside the resource-directory offset tables
(`DSCR` / `DSOU` / `DCOS` lane-2 offsets — see
[Index File §3–4](../scumm/index-file.md)). The Italian translation resizes the
scripts that carry on-screen text, which shifts every resource's position in
`MONKEY.001`, which in turn changes the offsets recorded in `MONKEY.000`. So the
index files genuinely differ between releases — but as offset drift, not as a
clean marker you can read.

That makes a **content hash of the index file** the natural identity. At install
time GrogVM reads `MONKEY.000` and takes its SHA-256. Two builds of the same game
hash differently (their offset tables differ); the same build always hashes the
same. This mirrors how ScummVM identifies a release — hash the index file, look
the result up in a table — the difference being only the hash function (SHA-256,
because it is the browser's built-in; the exact algorithm doesn't matter, only
that it discriminates).

### From hash to a human label

A small built-in table maps known index-file hashes to a friendly label
("English", "Italiano"). A release whose hash isn't in the table still installs
normally — it is labeled by a short prefix of its hash (`variant 8f40364`) rather
than rejected. The table is convenience, not a gate: identity is the hash, the
label is cosmetic.

## What the hash and the engine target each key

| Concern | Keyed by |
|---|---|
| Booting / parsing the game | engine target (`MI1` / `MI2`) |
| Duplicate-install check | index-file content hash |
| The play / explore deep-link (`?game=…`) | the install's own id |
| Save-slot namespace | the install's own id |

The duplicate check is on the **content hash**, so the literal same copy can't be
installed twice, while English and Italian — different hashes — coexist. Each
install carries its own opaque id; deep-links and save slots are namespaced by
that id, never by the engine target, so two `MI1` variants never collide and a
quick-save made in one is invisible to the other.

Because object, script, and verb ids are engine-structural — identical across an
EN and IT build, only the text is translated — gameplay logic and the
integration playthroughs are written against those ids and pass against either
build (see [Test Harness](harness.md)). Only the *identity* layer cares which
release is in hand.
