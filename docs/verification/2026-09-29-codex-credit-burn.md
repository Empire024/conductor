# codex-credit-burn: closing the final-review REJECT (2026-09-29)

The final review (docs/verification/2026-09-29-final-review.md, "codex-credit-burn") rejected the item
for two gaps and asked for parked checks of fixes (1) and (4). All of it was run on a build of HEAD
d16b4bd plus exactly this change, in a detached worktree (parked windows, smoke lock, one at a time,
no local model server touched). Raw logs: `.conductor-scratch/relay-roll/evidence/`.

## Fix (3): relay and coordinator tabs are short-lived sessions

What it does now:

- `tabs.open` / `router.dispatch` record a relay or coordinator role (`role`, or a title naming a
  relay, bridge or coordinator) as the setting `coordinationRole:<id>`; such a tab still opens on
  medium effort (2fdd0d5).
- After each of its turns settles (`StructuredSessions.onTurnSettled`), `AgentControl.rollIfLong`
  reads the tab's context from its own last usage report (`summarizeContext`, the same figure
  `agents.status` shows). Past `RELAY_CONTEXT_TOKENS` (60,000) it continues the tab through the
  existing successor path (`succeed`, as `agents.handoff({successor:true})`): a new tab named
  "<title> (continued)" on the same provider, model, effort and mode, in a fresh native session,
  takes over the controller link, coworkers, handed-in senders, permission grants and any pending
  restart; the old tab is marked superseded ("Rolled to a fresh session … at N tokens") and says
  where it went.
- The fresh session's first prompt is a short Conductor brief (`relayBrief`, well under 2,500
  characters): the role as first given (carried down the chain in `coordinationInstructions:<id>`,
  so briefs never nest), the last exchange, and "reply Ready. and wait".
- A controller that still addresses the old id is forwarded to the newest session (agents.steer /
  agents.submit; result `forwardedFrom`); cross-workspace and cross-project messages already follow
  successors. The successor chain is followed up to 64 hops (was 8).
- Never a wizard, a local model, an approval reviewer, a tab on another machine, a tab with input
  queued or a turn running. A roll that fails is reported on the tab as a notice and not retried
  in that run.

Evidence:

- Unit tests (`agent-control.test.ts`, "relay and coordinator tabs roll to a fresh session past the
  context bound", 2 tests): no roll at 59k; roll at 61k into a new runtime with the brief;
  successor recorded as relay and superseding the old tab; controller's steer to the old id
  delivered to the successor (`forwardedFrom`); a short successor does not roll, a long one rolls
  again and the next brief carries the original instructions, not the previous brief; a `worker`
  never rolls.
- `scripts/smoke-relay-roll.mjs` (new), parked: **PASS 5/5**. Eight messages sent to the relay's
  first id, each synthetic Codex turn 25k tokens larger than the last:
  contexts 25k, 50k, **75k → rolled**, 50k, **75k → rolled**, 50k, **75k → rolled**, 50k; briefs
  844 / 856 / 856 characters, each successor at 3,000 tokens after its brief; messages 4-8 all
  `forwardedFrom` the first id; `agents.list` shows each rolled session superseded by its successor.
  Peak context 75,000 tokens against 200,000 without the roll.

## smoke-token-burn: root cause and fix

Root cause (product): `TokenBurnService` cached every tab's measure for 55 s, including an empty
one. The meter's publisher ticks (every second in the smoke, every minute in the app) over every
conversation whose runtime is up *or starting*, so a tick landing between the tab's runtime
starting and its turn's usage row cached `null`, and the smoke's 15 s poll then read 0. Whether a
tick landed in that gap depended on how long the synthetic app server took to start, which is why
the same build passed at 12:59 and failed under the durable-jobs soak load. In the app the same
race hid a new tab's burn for up to a minute.

Proof on the unfixed review build (feeae95, `.conductor-scratch/final-review/wt`), with the smoke's
poll widened to 75 s: `meter caught up after 54879 ms` (the 55 s cache expiring). On the fixed build
the same variant: `meter caught up after 44 ms`.

Fix: `StructuredAgentStore.usageMark(id)` counts each conversation's top-level usage reports as they
are projected; the meter keys its cache on that mark, so a cached reading is dropped as soon as the
conversation reports usage and is still reused while nothing new arrived. Unit test
(`token-burn.test.ts`, "drops a cached reading once the conversation reports usage") fails on the
old meter and passes now. `scripts/smoke-token-burn.mjs` is unchanged and passes **2 of 2** runs on
the fixed build.

## Parked checks of fixes (1) and (4)

`scripts/smoke-credit-burn-controller.mjs` (new), driven with a real controller conversation's own
app-control credential: **PASS 3/3**.

- (1) The controller in the project's first workspace steers the lead of workspace "Review room" (opened by
  the owner, nobody's coworker): `acrossWorkspaces: true`, `controlled: false`, delivery started, no
  tab opened in either workspace; the lead receives `[From Build controller (<id>), workspace
  "…"] …` and replies with its own credential the same way.
- (4) A coworker opened by the controller hits the provider usage limit (`synthetic:usage-limit`);
  90 ms later the controller holds `[Conductor] Your coworker "Limited worker" (<id>, codex) stopped
  on its provider's usage limit: You've hit your session limit · resets in 3 seconds. …`.

## Suites

Unit files touched (agent-control, structured-sessions, structured-store, token-burn,
turn-briefing): 374/374 before the brief-chain fix; the two roll tests again after it. Typecheck
and electron-vite build clean on the worktree. The full suite runs in git.ship.
