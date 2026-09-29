# Durable jobs: fault, approval, loop/stall and soak acceptance (2026-09-29)

Feature-list item `durable-jobs-verification`, agent `agent_mumnvf1h_pldd9go`, controller
`agent_mumf4ytg_1eav7g4`.

Build under test: HEAD `8f670047b4a93553192d9f3b1784ac03cdc79821`, built in a detached worktree
(`.conductor-scratch/dj-verify/wt`, node_modules junctioned, `electron-vite build` under
`smoke-lock`), `out/main/index.js` SHA256
`2adec1f422f4b2c35cfab0fd50bf6c5048f13720e7f1c11f95547f1011cba1a3`. Every run passes
`--app=<that file> --app-sha256=<that hash>`, so the smoke re-hashes the build before each launch.
Every run is parked (`CONDUCTOR_TEST_USER_DATA` temp profile); none used `npm run dev`.

Logs: `artifacts/verification/2026-09-29-durable-jobs/` (`<run>.log` is the timestamped
observation stream, `<run>.json` the smoke's JSON summary, `<run>.start`/`.exit` the wall-clock
bounds in UTC and the exit code).

Machine: before the real-model runs, `local.servers` showed the owner's idle Dolphin X1 8B
(pid 36964, started by the installed Conductor). The CPU Laya decider was left alone throughout.

## Acceptance matrix

| # | Case | Command (all from `C:\Claude\conductor`, `APP`/`SHA` as above) | Start / end (UTC) | Log | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1 | Stub loop + stall (and the stub main flow: tab close/reopen, reload, pause/resume, cancel, approval->blocked) | `node scripts/smoke-lock.mjs --timeout-min 30 -- node scripts/smoke-durable-jobs.mjs --loop-case --stall-case --app=$APP --app-sha256=$SHA` | 12:39:01 / 12:44:21 | `stub-loop-stall.log` | **PASS**, exit 0. Loop job blocked in 52.6 s: "looped again after a replan: near-identical calls read_file on README.md 4 times" (retries 2, loopsDetected 1). Stall job (maxStageAttempts 1) blocked in 181 s: "Watchdog: no progress for 180s and the server is not processing", the model call interrupted as stalled. Approval job blocked in 16 s. Cleanup: no leftovers, nothing unresolved. |
| 2a | Real Qwen control + approval, attempt 1 | `node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --app=$APP --app-sha256=$SHA` | 12:44:5x / 12:45:57 | `real-control-attempt1-dolphin-held.log` | **NOT RUN (precondition)**, exit 1. The job waited: "local/dolphin-x1-8b holds the local model server (idle); the job does not interrupt it", and the smoke's 60 s "stage running" wait expired. This is the documented supervisor behaviour (an idle server is displaced only after 10 quiet minutes), not a defect. The owner's Dolphin was then stopped with `local.stop({model:"local/dolphin-x1-8b"})` (pid 36964) to be restored afterwards. |
| 2 | Real Qwen control + approval | same command as 2a | 12:46:14 / 12:51:39 (queued behind another agent's smoke until 12:46:28) | `real-control.log` | **PASS**, exit 0. Main job completed both stages in 50 s (peaks 5,737 and 5,221 prompt tokens) through tab close/reopen, reload and pause/resume; report.md/report.json written, cloud escalation false. Cancel job cancelled, and resuming it was refused. **Approval case against the real model:** blocked after 192.6 s with an owner/permission reason (the smoke asserts `/approv|permission|owner/`). Final cleanup killed only the parked app's own llama-server (pid 77176); no leftovers. |
| 3 | Real Qwen `--kill-server` + `--restart-app`, crossref fixture (4 stages, verified output) | `node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --fixture=crossref --kill-server --restart-app --extras=none --keep --app=$APP --app-sha256=$SHA` | 12:52:09 / 13:06:28 | `real-fault.log` | **PASS**, exit 0. At 12:53:03 the parked app's own Qwen (pid 27840, parent = parked main) was stopped with `local.stop` and its exit observed from the OS; the stage recorded `retry ... provider_error: fetch failed` and `server is dead (was healthy)`; one replacement server (pid 45788, parent = parked main) was listed within 1 s. The app was then closed and relaunched on the same profile: `Reconciling after restart; previous owner 18840 (epoch 3)`, attempt 2 started 12:53:41, and the **same job** completed all 4 stages at 13:06:02 (recoveries 1, retries 1, peaks 20,774 / 19,229 / 20,684 / 10,612 of 32,768). Output checked against the fixture on the job's branch: no problems (every CROSSREF row present, notes/ for all six modules, owner checkout untouched). Profile kept: `%TEMP%\conductor-durable-jobs-QhIjER`. |
| 4 | Real Qwen `--kill-server` alone (recovery without an app restart), with the tightened check | `node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --fixture=crossref --kill-server --extras=none --keep --app=$APP --app-sha256=$SHA` | 13:11:5x / 13:27:04 | `real-kill.log` | **PASS**, exit 0. Parked Qwen pid 67844 (parent = parked main) stopped at 13:12:26 and its exit observed. Events after the kill: 13:12:24.809 `retry Stage 1 attempt 1 did not finish: provider_error: fetch failed`, 13:12:24.822 `server is dead (was healthy)`, 13:12:30.513 `server was restarted (pid 67844 → 3124, port 51436 → 51436); in-flight work is reconciled and the prompt cache is cold`, 13:12:30.579 `Stage 1 ... attempt 2 started`. Exactly one replacement server (pid 3124, parent = parked main). The same job completed all 4 stages at 13:26:37 (peaks 22,361 / 21,981 / 22,451 / 9,819 of 32,768) with fixture-verified output. Cleanup killed only pid 3124; no leftovers. Profile kept: `%TEMP%\conductor-durable-jobs-YMY0g3`. |
| 5a | 6-hour soak, attempt 1 | same command as row 5 | 13:27:54 / 13:48:19 | `soak-attempt1-soak.log` | **HARNESS FAIL**, not a product finding. Iteration 1 was still making progress (`Stage 3 "Write notes for epsilon and zeta" attempt 1 started` at 13:46:57) when the soak's settle wait gave up at 20 min. That wait was one *stage's* timeout applied to a whole 4-stage job. Fixed: an iteration is now bounded by stage count × stage timeout (`SOAK_ITERATION_TIMEOUT`, 80 min for crossref), and the watchdog uses that bound. Cleanup killed only the parked app's llama-server; no leftovers. |
| 5b | 6-hour soak, attempt 2 (iteration bound fixed, forced fraction still 0.4) | same command as row 5 | 13:49:15 / stopped 16:2x | `soak-attempt2-soak.log`, ledger `artifacts/durable-jobs/soak-ledger.attempt2-2026-09-29.ndjson` | **STOPPED: could not pass (harness configuration)**. 36 iterations, 36 blocked (34 in stage 1, 2 in stage 2), each after 3 charged attempts whose last errors were context rollovers at 15.4k-16.6k tokens or loop-guard replans on re-reads of `modules/alpha.js`. The attempt audit was `ok` for all 36 (no accounting violation), but 0 credited rollovers and 0 completions. Cause: at the forced 0.4 (13,107 tokens) a crossref stage rolls over before it has read one ~1,100-line module, so no rollover has written a file. The controller credits a rollover only with file progress (`controller.ts:449`), which is the intended rule, so every rollover was charged, and each fresh context re-read the same ranges. The soak's must-haves (a verified completion, a credited rollover that went on) were unreachable. It was stopped by killing exactly its own process tree (wrapper 27600 → smoke 30916 → cmd 58044 → parked Electron main 52684 → its children and llama-server 26392); nothing was left behind. Profile kept: `%TEMP%\conductor-durable-jobs-K8KgEU`. The same pattern explains the 2026-09-27 soak's 83 iterations with 1 completion. |
| 5p | Probe: one soak iteration at fraction 0.55 | `DURABLE_SOAK_ROLLOVER_FRACTION=0.55 DURABLE_SOAK_WORKLOAD_MS=1 node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --fixture=crossref --soak --keep --app=$APP --app-sha256=$SHA` | 16:19 / 16:38:01 | `probe-055.log`, ledger `soak-ledger.probe-055-2026-09-29.ndjson` | Probe only (exit 1 by design: "only 1 iteration"). The iteration **completed** all 4 stages in 18.5 min with fixture-verified output: 4 rollovers, 3 retries, audit `PASS`, credited rollover `EXERCISED` (2 credited, 2 went on). The soak's forced fraction is now `DURABLE_SOAK_ROLLOVER_FRACTION`, default 0.55 (18,022 tokens: past one module read and written, below the stage's ~21k peak). |
| 5 | 6-hour unattended soak, several context rollovers | `node scripts/lib/background-priority.mjs -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --fixture=crossref --soak --keep --app=$APP --app-sha256=$SHA` (fraction 0.55), started detached (PowerShell `Start-Process`, pid in `soak.pid`) outside the smoke lock at the controller's request, below-normal priority | 16:38:33 / 22:55:03 | `soak.log`, `soak.json`, ledger `artifacts/durable-jobs/soak-ledger.ndjson`; profile `%TEMP%\conductor-durable-jobs-6F50pX` (every job's branch is kept in its `project`) | **PASS** on every soak assertion; exit 1 from the cleanup accounting only (explained below). Measured workload **22,566,568 ms (6 h 16 min)** against the required 21,600,000. **20 iterations, 20 completed** (80 stages), unattended, no owner action. **42 context rollovers** (0-5 per iteration), 38 retries, 0 recoveries, 0 loops, 0 cloud escalations. Stage-aware attempt audit: **PASS**, credited rollover **EXERCISED** (24 credited rollovers, all 24 went on to another attempt or completion), no violations, nothing unproven. Output: the run counted 18 of 20 verified. Re-judged with the corrected checker (below), **19 of 20 are correct**. Iteration 13 is a real incomplete result (see finding 2). Iterations took 12-39 min each; the later ones were slower. |

### Row 5 cleanup accounting (exit 1)

Final cleanup killed only the parked app's llama-server (pid 536) and left no leftovers, but
reported three processes it could not account for:
- pid 79300 "registered root has no readable OS identity": that pid then belonged to `WmiPrvSE.exe`
  (created 22:37:54Z). A registered root's pid had been reused.
- pid 61268 `conductor-runtime-host.exe` "created before its listed parent 536". It was the
  **installed** Conductor's runtime host. The installed app restarted for an update at about
  22:54Z, the same minute as this cleanup, and its old parent's pid 536 had been reused.
- pid 54792 `conhost.exe`, a possible orphan of an exited root. It was gone a minute later.

The kit failed closed and killed none of them. A fresh inventory at 22:56Z showed no Electron on
any `conductor-durable-jobs-*` profile and no llama-server except the owner's. So the exit 1
records an honest "cannot prove" that coincided with the installed app's restart, not a leak.

## Findings

1. **Fixed (product): `local.servers` listed a dead server whose pid the OS had reused.** Server
   run records live in the machine-wide local-model runtime folder, which every Conductor
   instance shares. The soak's teardown killed its llama-server as a process, so its record
   (pid 536) stayed behind. Pid 536 then went to an unrelated `conhost.exe`, and the installed
   app's `local.servers` reported "Qwen 3.6 35B-A3B, pid 536". `listLocalServers` trusted any
   live pid. Admission (`inspectAdmission`) and stop (`stopOwnedServer`, identity-bound) were
   already safe: `local.stop({model:"local/qwen3.6-35b-a3b",pid:536})` answered "pid 536 had
   already exited; the pid now belongs to another process, left alone", removed the record and
   left the conhost running. Fix: `src/main/local-models/servers.ts` now treats a readable
   llama-server inventory as the authority for records (a recorded pid that is not a
   llama-server is not listed). A caller that skips the inventory, local-assist's
   `model-runner.ts`, no longer passes a stub that returned `[]`, so it still trusts records.
   Test: `servers.test.ts` "drops a run record whose live pid is no longer a llama-server, unless
   the inventory is unknown". `npx vitest run src/main/local-models/servers.test.ts
   src/main/local-assist`: 63/63 pass (`.conductor-scratch/local-assist/2026-09-29T22-59-16-237Z-b85769.log`).
2. **Open (product limit, follow-up item `durable-jobs-semantic-completion`): a job can report
   completed with an incomplete result.** Soak iteration 13 (`job_mun3luxu_ct5918b`) wrote a
   `CROSSREF.md` with 2 of the 12 import rows, although its own `notes/alpha.md` lists the
   others, and the job ended "Every stage completed". `completion-check.ts` verifies only
   mechanical criteria (a file exists, a line count). "CROSSREF.md has a row for every import
   listed in notes/" is left unchecked and the stage's own "done" is trusted, as documented. That
   is 1 wrong completion in 20 real ones, and closing it (a model-judged criteria check or a
   verify stage) is a design decision.
3. **Fixed (harness): the soak's per-iteration bound** (row 5a), **the kill-server recovery
   check** (row 3), **the forced rollover fraction** (rows 5b and 5p), and **the crossref
   checker**, which rejected a correct one-row-per-function table (iteration 10,
   `job_mun1pn7y_q45tjtb`). All four are in `scripts/smoke-durable-jobs.mjs`; the re-judge of all
   20 soak outputs used `.conductor-scratch/dj-verify/rejudge.mjs`.
4. **Precondition (documented):** a durable job does not displace another Conductor's idle
   server for 10 quiet minutes (row 2a). `docs/durable-jobs.md` "Smoke" now says to stop the
   owner's server first and restore it afterwards.

## Machine state at the end

The owner's Dolphin X1 8B was restored at 22:57:04Z (pid 19936, port 51438, started by the
installed app through a local tab). The CPU Laya decider was running (pid 72192), and no other
llama-server was running.

## Harness finding (fixed)

In run 3, the smoke's "server loss noticed" and "job running again after server restart" waits
passed within 2 ms of the kill. Both only read `jobs.status`: a job stays `running` through a
server loss, and its last event was already a `server` event. The trace shows the retry and the
dead-server event did happen, but the first new stage attempt came only after the app relaunch
27 s later. So the combined run proves recovery through a restart, and not that the watchdog
alone brings a stage back. `scripts/smoke-durable-jobs.mjs` now counts the job's events before
the kill and requires, after it, a server-loss event (`server ... dead`, `retry` or `recovery`)
followed by a new `stage ... attempt N started` event (or the job completing). Row 4 runs that
check on its own.

## Verdict

Every row of the item passes: real-model `--kill-server` (rows 3 and 4) and `--restart-app`
(row 3), the approval case against the real model (row 2), the stub `--loop-case` and
`--stall-case` (row 1), and the 6-hour unattended soak with 42 context rollovers (row 5). Rows
2a, 5a, 5b and 5p are the attempts and probe that led there, kept as evidence. Two things are
not part of this item's pass: the product limit in finding 2 has its own follow-up item, and
row 5's cleanup exit is explained above.

## State at pause (13:10 UTC)

Paused so the controller could install update 0.1.55-local (3b36fff). No smoke or background
task was left running from this tab. No llama-server was running. The owner's Dolphin server is
still stopped and has to be restored once all real-model runs are done. Next: row 4, then row 5.
The install finished at about 13:11 and the work resumed.
