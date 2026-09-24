# F1 — durable-job newest-event correctness

Worker: Grok. Orchestration task `task_muerw1jr_4mqtzu2`. Date: 2026-09-24.

Scope owned: `src/main/durable-jobs/store.ts`, `controller.ts`, `wiring.ts`, `index.ts`, `report.ts`, their focused tests, and this file. No schema migration. `events(jobId, afterId, limit)` is still oldest-forward and still capped at 1,000 rows per call. Approval, generation-gate, and watchdog behavior were not changed.

## Defect

`DurableJobStore.events(id, undefined, 1000)` returns the oldest 1,000 rows (`seq > after ORDER BY seq LIMIT`). After a job passes that prefix, these reads missed later rows:

- elapsed-budget restart note (`controller.ts`, latest `note` with `data.elapsedBudget === 'restarted'`)
- same-failure retry history (`controller.ts`, `retry` events for that stage whose `data.error` is a string)
- replan restore (`wiring.ts`, `loop-detected` events for that stage whose `data.replan` is a number)
- `DurableJobsServiceImpl.report` (`index.ts`), which passed that same oldest page into the report writer

`generateDurableJobReport` already paged. `service.report` did not. A newest-only tail would also be wrong: a full report has to keep early records as well as late ones.

## Change

`DurableJobStore.matchingEvents(jobId, match, limit?)` filters in SQLite by kind, optional `data.stageId`, optional `data` equality, and optional JSON type, ordered `seq DESC`. Results are returned oldest-first. A limit keeps the newest matches. Omitting it returns every match, which is what the replan count and the retry history need. No new index and no migration.

The three decision sites call `matchingEvents`. `service.report` and `generateDurableJobReport` both use `collectDurableJobEvents`.

Review finding P2-1: a short page is not the end, because `events()` caps a call at 1,000 rows. The collector stops only when the next page is empty. A page with no id, or a cursor already seen, throws instead of returning a partial history. No schema change. Resume still counts replans across the whole history. The IPC detail tail is untouched.

## Failing before

Command, run before `matchingEvents` existed. Exit 1. Vitest start `02:20:19`, duration 3.82s. 6 failed, 34 passed (40).

```text
npx vitest run src/main/durable-jobs/store.test.ts src/main/durable-jobs/controller.test.ts src/main/durable-jobs/wiring.test.ts src/main/durable-jobs/report.test.ts --reporter=verbose
```

Exact reporter output, with ANSI color codes removed and no other edits: [f1-failing-before.txt](f1-failing-before.txt).

The six failures are the elapsed-budget resume (stage 2 never opened: `expected 1 to be greater than or equal to 2`), the same-failure loop (`used all 6 attempts` instead of `Loop detected`), the late replan (`loop guard replan` instead of `loop:`), the report (`EARLY-RECOVERY-MARKER` only), and `matchingEvents is not a function` on the open store and after reopen. The reopen failure then hit `EPERM` removing the temp directory because `close()` had not run. The oldest-forward page test passed on that unfixed store.

## Passing after

Same vitest command, after the fix. Exit 0. Vitest start `02:22:31`, duration 2.56s. 4 files, 41 tests passed.

Exact reporter output, ANSI color codes removed and no other edits: [f1-passing-after.txt](f1-passing-after.txt).

That run includes the six regressions, the exact 1,000-row page boundary, stage filtering, oldest-forward `afterId` paging of 1,201 events, and reopening SQLite. The reopened store still returns `persisted restart`.

```text
npm run typecheck
```

`tsc --noEmit`, exit 0, about 23s. Exact output: [f1-typecheck.txt](f1-typecheck.txt). No full `npm test` and no `npm run build` in this workspace. No `npm run dev`, model start, or Electron smoke.

## P2-1 follow-up

After the review, the same four files were run again with the empty-page collector, the capped-reader test, the stalled-cursor test, two late restart notes, and a second job in the same store. Exit 0. Vitest start `02:32:05`, duration 2.15s. 4 files, 44 tests passed. `npm run typecheck` then exited 0. Exact combined output: [f1-p2-passing-after.txt](f1-p2-passing-after.txt). The original failing and passing logs above were not rewritten. `*.log` is gitignored, so these copies use `.txt`.

`store.events(id, undefined, 2000)` still returns 1,000 rows. `collectDurableJobEvents` over that reader with page size 2,000 returns all 1,501 rows (the create event plus 1,500 notes). A reader that repeats one id throws `did not advance`. A blank id throws `missing an id`. The newest of two restart notes past row 1,000 is the one `matchingEvents` keeps when limited to 1. The other job's note, retry, and replan with the same stage id are not returned.

## Diff

```text
 src/main/durable-jobs/controller.test.ts | 56 +++++++++++++++++++--
 src/main/durable-jobs/controller.ts      |  4 +-
 src/main/durable-jobs/index.ts           |  4 +-
 src/main/durable-jobs/report.test.ts     | 85 +++++++++++++++++++++++++++++++-
 src/main/durable-jobs/report.ts          | 30 ++++++++---
 src/main/durable-jobs/store.test.ts      | 79 +++++++++++++++++++++++++++++
 src/main/durable-jobs/store.ts           | 45 +++++++++++++++++
 src/main/durable-jobs/wiring.test.ts     | 35 +++++++++++++
 src/main/durable-jobs/wiring.ts          |  2 +-
 9 files changed, 324 insertions(+), 16 deletions(-)
```

The delivery paths are the five production files, the four focused test files, this note, and the four logs named above. `docs/autopilot-evidence/f1-opus-review.md` is not included.

## Remaining acceptance

Not product-complete. Independent acceptance stays with the controller. Still required, and not done here:

- The review of the first diff is `f1-opus-review.md` (commit `d996eae`). P2-1 was applied after that review. A further review of this follow-up is the controller's choice.
- A real job restart: a history longer than 1,000 events, a resume past an elapsed-budget reset, and proof that the note, the retry loop, the restored replan, and `report.md` survive process restart. The unit reopen covers the SQLite file only.
- The host delivery of these paths runs the suite and production build in an isolated worktree. That log is not a substitute for the restart check.
