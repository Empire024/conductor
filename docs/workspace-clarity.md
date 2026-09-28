# Workspace clarity: live work first, finished tabs out of the way

On 2026-09-28 the owner's "local models" workspace held 43 agent tabs, three of them live. The tab
strip was a row of identical "C..." chips, the sidebar a flat list of 40 "completed" rows, and two
tabs wore MAIN (a failed old wizard and the live one). Nobody could tell which tab was in charge,
what was running, or who worked for whom. The rules below cost no model tokens; they live in
`src/shared/workspace-clarity.ts` and are shared by the sidebar, the tab strip and the main-process
sweep.

## One MAIN per workspace

MAIN is the live wizard: a wizard tab that has not handed itself on and whose last turn did not
fail or get stopped. With several, one at work wins, then the one that settled last. With no
wizard, it is the controller with the most live coworkers. Any other controller with live coworkers
is a **Lead**. A handed-off predecessor reads "handed off" and a failed or stopped one reads "ended",
both in Done, never as MAIN. The tab strip's relationship marker follows the same rule (`MAIN` on
one tab, `LEAD` on the others).

## Sidebar

For each workspace, the list shows live work first. The MAIN comes first with its live coworkers
nested under it (waiting on you, then running, then idle). Other live or open tabs follow: running
and waiting agents first, then everything else in strip order. A row that is running is tinted, and
one waiting on you gets an amber edge. Every finished agent tab (done, failed, stopped, handed off)
goes into one **Done (N)** group, collapsed by default and newest first, each row labelled with how
it ended. A controller whose own turn is over but whose coworkers still work stays live, and so
does the MAIN between turns. A pinned tab is never listed as done.

**Close finished** in the Done header asks for confirmation ("Close N finished tabs? History is
kept."), then closes them. Each close goes through `AgentControl.closeFinished`, the route
`agents.finish` uses. The tab goes to the workspace's closed tabs, the CLI process is released, and
a controller that dispatched the tab still reaches it (below). Coworkers close before their
controllers, so a finished controller and its finished coworkers go together. A tab that is still
running, waiting on an approval or a question, pinned, the live wizard, or on another machine is
kept, and the result names it with the reason.

## Tab strip

- **Finished tabs leave the strip.** A finished agent tab that you have not looked at since it
  finished is left out of the strip. It is still open, so you can reach it from the sidebar's Done
  group, the strip's check-mark button (which lists them) or Ctrl+K. Selecting it brings it back.
  "Looked at" is `tab.state.seenAt`, stamped whenever you select a tab (strip, sidebar, menu), both
  on the tab you select and on the one you leave. It is compared with when the conversation settled
  (its newest timeline item). The tab on screen in its pane is never hidden.
- **Order.** The MAIN moves to the front of its pane once per MAIN, so if you drag it elsewhere it
  stays there. Its coworker group follows it and is expanded by default, with live coworkers first.
  Everything else keeps its place.
- **Chips carry titles.** Chips keep at least about 50 px of title. Secondary icons (limit
  continuation, anonymous, the close button on inactive tabs) give way first. Titles that start
  with the same words drop the shared words ("…sidebar", "…sweep"); the full title is in the
  tooltip. Tabs that do not fit go into the **+N** menu at the end of the strip, which also lists
  the finished tabs left out.
- **Pin tab** (tab menu, strip or sidebar) keeps a tab in the strip and exempts it from every
  close rule.

Drag and drop still land where they appear to. Each shown slot also counts the hidden tabs right
before it (`data-drop-span`), so the drop index matches the real tab order.

## The sweep

Every 10 minutes, a finished agent tab closes itself (history kept, same route as above) once all
of these hold: it settled longer ago than the owner's age, you have not looked at it for that long,
it is not the tab on screen in its pane, and none of the keep rules apply. The age is set in
Settings > Usage > **Close finished tabs after**: 4 h, 12 h, **1 day** (default), 3 days, 1 week
or Never. It is stored as `finishedTabSweepHours`. A test profile can shorten it with
`CONDUCTOR_TEST_FINISHED_TAB_SWEEP_MS`. This is separate from the coworker auto-close
(`coworker-autoclose.ts`), which closes a delivered coworker after minutes.

## A closed conversation stays reachable

Messaging a conversation whose tab closed brings it back:

- A controller's `agents.submit` or `agents.steer` to a coworker it dispatched that finished and
  closed reopens the coworker's tab in the background, in the coworker's own workspace, and starts
  the turn. The result says `reopened: true`. `agents.list` lists such coworkers with
  `finished: true, tabId: null`. The dispatch is remembered under `agentControlFinished:<id>`, and
  each controller keeps its last 50.
- The owner credential and a wizard do the same for any closed conversation of their own
  workspace, whoever dispatched it.
- Anyone else still uses `agents.resume` for a closed tab of its own workspace. A conversation it
  neither dispatched nor may command is refused as before.

## Verification

- Unit tests: `src/shared/workspace-clarity.test.ts` (grouping, MAIN, hiding, labels, close rules),
  `src/main/workspace-clarity.test.ts` (sweep and button), `src/renderer/src/layout/tab-seen.test.ts`,
  `src/renderer/src/components/WorkspaceTabList.test.ts`, and `src/main/agent-control.test.ts`
  (controller, owner and wizard reopen).
- Parked smoke: `node scripts/smoke-lock.mjs -- node scripts/smoke-workspace-clarity.mjs`
  (`--before` with `CONDUCTOR_SMOKE_MAIN` screenshots an older build). Screenshots go to
  `artifacts/workspace-clarity/`.
