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
