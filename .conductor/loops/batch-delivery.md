---
id: batch-delivery
version: 1
title: Deliver one batch of related tasks with the least tokens at the highest quality
trigger: [manual, after:task-triage]
inputs: [batchId, taskIds, allowedPaths]
budget:
  claudeWeeklyMax: 75
  codexWeeklyMax: 95
  opusOnlyReviewAbove: 70
  claudeStopAt: 73
steps:
  - id: contract
    role: architect
    model: claude:opus[1m]
    effort: high          # xhigh only for a root cause that is not yet known
    output: failing tests + acceptance (commands, allowedPaths)
  - id: implement
    role: implementer
    model: codex:gpt-6-astra
    effort: high
    fallback: claude:sonnet   # for role=ui batches with an exact spec
  - id: churn
    role: churn
    model: local:qwen3.6-35b-a3b
    job: durable
    optional: true
    output: last line `OK` or `FAILED <stage>` + ≤20 lines
  - id: review
    role: reviewer
    model: claude:opus[1m]
    effort: high
    input: git diff limited to allowedPaths, once
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.review, steps.ship]
---

# Batch delivery

1. **Contract.** Opus writes the failing tests and an acceptance list: the commands that must pass and the
   allowed paths. Keep it short; point to code by file:line; no broad exploration.
2. **Implement.** One fresh Astra tab per batch, dispatched with `projectTaskIds`. It makes the tests pass within
   `allowedPaths` and does not choose scope. Check `agents.snapshot` → `effectiveSettings.permissionMode` is `auto`.
3. **Churn.** A local durable job runs the suites and benchmarks and summarizes failures. Frontier models read only
   the summary.
4. **Review.** Opus reads the diff once and answers approve or a specific list of changes. At most one corrective
   round, then escalate to the owner.
5. **Ship.** `git.ship({message, paths})` with the batch's files only; wait on `git.ship.status`. Do not publish;
   publish once per set of batches.
6. Before every dispatch, read `usage.limits`. At 70% Claude weekly or more, Opus only reviews. At 73%, Claude work
   stops and Astra plus local finish. Astra stops at 95%.

Known hazard (2026-09-24): a coworker whose tab disappears loses app control and cannot `git.ship`. Its controller
ships for it from the coworker's handoff, which must list the exact paths and message.

## Run log

- 2026-09-24 (pre-loop, by hand): two Opus xhigh coworkers (Schedules ea74d128, typing performance 141e0a02).
  Both lost their tabs to the CLI toggle bug and handed off message and paths; the controller shipped for them.
