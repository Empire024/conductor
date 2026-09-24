# F1 runtime acceptance — durable-job history after an app restart

**Status: PASS**, 2026-09-24 09:35 UTC. The durable-jobs source under test is commit `cacfc74`. It was built from committed HEAD `4b7e58f`, which changes only Grok files: `git diff --quiet cacfc74 4b7e58f -- src/main/durable-jobs src/shared/durable-jobs.ts src/main/index.ts` exited 0. The same smoke **FAILS on the pre-fix build `cacfc74^`**, as the defect predicts. No product code changed. The smoke found no F1 defect.

Author: Opus coworker `agent_mufbsiu7_zrjwtdz`, task `task_mufbsizb_yvenjpp`. This replaces the rejected Stage A scaffold (still preserved as `f1-seed-scaffold.txt`).

## Commands and exit codes

Each build was exported with `git archive <rev> | tar -x` into `%TEMP%`, with `node_modules` junctioned and `npx electron-vite build` run there. The export matters: the shared `out/` held other workers' uncommitted durable-jobs changes, and a smoke build is not a packaged app. Before every launch, no other `electron.exe` was running.

| Run | Command | Exit | Result |
|---|---|---|---|
| HEAD build | `(export HEAD 4b7e58f) npx electron-vite build` | 0 | out has `matchingEvents` |
| pre-fix build | `(export cacfc74^) npx electron-vite build` | 0 | out has no `matchingEvents` |
| **acceptance** | `node scripts/smoke-durable-history.mjs --app=%TEMP%/conductor-f1-head-build/out/main/index.js` | **0** | PASS |
| negative control | `node scripts/smoke-durable-history.mjs --app=%TEMP%/conductor-f1-prefix-build/out/main/index.js --summary=f1-runtime-smoke-prefix-summary` | **1** | FAIL, as expected |
| syntax | `node --check scripts/smoke-durable-history.mjs` | 0 | |

Two runs against the shared `out/` build also exited 0 (09:30 and 09:33 UTC). Neither counts as acceptance: that build was not a commit, and the 09:33 run overlapped another worker's Electron. A first run at 09:29 is **void**: `app.close()` hung and killing the Playwright pid left the real Electron main process running on the temp profile, so the seed was written under a live app. That run's relaunch then hit the single-instance lock. The smoke was fixed (see *Restart method*); its log is kept as `artifacts/autopilot/f1-runtime-smoke-run1-void.log`.

Logs (the committed copies are the evidence; `artifacts/` is gitignored):
- `docs/autopilot-evidence/f1-runtime-smoke-pass.txt` (= `artifacts/autopilot/f1-runtime-smoke.log`), summary `artifacts/autopilot/f1-runtime-smoke-summary.json`
- `docs/autopilot-evidence/f1-runtime-smoke-prefix-fail.txt` (= `artifacts/autopilot/f1-runtime-smoke-prefix.log`), summary `artifacts/autopilot/f1-runtime-smoke-prefix-summary.json`
- Screenshot of the parked window after the run: `artifacts/autopilot/f1-runtime-jobs.png`

## What the smoke does

`scripts/smoke-durable-history.mjs` reuses the launch, profile, owner-credential, control-call and stub-model patterns of `scripts/smoke-durable-jobs.mjs`. It sets `CONDUCTOR_TEST_USER_DATA` to a fresh `%TEMP%\conductor-durable-history-*\profile` (window parked off-screen) and passes `CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT` to a loopback stub. No real model server is involved.

1. **Launch 1.** Open a git project and create three jobs through `jobs.create`:
   - **A**: `maxElapsedMs` 1 h, stages Append and Verify. The stub holds A's first request, so A is `running` mid-stage.
   - **B**: control job, `maxElapsedMs` 1 h. Queued.
   - **C**: LOOP-CASE job. Queued (maxConcurrent is 1).
2. **Hard stop.** `taskkill /T /F` the app's process tree, then poll until no `electron.exe` command line names the run's temp root.
3. **Seed.** Write to the closed `conductor.db` in one `BEGIN IMMEDIATE` transaction, with rollback on error:
   - **A** (1,106 events): `startedAt` backdated 14 days. An early `note {elapsedBudget:'restarted'}` 14 days old. An early `recovery` carrying test marker `f1-early-marker`. 550 fillers. A middle `note` carrying `f1-middle-marker`. 550 fillers. A late `note {elapsedBudget:'restarted'}` 3 s old. A late `recovery` carrying `f1-late-marker`. An `escalation {occurred:true}`.
   - **B** (1,101 events): the same backdate, early note and fillers, but **no late note**.
   - **C** (1,101 events): 1,100 fillers, then one `loop-detected {stageId, replan:1}` for C's stage.
   - Event rows use the store's shape: columns `id, job_id, at, kind` and `data` holding the whole event JSON. No timestamp is in the future.
   - The containment guard (`isolatedDatabase`) accepts only this run's own profile path. That path must realpath to itself, sit strictly inside `%TEMP%`, and not be `%APPDATA%\Conductor`, lie inside it, or contain it. `conductor.db` must realpath to `<profile>\conductor.db`.
4. **Launch 2** on the same profile, with the stub now answering. Wait until all three jobs settle, record their outcomes, then assert:
   - **A (newest elapsed reset honoured).** A reaches `completed` (not `blocked` on elapsed), has ≥1 recovery, and the stub gets fresh A requests after the relaunch.
   - **B (control).** B ends `blocked` with "Reached the job's elapsed-time budget", and the stub never sees a B request. This shows the seeded budget really binds, so A completing is due to the late note.
   - **C (exactly one replan persists).**
     - C ends `blocked`.
     - Its paged events hold more than 1,000 records.
     - The only `loop-detected` events with numeric `data.replan` are **exactly the seeded one**.
     - The new loop blocks with `data.replans === 1` and `blocked: true`.
   - **A paged events** (`jobs.events`, afterId paging at the protocol's 200 cap):
     - No duplicate ids.
     - More than 1,100 events over ≥6 pages.
     - All six seeded records are present and in order, the late ones past position 1,000.
     - After the seeded tail come the reconciliation `recovery`, stage events and the `completed` transition. There is no `blocked` transition.
     - `jobs.status.lastEvent` equals the last paged event.
   - **A report** (`jobs.report` response and `report.json` on disk):
     - Status `completed`.
     - Tests include `f1-early-marker`, `f1-middle-marker` and `f1-late-marker` as `pass`.
     - Recoveries include the early and late seeded records, followed by the post-restart reconciliation.
     - `cloudEscalation.occurred === true` with the detail "F1 seed: late escalation".
     - `report.md` contains all three markers and the escalation.

## Results

Acceptance run against the HEAD build:

- **A: `completed`, "Every stage completed".** It reconciled once, and Stage 1 finished on attempt 2 after the restart cut off attempt 1. It had 1,126 events over 6 pages. The seeded records sit at positions 6 (early note), 7 (early), 558 (middle), 1109 (late note), 1110 (late) and 1111 (escalation). The newest tail runs: attempt 2 started → checkpoint → stage 1 completed → stage 2 completed → `running → completed`. The stub saw 1 held A request in launch 1 and 4 A requests in launch 2.
- **A report.**
  - Tests: early, middle and late markers, all `pass`.
  - Recoveries, in order: "F1 seed: early recovery", "F1 seed: late recovery", "Reconciling after restart; previous owner … (epoch 1)", and the model-call settled `failed` (cut off, no tool pending).
  - `cloudEscalation`: `{occurred: true, detail: "F1 seed: late escalation"}`.
- **B: `blocked`**, "Reached the job's elapsed-time budget of 60 minutes", with 0 stub requests.
- **C: `blocked`**, "…looped again after a replan: near-identical calls read_file on README.md 4 times…". The `loop-detected` events are the seeded `replan:1` event (`jobevt_f1seed_C_1100`) and the new block event (`replans:1, blocked:true`). No second replan occurred. The stub saw 6 C requests.

Negative control against the pre-fix build `cacfc74^`:

- **A: `blocked`**, "Reached the job's elapsed-time budget of 60 minutes". The old controller read only the oldest 1,000 events, found the 14-day-old note and never saw the late reset. The smoke exits 1 on this assertion.
- **B: `blocked`** on elapsed, the same as the fix.
- **C: `blocked` after two replan events.** Besides the seeded one, a new `replan:1` "Replanning once with a fresh worker context" appeared, then the block on attempt 2. The old guard restored 0 replans because the seeded one lay past row 1,000. The stub saw 12 C requests against 6 with the fix.

So the smoke reproduces the original failure and shows it gone after the fix. Two of the four F1 consumers are proven through a real restart: the elapsed-reset note (controller) and the replan restore (wiring). A third, full report paging (`index.ts` `collectDurableJobEvents`), is proven through `jobs.report`. Per-stage retry errors are not exercised at runtime here; their failing-then-passing unit tests are in `f1-event-history.md`.

## Restart method

A graceful `app.close()` with a job running waits on the intended "Quit Conductor? Work is still running" dialog (`index.ts` `confirmApplicationStop`). The smoke therefore stops the whole process tree: a crash or power loss, the case `reconcile.ts` exists for.

Also observed: in this Playwright launch, `app.process()` is a parent `electron.exe` whose child is the real main process, so `app.process().kill()` alone leaves the app running. `scripts/smoke-durable-jobs.mjs --restart-app` uses exactly `app.close()` (20 s race), then `app.process().kill()`, so its relaunch may hit the single-instance lock while a job runs. That file belongs to another worker and was not changed here; this is reported to the controller.

## Not covered

- No real model (stub only), no `--kill-server`, and no graceful-quit restart (see above).
- Per-stage retry errors and the P2 short-page collector edge are covered by unit tests only (`f1-event-history.md`, `f1-p2-passing-after.txt`).
- The stale >20k tail in `durable-jobs-ipc.ts` belongs to F4, not this acceptance.
