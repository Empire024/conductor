# Needs attention, and the tab strip's waiting mark (2026-09-29)

## Needs attention (feature-list eb5faab5)

A compact block under the projects list names the agent tabs, across every open project, that need
the owner now (src/shared/needs-attention.ts):

- approval: its turn waits on an approval card (SessionPhase waiting_approval);
- question: it asked the owner a question (waiting_input);
- permission: a request_permission card is still pending;
- limit: it stopped on a usage limit and limit continuation is off (or the provider stopped the turn with
  the usage-limit error);
- failed / interrupted: its turn failed or lost its connection mid-turn, and the owner has not looked at the
  tab since (tab seenAt >= its settle time); a superseded or handed-off tab is not listed.

Not listed: running tabs, a limit wait that continues by itself, finished tabs, and tabs waiting for other
conversations' results (they wake by themselves). Clicking a row shows that tab (agent-control focus, which
switches project and workspace).

Cost and typing: main (src/main/needs-attention.ts) reads what the project roll-up already reads - the
agent_sessions phases and the open layouts - and loads a conversation's state only for tabs whose phase flags
it; never the journal. It recomputes on a 250 ms debounce after `agent:status` and on a 15 s tick (layout and
permission changes), and publishes `attention:changed` only when the list changed. The renderer component is
memoized and re-renders only on that event.

## Tab strip

A tab whose clarity status is `awaiting` shows an hourglass (AwaitingMark) with the "Waiting for results from
…" sentence as its tooltip in place of the completed-turn ring, matching the sidebar's "waiting for …" row.

## Evidence

- src/main/needs-attention.test.ts: every reason across two projects in ranked order; seen, superseded,
  handed-off, closed and self-continuing-limit tabs left out; detached-window tabs included; only flagged tabs
  load state; one recompute per burst and no publish of an unchanged list.
- scripts/smoke-needs-attention.mjs (parked, synthetic Claude): N1 permission card + a failure in each of two
  projects listed, running / waiting-for-results / completed tabs not; N2 no republish in 20 s idle (longer
  than the tick); N3 clicking the other project's row brings that project and tab to the front, and the looked-at
  failure leaves the list; N4 denying the card and a successful retry empty the list, which then takes no room.
  All PASS; screenshot artifacts/verification/2026-09-29-needs-attention/n1-needs-attention.png.
- scripts/smoke-waiting-tabs.mjs W1-W4 PASS again on the same build, now also asserting the strip chip: an
  hourglass and no ring while waiting, none once the review completed.
