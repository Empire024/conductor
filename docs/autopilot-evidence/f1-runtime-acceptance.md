# F1 runtime acceptance — Stage A fixture

**Controller rejection and stop, 2026-09-24 01:09 UTC:** this is an incomplete, unaccepted scaffold. Report test markers need `{command, outcome, detail}`, escalation needs `occurred:true`, timestamps must not be in the future, and database containment must be inside the exact isolated profile. Readback assertions and runtime integration are absent. The requirement below about the job stopping/replanning is superseded: the elapsed-resume scenario must reach **COMPLETED**, with a late reset note and fresh stub request. The independent author failed with HTTP402 `Grok Build usage balance exhausted` before these corrections. See [provider stop and recovery](provider-stop-2026-09-24.md); the rejected scaffold is preserved as `f1-seed-scaffold.txt`. No runtime pass or trust increment.

Status: **NOT RUN**. This is not acceptance. No smoke, build, test, server, or ship was run. The only command was `node --check scripts/smoke-durable-history.mjs`, exit 0. The module is 83 lines.

## What exists

`scripts/smoke-durable-history.mjs` exports `seedHistory(profile, jobId)`. Running the file as an entrypoint throws `StageA scaffold only` before any database call, so it cannot be mistaken for a passing acceptance smoke.

`seedHistory` is for a later harness:

- Path guard: the profile must already be a directory strictly inside `os.tmpdir()`, and neither the profile nor `conductor.db` may resolve under `%APPDATA%\Conductor` (junctions included). The database file must already exist. The owner profile is never opened.
- One `node:sqlite` `BEGIN IMMEDIATE` transaction on `profile/conductor.db` (`src/main/durable-jobs/store.ts` stores jobs in that database). Failure runs `ROLLBACK`, then `close()`.
- The existing `durable_jobs.data` document is parsed and written back with only `startedAt` set 14 days in the past, so an elapsed budget measured from `startedAt` (`store.ts` sets that field on the first run) is expired. Status, lease columns, and every other JSON key stay as they were.
- Events use the store shape: columns `id`, `job_id`, `at`, `kind`, and `data` = the whole event JSON (`store.ts` insert). Order: one early `recovery`, 550 `note` fillers, one middle `note` with `data.test: true`, 550 more fillers (1100 fillers), one late `recovery`, one `escalation`. The job row must already exist.

## Still required before acceptance

Not done, and not claimed:

- Launch Conductor on the isolated temp profile (parked off-screen, as `scripts/smoke-durable-jobs.mjs` does). Do not use the owner profile.
- Resume the seeded job and show the expired elapsed budget is what stops or replans it.
- Read `jobs.report` and the paged event history: early recovery is not the latest page, the middle `data.test` note is still found, and the late recovery plus escalation are present.
- Replan integration against that history, then a real runtime assertion. Until that passes, F1 is not accepted.
