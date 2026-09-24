# F4 acceptance: durable-job detail shows the newest tail beyond 20,000 events

Worker `agent_mufbsm36_dmq4ffe`, task `task_mufbsn43_wja47z9`, controller `agent_muer6h9a_fwe9n16`. Recorded 2026-09-24.

## Failure

`src/main/durable-jobs-ipc.ts` (detail handler) paged `events()` oldest-first 500 at a time until 20,000 rows, then returned `events.slice(-200)` of that prefix. For a job with more than 20,000 events the view showed events 19,800-19,999 and never the newest ones, and every refresh (each published change) re-read up to 20,000 rows.

## Change

- `src/main/durable-jobs/store.ts`: additive `latestEvents(jobId, limit)`: `SELECT data FROM durable_job_events WHERE job_id = ? ORDER BY seq DESC LIMIT ?` (limit clamped 1-1000), reversed to oldest first. Same newest-first pattern as `matchingEvents` (cacfc74). Served by the existing `durable_job_events_job_idx (job_id, seq)`; no schema change.
- `src/shared/durable-jobs.ts`: `DurableJobsService.latestEvents(jobId, limit)`.
- `src/main/durable-jobs/index.ts`: 4-line pass-through in `DurableJobsServiceImpl` (checks the job exists, as `events()` does).
- `src/shared/durable-jobs-fake.ts`: the fake service implements it.
- `src/main/durable-jobs-ipc.ts`: detail returns `latestEvents(id, 200)`; one bounded read. The `events` channel (forward paging with `afterId`, capped at 500) is unchanged. Checkpoints still come from their own table.
- Renderer unchanged: `DurableJobDetail.events` keeps its shape and order.

Scope note: the brief listed `durable-jobs/index.ts` as do-not-touch, but the IPC reaches the store only through `DurableJobsService`, whose `events()` pages forward only. A tail needs one service method. The additive change was announced to the controller by `agents.steer` before it was made. `index.ts` had no other uncommitted edits at the time, and the shipped diff holds only this hunk.

## Tests (failing, then passing)

- New `src/main/durable-jobs-ipc.test.ts`: real `DurableJobStore` with 20,500 notes plus a late marker, driven through the registered detail handler (mocked `ipcMain`). It asserts the exact newest 200 (`n20301`…`n20499`, `late marker`) in order, one `latestEvents(job, 200)` call, and no `events()` paging. Forward paging through the `events` channel is unchanged (oldest-first default page of 100, `afterId` continues, limit capped at 500). Another project's job reads as missing.
- `src/main/durable-jobs/store.test.ts`, two new cases:
  - >20k fixture plus a late marker and a newer event of another job. It asserts the exact newest 200 oldest first, exactly one prepared statement, and `EXPLAIN QUERY PLAN` using `durable_job_events_job_idx` with no `TEMP B-TREE` (no sort of the history). It also checks the limit clamps to 1000, per-job isolation, and an empty result for an unknown job.
  - The tail is re-read correctly after the database file is reopened and a new event is written.

Red, before the implementation: `npx vitest run src/main/durable-jobs-ipc.test.ts src/main/durable-jobs/store.test.ts` exited 1: 3 failed, 11 passed. The IPC case got `n19799`…`n19998` (the 20k prefix tail) where it expected `n20301`…`late marker`; the store cases failed with `latestEvents is not a function`. Log: `artifacts/f4/red.log`.

Green: `npx vitest run src/main/durable-jobs-ipc.test.ts src/main/durable-jobs/ src/renderer/src/components/DurableJobsPane.test.ts src/main/agent-control.test.ts` exited 0: 13 files, 190 tests passed. Log: `artifacts/f4/green.log`.

Typecheck: `npx tsc --noEmit -p .` (the repo `typecheck` script) exited 0. Log: `artifacts/f4/tsc.log` (empty).

## Real app, restart on an isolated profile

`scripts/smoke-durable-tail.mjs` (new; `scripts/smoke-durable-jobs.mjs` was not edited). It uses the built `out/main/index.js` (`npx electron-vite build`, exit 0, `artifacts/f4/build.log`) under `CONDUCTOR_TEST_USER_DATA` = a fresh `%TEMP%\conductor-durable-tail-*` profile (parked window), driven as the owner through the profile's `control-owner.json`, against a loopback stub model:

1. `projects.open` a temp git project, then `jobs.create` a one-stage job, which completes (8 events).
2. The app closes (the process is confirmed gone). One IMMEDIATE transaction writes an early `retry` marker, 20,500 `note` fillers and a late `retry` marker into that profile's `conductor.db`, for 20,510 events in total. The guard refuses any path outside the temp dir or under `%APPDATA%\Conductor`.
3. The app relaunches on the same profile. `window.conductor.durableJobs.detail` (the job view's IPC) returns 200 events, `F4 filler 20301` … `F4 late marker`, the exact expected sequence, chronological, without the early marker. It took 3 ms per call, measured in the renderer on two consecutive calls.
4. `jobs.status.lastEvent` is the late marker.
5. `tabs.open` job opens the job tab. Its "Errors and recoveries" list shows `RETRY F4 late marker: seeded after 20,500 fillers` and not the early marker. Screenshot: `artifacts/f4/job-tab-after-restart.png`.

Only one Electron smoke ran at a time: `Get-Process electron` was checked before each run, and the run waited for another worker's F1 history smoke to exit. The final run exited 0 with result `PASS`. Summary: `artifacts/f4/smoke-summary.json`. Log: `artifacts/f4/smoke.log`. Earlier attempts failed on smoke-script issues, not the product: a stale control endpoint after relaunch, and the job-worktree project row matched before the smoke project. Both were fixed in the script.

`artifacts/` is gitignored (`.gitignore:5`); the logs are local to this checkout.

Not reproduced in the running app: the pre-fix build. The failing IPC unit test covers the defect itself.
