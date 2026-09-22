# Local-worker brief: released approval runtime slice

2026-09-22. Owner of this slice: `agent_mucykb2d_xjxx7ve`, visible Conductor tab `tab_mucykawi_mobzyn8`. Initiating invoice controller: `agent_mucxjb30_hbeu26m`. **Tested source changes only; installed behavior is unchanged. No delivery or deployment is claimed.**

## Received brief and lead observation

The completed faktury review and implementation brief were read through the authorized sibling-project `files.read` protocol. Both returned contents are preserved in [local-worker-operating-brief.md](local-worker-operating-brief.md), with source URIs and SHA-256 hashes. The reproduction/test report was finished first; its original failing evidence remains in [approval-auto-refusal-repro.md](approval-auto-refusal-repro.md).

Read-only native snapshot of existing lead `agent_mucxgir3_mmkk8m6`, observed **17:51:29.324 UTC**:

- Phase: **completed**, no active tools. Last activity: **17:49:01.525 UTC**.
- Latest meaningful result: local permission-parity repair and guarded review infrastructure; **329 tests and build passed**. Automatic native execution remains blocked because execution-time guarantees are missing. Nothing deployed; tab retained.
- Durable source: [approval-upgrade-report.md](approval-upgrade-report.md). This is the lead's reported result, separate from this coworker's own checks below.

Refreshed at **17:59:56.847 UTC**: still completed, zero active tools, same last activity and meaningful result. The final source-checkpoint comparison found zero hash mismatches.

The lead's report explicitly states: “the legacy Auto-refusal branch and its tests are available for your bounded follow-up; preserve the added `!this.options.reviewApprovals` gate.” That releases `src/main/providers/codex.ts` and `codex.test.ts` for this slice. Both files accepted exact-content `files.write` lease checks before editing. Existing broker, structured-session, shared/UI and other agents' claims were preserved. No control relationship was seized or released. The earlier direct-message ownership refusal remains respected; this document and the project checklist are the durable relay.

## Implemented source behavior

- Auto's native command/file/permission requests now reach the existing pending-interaction path. The adapter publishes a notice, the approval interaction, tool-awaiting-approval state and `waiting_approval`. It sends neither native decline nor cancellation merely because Auto cannot approve.
- Enabled MCP tools keep their existing Auto path unless host review or reviewer isolation requires the native request to remain pending. The existing `reviewApprovals` gate is preserved.
- Auto native escalation offers only native-provided decisions and removes session-wide grants. A permission request can grant its native turn scope; this is not represented as a command-specific grant. The provider's genuine response API remains authoritative. No host executor was added.
- Identical repeated pending requests reuse the existing card. Changed method/arguments under the same request ID expire its old interaction and prohibit that identity for the remainder of the runtime. The existing canonical comparison helper is reused. The invalidation set is bounded; saturation refuses further requests. No alternate approval architecture was created.
- Native response reservation remains synchronous. Stale runtime, unoffered decision, duplicate answer and ambiguous-delivery retry continue to be refused. Actual human denial still travels through the genuine native decline response; no policy refusal is converted into a human denial in this branch.

Files changed in the released implementation: [codex.ts](../src/main/providers/codex.ts), [codex.test.ts](../src/main/providers/codex.test.ts). New/extended regression coverage: [codex-auto-refusal.regression.test.ts](../src/main/providers/codex-auto-refusal.regression.test.ts). The original six expected failures are now ordinary passing assertions, with no environment switch or expected-failure annotation. The historic failing JSON is retained separately.

## Observed validation

**303/303 tests passed across seven files**, exit code 0. [Machine-readable result](../artifacts/approval-auto-refusal-after-fix.json).

| Suite | Tests |
| --- | ---: |
| New Auto-refusal/native-response/renderer regression | 16 |
| Existing Codex adapter | 47 |
| Approval review journal | 13 |
| Approval review gate | 9 |
| Structured sessions | 112 |
| Existing structured renderer | 64 |
| Existing attention projection | 42 |

The new renderer regression consumes the adapter's actual interaction event and renders the existing component without launching Electron. It verifies `needs-attention`, enabled **Allow once** and **Deny** buttons, exact synthetic command text, and removal of controls after resolution. The adapter fixture verifies native permission-response shape, owner accept/deny, exact duplicate delivery, changed-argument invalidation, stale response rejection, reconnect without replay and explicit uncertainty after ambiguous delivery. The existing process fixture additionally observes the provider's synthetic completion after owner acceptance. No invoice command or process inspection was used.

`npm.cmd run build` passed, including TypeScript, main/preload and renderer builds (renderer: 17.88 seconds). `git diff --check` passed for the touched tracked files; only line-ending warnings were emitted. No Electron smoke or live native escalation was run. [Source checkpoint](../artifacts/approval-auto-refusal-source-checkpoint.json) records the tested source hashes; other agents' unrelated work was not rolled back. These checks do not replace later integration acceptance against the final shared source state.

## Remaining integration and ownership

This is the highest-priority released slice, not completion of the full operating brief. The existing lead still owns the broker/reviewer integration and its report; its earlier source freeze is superseded for the changed adapter files.

| Requirement | Current boundary / next owner |
| --- | --- |
| Qualified equal-or-higher tier and comparable-effort reviewer | Existing lead's routing policy still needs the requested verified comparison and explicit authority contract. This slice does not create reviewer authority. |
| Reviewer Auto-block → one human escalation for the original action | The adapter retains a reviewer's own native request. The original-worker handoff, one-time human escalation and recursion policy remain broker/routing work. |
| Durable project/device/action-digest binding and execution fencing | Existing broker journal/gate work remains under the lead. The adapter retains exact native request data and runtime identity, but cannot establish atomic execution preconditions or cross-provider fencing. `supportsExactExecution` remains absent in production. |
| Pending approval after process reconnect | Existing adapter behavior expires stale requests and never replays them. Recovery of an actionable owner card across process restart is not implemented here. |
| Human denial persistence across native routes | Existing synthetic journal/denial-gate checks pass. The new adapter does not claim native cross-process/cross-provider enforcement beyond that boundary. |
| Enforced local task packets, tool/output/time budgets, checkpoints, freeze/acceptance and one-repair limit | Preserved in the copied brief; no local-agent runtime edits in this slice. Existing `invoicing-runtime-budget` and recovery/telemetry claims remain with the lead. |
| Compact observation and successor coordination | Compact read-only evidence is relayed here. No new authority, messaging endpoint, controller handoff or telemetry API was implemented. |
| Matched throughput/economics benchmark | Not run. Ornith's three-call CSS microtask remains assisted work; the failed broad task and cloud repair costs remain in the copied source. No savings claim. |

The separately claimed `codex-auto-owner-escalation` and evidence checklist entries remain `[~]` for outstanding native acceptance/delivery; existing claims were not transferred. There is no need to bypass another controller to preserve or review this handoff.

## Installed app and machine boundary

No commit, push, release, deployment, installation or app restart was performed. No model server was started, stopped or switched; no model files were downloaded or software installed; no local inference or extra queue was created. The one-resident-Ornith/one-local-queue constraint remains unchanged. All implementation and tests in this slice are cloud-coworker work, not Ornith authorship.

The invoice controller has asked the owner to change its conversation from Auto to Edit and is awaiting confirmation. This coworker made no inspection/restart retries and did not infer that the setting had changed. The installed app has not received this source fix; genuine native/platform approval still applies to any later request.
