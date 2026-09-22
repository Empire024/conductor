# Invoicing swarm upgrade implementation — 2026-09-22

Owner brief: [original sibling brief](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FCONDUCTOR_UPGRADE_PROMPTS.md).
Evidence: [failure log](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FFAILURE_LOG.md), [local review](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FLOCAL_MODEL_REVIEW.md), [attribution report](conductor://project_mucnd7cv_6r2ehsg/file/docs%2FLOCAL_MODEL_REPORT.md).

## Scope and ownership checkpoint

New native tab: `tab_mucxgile_euds0f7`; implementation controller: `agent_mucxgir3_mmkk8m6`, GPT-6-Astra high. Retain this tab and report here; the initiating faktury controller tracks its own handoff.

First slice: permission propagation and truthful configured/native permission parity; stronger reviewer routing for delegated worker actions, exact action binding, persistent denials, reconnect/idempotency, explicit unsupported boundaries and review outages. No deployment, destructive actions, downloads, installs, additional model servers, or relaxation of platform/owner controls.

Initial working tree already changed agent-control, index, local-models, styles, documentation, and local-update-build files. Preserve those edits. Cross-workspace inspection/steering through this control scope was refused; do not circumvent scope. Current workspace had only this controller before delegation. No local inference or Electron smoke is started: Ornith is shared with invoicing and requires coordination first.

Exclusive delegated files: GPT-5.6-Luna (`agent_mucxjjxo_zdo8epm`) owns `src/main/providers/claude.ts` and its existing test file for permission parity. GPT-6-Astra (`agent_mucxjhps_vp51h67`) performs one read-only security architecture review. Controller owns new approval-review files, narrow structured-sessions/agent-control/shared/UI integration, and this report/checklist. Native coworker tabs expose their turns; model assignments are not completion evidence.

## Remaining acceptance contract

- Authorized workspace Write goes through an actual stronger reviewing turn and completes without owner interruption.
- Only explicit reviewer escalation reaches owner; mandatory platform/security boundaries remain enforced.
- Exact action/arguments/project/device/paths/side effects and relevant owner authorization reach reviewer. Actual reviewer model and turn identity are recorded; workers cannot approve themselves.
- Digests invalidate changed arguments. Denial survives restart and alternate routes. Reconnect recovers outstanding requests; ambiguous transport delivery never replays a mutation.
- Request, worker, review decision/rationale, narrow scope, owner answer and observed execution result are audited without credentials. Outage/budget exhaustion pauses explicitly.
- Native tab distinguishes pending reviewer from pending owner; configured/effective permission mismatch is visible.

## Further bounded slices

Recovery: explicitly owner-granted observer authority scoped by project/device/task, bounded attempts, durable handoff, ownership and pending approvals retained. No implicit ancestor authority. Superseded failures must be distinguished from unfinished work.

Capabilities: native model-specific effort (Haiku has no effort), remaining local tool rounds and checkpoint before exhaustion, accepted follow-ups verified to start a turn. Prefer fresh bounded recovery tasks. One resident server only.

Telemetry: compact phase/final-result/active-tool projections, incremental semantic cursors, artifact freeze before integration tests, separate model authorship/supplied-code execution/assisted repair/cloud takeover/independent acceptance. Record actual tokens, retries, elapsed and reviewer cost. No measured net savings exist; no savings claim is authorized by this evidence.

Implementation and validation evidence will be recorded in [approval-upgrade-report.md](approval-upgrade-report.md). Checklist items stay unfinished until their full acceptance contract is met; release delivery is explicitly out of scope for this task.
