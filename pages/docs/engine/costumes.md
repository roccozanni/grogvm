# Costume Loading & Decoding

How GrogVM turns a costume id into pixels on screen. This is the engine side;
the **binary format** it reads is documented in [`cost.md`](../scumm/cost.md),
and the **animation runtime** that sequences frames is in
[`costume-anim.md`](../scumm/costume-anim.md). This doc covers what sits between
them: resolving a costume by id, and the lazy decode model.

## Resolving a costume by id

A costume is loaded **by id, through the `DCOS` directory** — the engine does
not guess by walking the block tree and counting `COST` blocks. The chain is:

1. **`DCOS` lookup.** The costume id indexes the `DCOS` directory parsed from
   the index file, yielding the costume's **owning room** and its **byte offset
   within that room's bundle**.
2. **LOFF base.** The owning room's absolute position in the resource file comes
   from the `LOFF` room-offset table.
3. **Absolute offset.** Room base + the `DCOS` offset gives the absolute byte
   position of the costume's `COST` block, which is then located in the parsed
   block tree.

The lookup fails loudly, with the id in the message, on each thing that can go
wrong: id 0 or out of range, an **unused `DCOS` slot** (owning room recorded as
0), an owning room absent from `LOFF`, or a resolved offset that doesn't land on
a `COST` block.

## Lazy decode

Loading a costume parses only its **fixed header** and keeps the **raw block
payload** alongside it. Individual frames are *not* decoded up front — there can
be dozens per limb and only the few matching the actor's current animation state
are ever needed. The compositor decodes a frame on demand from a frame pointer
into the stored payload, each tick, for whichever pose each limb is currently
showing.

## Transparent pixels

Costume palette index 0 is the format's transparent slot (see
[`cost.md` §5.2](../scumm/cost.md)). The decoder emits a fixed **sentinel value
of `0xFF`** for those pixels, which the compositor recognises and skips. Costume
indices only ever range 0..31, so `0xFF` is unambiguous in this namespace — the
compositor needs a single value to test rather than tracking a per-costume
transparent colour.
