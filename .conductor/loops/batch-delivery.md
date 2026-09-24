---
id: batch-delivery
version: 3
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
    model: codex:gpt-6-astra   # owner rule 2026-09-24: Astra and Fable are the brains
    alternate: claude:claude-fable-5-1   # for the hardest designs; Fable has its own weekly window
    effort: high
    output: failing tests + acceptance (commands, allowedPaths)
  - id: implement
    role: implementer
    model: claude:opus[1m]   # owner rule 2026-09-24: Astra and Fable think (contract, architecture, review), Opus and lower implement
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
    model: claude:claude-fable-5-1   # the frontier model that did not write the contract; Astra if Fable is limited
    alternate: codex:gpt-6-astra
    effort: high
    input: git diff limited to allowedPaths, once
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.review, steps.ship]
---

# Batch delivery

1. **Contract.** Astra (or Fable for the hardest designs) writes the failing tests and an acceptance list: the commands that must pass and the
   allowed paths. Keep it short; point to code by file:line; no broad exploration.
2. **Implement.** One fresh Opus tab per batch (Sonnet for exact-spec UI batches), dispatched with `projectTaskIds`. It makes
   the tests pass within `allowedPaths` and does not choose scope. Check `agents.snapshot` → `settings.permission` is `auto`
   (Codex has no `effectiveSettings.permissionMode`). The contract's allowedPaths must include every store, IPC-type and
   session file the fix path crosses, not only the files the bug shows in; a missing path costs a full stop-and-ask round.
3. **Churn.** A local durable job runs the suites and benchmarks and summarizes failures. Frontier models read only
   the summary.
4. **Review.** The frontier model that did not write the contract (Fable ↔ Astra) reads the diff once and answers approve or a specific list of changes. At most one corrective
   round, then escalate to the owner.
5. **Ship.** `git.ship({message, paths})` with the batch's files only; wait on `git.ship.status`. Do not publish;
   publish once per set of batches.
6. Before every dispatch, read `usage.limits`. At 70% Claude weekly or more, implementation moves to Sonnet/Haiku with a
   tighter contract. At 73%, Claude work stops; Astra plus local finish. Astra stops at 95%.

Known hazard (2026-09-24): a coworker whose tab disappears loses app control and cannot `git.ship`. Its controller
ships for it from the coworker's handoff, which must list the exact paths and message.

## Run log

- 2026-09-24 (pre-loop, by hand): two Opus xhigh coworkers (Schedules ea74d128, typing performance 141e0a02).
  Both lost their tabs to the CLI toggle bug and handed off message and paths; the controller shipped for them.
- 2026-09-24 B1 renderer state bugs (+ restart initiator added mid-contract), commit 3b2ea0f. Contract: Opus high,
  17:31-17:38 (7 min; 6 failing test files). Implement: Astra high, 17:38-17:50 round 1 (stopped to ask for 3 paths
  outside allowedPaths: structured-store, shared/ipc, structured-sessions), 17:52-17:59 round 2 (READY, 3,264 tests),
  17:59-18:04 corrective round. Churn: skipped (no local server running). Review: Opus, pre-read while Astra ran,
  one list of 5: [major] the idle recovery checkpoint persisted layouts around the new save guard; the guard could
  duplicate a tab moved to another workspace/window; phone working words had "?" for "…"; AgentDialog X/Esc
  closed natively past a busy caller; plus (fixed by Opus at ship) the guard read every layout on every checkpoint.
  Ship: 18:06-18:08, git.ship clean first try. Rounds: 1 scope stop + 1 corrective. Slow/useless: the allowedPaths gap
  (one whole round); reading a Codex report via agents.history paged ~120 × 100 events (needs a tail/last-message
  read); the effectiveSettings.permissionMode check does not exist for Codex. Owner rule from this run: the
  implementer role moves from Astra to Opus from B2 on (applied as v2).
- 2026-09-24 v3 (owner rule, applied by the controller): contract moves to Astra (Fable for the hardest designs) and review
  to the frontier model that did not write the contract. The owner approved changing the locked review step. Opus/Sonnet/Haiku
  implement; local helps.
