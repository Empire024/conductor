# Logic loops

A **logic loop** is a saved, versioned procedure that agents run, measure and improve. It captures
*how* a kind of work is done well: which steps, which model at which effort for each step, what
counts as done, and where the budget gates are. The next agent then reuses it instead of working
it out again. The Auto Fixer is the first consumer: it stops being a fixed prompt
(`AUTO_FIXER_INSTRUCTIONS`, src/shared/orchestration.ts) and becomes the runner of the
`task-triage` → `batch-delivery` → `update-readback` loops.

## Why

Today's session worked out a good procedure by hand: group and merge the task list, rank it by urgency,
pick the cheapest model that can do each step well, write tests first, let the local model churn, have
Opus review once, and let Qwen build and read back the update. Unless it is saved somewhere, it is
worked out again every time (tokens) and forgotten (quality). A loop file keeps it. Its run metrics
show which step is slow or useless, and agents may improve the loop within fixed limits.

## Resource model

A loop is a Markdown file in the project: `.conductor/loops/<id>.md` (tracked in git, so every
refinement has history and can be reverted). Its front matter is machine-read; the body is what an
agent reads.

```yaml
---
id: batch-delivery
version: 3                     # bumped by every applied refinement
title: Deliver one batch of related tasks
trigger: [manual, after: task-triage]   # manual | schedule:<scheduleId> | after:<loopId> | event:<name>
inputs: [batchId, taskIds, allowedPaths]
budget:                        # owner-locked: agents cannot loosen these
  claudeWeeklyMax: 75
  codexWeeklyMax: 95
  opusOnlyReviewAbove: 70
steps:
  - id: contract
    role: architect
    model: claude:opus[1m]
    effort: high
    output: failing tests + acceptance.md
    done: tests fail for the stated reason; acceptance lists commands
  - id: implement
    role: implementer
    model: codex:gpt-6-astra
    effort: high
    done: acceptance commands pass
  - id: churn
    role: churn
    model: local:qwen3.6-35b-a3b
    job: durable             # runs as a durable job with a contract
    output: ≤40-line failure summary
  - id: review
    role: reviewer
    model: claude:opus[1m]
    effort: high
    input: git diff limited to allowedPaths
  - id: ship
    role: controller
    action: git.ship
locked: [budget, steps.review, steps.ship]   # owner approval needed to change these
---
```

Runs are stored in SQLite (`loop_runs`, `loop_step_runs`: loop id and version, step, model, effort,
started/finished, tokens in/out by provider, outcome, retries, a link to the conversation or durable job,
and a short note).

## Running

- The controller (Auto Fixer, a wizard tab, or a scheduled task) calls `loops.run({id, inputs})`. Each step
  becomes a `router.dispatch` task (native), a durable job (local), or a control action (`git.ship`,
  `app.update`), with the step's model and effort passed exactly.
- Before each step the runner checks `usage.limits` against `budget`. When a cap would be crossed, the
  runner downgrades the step to the fallback the loop names, or pauses the run with a readable reason. It
  never silently skips a review or a ship check.
- A local step reports in a fixed last-line format (`OK …` / `FAILED <stage>` + ≤20 lines); the parent
  wakes up only when there is a problem. Until local models get `agents.report`, a zero-token shell watcher
  polls `agents.status`.

## Refinement: agents improve loops, within limits

- Every run writes per-step metrics. After a run, the controller may call `loops.propose({id, change, evidence})`
  with a diff of the loop file and the metrics that justify it. For example: "step `churn` gave no signal in
  5/5 runs, remove it" or "Sonnet passed review in 4/4 UI batches, use it instead of Astra for role=ui".
- **Auto-applied** (version bump, change recorded): model/effort choice for a step, thresholds inside the owner's
  caps, step order among unlocked steps, prompt wording, and dropping a step marked `optional`.
- **Owner approval**: anything in `locked`, any budget change, removing a review, test or ship step, widening
  permissions, adding a new action type.
- A change that makes the next two runs worse on its own metric (tokens, time, rework, or review findings) is
  reverted automatically to the previous version.

## App control and UI

- v1 exposes `loops.list`, `loops.get({id})`, `loops.history({id})`, `loops.run({id, inputs})`, and
  `loops.record({runId, stepId, model, startedAt, finishedAt, outcome, tokens?, note?})`. `loops.run`
  records the plan, checks current reported usage against the loop budget, applies an allowed fallback, and returns
  exact model/effort steps for the caller to execute. It does not autonomously dispatch them.
- `loops.status`, `loops.propose`, and `loops.apply` (owner or wizard only) remain v2 work.
- No new sidebar tab (see the owner's durable-jobs note). Loops appear in the **Scheduled tasks** panel, where a
  schedule can trigger one, and in **Project tasks**, where "Run task-triage" produces the grouped plan. A run shows
  its steps inline with model, time, tokens and outcome, and a pending proposal shows as a reviewable diff.
- Scheduled tasks run their local churn and script steps the same way, so both features share the durable-job
  runner and the step metrics table.

## Seed loops (version 1, written 2026-09-24)

- `.conductor/loops/task-triage.md`: read the task list, merge related items, drop addenda and stale claims, rank
  them (P0 loses work or blocks, P1 autonomy and tokens, P1 scale, P2 UX, P3 large), map each to a batch and a model
  role, and write `docs/task-triage-<date>.md`.
- `.conductor/loops/batch-delivery.md`: contract, implement, churn, review and ship, as above.
- `.conductor/loops/update-readback.md`: Qwen builds `app.update`, reads it back and reports; the wizard installs;
  Qwen verifies after the restart.

## Phases

1. **v0 (no code).** The seed loop files exist, and `AUTO_FIXER_INSTRUCTIONS` tells the Auto Fixer to read and follow
   `.conductor/loops/*.md` and append a run note to the file's `## Run log`. This is already useful and costs nothing.
2. **v1 (done 2026-09-24).** The front-matter parser validates the checked-in loop schema and filename identity;
   `loops.list/get/history/run/record` are registered in app control; `loop_runs` and `loop_step_runs` store plans and
   caller-recorded outcomes; and the budget helper reads current usage windows, selects a declared fallback, or pauses
   a plan at a hard cap. The Auto Fixer reads these files and records every executed step.
3. **v2.** `loops.propose` / apply / auto-revert, the UI inside Scheduled tasks and Project tasks, and `agents.report` for local models.
