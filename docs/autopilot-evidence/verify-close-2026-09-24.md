# Verify-close 2026-09-24

| Item | Verdict | Evidence | What is left |
|---|---|---|---|
| invoicing-approval-review | PARTLY | `09f5963` (gate/routing/UI), `f5e0afb` (Claude parity), `9c1b5da` (owner-not-locked, idle-give-way) | `supportsExactExecution` not implemented; no enforceable mutation broker; live native acceptance not run |
| invoicing-bounded-recovery | OPEN | No commit touches recovery/observer-scoped handoff; `85b9b0d` is durable-jobs starvation fix, not recovery | Recovery with bounded attempts, durable handoff, ownership retention, pending-approval retention |
| invoicing-runtime-budget | OPEN | No commit touches model effort parity, local remaining-round checkpoints, or confirmed follow-up turn start | Native model effort parity, round-budget checkpoints, confirmed follow-up turn start |
| invoicing-evidence-telemetry | OPEN | No commit touches compact semantic monitoring, artifact-freeze handoff, or evidence-linked attribution metrics | Compact phase/final-result projections, artifact freeze, actual tokens/retries/elapsed/reviewer cost |
| approval-auto-refusal-evidence | PARTLY | `ddb4f23` fixes Codex PowerShell path holding (303 tests + build pass) | Native integration/delivery outstanding; installed app unchanged; no deployment |
| codex-auto-owner-escalation | PARTLY | `ddb4f23` + `9c1b5da` (owner-not-locked, idle-give-way); adapter source repaired, 303 tests + build pass | Native approvals render, changed-argument expiry, no-replay acceptance pending; broker/reviewer integration with agent_mucxgir3_mmkk8m6 |

Summary: invoicing-approval-review and approval-auto-refusal-evidence are partially done (source+tests pass locally but native execution/delivery remains blocked). invoicing-bounded-recovery, invoicing-runtime-budget, and invoicing-evidence-telemetry are open with no implementing commits found.
