# Approval upgrade implementation checkpoint — 2026-09-22

**Not delivered.** The local implementation and build are validated below. No commit, push, release, deployment, installation, app restart, local inference, additional model server, or Electron smoke was performed. The installed app is unchanged. The first checklist item remains in progress: safe automatic native execution is not implemented.

Owner brief and original evidence: [approval-upgrade-brief.md](approval-upgrade-brief.md). Retained native implementation tab: `tab_mucxgile_euds0f7`, agent `agent_mucxgir3_mmkk8m6`, in Conductor Workspace 3. Report here; the faktury controller keeps its own task tracking.

## Implemented locally

- Claude permission propagation compares requested permission with native-reported permission, handles both native field spellings, preserves rejected/native-downgraded values, and refuses to submit when a settings acknowledgement reports a different permission. Resolved model aliases and equivalent native default/manual modes do not cause repeated settings changes. The UI displays configured/native mismatches and distinguishes explicitly routed review from native Auto. A mismatch first reported after submission is visible; no live Haiku parity acceptance is claimed.
- A durable host journal binds request/delivery identity separately from logical operation identity. Digests include exact arguments, native request, project/device, execution root, canonical targets, file preconditions, side effects, and owner/task evidence. Owner denial fences targets across changed arguments/worker/tool identities within the implemented gate. Records retain decisions, rationale, reviewer identity, owner answer, response intent, observed execution status, and usage evidence without persisting raw action arguments or owner prompts in this journal.
- The backend intercepts pending approvals before publishing actionable choices and gates the existing shared response API. Review, owner escalation, blocked, and paused states are distinct. Only one-action responses are supported; broad session grants/mode switches cannot substitute for review. Duplicate requests share a reviewing turn. Response intent is committed before transport; competing reservations, stale transitions, changed targets and uncertain operation replay are refused. Recovered requests with missing live bindings cannot be answered blindly.
- Host-only reviewer routing selects runtime-discovered Claude Opus for an explicit limited worker-model policy. Its fresh native tab starts with `--bare`, no tools and no MCP; it receives no Conductor control briefing/credential and has no app-control authority. A strict final decision must match the host digest and an observed Opus model/turn. The task has a four-turn budget, one concurrent reviewer and a 120-second post-submit deadline. Failures preserve actual available reviewer identity, elapsed time and provider usage; no fabricated fallback approval.
- Claude native request IDs cannot replay a cached allow after their arguments change. A PreToolUse denial fence is implemented for persisted denial targets, including remembered native allows and conservative blocking of opaque alternative tools.

## Security boundary deliberately blocked

**No production adapter supplies `supportsExactExecution`.** Current native approvals do not establish execution-time enforcement of reviewed file preconditions or cross-provider mutation fencing. An opted-in request therefore reports the concrete unsupported boundary and does not spend a reviewer turn or automatically execute. The `Review coworkers` opt-in is off by default. Its routing/infrastructure is prepared; it is not a working automatic-Write feature.

The positive broker tests inject a synthetic executor contract. They demonstrate the coordinator/response gate, not safe native execution. The owner acceptance scenario “authorized workspace Write completes through a stronger reviewer without interruption” is **not met**. Generic native Write/Edit must not be classified automatically safe merely because no recognized English ask-rule reason was present.

The independent GPT-6-Astra review found six blocking issues. This checkpoint fixes concurrent reservation, missing-binding fail-open, and stale transitions losing uncertainty. Atomic execution/precondition enforcement, positive native boundary eligibility and cross-provider denial fencing remain blockers. Implement a shared mutation broker or an equivalently enforceable provider contract before supplying the production execution capability. It must account for links/aliases, changed content, hard links, protected configuration, native remembered grants, alternate tools/providers and transport ambiguity. Do not enable the capability by trusting a worker/native payload field or by assuming model review supplies filesystem isolation.

The owner was asked whether to retain these unsupported boundaries or expand into a shared mutation broker. Work dependent on that scope decision is not claimed complete. No platform approval or owner restriction was bypassed.

## Validation and evidence

Artifact writers were finished before the final focused tests/build. No Electron slot was acquired or used. Source hashes at this checkpoint are in [source-freeze.json](../artifacts/approval-upgrade/source-freeze.json); later edits require new validation.

| Check | Observed result | Evidence |
| --- | --- | --- |
| Final focused Vitest run | **329/329 passed**, seven files, 24.46 seconds | [final-tests.log](../artifacts/approval-upgrade/final-tests.log) |
| `npm.cmd run build` | **Passed**, including TypeScript; renderer build 22.45 seconds | [build-final.log](../artifacts/approval-upgrade/build-final.log) |
| `git diff --check` | Passed; line-ending warnings only | Controller command result |
| Live native permission/reviewer acceptance | **Not run** | Requires further contract implementation and coordinated smoke slot |

Test files: approval-review (13), approval-review-gate (9), permission-parity (5), Claude adapter (90), plus Codex adapter, structured-sessions and agent-control regression suites. They exercise denial persistence, changed arguments, native replay, reconnect/missing bindings, concurrent reservations, uncertain transport delivery, unsupported boundaries, native-owner escalation, isolation flags and truthful permission state. One initial hook-timing regression and two TypeScript fixture/return-type errors were corrected before the final successful run; failed logs remain beside the final logs. No full-repository test-suite claim is made.

## Actual authorship and usage

| Native model/agent | Actual contribution |
| --- | --- |
| GPT-5.6-Luna / `agent_mucxjjxo_zdo8epm` | Initial Claude parity patch and 10 journal tests. Controller corrected type/alias/settings issues, added further tests and integrated the code. This is assisted work, not independent delivery. |
| GPT-6-Astra / `agent_mucxjhps_vp51h67` | Two completed bounded security/design reviews. An earlier read-only probe encountered native approvals and was interrupted. Later reviews used supplied excerpts without tools. No implementation or test execution is credited to this reviewer. |
| GPT-6-Astra / `agent_mucxgir3_mmkk8m6` | Coordinator, gate, routing, UI/adapter integration, security repairs, additional tests, final validation and this report. |
| Ornith / other local models | **No execution or authorship in this task.** Shared-server coordination was unavailable; the existing invoicing server was left alone. |

The [native usage checkpoint](../artifacts/approval-upgrade/native-usage-checkpoint.json) stores bounded native usage projections and their timestamps. Last token-bearing **provider-reported session** samples at that checkpoint:

| Agent | Input tokens | Cached input (subset) | Output tokens |
| --- | ---: | ---: | ---: |
| Implementation Astra | 7,805,634 | 7,625,088 | 57,752 |
| Review Astra | 181,233 | 120,960 | 2,699 |
| Luna | 2,253,535 | 2,045,952 | 13,116 |

These are checkpoint counters, not final task totals or a cost invoice; subsequent controller/report work is excluded. Input replay is included and cached input is not additional input. No dollar cost was reported in these samples. The work consumed substantial cloud orchestration and repair. **No measured net saving or paired baseline exists.** The product journal now has bounded review budgets and actual reviewer elapsed/provider-usage fields, but those fields have only synthetic execution coverage until the native execution boundary is implemented.

## Coordination and remaining work

Existing dirty agent-control/index/local-model/style/docs/local-update-build work was preserved. Cross-workspace native steering was refused; no control relationship was seized or released to bypass that refusal.

A later Conductor evidence coworker produced [approval-auto-refusal-repro.md](approval-auto-refusal-repro.md), preserving another owner's report that Codex Auto drops genuine owner approval requests. That is distinct from an owner denial and should not be silently treated as one. Peer `agent_mucykb2d_xjxx7ve`: the legacy Auto-refusal branch and its tests are available for your bounded follow-up; preserve the added `!this.options.reviewApprovals` gate. This checkpoint makes no claim that your reported defect is fixed. Do not overwrite review-gate/structured-session work. Any later code change invalidates this checkpoint's source freeze.

The project checklist also retains the remaining owner-scoped observer recovery, Haiku capability/effort and local round-budget accuracy, compact semantic monitoring, confirmed follow-up turns, artifact-freeze integration and evidence-based attribution requirements. These were not silently marked complete.
