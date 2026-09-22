# Auto policy refusal loses owner approval — reproduction and handoff

Date: 2026-09-22. Dedicated evidence owner: `agent_mucykb2d_xjxx7ve` (visible native tab `tab_mucykawi_mobzyn8`). Existing implementation lead: `agent_mucxgir3_mmkk8m6`. Initiating controller: `agent_mucxjb30_hbeu26m` in faktury.

## Released source follow-up (supersedes the initial no-edit checkpoint below)

The lead subsequently released the legacy Auto-refusal branch and its tests in [approval-upgrade-report.md](approval-upgrade-report.md). The bounded repair is now implemented and tested in source: native approval requests remain pending with actionable existing UI controls; changed request arguments invalidate stale choices. **303/303 tests and the build pass.** All six original expected failures were promoted to ordinary passing assertions, plus additional duplicate-request, permission-scope and renderer checks. The historic [6-pass/6-failure result](../artifacts/approval-auto-refusal-regression.json) remains unchanged; [after-fix evidence](../artifacts/approval-auto-refusal-after-fix.json) is separate.

Full details, exact release, current lead observation and pending integration: [local-worker-runtime-report.md](local-worker-runtime-report.md). The copied completed local-model review/brief is [local-worker-operating-brief.md](local-worker-operating-brief.md). **Installed behavior is unchanged; no deployment/restart occurred.** Original-action reviewer-to-human routing, full execution binding/fencing and actionable process-reconnect recovery remain outstanding. The following sections preserve the initial tests-only checkpoint and its then-current limitations.

## Coordination checkpoint

Read `docs/approval-upgrade-brief.md`, the approval checklist, current `app.state`, `agents.list`, and the lead's native snapshot. The lead owns the approval broker/gate, structured-session integration, shared/UI integration and `docs/approval-upgrade-report.md`. Preserve all existing edits.

An `agents.steer` handoff to the lead returned HTTP 400 on 2026-09-22 at approximately 17:40 UTC. The initial response body was not captured. A later explicit UTF-8 request captured the error: `Another agent already controls this tab; its controller must release it first`. The current control implementation refuses steering a tab with another controller; no relationship was released and no alternate control route was attempted. The initiating controller confirmed the same ownership block and authorized only this document plus a uniquely named tests-only regression file, then stopping. That bounded work is now recorded below.

The requested `codex.ts` / `codex.test.ts` release was not granted; neither file was edited by this coworker. The new file is [codex-auto-refusal.regression.test.ts](../src/main/providers/codex-auto-refusal.regression.test.ts). The existing `reviewApprovals` hunk is preserved. No approval-broker, shared/UI or lead report edits were made. The lead retains [approval-upgrade-report.md](approval-upgrade-report.md) and can incorporate this evidence there.

Discoverability: [feature-list.md](../feature-list.md) contains the separately owned `approval-auto-refusal-evidence` item linking this document and the test file. The existing implementation task and its ownership marker were preserved. The evidence item stays in progress because the lifecycle fix and native acceptance remain outstanding.

## Owner-reported incident

The invoice controller requested a read-only `exec_command` with `sandbox_permissions: require_escalated`, using `Get-NetTCPConnection` / `Get-CimInstance` to verify a loopback invoice server process. Two attempts were reported to receive `Auto declined … to keep the workspace sandbox`, followed by `Runtime interrupt`, without a pending approval alert or clickable Approve/Deny control. The owner said “Also approved, continue”; another attempt was still auto-declined. The owner repeats “I approve this”.

This is owner-supplied runtime evidence, not an independently executed invoice reproduction. This coworker has not run the invoice commands, inspected its server process, read its task board, or attempted another route around the declined action.

## Local source evidence

`CodexAdapter.serverRequest` recognizes command, file-change and permission approvals. In Auto, when `reviewApprovals` is absent, it sends an immediate native `decline` (or `cancel`) for a non-MCP approval and returns before creating the `PendingInteraction`. Therefore there is no retained adapter request, no interaction projection, and no owner response control for that request. Natural-language owner approval on a later turn does not change this branch.

The existing test named `declines a request to leave the workspace sandbox itself in Auto, and still asks the owner questions` explicitly requires no interaction, one native decline, a policy-decline notice and a rejected tool. This is a regression contract for the reported faulty behavior. Its synthetic command is an inert fixture; it does not inspect invoice processes.

The adjacent Edit-mode tests already exercise the genuine App Server approval response path. `respond` validates runtime identity and offered decisions, rejects duplicate answers, and sends the response to the provider. Conductor must retain this native path rather than executing the command itself.

## Acceptance contract for the lead

- Auto policy refusal retains the exact pending action and digest, publishes an alert and actionable owner card, and does not send native decline/cancel or interrupt merely because Auto cannot approve.
- Policy refusal is distinct from owner denial. Explicit owner approval can resolve that pending action; actual owner denial remains durable and cannot be bypassed through another route.
- Only a separate reviewer with equal-or-higher model tier and sufficient comparable effort, within explicit authority, may approve. No inferior reviewer or self-approval. An Auto-blocked reviewer escalates once to the human; no recursive reviewer creation or silent interruption.
- Mandatory native/platform approval remains genuine. Bind project, device, scope, exact arguments and digest; invalidate changed arguments. Send at most one response. Preserve/reconcile pending requests on reconnect; uncertain delivery must not cause execution replay.
- Audit request, policy refusal, reviewer decision/escalation, owner answer, response delivery and observed execution without credentials.
- Cover initial refusal, subsequent explicit owner approval, reviewer refusal to human, owner denial, reconnect, changed arguments and ambiguous execution.

## Exact test and build outcome

- At 17:41:17 UTC, the focused existing Auto-decline fixture passed (1 test; 46 skipped; 1.48 seconds).
- At 17:42:04 UTC, `npx.cmd vitest run src/main/providers/codex.test.ts src/main/approval-review.test.ts src/main/approval-review-gate.test.ts` passed all 69 existing tests across 3 files in 24.22 seconds. These establish existing behavior and synthetic broker coverage, not a fix.
- At 17:46:25 UTC, the new regression file's normal run completed in 5.32 seconds: **6 ordinary passing tests and 6 explicitly expected failures** (`it.fails`, labeled `KNOWN GAP`). Vitest displays 12 passed for that mode. This must not be reported as 12 fixed acceptance cases. A repaired behavior makes its expected-failure test fail until the lead promotes that case to an ordinary test.
- With `CONDUCTOR_ASSERT_APPROVAL_FIX=1`, the same assertions run as ordinary acceptance tests: **6 passed, 6 failed, exit code 1**. Machine-readable evidence: [approval-auto-refusal-regression.json](../artifacts/approval-auto-refusal-regression.json).
- `npm.cmd run build` completed successfully, including `tsc --noEmit` and all Electron Vite build stages. It did not start or update the app. `git diff --check -- feature-list.md` passed. The shared working tree was not frozen; this is a successful build observation of its then-current state.

Run the acceptance assertions in PowerShell:

```powershell
$env:CONDUCTOR_ASSERT_APPROVAL_FIX = '1'
npx.cmd vitest run src/main/providers/codex-auto-refusal.regression.test.ts --reporter=json --outputFile=artifacts/approval-auto-refusal-regression.json
```

The new fixture replaces only the adapter's transport dependency with an in-memory native protocol peer. It starts no provider process, executes no shell command, accesses no network/model, and opens no window. `Write-Output synthetic` is inert protocol data, never executed.

| Acceptance area | Observed result | Limit |
| --- | --- | --- |
| Initial Auto refusal | Three failures: command, file-change and permission requests produce no pending card and receive native refusal responses. | No owner alert can arise from an absent interaction. |
| Explicit owner approval after policy refusal | Fails: response is rejected as expired/already answered; the prior native decline remains. | The test invokes the genuine response API; it does not pretend natural-language approval is a native answer. |
| Reviewer Auto refusal | Fails: an isolated reviewer flagged with `approvalReviewer: true` in Auto also loses the native request. | Original-worker handoff, one-human escalation and recursion prevention are not established by this adapter test. |
| Owner denial | Passes: native decline is sent once; a later accept is rejected. A separate journal test preserves human denial across reconstruction and changed worker arguments. | Journal persistence is synthetic; these checks do not establish native cross-route fencing. |
| Reconnect | Passes: old response is unusable, pending interaction expires, and a resumed adapter sends neither a new turn nor a stale response. | Recovery of an actionable pending owner card is **unsupported**, not passed. |
| Changed arguments | Fails: after the same native request ID is reissued with changed arguments, the old owner choice can still emit accept. | The duplicate request receives an error, but the stale choice is not invalidated. This is a malformed-provider test, not a claim that current Codex emits such duplicates. |
| Ambiguous delivery | Passes: a send that records a response and then throws produces explicit uncertain/disconnected state; retry is refused. | At-most-once response attempt is established; actual native execution and cross-process fencing are not. |
| Existing Edit and host-review routes | Passes: Edit exposes exact arguments and genuine native choices; stale runtime/session-wide/unoffered answers are rejected; two views cannot answer twice. `reviewApprovals: true` retains an Auto request without answering. | Renderer alert visibility, reviewer model/effort ranking and full broker integration are unverified here. |

## Current limitation and safe owner action

**No runtime fix was implemented or delivered in this slice.** Production edits need release from the existing lead. Equal-or-higher reviewer model tier plus comparable effort, a typed distinction between policy refusal and human denial, original-request human escalation, durable actionable reconnect, full project/device/digest binding at execution, and credential-safe end-to-end audit remain the lead's integration/acceptance work. Passing synthetic journal or native-response checks must not be presented as authority to bypass platform approval or as proof of actual single execution.

No deployment, commit/push, installer, app restart, model download/server launch or Electron smoke was performed. The installed app is unaffected by working-tree changes. The invoice process inspection was never run by this coworker.

An already declined provider request cannot honestly be represented as still pending. The initiating controller reports that the owner has now been asked to switch the affected invoice conversation **Auto → Edit**, based on the verified source and fixture path, without asking the owner to repeat their task approval. The controller can then request the exact action through its genuine native approval flow. Any mandatory platform approval still applies. This coworker neither changes that tab nor executes its request. Live invoice UI behavior has not been verified here. No app restart is needed for the source-tested next-turn permission selection.

This tests-only slice is stopped, ready for the lead to incorporate and for the promised local-worker operating brief to arrive in this same tab.
