# Durable local-model jobs

A durable job is overnight work for a local model (Qwen on llama.cpp): the owner states an
objective, leaves Conductor open, and in the morning reads a short factual report. The job is the
stable unit; each stage runs in a fresh local-model context rebuilt from the persisted handoff, so
no single conversation has to survive the night.

Contract: `src/shared/durable-jobs.ts`. Controller and store: `src/main/durable-jobs/`. Control
methods: `src/main/agent-control.ts` (`jobs.*`). IPC: `src/main/durable-jobs-ipc.ts`,
`src/preload/durable-jobs.ts`, `src/shared/durable-jobs-bridge.ts`. View:
`src/renderer/src/components/DurableJobsPane.tsx`. Report: `src/main/durable-jobs/report.ts`.

## Creating a job

**In the app.** Open *Durable jobs* on the activity rail (hourglass). Enter the objective, pick a
local model (only local entries are offered), optionally a title and one constraint per line, and
press *Start job*. The panel lists every job of the project; selecting one shows its status,
elapsed and active time, current stage and attempt, milestones, recent checkpoints with their
commit, the model used by each stage, retries, errors and recoveries, and Pause, Resume and Cancel.
*Tab* opens the same view as a workspace tab.

**Over the control protocol.** `tools.list` shows `jobs.*` once the job controller is running.

```json
{"method":"jobs.create","args":{"objective":"Make the invoice parser accept Fio exports","model":"local/qwen3.6-35b-a3b",
  "constraints":["Only edit src/parser/"],"stages":[{"title":"Reproduce","objective":"Add a failing test","completionCriteria":["test fails"]}]}}
```

Then `jobs.status({jobId})` (poll this), `jobs.events({jobId, afterId?, limit?})`,
`jobs.pause({jobId, reason?})`, `jobs.resume({jobId})`, `jobs.cancel({jobId, reason?})`,
`jobs.report({jobId})`, and `tabs.open({kind:"job", jobId})` to show it.

Who may do what:

| Caller | create | pause / resume / cancel | list / status / events / report |
| --- | --- | --- | --- |
| Owner credential (`control-owner.json`), wizard tab | yes | any job of the project | yes |
| A writable, non-local conversation | yes | jobs it created | yes |
| A read-only or planning conversation | no | no | yes |
| A local model | no | no | yes |

A job runs on the local model it was created with. `jobs.create` accepts only a local entry of
`models.list` and has no provider or escalation argument; no caller can move a job to a cloud
model, and the report says `cloudEscalation.occurred: false` unless an escalation was recorded.
Another project's job reads as missing.

## What survives what

| Event | Job | View |
| --- | --- | --- |
| Close the job tab or the panel | keeps running | reopen shows the same job (identity is the job id) |
| Split, move or detach the tab | keeps running | same job |
| Renderer reload | keeps running (it lives in the main process) | job tabs are restored with their job id |
| llama-server crash or restart | the watchdog restarts the server and retries the stage within its attempt budget; a `server`/`recovery` event is recorded | shows the recovery |
| App restart | the store is on disk; on launch the controller reconciles in-flight operations from the operation journal and continues from the last checkpoint | tabs come back |
| Reboot or sleep | as an app restart once Conductor runs again; the wall-clock gap counts as elapsed, not active | — |

Elapsed time is wall clock since the job started; active time excludes paused and blocked spans.

## Logs and reports

Every job has a `logDir` (shown in the view and in the `logPaths` of `jobs.report`). *Logs* in
the view reveals it in the file manager. `jobs.report` (or *Write report*) writes `report.json` and
`report.md` into `logDir`: status and reason, elapsed and active time, local model, models by
stage, files changed, results, tests and outcomes, git checkpoints, recoveries, remaining work,
cloud escalation, and log paths. The report lists paths; it never pastes log contents. An interim
report can be written at any time.

## Recovering a blocked job

`blocked` means the job needs the owner: an approval it may not grant itself, exhausted stage
attempts, or a loop the guard stopped. Read `statusReason` and the latest events, then either fix
the cause (grant the approval, adjust the project) and *Resume*, or *Cancel*. A cancelled job keeps
its worktree, checkpoints and logs; start a new job from the report's remaining work. A job never
escalates to a cloud model to get unstuck; handing a stage to a cloud coworker is the owner's call.

## Limits

- One local model server at a time on this machine (`docs/machine-profile.md`); jobs queue behind it.
- `jobs.events` returns at most 200 events per call; page with `afterId`.
- A stage retries at most `budgets.maxStageAttempts` times (default 3) before the job blocks.
- The view refreshes on every persisted change; it does not stream model output (open the
  stage's conversation for that).

## Smoke

`scripts/smoke-durable-jobs.mjs` drives the built app parked off-screen
(`CONDUCTOR_TEST_USER_DATA`): creates a job as the owner, closes/reopens its tab and reloads the
renderer while it runs, pauses, resumes, cancels, and checks that an approval-gated step ends in
`blocked`. Build first (`npm run build`), one smoke at a time.

- `node scripts/smoke-durable-jobs.mjs` — stub model. The script serves an OpenAI-compatible stub
  on loopback and passes it as `CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT`; the controller must use
  that endpoint instead of starting llama-server when the variable is set in an unpackaged build.
- `--real-model[=local/qwen3.6-35b-a3b]` — the real server Conductor manages.
- `--kill-server` (with `--real-model`) — kills `llama-server.exe` mid-stage and expects recovery.
- `--restart-app` — closes and relaunches the app on the same profile mid-job.
- `--keep` — keeps the temp profile and project.
