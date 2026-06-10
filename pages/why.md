---
title: Why
description: Why GrogVM exists — a love letter to Monkey Island, LucasArts, and Ron Gilbert; rebuilding the SCUMM v5 engine in the browser, with AI handling the bit-flipping, for fun and for preservation.
---

# Why GrogVM

AI has the whole industry in a frenzy, and everyone's dying of FOMO to build
something with it.

I'm guilty too. I've got at least three AI-built side projects sitting at 80%,
left to rot because they were solutions looking for a problem: not useful, not
educational, not fun. And honestly, after the last 15 years I'm too scarred to
seriously consider building another business. It turned out I just had to look
back at what I loved as a kid and jump into the deepest rabbit hole I could
find. For fun.

## Enter GrogVM.

*The Secret of Monkey Island* is one of the first things I remember about PC
gaming, the first graphic adventure I ever played. I have an extremely vivid
memory of being at a friend's place in the mid-90s, watching him play as this
weird pirate sprinting across Mêlée Island with a mug of grog, the stuff so
corrosive it eats straight through the metal, pouring it from mug to mug all
the way to the prison before the grog eats through and there's nothing left to
melt Otis' cell lock. I was in shock, mind totally blown.

So, when looking for a fun way to spend some time, shouldn't I just have
replayed it, like countless times before? This time it didn't feel "enough",
so I decided I'd try rebuilding the engine that ran it all, to see how the
magic actually worked. And I chose to do it on the platform I love and have
spent my whole career on, the browser. This is my love letter to *Monkey
Island*, LucasArts, and Ron Gilbert.

Even though I'm privileged to have plenty of time available to spend on side
projects, I'd never have embarked on something like this if it weren't for AI.
Regardless of how fun something may be, it's extremely unlikely anyone would
dedicate months (years?) of their own life to it, especially a monumental one
that's already been done, works perfectly, and is openly accessible to anyone
(looking at you, ScummVM).

I've been working in tech for more than 20 years, but I have no experience in
the gaming industry, so my role here is to use what I've learned over the
years to steer the work in a direction I believe in, while AI (Claude Opus
4.7, 4.8, and then Fable 5) handles the bit-flipping.

## So this is just for fun?

When I started this a few weeks ago (on May 25th, 2026), I thought this was an
opportunity to have fun while learning how to build a non-trivial project with
AI. That FOMO I mentioned above contributed to it, but the first and foremost
goal was to have fun. Within a few days I realized there was another
opportunity, to contribute at least a bit to the preservation of the
absolutely outstanding work done by the LucasArts team first, and the ScummVM
volunteers later.

Everyone working in the industry knows that documentation is a double-edged
sword. When well written it's very useful, but it takes a lot of effort, and
the more you write the more likely it's going to get stale over time. I
realized that, while there are resources available on the web about SCUMM
(Script Creation Utility for Maniac Mansion), they are scattered across
websites and forums, hard to consume, sometimes conflicting with each other,
or even only available through the Wayback Machine. That's why this project
ships with [extensive documentation](/docs/), not only about the engine
itself, but also about every SCUMM detail we could reconstruct from the
reverse engineering process. And because this documentation doubles as the
AI's durable memory, it's treated as a first-class citizen — not an
afterthought, or something a developer was forced to write.

In addition to this, GrogVM comes with an extensive set of inspection /
educational tools. A full-fledged disassembler (`disgrogate`), a headless
harness driving the virtual machine to probe real game files and build
integration tests including an e2e game walkthrough, a screenshot tool
(`mugshot`), a real-time VM inspector, and a resource explorer that allows you
to deep dive into game files and their content.

## Project status

As of today, GrogVM is capable of playing the CD VGA version of *The Secret of
Monkey Island* end to end, both the English and Italian variants. Any other
format or variant has never been tested and may be broken. No other game is
supported at the moment, but *Monkey Island 2: LeChuck's Revenge* is the next
(and likely last) target.

Install your own copy in the [Library](/library/) and check it out.
