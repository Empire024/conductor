# Waiting-for-results tabs stay active (2026-09-29)

Owner report: the independent reviewer tab `agent_mumgbwry_9p0h99y` ended its provider turn waiting for fix
commits from coworkers it does not control and was filed under Done, where the finished-tab sweep would
eventually close it. Ending a turn to wait is not finishing.

## The signal

An explicit declaration (src/shared/awaiting-results.ts), because only the conversation knows it waits and an
idle tab that merely could receive a message must still go to Done:

- `agents.await({agents, reason?})` names the conversations it waits for; `agents.await({clear:true})` cancels;
- `send_message({agentSessionId, text, awaitReply: true})` (agents.steer with `awaitReply`) awaits the recipient;
- a controller's own live coworkers already keep it live (control links), so they need no declaration.

The record is a settings row (`awaitingResults:<id>`), so it survives a restart. It is resolved from the
waiter's persisted timeline: a user message whose origin is an awaited conversation (or its successor), newer
than the declaration. Every route another tab reaches it by records that origin, and the message itself starts
the waiter's turn, so nothing polls. Each awaited conversation drops out when its message arrives; when none is
left the record is deleted and the next settle is Done. `agents.finish` and every finish route clear it; an
awaited tab that is closed is no longer waited for; a stopped, handed-off or superseded waiter is not waiting.
Claude and Codex tabs are told once per runtime how to declare it (turn-briefing AWAIT_HINT).

While waiting: workspace clarity status `awaiting` (live group, second line "waiting for <name>", tooltip with
the reason), and the finished-tab sweep, "Close finished", the coworker auto-close sweep and the tab archive
refuse it, naming whom it waits for.

## Evidence

- Unit: src/shared/awaiting-results.test.ts, src/main/awaiting-results.test.ts; integration in
  src/main/agent-control.test.ts ("waiting for results"): declare, arrival clears, restart (fresh AgentControl
  over the same database), awaitReply, clear, closed awaited tab, finish.
- Parked smoke `scripts/smoke-waiting-tabs.mjs` (spawn mode, synthetic Claude CLI), on HEAD plus only this
  change, built in a detached worktree: W1 reviewer live "waiting for Fixer", plain and superseded tabs in Done;
  W2 same after the owner's app.restart; W3 the sweep closes the Done tabs and keeps the reviewer, Close
  finished refuses it; W4 the fixer's message starts one reviewer turn (delivery started, no polling), the
  reviewer waits again and stays live, the second message completes it and it moves to Done. All PASS
  (the harness cleanup inventory twice tripped over an unrelated process command line; no process was left).

## Review fixes (reviewer agent_mumgbwry_9p0h99y on 93c049f)

1. Partial arrivals were not consumed durably: the owed list was recomputed from the projection,
   which keeps only the newest 2000 items, so a reply that fell out of it brought a satisfied
   dependency back. Now each read consumes arrivals from the durable event journal
   (StructuredStore.journalRange, a primary-key range from the record's cursor, at most 20 pages of
   1000 rows) and saves the remaining owed list with the sequence it read through; the projection is
   only a fallback when the journal was trimmed past the cursor. Main consumes on every
   `agent:status` change of a waiting conversation (index.ts), so a reply is recorded as soon as it
   starts or joins a turn. Regressions: src/main/awaiting-results.test.ts (eviction + journal trim +
   restart; a reply already out of the projection) and agent-control.test.ts (real journal, projection
   emptied, fresh AgentControl).
2. send_message awaitReply took its baseline after delivery, so a reply that landed while the send
   was returning was ignored. The baseline is now the sender's sequence before delivery.
   Regression: agent-control.test.ts, the fixer replies inside the delivery; the test fails on the old
   order and passes on the new one.

## Second review (reviewer agent_mumilb5c_0ba33es on 66e7037)

1. A reply steered into an already running turn emits no `agent:status`, so a long turn could
   outlive the journal's retention before the next consume. The journal events are now consumed
   as they are broadcast (`structured:events`, already durable): only user messages with an origin
   are looked at, and only for a conversation that has a wait. Regression: a reply joining a running
   turn, then 25,000 events and a journal trim, still owes only the other agent.
2. The cursor could move to the projection's sequence past events that were staged but not yet
   written. The projection (which holds the staged tail) is now always read too, and the cursor
   moves past the journal's end only when the journal was read to its end; with more than 20 pages
   pending it stops at the last durable event read and continues from there. Regressions: a staged
   reply; bounded paging that resumes.

## Third review (reviewer agent_mumilb5c_0ba33es on 14208ca)

A flush checkpoints (and may trim the journal) before its events are broadcast, and the outbox drains
500 events per tick, so a reply's broadcast can arrive after the reply has left both the journal and the
projection; noteEvents re-read those stores and lost it. noteEvents now counts the broadcast reply itself.
Each owed agent carries its own baseline (record.baselines), and a reply counts when it is newer than
that agent's baseline, even if a catch-up read already moved the cursor past a trimmed gap. consume()
judges journal and projection arrivals per agent the same way, so an older message from a newly awaited
recipient never counts. Regressions (src/main/awaiting-results.test.ts): the delayed broadcast after a
25,000-event trim, then a restart; per-agent baselines with add().
