# Local-worker operating brief received in Conductor

Received 2026-09-22 by agent_mucykb2d_xjxx7ve from faktury project project_mucnd7cv_6r2ehsg. The source snapshots below are preserved verbatim. They establish assisted local contribution and no measured net savings. No deployment, restart, downloads, installs, server changes or invoice inspection is authorized.

Current implementation/evidence: [local-worker-runtime-report.md](local-worker-runtime-report.md). Approval regression: [approval-auto-refusal-repro.md](approval-auto-refusal-repro.md). Existing approval lead retains its broker and integration; its report releases only the legacy Codex Auto-refusal branch and its tests for this coworker.

---

Source: [docs/LOCAL_MODEL_REVIEW.md](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FLOCAL_MODEL_REVIEW.md)
Source content SHA-256: `f057bee6d0408633e9be9c81536b0c84be84aafaa59562bdd60ce6b9a2728353`

# Local model review — 2026-09-22

This run did not demonstrate net GPT token or cost savings. Local experimentation, orchestration and repair consumed substantial frontier work. A capable cloud model might have completed the application with less coordination, but we have no measured comparison and cannot quantify that counterfactual.

## What worked

Only resident `local/ornith1.5-9b` was practically tested. It produced useful inventory, PDF extraction and rendering code after explicit guidance. It executed a supplied sandbox probe and completed narrow repairs. Accepted inventory tests passed 5/5 and extraction tests 4/4. These are assisted contributions, not independent end-to-end delivery.

## What failed or remains unknown

- Broader tasks repeatedly exhausted the observed 16-tool-round ceiling. Accepted follow-ups did not establish successful recovery.
- Unfamiliar PDF libraries led to invented APIs and package paths. Tests also needed precise repairs.
- Generated reports misattributed cloud work to local models and recommended a prohibited second server. Reporting needs evidence review too.
- Configured Qwen models were not resident or tested. Findings about Ornith cannot establish their capabilities.
- Budget GPT produced substantial UI code but missed form state and API contracts; passing syntax checks was insufficient.
- Claude Haiku's permission mismatch delayed shell and safeguard work. Owner approval eventually unblocked both; that is not a deployed Conductor fix. The safeguard produced logs, but automatic restart was not demonstrated.

## Changes needed before local models can handle much of this work

1. Give one small file-level change, exact input/output contracts, a working library example and a concrete acceptance check per task.
2. Supply compact repository context and real tool/model capabilities. Show remaining rounds and checkpoint before exhaustion; create a fresh bounded recovery turn when needed.
3. Limit repeated repair loops. Escalate with a minimal failing example and distinguish local authorship, supplied-code execution, assisted repair and cloud takeover.
4. Route authorized worker approval requests to a stronger reviewer, with accurate effective permissions, persistent audit and owner escalation when required. Preserve platform security boundaries.
5. Measure provider tokens, wall time, retries, reviewer time and accepted changes. Compare equivalent small tasks before claiming savings.
6. Compare other already configured local models sequentially only after owner authorization to change the resident server. Never launch a second server or download weights implicitly.

Local inference can avoid per-token API fees, but compute, electricity and cloud review still have costs. Financial correctness, archive integrity and final integration remain higher-tier responsibilities until measured evidence justifies changing that allocation.

Detailed chronology and attribution: [LOCAL_MODEL_REPORT.md](LOCAL_MODEL_REPORT.md). Upgrade briefs: [CONDUCTOR_UPGRADE_PROMPTS.md](CONDUCTOR_UPGRADE_PROMPTS.md) and [LOCAL_WORKER_CONDUCTOR_BRIEF.md](LOCAL_WORKER_CONDUCTOR_BRIEF.md). The completed CSS comparison and implementation contract follow. These conclusions supersede earlier assignment-only checkpoints.

## Completed CSS experiment and attribution

| Assignment | Observed result | What it establishes |
| --- | --- | --- |
| Broad CSS repair, agent_mucxgrwc_o7o4pgv | Failed at the runtime's 16-round ceiling, zero edits; prompt requested at most eight rounds | Prompt budgets alone are ineffective; repeated context/ownership investigation consumed the turn |
| Fresh exact-selector microtask, agent_mucxlr6k_kb0tgea | One read, two edits, final handoff and freeze at 17:12:26 UTC | Ornith can perform a supplied one-file contract with limited exploration |
| Lead integration | Corrected row grid, missing breakpoint, radio direction and desktop shrink rules | Accepted CSS remains assisted work, not independent local delivery |
| Preferred-PDF backend and functional UI | 69 unit tests, 30 negative HTTP cases and synthetic browser selection flow pass | Frontier implementation and acceptance; CSS contribution does not earn credit for persistence or security |
| Independent GPT-6-Astra high review | Reproduced a stale legacy request clearing a newer preference; lead fixed it with unit/HTTP regressions | Capable review found a real concurrency defect; this was cloud work |

The successful CSS task exposes four native usage events and a final context snapshot of 8,274 tokens; the failed task's final snapshot is 23,508. These are **not** total billed tokens, inference work or a savings comparison. Do not sum overlapping/cumulative telemetry without establishing its semantics. One accepted microtask is not a measured general success rate.

Machine constraints remain 24 CPU threads, 63 GB RAM, no detected NVIDIA GPU and one local model server. Inference throughput, power draw and peak memory were not measured. Configured Qwen entries establish neither residency nor capability. No model downloads, installs or server switch are authorized.

## Operating model for useful local throughput

Use the local lane for repeated edits following an accepted example: targeted CSS, fixture repair, deterministic transformations, field mappings against an explicit schema, extraction adapters with a working API sample, and evidence-only documentation. Each task needs bounded inputs, allowed outputs and a cheap independent acceptance check. Keep financial semantics, issuance/payment invariants, migrations, authentication, approval security and ambiguous historical evidence with a capable reviewer. A selected PDF proves neither chronology nor payment.

Prepare a compact task packet before dispatch. Include the objective; allowed/protected files and base-content hashes; exact types/selectors/functions; locked library version and working example; expected artifact; acceptance command; ownership and smoke-test lease; effective OS/tool/model/effort/permission capabilities; round/output/time limits; checkpoint location; and escalation conditions. Exclude credentials and unrelated conversation history. Resolve unfamiliar APIs once and reuse the example instead of making every local task rediscover them.

Enforce the budget in the runtime. Four tool calls is a proposed starting budget for a straightforward one-file edit, not a universal capability claim; the accepted CSS task used three. Reserve a checkpoint before hard exhaustion. Return a precise missing-contract reason instead of guessing APIs or searching the repository indefinitely. Cap output and elapsed time independently of context size.

At completion, return changed paths, base/result hashes, checks actually run, uncertainty and a freeze signal. The controller verifies hashes stayed fixed during acceptance. A completed native turn is not an accepted artifact. Release ownership only after acceptance or an explicit handoff.

Allow one precise repair when the failing assertion or contract mismatch is known. Repeated failure, invented APIs, scope violations, exhausted budgets or uncertain mutations escalate with a minimal handoff. A fresh local tab may recover an exhausted conversation, but must not replay ambiguous mutations or erase denials. Keep failed attempts and their costs in the record.

Initially queue one local inference worker under the one-resident-server constraint. This run did not establish beneficial local concurrency; simultaneous requests can contend for memory/context. Throughput should come from a queue of small, independently accepted artifacts, not a single broad task with many unrelated edits. Recovery requires explicit owner-granted project/device/task authority, bounded attempts and preserved pending approvals. The safeguard produced documentation, not an autonomous watchdog.

## Approval and coordination defects

Conductor Auto twice rejected the invoice controller's read-only process-inspection escalation “to keep the workspace sandbox,” interrupted runtime and showed no Approve/Deny card. The owner explicitly approved between attempts. The Conductor worker traced the fallback branch to a native decline before PendingInteraction creation; see [approval-auto-refusal-repro.md](conductor://project_mtrcoj95_1dits18/file/docs%2Fapproval-auto-refusal-repro.md). This is a product-control defect, not missing owner intent or local-model inability.

Preserve policy refusal as pending escalation with an alert and actionable card. It must remain distinct from an actual owner denial. Route to a distinct reviewer with equal-or-higher capability tier and equal-or-higher comparable effort, within explicit authority. Model capability does not grant wider filesystem/project/device authority. Cross-provider tier/effort comparisons require a verified policy; unknown comparisons go to the owner. Never invent an effort setting for models such as Haiku that expose none.

If the reviewer's own Auto policy blocks it, escalate once to the human, without recursive reviewers or silent interruption. Actual owner denial persists; automatic policy refusal must not poison a later valid human approval. Native/platform approval must genuinely occur. Bind grants to action digest, arguments, project, device and effects. Audit requester, actual reviewer/effort, decision, native delivery and observed execution without credentials. Reconnect reconciles pending requests; it never blindly repeats uncertain execution. Already-declined native requests cannot honestly be shown as still pending.

Successor coordination also failed: this controller could not steer the sibling tab created by its predecessor, and a new coworker could not steer the existing lead because it had another controller. Preserve the authority guard, but implement explicit owner-authorized controller handoff and scoped coordination messages. Observation, messaging, steering and approval are distinct capabilities. A project message must not silently grant execution control.

Monitoring should return compact phase, active tool, last meaningful result, pending reviewer/owner, artifact state and a semantic cursor. Pulling complete snapshots and token deltas consumed excessive frontier context in this run too. Show configured versus effective permissions/model/effort, actual residency, accepted prompt versus observed turn start, and failures superseded by accepted replacements.

## Economics and evaluation gate

No electricity measurement, provider bill reconciliation, matched direct-cloud baseline or end-to-end savings percentage exists here. Local generation can avoid metered cloud calls, while planning, monitoring, review, repair and recovery still consume cloud work. Report these costs instead of equating locally generated tokens with saved cloud tokens.

For each accepted task record local input/output/cache telemetry with documented event semantics, all cloud planning/monitoring/review/repair usage, wall time, active inference time, retries, rejected artifacts, accepted changes and independent checks. Record power/memory only when measured. Account for the actual billing model: subscription tokens are not automatically marginal dollar charges. Avoid double-counting cached or cumulative events.

Compare `local compute + cloud planning + orchestration + review + repair + recovery` with direct cloud delivery of the same task under the same acceptance check. Show latency separately from cost. Do not credit cloud takeover to local models.

Proposed initial evaluation: at least 20 held-out, reversible microtasks with fixed inputs and checks, repeated across resident Ornith and the existing direct-cloud route. Include layout, transformations, fixture repair and evidence-only documentation; exclude safety-critical changes from the first local benchmark. Compare first-pass acceptance, acceptance after one repair, regressions, cloud tokens per accepted task and median/p95 latency. This sample size is an evaluation starting point, not statistical assurance. Publish failures and uncertainty.

Expand local routing only when matched runs show less total cloud work/cost without reduced acceptance quality or unresolved safety regressions. Compare configured Qwen models only after owner-authorized sequential switching; no extra server or download is implied.

## Completion boundary

This review covers the failed broad task, accepted assisted CSS microtask, integrity review, passing invoice tests/browser checks, approval interruption and coordination failure. It proposes concrete runtime implementation; it does not claim deployed Conductor fixes. Full invoicing specification acceptance remains unknown. Narrow layout was checked at 390px with cloned synthetic markup; a physical-mobile workflow and native file dialogs remain untested. Actual APX application is tracked separately in ARCHIVE_SELECTION_RESULT.json and APX_SELECTION_RESULT.json when available.

---

Source: [docs/LOCAL_WORKER_CONDUCTOR_BRIEF.md](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FLOCAL_WORKER_CONDUCTOR_BRIEF.md)
Source content SHA-256: `2e1fa059a7c4cda1d95a4bcf8546fdf452c781523a204a1cff7c81cc21fdb83c`

# Implement useful local-worker throughput in Conductor

Owner requested the completed local-model review and an implementation prompt in Conductor. Read [LOCAL_MODEL_REVIEW.md](LOCAL_MODEL_REVIEW.md), [LOCAL_MODEL_REPORT.md](LOCAL_MODEL_REPORT.md), [ARCHIVE_SELECTION_RESULT.json](ARCHIVE_SELECTION_RESULT.json) and [CONDUCTOR_UPGRADE_PROMPTS.md](CONDUCTOR_UPGRADE_PROMPTS.md).

Continue implementation in visible native tabs. Existing approval lead agent_mucxgir3_mmkk8m6 retains its claims. Regression worker agent_mucykb2d_xjxx7ve is reachable by the successor controller. Use supported ownership coordination; if messaging is blocked, expose a durable task/artifact and continue only independent work. Do not drive ancestors, bypass controller scope, duplicate approval architecture or overwrite another worker. No deployment, app restart, installs/downloads, second server or invoice-process inspection is included.

1. **Approval lifecycle first.** Implement the owner-reported Auto-refusal regression from docs/approval-auto-refusal-repro.md: pending action plus alert and Approve/Deny, distinct policy refusal versus owner denial, eligible equal-or-higher-tier/effort reviewer within authority, reviewer Auto-block -> one human escalation, real native approvals, digest-bound grants, durable denial and safe reconnect/single delivery. Preserve the existing broker work. Cover owner approval after policy refusal, duplicate answer, changed arguments and uncertain delivery. Distinguish tested source from installed-app behavior.

2. **Enforced local task contract.** Validate objective, allowed/protected paths, base hashes, artifact schema, exact API/example, independent acceptance check, ownership/smoke lease, discovered capabilities, and tool/output/time budgets before dispatch. Expose remaining rounds and reserve a durable checkpoint before exhaustion. Record pending approvals and ambiguous actions. Verify an accepted follow-up actually starts a turn. Permit one bounded repair after safe-state reconciliation, then escalate. No replay on timeout. Freeze artifacts and verify hashes through acceptance.

3. **Compact observation and handoff.** Return phase, active tool, semantic cursor, actual model/effort/permissions/residency, pending review/owner and artifact result without full native histories. Support explicitly authorized successor-controller handoff and coordination messaging distinct from execution control; retain ancestor/project/device boundaries.

4. **Honest throughput/economics.** Attribute authorship, supplied-code execution, assisted repair, cloud takeover and independent acceptance separately. Measure all planning/monitoring/review/repair/retry usage plus local generation and latency. Establish token-event semantics and a held-out direct-cloud baseline before calculating savings. Use quality and total cost per accepted task rather than raw generated-token volume.

Ornith alone was tested in this invoicing run. Qwen remains untested here. One resident server and initially one local queue; no implicit switching/downloads. Use small configurable budgets, not a claim that all tasks fit four calls. Preserve prior work, coordinate shared smoke, and report exact changed files/check results/unfinished acceptance. Keep checklist items incomplete until demonstrated. Deliver bounded runtime improvements with tests where ownership permits, not only this proposal.
