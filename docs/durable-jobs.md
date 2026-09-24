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

`blocked` means the job needs the owner: an approval it may not grant itself (a step the sandbox
refused twice, such as a network install), exhausted stage attempts, a loop the guard stopped after
its one replan, a server that did not come back, or the elapsed-time budget (`maxElapsedMs`; a
resume restarts that budget). Read `statusReason` and the latest events, then either fix
the cause (grant the approval, adjust the project) and *Resume*, or *Cancel*. A cancelled job keeps
its worktree, checkpoints and logs; start a new job from the report's remaining work. A job never
escalates to a cloud model to get unstuck; handing a stage to a cloud coworker is the owner's call.

## Dependencies in a job worktree

A job on a repository works in its own `git worktree`, which holds committed files only. A Node
project's `node_modules` is git-ignored, so the worktree starts without it and `npm test` or a
build there fails with "module not found". `gitWorktrees.create` (`src/main/durable-jobs/worktree.ts`)
checks every `package.json` folder (repository root and the job's project folder) and returns the
result in `worktree.dependencies` (`mode`, `status`: `ready` / `copied` / `missing`, `note`).

- **Default: nothing is provisioned, never a link.** A junction or symlink to the owner's
  `node_modules` would let an `npm install`, a `patch-package` or a build cache write straight into
  the owner's tree, which defeats the isolation the worktree exists for, and electron-builder drops
  packages it reaches through a junction (`docs/machine-profile.md`). A hard-link farm has the same
  write-through problem for any tool that rewrites a file in place. `dependencies.note` says why
  tests cannot run and what unblocks them: install in the worktree (`npm ci`, which needs network
  and the owner's permission) or opt in to a copy.
- **Opt-in: a private copy.** `.conductor/durable-jobs.json` in the project folder with
  `{"worktreeDependencies":"copy"}` makes job creation copy the project's `node_modules` into the
  worktree as real files. Links inside it are skipped, not followed, so nothing in the copy points
  back into the owner's tree. The copy is made only where git ignores `node_modules`, so a
  checkpoint commit can never pick it up; otherwise the note says it was refused. It reflects the
  owner's install when the job started. Cost on this machine: Conductor's own 724 MB
  `node_modules` copies in about 18 s, and vitest runs from the copy.
- The setting is read when the job is created; changing it affects the next job.

The note must reach the stage prompt and the job's events to be useful: `index.ts` is expected to
record `worktree.dependencies.note` as a creation note and a handoff constraint (see
`docs/autopilot-evidence/review-item-9.md` for the state of that hook).

## Checkpoints in a folder without git

A job on a folder without git (or with isolation off) works in place, and each checkpoint is a
snapshot of the whole folder, not only the files the model reported changing: a file a shell
command or a test run created is captured too. Contents go into a content-addressed store shared by
the job's snapshots (`<logDir>/checkpoints/objects/`), so an unchanged file is stored once and is
not re-hashed when its size and mtime match the previous snapshot. `manifest.json` is written last
and lists every file with its sha256, the files reported changed, and what was skipped.

- Skipped: links (never followed), `.git`, `.hg`, `.svn`, `node_modules`, `.venv`, `venv`,
  `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.tox`, `.cache`, and files over 50 MB. A
  snapshot stops capturing at 20,000 files or 2 GB and marks itself `truncated`.
- `gitWorktrees.restore(directory, cwd?, {prune?})` verifies every stored copy against the manifest
  before it touches the folder, then rewrites each file whose content differs. With `prune` it also
  deletes files the snapshot did not have (skipped folders and over-size files are left alone); a
  truncated snapshot refuses to prune. Snapshots written in the earlier `files/` layout still
  restore. No automatic step calls restore; it is the owner's (or a tool's) explicit rollback.

## How the parts are wired

`src/main/index.ts` builds the service; `src/main/durable-jobs/wiring.ts` adapts the modules to the
controller's ports:

- **Stage prompt**: `buildStagePrompt` from the persisted handoff, budgeted against the live model's
  window with the stage kind's system prompt and tools (`stagePromptBudgetTokens` overrides the
  default ceiling); a stage whose fixed part does not fit blocks the job. The prompt ends asking for
  `JOB STATUS: DONE` or `JOB STATUS: CONTINUE: <next>`; a CONTINUE with no planned stage left appends one.
- **Stage kind** (`plan`, `investigate`, `implement`, `verify`, `research`, `report`; inferred from
  the title when not given) sets the stage conversation's mode: read-only kinds open read-only,
  coding kinds get the coding tool set. No grant is widened.
- **After a stage**: `extractHandoff` from the stop report; tests become events with `data.test`;
  a stage whose context passed `contextRolloverFraction` counts a rollover.
- **Watchdog and loop guard** read the stage conversation every 15 s: new events are progress,
  finished tool calls feed the loop guard. A loop replans once (the retry prompt carries the
  instruction), a second one blocks; a step refused twice blocks for the owner; a stalled call on
  a server that is not processing is interrupted.
- **Server**: one `ServerSupervisor` per model over `startServer`; it never stops a model someone is
  using and switches an idle Conductor-started one only after 10 quiet minutes.
- **Generation gate**: one process-wide `LocalGenerationGate`; a stage does not start while an
  interactive local turn is in flight. A running stage is not cut short: llama-server's single
  slot serves requests in order, so an interactive turn waits at most for the job's current request.

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
  on loopback and passes it as `CONDUCTOR_DURABLE_JOBS_MODEL_ENDPOINT`; an unpackaged build then
  sends every local conversation there and starts no llama-server (a packaged app ignores it).
- `--real-model[=local/qwen3.6-35b-a3b]` — the real server Conductor manages.
- `--kill-server` (with `--real-model`) — kills `llama-server.exe` mid-stage and expects recovery.
- `--restart-app` — closes and relaunches the app on the same profile mid-job.
- `--keep` — keeps the temp profile and project.
- `--fixture=crossref` — six large modules summarised and cross-referenced over four stages, so
  the job advances through several fresh contexts; `--extras=none` stops after its report.
  `DURABLE_SMOKE_STAGE_TIMEOUT_MS` raises the settle wait for a slow real model.
