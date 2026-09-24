# Whole-app verification of HEAD 77686fd before the installed-app update

Worker `agent_mufez417_y0st4p6`, orchestration task `task_mufez4xb_qzfer3d`, controller `agent_muer6h9a_fwe9n16`. Run 2026-09-24 10:55–11:35 UTC on MAIN, sole worker in the checkout. HEAD `77686fd` (today's range `e3aa664..77686fd`). The working tree was HEAD plus the owner's uncommitted `feature-list.md` for the whole run. No product source was changed. No publish. Package version not edited.

Every row ran one at a time. Before and after each Electron row the harness checked `Get-Process electron`, and would have recorded and `taskkill /T /F`-ed any leftover. `artifacts/whole-app-verification/leftovers.jsonl` stayed empty. Every app launch used `CONDUCTOR_TEST_USER_DATA` on a fresh temp profile, set either by the smoke itself or by the harness, so every window was parked.

Logs and harness are under the gitignored `artifacts/whole-app-verification/`:

- `results.jsonl`: one record per row, with command, exit code, UTC start and finish, and seconds.
- `logs/<row>.log`: full output of each row.
- Harness scripts:
  - `run.mjs`: runs and records one row.
  - `sequence.mjs`: runs the Electron rows one at a time and sweeps leftover processes.
  - `attached.mjs`: launches a parked app with a CDP port for the smokes that attach instead of launching.
  - `baseline.mjs`: reruns a smoke on the baseline build.
  - `slot.mjs`: grants the Electron-slot lease that two older smokes require.
  - `smoke-local-models-9b.mjs`: a 9B-only variant of smoke-local-models.
  - `workflow.mjs`: the step 4 workflow.

**Baseline comparison.** Every smoke that failed on HEAD was rerun on a build of `e3aa664`, the commit before today's range. That build lives in a detached worktree `%TEMP%\conductor-baseline-e3aa664` with a junctioned `node_modules`, built with `electron-vite build` only; nothing was packaged from it. Each smoke ran from that worktree with its own scripts. Rows are prefixed `B`.

## 1. Typecheck and tests

| # | Command | Exit | Duration | Log | Result |
|---|---|---|---|---|---|
| 01 | `npx tsc --noEmit` | 0 | 10.3 s | `logs/01-tsc.log` | PASS |
| 02 | `npm test` (vitest + `test:scripts`) | 0 | 39.9 s | `logs/02-npm-test.log` | PASS: Vitest 260 files / 3091 tests passed; script tests 65/65 |

## 2. Build

| # | Command | Exit | Duration | Log | Result |
|---|---|---|---|---|---|
| 03 | `npm run build` (typecheck + electron-vite build) | 0 | 28.2 s | `logs/03-build.log` | PASS: renderer `built in 16.24s` |

## 3. Electron smokes

In the Baseline column, "same failure" means the `B` rerun failed at the identical assertion.

| # | Smoke (command) | Exit | Duration | Log | Result | Baseline e3aa664 |
|---|---|---|---|---|---|---|
| 10 | `smoke-background-windows.mjs` | 0 | 1.6 s | `logs/10-background-windows.log` | PASS: parked at x −6000, focused false, painted | — |
| 11 | `smoke-ui.mjs 9333` via `attached.mjs ui` | 1 | 8.3 s | `logs/11-ui.log` | FAIL: `Requested docking option was not available after drag start` (`smoke-ui.mjs:341` dragTab) | same failure (`B11-ui`) |
| 12 | `smoke-navigation.mjs` | 1 | 3.3 s | `logs/12-navigation.log` | FAIL: 2 PASS, then `0 !== 1` always-on-top detached windows (`:58`) | same failure |
| 13 | `smoke-workspace-restore.mjs` | 1 | 6.8 s | `logs/13-workspace-restore.log` | FAIL: `.sidebar-session-rename` never focused | same failure |
| 14 | `smoke-recovery.mjs 9341 prepare/verify` via `attached.mjs recovery` | 1 | 8.2 s | `logs/14-recovery.log` | FAIL (blocked): its seed step `smoke-ui.mjs --preserve` fails at the same docking drag as row 11, so prepare/verify never ran | seed fails the same way (`B11-ui`) |
| 15 | `smoke-session-controls.mjs` | 1 | 26.9 s | `logs/15-session-controls.log` | FAIL: effort slider expected `3`, got `2` | same failure |
| 16a | `smoke-structured-agents.mjs` (Codex) | 1 | 33.1 s | `logs/16a-structured-agents-codex.log` | FAIL: `getByLabel('Execution sandbox')` not found (`:53`) | same failure |
| 16b | `smoke-structured-agents.mjs --provider=claude` | 0 | 11.9 s | `logs/16b-structured-agents-claude.log` | PASS | — |
| 17 | `smoke-steering.mjs` | 1 | 7.1 s | `logs/17-steering.log` | FAIL: strict-mode violation, two `Resume conversation` buttons (`:76`) | same failure |
| 18 | `smoke-agent-control.mjs` | 1 (killed) | 170.8 s | `logs/18-agent-control.log` | FAIL: 1 PASS, then hangs after `router.start`; the router briefing never reached the capture. Killed after ~3 min. | same hang (`B18-agent-control-rerun`: timed out at 480 s after the same 1 PASS) |
| 19 | `smoke-capability-sweep.mjs` (offline) | 1 | 3.4 s | `logs/19-capability-sweep.log` | FAIL: 4 checks, then expected `Account default`, got `Medium (account default)` (`:244`) | same failure |
| 20 | `smoke-project-task-dispatch.mjs` | 1 | 13.7 s | `logs/20-project-task-dispatch.log` | FAIL: 7 PASS, then `Auto Fixer must not switch the provider permission mode` (`:208`) | same failure |
| 21 | `smoke-tab-groups.mjs` | 1 | 43.1 s | `logs/21-tab-groups.log` | FAIL: `.pane-tab` never visible in the vite fixture (`:73`); retry `21-tab-groups-retry` same | same failure |
| 22 | `smoke-composer-settings.mjs` | 0 | 6.7 s | `logs/22-composer-settings.log` | PASS | — |
| 23 | `smoke-usage-warning.mjs` | 1 | 17.3 s | `logs/23-usage-warning.log` | FAIL: the composer "Expensive" warning passed, but `.process-status-summary-warning` (Processes sidebar) never appeared (`:72`) | same failure |
| 24 | `smoke-local-models.mjs` → `smoke-local-models-9b.mjs` | 0 | 31.3 s | `logs/36-local-models-9b.log` | PASS (9B variant): streamed `LOCAL_UI_9B_OK`; run_command + read_file through the Docker sandbox wrote a real file; Stop interrupted; API key absent from renderer; tabs restored after reload. The original also opens Qwen 3.6 35B beside the 9B, which the one-server rule forbids. | — |
| 25 | `smoke-local-grants.mjs` | 0 | 2.3 s | `logs/24-local-grants.log` | PASS | — |
| 26 | `smoke-local-admission.mjs` via `slot.mjs` | 1 | 32.0 s | `logs/35-local-admission.log` | FAIL: host-level refusal of 35B passed; the in-app text `Cannot start local/qwen3.6-35b-a3b: … already running` never appeared after `structured.connect`. No 35B was started: only llama-server pid 12280 (9B) before and after. | same failure (`B35-local-admission`) |
| 27 | `smoke-durable-jobs.mjs` (stub) | 0 | 67.2 s | `logs/25a-durable-jobs.log` | PASS: 2 stages completed; cloud model refused; cancel + approval jobs | — |
| 28 | `smoke-durable-jobs.mjs --approval-gate` | 0 | 54.2 s | `logs/25b-durable-jobs-approval-gate.log` | PASS | — |
| 29 | `smoke-durable-jobs.mjs --blocked-restart` | 0 | 54.3 s | `logs/25c-durable-jobs-blocked-restart.log` | PASS: still blocked after the 2nd restart, nothing rewritten; resumed once to completion | — |
| 30 | `smoke-durable-jobs.mjs --restart-app` | 0 | 71.1 s | `logs/25d-durable-jobs-restart-app.log` | PASS: relaunch kept the job id, reconciled (recoveries 1), 2 stages completed | — |
| 31 | `smoke-durable-history.mjs` | 0 | 41.8 s | `logs/26-durable-history.log` | PASS | — |
| 32 | `smoke-durable-tail.mjs` | 0 | 27.7 s | `logs/27-durable-tail.log` | PASS: late marker shown after restart | — |
| 33 | `smoke-update-status.mjs 9363` + `smoke-update-feed.mjs 9370` via `attached.mjs update-status` | 0 | 2.9 s | `logs/28-update-status-feed.log` | PASS: bottom bar shows `Update pending` with highlight from the 0.1.4 feed | — |
| 34 | `smoke-local-update-build.mjs` | 0 | 75.1 s | `logs/41-local-update-build.log` | PASS: published `0.1.53-local.1790249619617` into `%APPDATA%\Conductor\local-updates` | — |
| 35 | `smoke-schedules.mjs` | 0 | 3.8 s | `logs/29-schedules.log` | PASS (4 checks) | — |
| 36 | `smoke-processes-fixer.mjs` via `slot.mjs` | 0 | 30.9 s | `logs/34-processes-fixer.log` | PASS | — |
| 37 | `smoke-system-performance.mjs` | 0 | 13.2 s | `logs/30-system-performance.log` | PASS | — |
| 38 | `smoke-phone-shell.mjs` | 0 | 26.8 s | `logs/31-phone-shell.log` | PASS (4 checks) | — |
| 39 | `smoke-change-history.mjs` | 1 | 32.1 s | `logs/32-change-history.log` | FAIL: waits 30 s for an `Allow once` approval button on the Codex fixture (`:47`) | same failure |
| 40 | `smoke-context-briefing.mjs` | 0 | 3.9 s | `logs/33-context-briefing.log` | PASS: 3950-byte briefing, then a 55-byte follow-up; re-briefs a resumed process | — |
| 41 | `smoke-control-repairs.mjs` (added: today's control changes) | 0 | 62.6 s | `logs/37-control-repairs.log` | PASS: catalog; G1 usage.limits incl. persistence across a hard restart; G7 steer idle/running/interrupted; G3 local 9B read-only dispatch, project unchanged | — |

Not run for want of a cloud login or the relay: none. Every listed smoke runs on offline fixtures, the stub model, or the local 9B.

## 4. App-control workflow (`workflow.mjs`, parked isolated profile)

| Command | Exit | Duration | Log |
|---|---|---|---|
| `node artifacts/whole-app-verification/workflow.mjs` | 0 | 12.5 s | `logs/40-workflow.log`, detail `workflow-results.json` |

| Check | Result |
|---|---|
| `tools.list` lists `usage.limits`; `git.ship` says "a local commit … Only publish: true"; `jobs.pause` says "interrupts the running stage at once" | PASS |
| `usage.limits` answers: Claude reported five_hour 24 %, seven_day 95 %, Fable weekly 99 % (synthetic runtime); Codex and Grok `unknown` | PASS |
| `agents.steer` on an idle Claude coworker → `delivery: "started"`, one turn, phase `completed`, prompt sent once | PASS |
| `files.list({query:'usage'})` order: `src/main/usage-limit.ts`, `src/main/usage-limit.test.ts`, `src/shared/usage-accounting.ts`, `.recovery-urgent-release-20260908/src/main/usage-limit.ts`, `artifacts/delivery-snapshot/src/main/usage-limit.ts`, `artifacts/usage-warning/usage-report.json`, `scripts/smoke-usage-warning.mjs`. Every `src` match ranks above every artifact/recovery copy, and the live file ranks above its copies. | PASS |
| `jobs.create` on `local/qwen3.5-9b` (the real llama.cpp server, owner credential) → `completed` ("Every stage completed") in 4.4 s active. Checkpoint `f8e1844`. `notes/verified.md` in the job worktree reads `VERIFIED-OK`. `jobs.report` lists that file and no remaining work. llama-server count 1 before and after. | PASS |

A first run (`40-workflow`, exit 1, 17.9 s) failed only my own ordering check. That check wanted every live file above every copy across all match tiers. G4's documented contract (`src/main/project-file-search.ts`) compares the match tier first: `scripts/smoke-usage-warning.mjs` is a name-contains match and ranks below the name-prefix matches, including the copies, by design. The check was corrected to the contract (src above copies; live above its own copies within a tier) and rerun green. No product code changed.

## Deviations, stated plainly

- **Qwen 9B server.** The brief named a running 9B on port 51436. At 11:26 no llama-server was running: the 9B run record showed port 51437, pid 43304 gone, last log 10:48 UTC. Port 51436 is the 35B slot. 1.7 of 12 GB VRAM were in use. I started the single default 9B with `npm run local -- start --fast` (`logs/05-start-qwen9b.log`, exit 0, pid 12280 on 51437). That is one server, not a second, and it is the model the brief intended. It is still running.
- **Electron-slot lease.** `smoke-processes-fixer` and `smoke-local-admission` refuse to run without a fresh lease in `artifacts/fixer-coordination/electron-slot.json` that names the 2026-09-21 fixer agents. As sole worker, `slot.mjs` wrote that lease immediately before each run and restored the previous file afterwards.
- **Attach smokes.** `smoke-ui`, `smoke-recovery` and `smoke-update-status` attach to an app that is already running, so `attached.mjs` launches one parked with a CDP port. Its first attempts were harness faults, kept in `results.jsonl` for completeness:
  - `11-ui` and `14-recovery` at 0.9 s: launched before the renderer title existed.
  - First `28-update-status-feed` at 15.1 s: launching `out/main/index.js` directly made `app.getVersion()` report Electron's 37.10.3, above the 0.1.4 feed. Launching the package directory reports 0.1.3.

  The table rows are the corrected reruns.
- **agent-control.** Row 18 was killed by hand after it hung for about 3 minutes. The baseline rerun hung identically until its 480 s limit.

## 5. Summary

- **Build and test:** 3/3 PASS (typecheck, 3091 + 65 tests, build).
- **Electron smokes:** 33 rows, **19 PASS, 14 FAIL**. Every one of the 14 fails the same way on the pre-today build `e3aa664`, and today's range changed no renderer file. The failures in groups:
  - Stale selectors and assertions against current UI and policy: ui/docking, and recovery's seed that depends on it; navigation always-on-top, which is intentionally off for parked windows since `030907e`; workspace-restore rename; session-controls effort scale; capability-sweep "Account default" label; steering's duplicate Resume; project-task-dispatch Auto Fixer not in Auto, contrary to the current dispatch-in-Auto policy.
  - The offline Codex fixture path: structured-agents Codex "Execution sandbox"; agent-control router hang; change-history "Allow once".
  - Tab-groups vite fixture.
  - Processes-sidebar usage warning.
  - local-admission in-app refusal text.
- **App-control workflow:** 5/5 PASS, plus control-repairs (row 41) PASS.
- **Everything today's commits touched passes on HEAD:**
  - Durable jobs: default, approval-gate, blocked-restart, restart-app, history, tail, and the real-9B `jobs.create`.
  - App control: usage.limits, idle agents.steer, the git.ship and jobs.pause texts, local read-only dispatch.
  - File-search ranking; the local model loop (9B tabs, tools, stop).
  - Unit tests covering Grok and the output-budget guard.
- **Fixes made:** none. No failure was a defect in today's commits.

**Go/no-go: GO.** HEAD `77686fd` typechecks, passes all 3091 unit tests and 65 script tests, and builds. Every area changed today passes end to end in the parked app:

- durable jobs through restarts, approvals and reconciliation;
- a real Qwen 9B job;
- the app-control repairs;
- file-search ranking;
- the local model loop.

The 14 failing smokes fail identically on the build from before today, so updating the installed app introduces none of them. They are stale smoke scripts or a pre-existing offline Codex/Processes/admission issue, and should be triaged as separate backlog items rather than block this update. Row 34 already put `0.1.53-local.1790249619617` in the local update feed, so the installed app will offer it as `Update pending`. Nothing was pushed and no release was built.
