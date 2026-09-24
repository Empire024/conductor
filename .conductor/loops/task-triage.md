---
id: task-triage
version: 1
title: Turn the task list into a ranked, batched plan
trigger: [manual, event:tasks-added]
inputs: []
output: docs/task-triage-<date>.md
budget:
  claudeWeeklyMax: 75
  codexWeeklyMax: 95
steps:
  - id: extract
    role: churn
    model: local:qwen3.6-35b-a3b
    output: every open/in-progress item with line, marker id, body (a script, not a model, can do this)
  - id: verify-facts
    role: churn
    model: local:qwen3.6-35b-a3b
    output: per item, whether it is already done (commits since the item was written, tools.list, grep)
  - id: triage
    role: architect
    model: claude:opus[1m]
    effort: high
    output: merged work items, ranked, each with the marker ids it absorbs
  - id: plan
    role: architect
    model: claude:opus[1m]
    effort: high
    output: batches grouped by shared files, a model role per step, budget check
locked: [budget]
---

# Task triage

1. Extract every `- [ ]` and `- [~]` item from `feature-list.md`, with its line, marker id and body. An item's
   body ends at the next checklist item or top-level heading. Skip the 200+ done items.
2. Check facts before ranking: for each item, look for commits after it was written, the current
   `tools.list`, and the code it names. Mark items that are already done or superseded; don't guess.
3. Merge items that share a root cause or files. Fold addenda (for example "to add to task X") into their parent.
   Flag stale claims (an agent id that is no longer running).
4. Rank by how urgently each needs repair:
   - **P0**: loses work, freezes the app, stalls unattended runs.
   - **P1**: autonomy friction and wasted tokens; performance and scale.
   - **P2**: UX.
   - **P3**: large features and long verifications.
   - Keep a separate list: verify-and-close or park (items owned by other projects or stale programs).
5. Batch by shared files, fastest wins first. Give each batch its contract/implement/churn/review roles
   (see `batch-delivery`).
6. Read `usage.limits` and state the headroom against the caps in the plan.
7. Write `docs/task-triage-<date>.md`. Don't rewrite `feature-list.md` while coworkers are editing their items in it.

## Run log

- 2026-09-24 v1, run by hand (wizard Opus 5.5): 36 items became 20 work items plus a verify/park list.
  Output: docs/task-triage-2026-09-24.md. Lesson: checking facts first (tools.list, commits) caught two
  items that were already fixed and one that was still open.
