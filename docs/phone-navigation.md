# Phone navigation across projects

Owner request (2026-10-22, `conductor-task:phone-multi-project-nav`): "in tabs, the tab I just sent
messages should be prioritized. Also like really work that through: currently I open it up and I'm
just lost when I have 2-3 projects at once, even if I'm using one coordinator in one random project
to sorta manage them all."

## What was wrong

- The Tabs list keeps the computer's order (project, workspace, tab) on purpose: sorting by
  `updatedAt` made running cards leapfrog several times a second (3dd4973). But that order says
  nothing about what the owner is doing, so the tab they just wrote in can sit at the bottom of the
  third project.
- Home's "Recent tabs" sorted by `updatedAt`, which agents bump constantly: five busy coworkers
  fill it and the owner's own conversation drops out.
- Nothing says which tab in a project is the wizard or coordinator, or what a project as a whole
  is doing. Opening the app always lands on Home, away from the conversation the owner was in.

## Design

### One ordering rule (`rankedSessions` / `nowSessions` in `src/phone/app.js`)

Open tabs are ranked into bands; only bands 1-3 are "Now":

1. **Last sent**: the one open tab with the newest owner message. "Owner message" is a real field,
   `PhoneSessionSummary.lastOwnerMessageAt`: the timestamp of the newest top-level user text item
   whose sender (`messageSenderOf`) is the owner, so agents' messages, Conductor notices and
   activity never move it. A message sent from this phone counts immediately (kept locally until
   the computer's state shows it), and one sent from the desktop counts as soon as it lands.
2. **Needs you**: approval or question cards, waiting for input, failed.
3. **Running**: working tabs that are not the coworker of another listed tab (a coordinator's
   running coworkers are counted on its row, "3 coworkers working", not listed one by one).
4. **The rest**, by last activity (they are idle, so this order does not tick). Home fills its
   five rows from here when little is going on; on Tabs the rest is simply the project groups.

Inside bands 2 and 3 the order is by the owner's last message, newest first, then the computer's
order. Never by `updatedAt`: that is what made cards leapfrog. A card therefore moves only when it
changes band or the owner writes somewhere.

### Tabs screen

```
Tabs                          1 need you · 6 running
[All] [Needs attention] [Working] [Done]

NOW
 ● Wizard: Conductor         conductor   You · 2m     <- last sent
 ● Approve npm install?      miron rosin Needs you
 ● Haftheme coordinator      haftheme    Running · 3 coworkers working

▌conductor     Wizard running · 4 running · 1 needs you
  ✦ Wizard: Conductor  (pinned first, marked)
    3 coworkers · 2 working ›
  Notes
▌miron rosin   2 running
  ...
Not open · 12 ›
```

- **Now** sits on top across all projects, only on the unfiltered list (All, no project chip).
  Every row already carries the project badge in the project's stable colour. It holds at most 8
  rows; the rest are still in their project group.
- **Project groups** keep the computer's order (no reshuffling below Now). Each header has a
  colour bar, the project name and a one-line status: the wizard's (else the coordinator's) phase,
  then running and needs-you counts. A project with nothing open says "idle".
- The **wizard** tab of a workspace is pinned first in its group and marked "✦ Wizard". A tab that
  controls coworkers but is not a wizard is marked "Coordinator".
- **Coworkers** stay folded under their controller. Expanded, live coworkers are listed and
  finished ones fold again behind "N finished".

### Home

Home is the overview the conversation's Back returns to: the counts, **Now** (same helper, at most
5 rows, replacing the activity-sorted "Recent tabs"), project cards with the same one-line status,
then recent activity.

### Landing

A cold launch on `#/` (the PWA icon, not a notification or a link) opens the last tab the owner
used, when that was within 12 hours and the tab is still open in the last state this phone saw:
the newer of the tab last opened on this phone and the computer's newest `lastOwnerMessageAt`.
History is seeded Home → conversation, so Back (or the Home tab) is one tap to the overview. A
reload keeps whatever page it was on.

### Cost

`lastOwnerMessageAt` is computed in `summarize` from the projection the phone already reads: a
backwards scan of items that stops at the first owner message, in the same pass budget as
`lastMessage`. Closed conversations that are not resident come from their stored summary
(`historyStandIn`) as before, so no conversation is loaded for this and no query is added per poll.
`wizard` is `wizardActive(settings, provider)` from the same projection.

## Tests

- `src/phone/phone-tabs-order.test.ts` ("phone Now across projects"), on the real app.js: the band order (last sent first, needs-you, running, rest),
  coworkers folded into their controller, the 8-row cap, stability under activity ticks, the
  wizard pinned in its group, the project status line, and the landing choice.
- `src/main/phone-access.test.ts`: `lastOwnerMessageAt` ignores agent and Conductor messages, and
  `wizard` follows the toggle.
- `scripts/smoke-phone-navigation.mjs`: three projects with a wizard and coworkers each, driven in
  a parked window's phone page in WebKit and Chromium; screenshots of the list.
