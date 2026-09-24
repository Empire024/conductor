# Durable jobs review items 5 and 8, research grant, tool-schema budget

Conductor task `durable-jobs-review-fixes` (orchestration task_mufcir2y_5e5xkps), worker
agent_mufciozs_73ebj5e, 2026-09-24. Built on HEAD 85b9b0d (F1 cacfc74, F2+F3 85b9b0d and F4
462fc11 already in), so none of those fixes is redone here.

## (5) Credentials no longer reach the job store, handoffs or reports

The redaction helper is still `src/main/durable-jobs/watchdog.ts` (`redactSensitive`, `redactData`).
Its patterns are unchanged, so nothing that was redacted before is let through now. Added
`redactHandoff`, which redacts every free-text field of a handoff and keeps file paths and
artifact paths as they are (they are evidence).

| Path | Where it is redacted now |
| --- | --- |
| Tool arguments (`store.intend` description), reconciliation text (`store.settle`) | `store.ts` intend/settle |
| Every event message and data, including the events written by transition, saveStage, addStage and addCheckpoint | `store.ts` insertEvent (`redactSensitive` on the message, `redactData` on the data) |
| lastError and last answer (`stage.error`, `stage.result`) | `store.ts` saveStage |
| A stage the job plans for itself (title and objective are model text) | `store.ts` addStage |
| Status reason, and handoffs passed to `transition` or `update` | `store.ts` transition/update (`cleanPatch`) |
| Next-action text and the rest of the handoff | `handoff.ts` extractHandoff. Entries are redacted before they are deduplicated, so a repeated failing command stays one entry instead of two. |
| report.json, report.md, jobs.report | `report.ts`: every `line()` is redacted, as are stage titles and the Markdown title. This also covers rows written before this fix. |

The owner's own `create` input (job objective and planned stages) is stored as the owner typed it.

## (8) contextRolloverFraction during a stage

- `watchdog.ts` `ContextRolloverWatch(contextTokens, fraction)` uses the same threshold as
  `shouldRollover`: `floor(contextTokens * fraction)`. It reports a crossing **once per
  attempt**. If a tool is running when the crossing is seen, it waits until the tool has finished,
  so a hand-off never cuts a side effect in half.
- `latestContextTokens(items)` reads the context of the newest request from the conversation's
  `usage` items (input plus output, which is how the stop report counts it).
- Hook in `wiring.ts`, inside the watchdog port's `scan()`: on a crossing it calls
  `onStuck("context rollover: …")`. The controller then interrupts the attempt, and the local agent
  writes a stop report with the context it had reached. `afterStage` returns `contextRollover: true`,
  so the controller counts one rollover and records the note. The next attempt opens a **fresh
  conversation** from the handoff, and its retry prompt names the rollover.
- Known limit: the controller (not owned by this worker) records the rolled-over attempt as a
  failed attempt, so it uses up one of `maxStageAttempts`. A stage that needs more rollovers than
  it has attempts blocks for the owner, with the reason stated.

## Research grant and conductor tool schema (handoff.ts ~444)

- `stageTooling` grants `research` to research stages by their kind, and to no other kind.
  `structured-runtime.ts` opens a research stage with `localResearch: true`, so its conversation
  really has `web_search`.
- `stageTooling(…, control = true)` now counts the `conductor` bridge schema in the full scope.
  Every local conversation gets that bridge from structured-sessions, so the stage prompt budget
  now subtracts it.

## Verification

Run from `C:\Claude\conductor` on Windows (Node 24.18.1, vitest 3.2.7).

1. Failing before: the new tests were copied into a `git archive HEAD` export
   (`%TEMP%\rev58-head`, node_modules junction for the tests only; nothing was built from it) and
   run with
   `npx vitest run src/main/durable-jobs/{watchdog,store,handoff,report,structured-runtime}.test.ts`.
   Exit 1: **9 failed | 48 passed**. Log: `review-items-5-8-failing-before.txt`. Each test failed for
   the expected reason: the planted bearer token appeared in the DB rows; the handoff kept
   `sk-proj-…` and the 64-hex control credential; the report leaked; the research stage opened
   without a grant; the conductor schema was missing from the tools; `ContextRolloverWatch` did not
   exist; and the end-to-end rollover test hit "Condition not reached in time" because nothing
   interrupted the stage.
2. Passing after: `npx vitest run src/main/durable-jobs/` exit 0, **12 files, 138 tests**. Log:
   `review-items-5-8-passing-after.txt`.
3. Full suite: `npx vitest run` exit 0, **258 files, 3070 tests** (run in the shared tree, which
   also held other workers' edits at the time).
4. `npx tsc --noEmit` exit 0.

What the new tests show:
- `store.test.ts` "DurableJobStore redaction": a bearer token, an API key and a control credential
  are planted through intend, settle, event (message, nested data, credential-named keys),
  saveStage (result, error, event), addStage, transition (reason, handoff, data) and update. None
  of them survives in any row of the five tables.
- `handoff.test.ts`: extractHandoff with secrets in the stop detail, unverified claim, constraints,
  failure source and excerpt, corrections, repeated failures, next action, commands, acceptance
  and artifact note. Neither handoff carries them, and a repeated command stays one test entry.
  The stage-tooling test covers the research grant and the conductor schema in the budget.
- `report.test.ts`: jobs.report (`service.report` with the real `reportPort`), report.json and
  report.md contain none of the three secrets. This includes rows written *before* redaction
  (status reason, handoff, stage result, recovery, escalation and test events inserted with raw
  SQL). The evidence around each secret is still present.
- `watchdog.test.ts`: `ContextRolloverWatch` (once only, waits while a tool runs, ignores later
  growth), `latestContextTokens` and `redactHandoff`.
- `context-rollover.test.ts`: runs the real controller, handoff port and watchdog port with a fake
  token counter feeding usage items. At 4k, 12k, 20k and 22.9k tokens nothing happens. At 24k,
  past 70% of 32,768, conversation 1 is interrupted exactly once. Conversation 2 starts with
  "This is a fresh context" and the rollover reason, the job completes, `contextRollovers` is 1,
  and there is exactly one `contextRollover` note.

No Electron smoke was run. These changes do not affect restart, lease or persistence behaviour.
A live check would have needed a local model to fill 70% of its window, and the machine's one
llama.cpp server was in use.
