---
id: batch-delivery
version: 8
title: Deliver one batch of related tasks with the least tokens at the highest quality
trigger: [manual, after:task-triage]
inputs: [batchId, taskIds, allowedPaths]
budget:
  claudeWeeklyMax: 85
  codexWeeklyMax: 95
  opusOnlyReviewAbove: 83
  claudeStopAt: 85
steps:
  - id: contract
    role: architect
    model: codex:gpt-6-astra   # owner rule 2026-09-24: Astra and Fable are the brains
    alternate: claude:opus[1m]   # owner 2026-09-24: Fable is too expensive; Opus when Codex has no allowance
    effort: high
    output: failing tests + acceptance (commands, allowedPaths)
  - id: implement
    role: implementer
    model: codex:gpt-6-sol
    alternate: claude:opus[1m]
    effort: medium
  - id: churn
    role: churn
    model: codex:gpt-6-sol
    effort: low
    optional: true
    output: last line `OK` or `FAILED <stage>` + ≤20 lines
  - id: review
    role: reviewer
    model: codex:gpt-6-astra
    alternate: claude:opus[1m]
    effort: high
    input: git diff limited to allowedPaths, once
  - id: verify
    role: verifier
    action: loops.run(verify) # adversarial check against the owner's original request (see verify.md)
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.review, steps.verify, steps.ship]
---

# Batch delivery

1. **Contract.** Astra (or available Opus) writes the failing tests and an acceptance list: the commands that must pass and the
   allowed paths. Keep it short; point to code by file:line; no broad exploration.
2. **Implement.** One Sol medium tab per bounded batch (escalate hard diagnosis to Astra), dispatched with `projectTaskIds`. It makes
   the tests pass within `allowedPaths` and does not choose scope. Check `agents.snapshot` → `settings.permission` is `auto`
   (Codex has no `effectiveSettings.permissionMode`). The contract's allowedPaths must include every store, IPC-type and
   session file the fix path crosses, not only the files the bug shows in; a missing path costs a full stop-and-ask round.
3. **Churn.** Sol runs only contract-named focused checks and needed smoke/benchmark commands through run_and_summarize on the existing local server. Full suite/build runs once in git.ship. Frontier models read only
   the summary.
4. **Review.** A fresh Astra reviewer that did not implement the change reads the diff once and answers approve or a specific list of changes. At most one corrective
   round, then escalate to the owner.
5. **Verify.** Run the `verify` loop on the batch: a brain plans adversarial, real-world scenarios from the owner's
   original item text and images, not the implementer's tests; an independent Astra verifier judges evidence collected by Sol using the shared
   scripts/verify-kit.mjs, day lane only (long, real-model and perf runs go to the overnight lane), and judges VERIFIED,
   REOPEN (guarded by a control run) or UNVERIFIED. An item is ticked `[x]` only after VERIFIED.
6. **Ship.** `git.ship({message, paths})` with the batch's files only; wait on `git.ship.status`. Do not publish;
   publish once per set of batches.
7. Before every dispatch, read `usage.limits`. Opus implements up to 83% Claude weekly (owner 2026-09-25: no downgrade to Sonnet for budget, it lowers quality); from 83% finish in-flight work only; at 85% Claude work stops; Codex plus the existing local server finish. Codex stops at 95%. The active Sol route does not require a Claude attempt first.

Known hazard (2026-09-24): a coworker whose tab disappears loses app control and cannot `git.ship`. Its controller
ships for it from the coworker's handoff, which must list the exact paths and message.

## Brief contract (Opus 5.5 guide, 2026-09-25)

- Every worker brief states its completion criteria ("done means: …") in the one dispatch message, with the owner's words and exclusive owned files; no "think carefully" lines (the model thinks before every reply).
- Workers answer "Needs from you" first, then a results table (item | status | commit | evidence), marking unconfirmed findings.
- The controller checks a worker's evidence before accepting it (reads the commit and the evidence path, re-runs the failing scenario when it is cheap), and folds corrections in with mid-run steers instead of restarts.
- The checklist that must survive context summarization is feature-list.md plus docs/swarm-<date>.md, updated as each step lands.


## Bounded continuation and token use (2026-09-27)

Read docs/verification/2026-09-27-loop-retro.md for measured takeover evidence.
The owner requested continuing the same loop with Codex after Claude's weekly limit.
Astra handles contracts and independent judgment; Sol handles implementation and churn.
Retain Opus as an alternate only when its quota permits.
Keep implementation and independent verification in different conversations.
Before dispatch refresh models.list and usage.limits; never infer general Claude
capacity from the Fable bucket. Do not retry a capped provider in fresh tabs.

Use agents.status with its cursor for routine supervision. Read a filtered snapshot
only for a transition, recovery or missing evidence; omit configuration notices and
full tool outputs until needed. Filter task updates to revision and affected IDs.
Use run_and_summarize for long tests/builds and local_ask for bounded large reads
when the existing server is available; never switch the GPU model just for a summary.
Assign one Electron/build slot at a time; waiting workers can read and edit.
Reuse committed smokes and passing evidence on unchanged relevant paths. Full
suite/build is git.ship's job; additional focused runs need a change or failure.
Briefs should fit 1,200 tokens with references; results need commit, verdict,
evidence and NOT RUN. Record loops.run/loops.record with actual timing and measured
tokens where available; no fabricated counters or claimed savings from estimates.
All existing acceptance, independent-review, budget, ship and overnight gates remain.

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
- 2026-09-24 v4 (owner rule): a Verifier step (loop `verify`) sits between review and ship. Passing tests or a small sample is not
  proof; items are ticked only when adversarial real-world scenarios pass. Locked step.
- 2026-09-24 v5 (owner): no Fable in the loop, because it is too expensive. The contract is Astra, or Opus when Codex has no allowance; the review is a fresh Opus tab.

- 2026-09-27 v6 (loops.apply loopproposal_muju1qsd_li782ay): 2026-09-27 takeover: Claude general weekly 100%, Codex 0%; controller quota-failed before first action; FX45 ten reads/no edits. Snapshot payloads 45149/119806 chars versus text 6350/4047. Local assist only 14 calls/week, estimated 23956 tokens saved. Owner requests same loop improved for token savings, then explicitly cheaper workforce for churn. Sol labor, Astra judgment. docs/verification/2026-09-27-loop-retro.md; new savings unmeasured.
- 2026-09-27 v7 (loops.apply loopproposal_muju44pk_zt2t4cu): Align prose and exact model/effort with owner correction: Sol medium implementation, Sol low churn, Astra independent judgment. Preserve Unicode via UTF-8 request bytes. No acceptance gates removed. See 2026-09-27-loop-retro.md.
- 2026-09-27 v8 (loops.apply loopproposal_mujuhksd_o0h14fk): Independent Sol read-only review found three route inconsistencies: stale Sonnet fallback, Luna automatically eligible for full execute, and duplicate full-suite churn wording. Remove automatic fallbacks and scope churn to contract-focused checks; full suite/build belongs to ship. Gates unchanged.
