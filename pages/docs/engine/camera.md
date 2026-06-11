---
title: Camera — Follow, Pan & the Viewport
description: How GrogVM positions the SCUMM camera — centre-based coordinates, clamping to room and scroll bounds, actor follow with a dead zone, 8-px scripted pans, and frame ordering.
---

# Camera — Follow, Pan & the Viewport

The presented frame is a **fixed-width window** into a room that can be wider
than the screen. The camera's x is the **centre** of that window, not its left
edge — every script opcode and every camera variable speaks in centre
coordinates. `setCameraAt(160)` on a 320-wide screen shows the room from x=0.

## 1. Clamping

The centre is clamped so the window never shows past the room: it can't go
below half a screen from the left edge or above half a screen from the right.
A script can narrow this further with `roomOps roomScroll`, which sets
`VAR_CAMERA_MIN` / `VAR_CAMERA_MAX`; when set, the scripted range **overrides**
the default room bounds. Every camera movement — follow, pan, or a direct
`setCameraAt` — lands inside the active range.

Every movement also **publishes the new centre into `VAR_CAMERA_POS_X`**.
Scripts poll that variable constantly — escape-watchers, walk-past-camera
gates (Meathook's payoff script loops on `meathookX < cameraX − 175`; Stan's
arrival script waits for the centre to equal the clamp floor exactly) — so a
camera that moves without writing it deadlocks them.

## 2. Follow mode

`actorFollowCamera` puts the camera in **follow mode**: it tracks the named
actor with a **dead zone of ±80 px** around the centre. The actor walks freely
inside that window; only when it leaves it does the camera move — and not by
snapping to the edge: leaving the dead zone arms a **pan to the actor's
(clamped) x**, stepped by the same 8-px-per-frame stepper as a scripted pan
(§3) and **latched until it lands**, even if the actor stops back inside the
dead zone meanwhile. `wait forCamera` covers a follow pan exactly like a
scripted one — Stan's lot script waits for the centre to settle at the clamp
floor while the ego stands well inside the dead zone, which only releases
because the follow pan runs to the *actor's* clamped position, not the
dead-zone edge. This is why walking around a one-screen room never scrolls,
and why a long walk across a wide room scrolls only once the actor leads the
camera by 80 px.

Pointing follow at an actor standing in **another room** is what triggers the
room switch — MI1's boot script enters the lookout exactly this way: it places
the ego in the lookout room and then issues `actorFollowCamera`, and the room
change falls out of the follow.

## 3. Scripted pans

`panCameraTo` detaches follow and glides the centre toward a target at
**8 px per game frame** — one background strip per frame, since the room
bitmap is stored in 8-px-wide strips (room 64's dig scene is the first to pan
this way). Because a pan detaches follow, the two modes never fight over the
camera within a frame.

`wait forCamera` blocks the calling script until the camera **reaches** its
pan destination — *not* merely while a pan target is armed. The distinction
is load-bearing: the SCUMM bar (room 28) runs a camera-controller script
(`#201`) that re-issues `panCameraTo` **every frame** to whichever of the
room's two fixed positions matches ego's side — including when the camera is
already there. Scripts that wait on the camera in that room (the
three-pirates conversation `#220`, the ambient chatter `#207`/`#210`) run
*later in slot order* than `#201`, so an "armed-pan" check deadlocks them
forever once they yield at the wait even once: the controller re-arms the
target before every re-check, and the pan stepper only clears it at the end
of the frame. A reached (or same-spot) destination must read as settled.

The pan target is **transient** state: a save taken mid-pan resumes with the
camera at its saved position and no pending pan. Only the camera position
itself persists.

## 4. Ordering within a game frame

The follow step runs **once per game frame, after actors walk**. Run it before
the walk and the camera is always one frame behind the followed actor — the
actor's screen position oscillates as it walks, a visible "two Guybrush"
stutter. Walking first, then following, keeps actor and camera in lockstep.

## 5. Wide rooms and screen-space text

`print … at (x, y)` coordinates for system text are **screen-space**. In rooms
no wider than the screen the two spaces coincide, but in wider rooms (MI1's
640-wide credits room) mapping screen text onto the room requires the camera
position — the shell composes overlay text **camera-relative**, so the text
stays put on screen while the room scrolls beneath it.
