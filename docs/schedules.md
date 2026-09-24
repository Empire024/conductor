# Scheduled tasks

A scheduled task is recurring work the owner wants done without asking each time: gather
information, run some code, watch something for changes. An agent sets one up when the owner asks
("check the llama.cpp releases every night and tell me when one matters for us"), or the owner
creates it in the Scheduled tasks panel (left rail). Tasks belong to a project.

A task has:

- a **goal** (`prompt`): what to find out, check or keep an eye on;
- an **assigned agent** (provider, model, effort): the agent that writes the task's scripts and
  answers its small review requests;
- **scripts** the agent wrote: deterministic checks that gather the evidence;
- a **cadence** (`everyMinutes`), a **timing** (`night` or `idle`) and an **urgent** flag;
- a **churn model**: the local model that summarizes changes (null = the first configured one);
- a history of **runs**, each with per-script results, the local summary, the agent's answer and a
  saved report.

Code: `src/shared/schedules.ts` (contract), `src/main/schedule-store.ts` (SQLite, migration),
`schedule-runner.ts` (when), `schedule-gate.ts` (smart scheduling), `schedule-executor.ts` (what a
run does), `schedule-scripts.ts` (script execution), `schedule-churn.ts` (local model),
`schedule-agent-turn.ts` (bounded frontier request), `schedule-control.ts` (app control),
`schedule-ipc.ts` + `schedule-wiring.ts` (panel and host wiring), `schedule-builtins/` (tasks
Conductor ships), `src/renderer/src/components/SchedulesPane.tsx` + `schedules/` (panel).

## What a run does

1. The task's scripts run in order, each with the project folder as its working directory, a
   timeout (default 120 s, at most 20 min) and a 256 KB output ceiling. A script is stored text
   with a recorded sha256; it is written to a fresh file for every run and refused if the text no
   longer matches its digest.
2. Each script's stdout is normalized and digested. When **every** script printed exactly what it
   printed last time, the run ends: outcome `unchanged`, no model is asked anything. This is what
   keeps a nightly task free when nothing happened.
3. A script whose output changed, or that failed (non-zero exit, timeout, invalid JSON for a
   `json` script, oversized output), is evidence. Scripts with `runWhen: "changed"` (tests, other
   expensive checks) only run in a run where an earlier script already moved.
4. **Churn**: the local model summarizes the changed lines against the goal (at most 12 bullets).
   Without a local model the plain line diff stands in.
5. **Brain**: when the task has a non-local assigned agent with review on (`brain`), the summary
   and a bounded slice of the evidence go to it as one request: a fresh conversation in its
   least-writing mode (Codex read-only, Claude "ask", browser tools off), any tool approval it asks
   for denied at once, stopped after 10 minutes. Its answer is the run's result. The conversation
   is archived afterwards and opens from the panel. A provider whose allowance is 80% or more used
   (`usage.limits`) is not asked; the local summary stands in.
6. A Markdown report and a JSON record are saved in `%APPDATA%\Conductor\schedule-evidence`
   (the newest 100 files per task are kept). New digests are committed last, and only when a
   wanted review succeeded, so a review that failed is retried on the next run.

A task with no scripts is a standing question: its agent answers the goal each run, bounded the
same way. A local agent with no scripts may search the web; nothing else it does writes.

### Script contract

- `node` scripts run as ES modules (`.mjs`, built-in modules only) with the owner's `node`, or
  Electron as Node when none is on PATH; `powershell` scripts run as `.ps1` with
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.
- stdout is the evidence: print a compact, deterministic summary (no timestamps or durations,
  sorted). stderr is diagnostics only. Exit 0 means valid.
- Environment: the app's environment plus `CONDUCTOR_SCHEDULE_TASK_ID`,
  `CONDUCTOR_SCHEDULE_PROJECT_DIR`, `CONDUCTOR_SCHEDULE_STATE_DIR` (persists between runs: caches,
  ETags), `CONDUCTOR_SCHEDULE_RUN_DIR` (earlier scripts' stdout of this run as `<name>.out`),
  `CONDUCTOR_SCHEDULE_CHANGED` (`1` once an earlier script changed or failed), and
  `CONDUCTOR_CLAUDE_PATH` / `CONDUCTOR_CODEX_PATH` (the CLIs the tabs use).
- At most 12 scripts of at most 64 KB per task; names are 1-48 lower-case letters, digits and
  hyphens.

## When a run starts (smart scheduling)

`src/main/schedule-gate.ts` holds every threshold and the detection, with tests. The runner ticks
every 30 s; when a task is due it measures the machine once (two samples four seconds apart) and
asks the gate. A refused run is not recorded as a run: the task shows why it waits
(`deferredReason`, first `deferredAt`), and the gate says when to look again (five minutes, or the
next night window).

- **The owner comes first.** A non-urgent task never runs while the owner is using the computer:
  last keyboard/mouse input under 10 minutes ago and the screen not locked.
- **Night.** `night` tasks wait for 01:00-06:00 local time. One overdue by 24 h may run in any
  idle window instead, so a machine switched off at night still gets its checks.
- **Busy machine.** Deferred while a smoke test holds its lock, a delivery (tests and build) or a
  local update build runs, a Conductor conversation is mid-turn, an overnight durable job runs
  (unless overdue by 24 h), machine CPU is at 30% or more, a GPU at 40% or more, a known heavy app
  (Blender, Houdini, Maya, Unreal, Unity, DaVinci Resolve, After Effects, Premiere, OBS, HandBrake
  and others) is using CPU or holds 1 GB+ of VRAM, or any other single process uses 15%+ of the
  machine.
- **Urgent** tasks run when due even while the owner works; they still wait for a smoke test and
  for a saturated CPU (85%+).
- One run at a time, whatever the project. **Run now** (panel or `schedules.runNow`) skips the
  wait but never runs beside another scheduled run.

## Models

- **Local churn** (`schedule-churn.ts`) follows docs/machine-profile.md: one llama.cpp server at a
  time. A server that is already loaded is used whatever model it holds, and never switched. With
  none running, the task's churn model (or the first configured one) is started through the same
  admission-locked start path as a local tab, and stopped again afterwards if nothing else started
  using it. Generation takes the process-wide local generation gate, so it queues behind a durable
  job's turn and yields to an interactive one. Nothing is ever downloaded.
- **Frontier brain** requests are small by construction: one turn, bounded evidence (12 KB), an
  answer of at most about 400 words, no tools.

## App control

An agent reaches tasks through `schedules.*` (listed by `tools.list`; see docs/agent-control.md):
`list`, `get`, `create`, `update`, `pause`, `resume`, `runNow`, `delete`, `scripts.save`,
`scripts.delete`. A new task defaults to the calling agent as its assigned agent and is due at
once, so it runs in the first allowed window. Reading is open to the project; pausing, resuming
and running now to any writable non-local conversation; changing the goal, agent or scripts to the
owner, a wizard tab, or the task's maintainer (its creator, or the conversation the owner assigned
its scripts to with **Assign agent to write scripts** in the panel, which opens that agent in a
visible tab with a brief). Deleting asks the owner unless the owner or a wizard tab asks. A
sandboxed local model changes nothing here: a script is host code that runs unattended.

## Built-in: latest models and CLI compatibility

Seeded once for the Conductor checkout's project (`package.json` name `conductor-desktop`); the
owner's changes to it are kept, and its Conductor-written scripts are replaced when a newer build
ships different ones. It can be paused, not deleted. It is the migrated form of the first
schedule, a fixed `latest-models-methods` job that only reported word-level page diffs; the
migration (`ScheduleStore.rebuildLegacySchedules`) keeps its id, cadence, enabled state and whole
run history.

Its scripts (`src/main/schedule-builtins/latest-models/`) ask, without any inference turn, what the
installed Claude Code and Codex advertise (`initialize`, `model/list`), read Conductor's pins in the
checkout (`CLAUDE_MODELS`, `CODEX_MODELS`, `GROK_MODELS`, `CLAUDE_COMPATIBILITY`,
`CODEX_PROTOCOL_BASELINE`, capability fixtures, other hard-coded model ids), extract the model ids
the primary sources list (OpenAI and Anthropic model pages, the llama.cpp release, the pinned Qwen
repository; conditional requests, pinned origins, no redirects, 256 KB cap), and compute concrete
findings such as "Claude Code 2.1.281 resolves opus[1m] to claude-opus-5-5[1m]; CLAUDE_MODELS
labels it …; edit src/main/agent-manager.ts". When a finding moved, the relevant offline tests run
and the assigned agent (Claude Opus by default) gets the report for one bounded review.
