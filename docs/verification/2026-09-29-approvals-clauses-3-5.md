# Permission approvals: clauses 3 and 5, and three review leftovers (2026-09-29)

Feature item `permission-approval-delivery-classifier`. The final review
(`2026-09-29-final-review.md`, Rejections) accepted clauses 1, 2 and 4 (feeae95,
`2026-09-29-approvals-residual.md`) and rejected the item on clause 3, which had no code, and clause
5, whose listing half was never re-run. This record closes both, plus three non-blocking findings of
the same review. Builds: a detached worktree of 8507c9a plus exactly this change. Parked smokes ran
one at a time under `smoke-lock`. No local model was started.

## Clause 3: "request_permission is exempt from the classifier"

**Code.** `CONDUCTOR_MCP_ALLOWED_TOOLS` (`src/main/permission-grants/control-mcp.ts`) is
`mcp__conductor__request_permission` and `mcp__conductor__list_permissions`. `ClaudeAdapter.flagAllowRules`
(`src/main/providers/claude.ts`) puts them in the flag-settings layer of every Claude tab that has
the conductor MCP server. They go in `--settings` at launch, which a tab with no grants now also
gets. They also go in every `apply_flag_settings` set, which replaces the layer, so a grant change or
revocation keeps them. Only the two exact tool names are allowed. There is no server-wide rule, so
`control` and `send_message` are still judged. An approval reviewer and an evaluation turn get
nothing.

**Unit.** `claude.test.ts`, "exempts the conductor request tools from the classifier with exact allow
rules, kept beside the grants": launch with no grants, launch with a grant, a live set after the
grant is gone, and no rules for a reviewer or evaluation turn. 122/122 pass.

**Real CLI** (claude 2.1.282, `CONDUCTOR_REAL_CLAUDE=1 node scripts/probe-request-permission-exempt.mjs`).
Headless, sonnet/low, stub stdio `conductor` server (`scripts/fixtures/stub-conductor-mcp.mjs`) that
runs nothing. The request names the production apply refused on 2026-09-28. `permissionDecisionMs`
comes from the CLI's own debug log. Two runs; the first run's table was wrong because 2.1.282 logs MCP
calls as `tool=mcp_tool`, so its values were read back from the debug logs, and the parser is fixed:

| case | rules | permissionDecisionMs (run 1, run 2) | decided by | call ran |
|---|---|---|---|---|
| A request_permission, no rule | 0 | 1037, 596 | classifier | yes, yes |
| R request_permission, `--settings` | 2 | 0, 0 | rule | yes, yes |
| P list_permissions, `--settings` | 2 | 0, 1 | rule | yes, yes |
| L request_permission, live `apply_flag_settings` | 2 | 0, 0 | rule | yes, yes |

Run 2 exited 0 (4/4 as expected). A shows that the classifier really does judge conductor MCP calls
in Auto. That was the gap: with no rule, a request could be refused, as on 2026-09-28. With the
rules, the classifier is never consulted.

**In the app** (parked, `scripts/smoke-permission-grant.mjs` 7/7). The synthetic CLI logs its flag
layer. At launch and in every live rule set a grant change sent, it held both exemption rules beside
the grant rule.

## Clause 5: "agents.list shows dispatched coworkers, and a finished router.dispatch tab stays reachable"

No defect was found in the code: `agents.list` lists the caller's own-workspace tabs,
`reachableElsewhere` (any other workspace or project where the caller holds the control link) and
`finishedBy` (coworkers that finished and closed). `agents.steer` reopens a finished coworker. New
parked smoke, `scripts/smoke-dispatch-listing.mjs`, driven from the controller's own credential with
a synthetic Claude CLI, **5/5 PASS in 2 of 2 runs**:

- **D1.** `router.dispatch` of two coworkers into the controller's project. `agents.list` lists both,
  with their tab ids. One is running, one completed.
- **D2.** The completed coworker is closed with `agents.finish`, and its tab is gone. It is still
  listed with `finished:true, tabId:null`. `agents.steer` reopens it (`reopened:true`,
  `delivery:"started"`), it runs a turn, and it is listed with a tab again.
- **D3.** `agents.steer` into the running coworker answers `delivery:"steered"`, and the running CLI
  receives the message in that turn.
- **D4.** `router.dispatch` into another open project with no wizard (the Haftheme case). Listed
  with `crossProject:true, controlled:true`. After `agents.finish`, listed `finished:true` and
  `crossProject`. `agents.steer` reopens it in its own project and it runs a turn.
- **D5.** `router.dispatch` into a project with a wizard hands the task to that wizard (ddbc6fb):
  `deliveredTo` is the wizard, no tab opens and `agents.list` is unchanged. The wizard answers with
  `send_message`.

## Review leftovers

- **(i) `agents.steer` said `delivery:"queued"` for a message it steered into a running turn.**
  `StructuredSessions.steerOrStart` now returns `SteerDelivery` (`started | steered | queued`).
  `followup` returns `steered` once the provider took the steer, and `queued` when the message waits
  in Conductor's queue. That applies to `agents.steer`, `agents.report`, `send_message`, a wizard
  hand-in and a local coworker's first prompt. The tools.list catalog and `docs/agent-control.md` say
  so. Tests: `agent-control.test.ts` expects `steered` for a steering provider and `queued` for one
  that cannot steer; parked: D3 above.
- **(ii) `agents.history {raw:true}` could return an unmasked token before the H17 backfill finished.**
  `StructuredAgentStore.journalRange` and `events` now run `maskStrings` over the rows they read
  while `redactionPending` is set. After the walk has finished, rows pass through unchanged, as
  before. Test: `structured-store.test.ts` (H17) reads the journal back before the walk and finds
  `CONDUCTOR_CONTROL_TOKEN=[REDACTED]` and no token.
- **(iii) Stale smokes after deliberate UI changes.**
  - `smoke-pasted-text.mjs` step 2: the chip now opens the text in the document strip's preview, and
    the chip has its own "Put … back in the message as text" button (0f968a8). 4/4 checks pass.
  - `smoke-permission-grant.mjs`: a spent grant's card reads "Action succeeded" with
    `data-grant-status="used"`, and a session grant reads "Action succeeded · in force now" (19ba9c9).
    Step 3b: an approval given while the turn runs now interrupts it and arrives as a turn of its own
    (404f175), instead of waiting in the queue. The flag-log checks ignore the two exemption rules and
    assert that they are present. 7/7 checks pass.
  - `smoke-control-repairs.mjs` G7 now expects `steered` for the running-turn steer. It was not run to
    G7: the script stops at its own "open project" stage (a `dialog.showOpenDialog` stub followed by
    `projects.openFolder`), before any check, and nothing in this change touches that stage. D3
    covers the same assertion.

## Tests

`vitest` on the four changed suites: `agent-control`, `structured-sessions`, `phone-access` and
`structured-store` pass 372/372, and `providers/claude` passes 122/122. `tsc --noEmit` is clean in
the worktree.
