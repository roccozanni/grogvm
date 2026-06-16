---
title: Privacy
description: GrogVM collects no personal data, runs no analytics or tracking, and has no app backend. Your game files and saves never leave your browser.
---

# Privacy

The short version: **GrogVM doesn't know or care who you are.**

## Privacy

- **No analytics, no tracking, no cookies.** The site loads no third-party
  scripts, fonts, or tracking pixels, and sets no cookies. Nothing here counts
  visits or profiles you.
- **No personal data, no accounts.** There is no sign-up, no login, no form.
  GrogVM never asks for, collects, or stores anything that identifies you.
- **Static hosting, no app backend.** The site is static files on Amazon S3,
  served through CloudFront with access logging disabled. CloudFront still serves
  normal web requests for the site assets, but GrogVM has no application backend
  receiving your actions, game data, or saves.
- **Your game files stay yours.** Installing a game grants the browser read
  access to a folder on your own disk. That directory handle is kept in your
  browser's IndexedDB so the game can be reopened; the game's bytes are never
  copied off your machine or uploaded.
- **Your saves stay local.** Save states live in your browser's local storage
  and in files you explicitly export. They go nowhere else.

**You don't have to take our word for it.** The entire site and engine are open
source — read the code and confirm there's no tracking, no analytics, and no
data leaving your machine: [github.com/roccozanni/grogvm](https://github.com/roccozanni/grogvm).

## Terms, licensing & game files

Licensing (GPL-3.0-or-later, as-is with no warranty), the fact that GrogVM
bundles and distributes **no game assets**, where to legally obtain the game, the
no-piracy policy, and trademarks all live on the **[Legal & game files](/legal/)**
page.
