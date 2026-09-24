# F1 independent review: late durable-job history correctness (Opus)

- Reviewer: Claude Opus 5.5, conversation agent_muesglj7_muv9pi0. I did not write any of this code.
- Orchestration task: task_muesgp3p_j2f4z03. Controller: agent_mues2ka2_oclznv3. Author: F1 Grok (agent_muerw1fu_a33x86v).
- How I reviewed it: I read the diff only, using read-only `git diff`/`grep`/`sed` commands. The review itself ran no tests, build or smoke.
- **Accidental delivery, separate from the review:**
  - After writing this file I started `git.ship` for this document alone. The assignment said not to ship, because F1 holds the test/build slot.
  - Delivery run: `delivery-e2b72824-9af2-48df-a5b9-3cb052037e7c`, started 2026-09-24T00:27:08Z and settled at 00:29:30Z as `delivered`.
  - It passed `npm test` and `npm run build` in an isolated worktree that held only `docs/autopilot-evidence/f1-opus-review.md`.
  - It committed that one file locally as `d996eaeccc982067aee598fa6d3666b62ff40d62`. Nothing was pushed or released.
  - Those host checks prove nothing about F1's source, which was not in that worktree. I started no further delivery, build or test.
- What I reviewed: the F1 files `src/main/durable-jobs/{store,controller,wiring,index,report}.ts` and their `*.test.ts`.
  - Hash: `git diff -- src/main/durable-jobs src/main/agent-control.ts` had sha256 `4b047a75e8553f82347f3ee347b5f5fa150f8465d1f1ad13d4d74c17ea5395ac`. I captured it at 2026-09-24T00:24:03Z and re-hashed it unchanged at 00:26:06Z. It spans 10 files, +280/-20.
  - `src/main/agent-control.ts` is inside that hash only because I included it in the command. Its hunks are uncommitted work already in the tree (Grok as a native provider) and are **not F1's**; I did not review them. The controller preserves them.

## Verdict

**I found no P0 or P1 problems in the source.** The fix changes what the program does on the three reads the task names, the new code keeps jobs and stages separate, and the existing oldest-forward `events()` API is byte-for-byte unchanged.

A passing unit run is **not product acceptance**. F1 still needs the runtime and restart proof described below. The existing `scripts/smoke-durable-jobs.mjs --restart-app` cannot accept this change by itself: it accepts `blocked` or `failed` as a result and never creates a history longer than 1000 events.

**Scope note:** the `src/main/agent-control.ts` hunks are uncommitted Grok-provider work that was already in the tree, not F1's. F1 should ship with `paths` limited to `src/main/durable-jobs/**`.

## Source findings

### Correctness (verified)

**`store.ts:272-294` `matchingEvents`**
- Every query starts `job_id = ? AND kind = ?`, so one job's events never leak into another's.
- The stage filter is `json_extract(data,'$.data.stageId') = ?` with a bound parameter. The column `data` holds the whole event JSON (`insertEvent`, `store.ts:193-196`), so `$.data.*` is the right path.
- Keys are checked against `^[A-Za-z_][A-Za-z0-9_]*$` before they are put into the path (`store.ts:46-49`). That leaves no way to inject SQL or a JSON path.
- `json_type` gives `'text'` for string, `integer|real` for number and `true|false` for boolean. These match the old JS `typeof`/`===` checks, and matching stays strict:
  - a string `'1'` does not count as a numeric `replan`;
  - the plural field `replans` on the blocking event is not counted, as before.

**Newest-first cap**
- `ORDER BY seq DESC LIMIT n` followed by `.reverse()` gives the newest *n* matches, in oldest-first order.
- `controller.ts:228` asks for `limit 1`, so it now takes the **newest** `elapsedBudget:'restarted'` note, wherever it sits in the history.

**Per-stage retry errors (`controller.ts:395`) and replan restore (`wiring.ts:128`)**
- Both are now unbounded and filtered by `stageId` in SQL, so neither is capped at the oldest 1000 rows any more.
- The result sets are naturally small: at most one row per attempt or replan of one stage.

**`events()` compatibility**
- The default is still 200 and the cap is still 1000.
- `afterId` is still looked up inside the same job and still throws `Unknown event id for this job`.
- It is still used by IPC (`durable-jobs-ipc.ts:62`), by app control (`agent-control.ts:1097`) and by `generateDurableJobReport`.

**SQLite reopen and restart**
- No schema change and no migration.
- Nothing is cached in memory. The wiring `guards` map is rebuilt through `restore()` from the database on the first `guardFor` after a restart.
- A restarted installed app therefore fixes existing long histories retroactively once it runs the new build (`app.update` then restart). Nothing needs rewriting.

**Report paging (`index.ts:250`, `report.ts:189-201`)**
- `service.report()` no longer stops at the first 1000 events.
- It pages oldest-forward in 500-row pages, below the store's 1000 cap, until a short page, and a page that is exactly full is correctly not taken as the end.
- If the store throws partway through, the error reaches the caller and no partial report file is written.
- Rows appended while it pages have higher `seq` values and are either included or come after the snapshot. None is skipped or duplicated.

### P2 — not blocking, worth fixing in this batch or recording in the backlog

1. **The report collector can silently cut a report short (`report.ts:196`, `report.ts:198`).**
   - A "short page means the end" rule is only sound when the reader never returns fewer rows than it was asked for.
   - `store.events` quietly caps at 1000. So `collectDurableJobEvents(read, 2000)`, or any reader clamped below `pageSize`, returns only its first page as the whole report. Examples of such readers: app control clamps to 200 and IPC to 500.
   - The `cursor === after` guard also returns a partial list silently instead of throwing.
   - Status: after this review, the controller resteered F1 to fix the collector (continue to an empty page, throw on a stuck cursor) and add tests before F1's delivery. Accepting that fix still needs checking.
   - No current caller hits this: both callers use the default 500 over `store.events` or `DurableJobsServiceImpl.events`, which reaches the store at cap 1000. But the helper is exported and its doc comment promises every event.
   - Fix, either one:
     - clamp: `size = Math.min(size, 1000)`, and throw when `cursor === after`;
     - or stop only on an **empty** page, which costs one extra query.

2. **An unbounded scan per stage attempt (`controller.ts:228`).**
   - With no resume note (the common case), the `LIMIT 1` query walks the job's whole event history through `durable_job_events_job_idx (job_id, seq)`, running `json_extract` on every `note` row.
   - It runs once per stage attempt from `loop()`, not on every poll, so the cost is modest.
   - The project rule for the multi-gigabyte `conductor.db` is that main-process event queries are indexed and bounded to a window. An index on `(job_id, kind, seq)` added with `CREATE INDEX IF NOT EXISTS` would restrict the scan to one kind; retry and loop-detected rows are rare.

3. **Design question: does the owner's resume reset the loop guard? (`wiring.ts:128`)**
   - Replans are now counted across the whole history.
   - Suppose the owner resumes a stage that was blocked for a loop, and `resume` grants it new attempts. The restored guard then already holds `replans ≥ 1`, so the next loop blocks at once instead of replanning.
   - This matches the old behaviour for short histories. For long ones the 1000-row truncation used to hide it by accident, and now it no longer does.
   - If resume is meant to restart the replan budget the way it restarts the elapsed budget, it needs an explicit marker the way `elapsedBudget:'restarted'` works. This is not a regression; the owner or the design should decide.

4. **Adjacent bug, outside this diff (`durable-jobs-ipc.ts:50-57`): the detail view shows the wrong tail.**
   - The detail handler says it shows "the recent tail". It pages the oldest events up to 20,000, then `slice(-200)`.
   - For a job with more than 20,000 events, the view shows events 19,800–20,000 instead of the newest.
   - This is the same late-history class of bug. It should go to the backlog or into F1 if F1 widens its scope.

### Test validity

Each new test would fail against the pre-change code, and none relies on how the fixture happens to be arranged. Stage ids are scoped to their job, and `controller.start` switches to `running` synchronously, so the post-resume `until(...)` cannot resolve on a stale `blocked`.

| Test | What it proves | Fails on old code? |
|---|---|---|
| `controller.test.ts:221` elapsed restart after 1000 events | resume note past row 1000 restarts the budget; stage 2 opens | yes: old head-only read → `startedAt` → re-blocks on elapsed |
| `controller.test.ts:240` repeated failure past 1000 | this stage's retries counted; the two other-stage retries with the same error ignored → loop at attempt 3 | yes: old read sees no late retries → runs to 6 attempts. A broken stage filter would give a loop at attempt 1 |
| `wiring.test.ts:105` late replan restore | a late same-stage replan → `loop:`; only another stage's replan → `replan` | yes: old read misses the late replan. The second case isolates the stage filter |
| `store.test.ts:146` matching beyond 1000 | stage, `dataEquals`, `dataType` strictness (string vs number, plural field), newest-first `limit 1` | yes: old head read cannot see these rows |
| `store.test.ts:172` reopen | file-backed database closed and reopened; the late match is still found | only a persistence sanity check: the query holds no state |
| `store.test.ts:129` events paging | the existing API shape (default 200, cap 1000, afterId continuation) unchanged | compatibility guard, not a regression test |
| `report.test.ts:113` collector | exact-multiple history (1000 rows / 500) and an empty history | n/a (new helper) |
| `report.test.ts:124` service report over 2500+ rows | early, middle and late records in both report JSON and markdown; the late cloud escalation wins | yes: old `service.report` read 1000 |

**Test gaps (none blocking):**
- No reader that returns fewer rows than asked for, e.g. `collectDurableJobEvents(read, 2000)` over `store.events`. That is the case finding P2-1 would catch.
- No second job in the same store with matching kind, stage-like id and data, to show `job_id` isolation in `matchingEvents`. The code is correct by inspection; the test would lock it in.
- No two late restart notes, to prove the newest wins rather than any late one. `store.test.ts:146` covers one early and one late note only.
- No controller- or service-level test across a store reopen. The reopen test works on the store alone. The runtime proof below covers this.

## Minimal runtime and restart proof needed to accept F1

The unit tests use `FakeRuntime` and an in-memory store. Acceptance needs the built app from the **main checkout**: a build with a junctioned `node_modules` crashes the installed app. Run it parked under `CONDUCTOR_TEST_USER_DATA`, one smoke at a time, in stub-model mode (no llama-server). One focused script, or new flags on `smoke-durable-jobs.mjs`, is enough:

1. **Elapsed restart past 1000, across a restart.**
   1. Create a stub job with the smallest allowed `maxElapsedMs` and 2+ stages. Wait for `blocked` with an elapsed-time reason.
   2. Close the app.
   3. With `node:sqlite`, insert ≥1100 `note` rows for that job into `<profile>/conductor.db`. Use the real row shape: `id`, `job_id`, `at`, `kind`, and `data` = the full event JSON. Close the database.
   4. Relaunch the app on the same profile, then call `jobs.resume`.
   5. Accept only if all of these hold:
      - the resume note sits past row 1000, checked by paging `jobs.events` by `afterId`;
      - a new stage request reaches the stub;
      - the job reaches **`completed`**. A `blocked` result whose reason mentions the elapsed budget is a failure.
2. **Replan restore past 1000, across a restart.**
   1. Run the `--loop-case` stub with ≥1000 filler rows injected before the first `loop-detected` event.
   2. Close and relaunch the app after the first `loop-detected {replan:1}` event.
   3. Accept only if the next loop ends `blocked` with a loop reason and paging shows exactly one `replan` event for that stage. A second replan after the relaunch is a failure.
3. **Complete report.**
   - The report summarises events into records: recoveries, tests, cloud escalation, stages and transitions. It is not the full raw ledger, so do not assert filler counts in `report.md`.
   - Instead, inject events the report *does* summarise at three points in the history:
     - an early `recovery` before the fillers;
     - a middle `note` carrying `data.test` at roughly row 1200;
     - a late `recovery` plus an `escalation {occurred:true}` after row 1000.
   - Then call `jobs.report` and assert that all of these hold in both the report JSON and `report.md`:
     - the early, middle and late records are all present;
     - the late escalation is the one reported;
     - the job's terminal status is correct.
4. Record all of the following in the F1 evidence:
   - the profile path;
   - the event counts;
   - the final statuses and reasons;
   - the diff hash that was built.

Allowing `blocked`/`failed` as success in scenario 1 or 3 would make the proof worthless.
