# Overseer

`scripts/overseer.mjs` is an unattended supervisor for goals that need the whole app: a local model solving a real file task, a tool-call format a model gets wrong, anything a unit test cannot show. It runs **outside** Conductor as a plain `node` process, so it survives the app restarting under it, and drives Conductor through the loopback app-control endpoint with an owner credential.

One run is a loop:

1. launch or verify the target app;
2. run each goal: prepare its project folder, open a worker tab, submit the prompt, wait for it to settle;
3. collect evidence and evaluate the goal's success predicate;
4. for each failed goal, open a Claude Opus **fixer** tab in Conductor with the evidence, and wait for it to fix, test and commit;
5. `npm run build`, relaunch the target, retest only the goals that failed;
6. repeat until every goal passes or the iteration budget runs out; optionally deliver the passing checkout to the installed app.

The code is small modules under `scripts/overseer/` (credentials, control client, dev instance, goal, evaluation, evidence, fixer, loop, delivery) with every effect behind an interface, so `node --test scripts/overseer.test.mjs` covers the loop without Electron.

## The owner credential

When its control server starts, the app writes `<userData>/control-owner.json`:

```json
{"version":1,"endpoint":"http://127.0.0.1:PORT/control","token":"<hex>","pid":12345,"startedAt":"<ISO>","appVersion":"0.1.x","packaged":true}
```

and deletes it on close. The installed app's userData is `%APPDATA%\Conductor`; a dev instance's is whatever `CONDUCTOR_TEST_USER_DATA` was at launch (the overseer uses `artifacts/overseer/profile`). A file whose `pid` is no longer running is stale and ignored.

**Anyone who can read that file has the owner's authority over the app**: no confirmation dialogs, coworkers on Auto, app updates and restarts. Never print, paste, log or commit the token; the overseer reads it, keeps it in memory and never writes it anywhere. Do not copy the file.

Requests are `POST <endpoint>` with `Authorization: Bearer <token>` and a body `{"method","args","scope":{"projectId","workspaceId"}}`; replies are `{"result"}` or `{"error"}`. The overseer queues its calls so one app never sees two at once.

## Targets

- **dev** (default): a parked instance of the checkout's `out/` build with its own profile (`artifacts/overseer/profile`) and projects root (`artifacts/overseer/projects`), launched with `CONDUCTOR_BACKGROUND_WINDOWS=1` so its window stays off every display and never takes focus. It can be killed and relaunched after every fix without touching the owner's open work, and its projects are fresh copies of the goal's inputs each iteration. This is why it is the default for iterating.
- **installed**: the owner's running app and the goal's real project folder. Use it to confirm on the real install. A fix only reaches it through `app.update`, so iterating on it needs `--restart-installed` (the overseer then builds the local update, installs it with a forced restart and waits for the app to come back).

Fixers open in `--fixer-target`: `auto` (default) picks the installed app when its credential answers, else the dev instance. The fixer's scope is always the Conductor checkout project.

Before a dev launch the overseer warns when `out/main/index.js` is older than the newest file under `src/`; `node scripts/overseer.mjs build` rebuilds. A dev instance still running from an earlier command is reused if it started after the last build.

## Commands

```
node scripts/overseer.mjs run --goal <file> [--goal <file>...] [--target dev|installed] [--fixer-target auto|dev|installed]
                              [--iterations 5] [--fixers 4] [--deliver] [--restart-installed] [--no-fix] [--run-dir <dir>] [--keep-app]
node scripts/overseer.mjs test --goal <file> [--target ...]        one pass, no fixing
node scripts/overseer.mjs status [--target ...]                    reachability, version, projects, working agents
node scripts/overseer.mjs app start|stop|restart                   the parked dev instance
node scripts/overseer.mjs call --method <m> [--args <json>] [--scope <json>] [--project <path-or-name>] [--target ...]
node scripts/overseer.mjs build                                    npm run build in the checkout
node scripts/overseer.mjs deliver [--restart-installed]            app.update on the installed app, then optionally install
```

`run` and `test` stop the dev instance at the end unless `--keep-app`. `call` is for an agent driving the loop by hand: one raw owner call, JSON on stdout.

Exit codes: **0** pass, **1** fail (a goal failed under `test` or `--no-fix`, a build or delivery command failed), **2** blocked (a fixer reported `blocked`, the iteration budget ran out, the app was unreachable, a goal file could not be loaded, or the run was interrupted).

## Goal files

Goals live in `scripts/overseer/goals/`. Example (`local-qwen-faktury.json`):

```json
{
  "id": "local-qwen-faktury",
  "title": "Local model reconciles invoice payments without interruptions",
  "project": { "name": "faktury", "path": "C:/Users/stilj/Conductor/faktury", "inputs": ["data.csv", "data2.txt"] },
  "worker": { "provider": "local", "model": "local/ornith1.5-9b", "permission": "accept-edits" },
  "prompt": "Check data2.txt -> find these payments in data.csv and give me the exact dates for each.",
  "timeoutMinutes": 25,
  "success": {
    "phases": ["completed"],
    "stopReasons": ["completed"],
    "answerMatches": ["Validated \\d+ targets"],
    "answerRejects": ["Could not complete the task"],
    "requireValidatedArtifact": true,
    "maxLoopWarnings": 2,
    "oracle": "scripts/overseer/oracles/faktury.mjs"
  },
  "fixer": { "provider": "claude", "model": "opus", "project": "C:/Claude/conductor", "focus": ["src/main/local-models/"], "notes": "..." }
}
```

- `project.inputs` are the only files copied into the dev project folder (`<projects root>/<project.name>`, recreated each iteration). The installed target uses `project.path` itself and changes nothing in it.
- `worker`: a `local` worker needs `permission: "accept-edits"`.
- `success` (every listed check must hold):
  - `phases`: the settled `agents.status` phase (default `["completed"]`);
  - `stopReasons`: the local stop report's reason (a missing report fails);
  - `answerMatches` / `answerRejects`: regular expressions over the final answer (assistant text after the last user message);
  - `requireValidatedArtifact`: a completed `process_files` tool call whose output is the JSON `{result:{outcomes:[...]}}`, with no outcome `blocked`; outcome counts by status are recorded either way. History carries only the tail of a large output, so the full text is fetched with `agents.artifact` first;
  - `maxLoopWarnings`: upper bound on the stop report's loop warnings;
  - `oracle`: optional module exporting `evaluate({goal, projectPath, answer, status, events, artifact}) -> {pass, notes}`. A missing file is skipped with a note. `oracles/faktury.mjs` requires one outcome per invoice line of `data2.txt` (tab-separated lines with at least four cells).
- `fixer`: `model` is used when the Claude catalog lists it exactly, else the first id containing `opus`, else the default; `focus` and `notes` go into the fixer's brief; `timeoutMinutes` defaults to 60.

## Fixer contract

A fixer is an ordinary Claude tab titled `Overseer fixer: <goal> #<n>`, opened unfocused in the checkout project and running on Auto. Its brief names the goal and worker, the predicate failures, stop reason and figures, loop warnings, last error, the last 600 characters of the answer, oracle notes and the evidence paths, and requires it to:

- read `AGENTS.md` and this file first;
- fix the root cause in the checkout (never the goal or its oracle), add or adjust tests, run the relevant vitest files;
- never run `npm run dev`, launch the app or start a local model; the overseer rebuilds and retests;
- deliver with `git.ship({message, paths:[<its files>]})` and wait on `git.ship.status` until it settles; never publish, push or tag;
- leave other fixers' work alone (up to `--fixers` run in the same checkout at once, one per failed goal);
- end its final message with exactly one line:

```
OVERSEER_RESULT: fixed <short summary>
OVERSEER_RESULT: blocked <what only the owner can decide>
OVERSEER_RESULT: no-change <why>
```

The overseer polls `agents.status` every 10 s, reads the marker from `lastAnswer` or, failing that, the latest assistant text in `agents.history`. A `fixed` claim without `git rev-parse HEAD` moving counts as `no-change`; no marker counts as `no-change`; a timeout interrupts the tab and counts as `blocked`. Any `blocked` ends the run with exit 2. When no fixer changed anything, the overseer retests without rebuilding. A failed build does not end the run: its log tail becomes the next iteration's failure, handed to a fixer.

## Evidence and run state

```
artifacts/overseer/runs/<YYYYMMDD-HHMMSS>-<goal ids>/      (or --run-dir)
  run.json                     rewritten after every step; outcome, exitCode, summary at the end
  app-<n>.log                  dev instance stdout/stderr per launch
  build-<n>.log                npm run build output
  iteration-<n>/<goal id>/
    status.json                settled agents.status
    events.jsonl               every agents.history event
    timeline.md                one line per event: time, type, tool name/status, input (<=300 chars), output (<=1200 chars), text, notices, errors
    answer.md                  final answer
    evaluation.json            {pass, failures, counts, oracle}
    server-log-tail.txt        last 200 lines of <local root>/logs/<model id>.log, local workers only
```

`run.json` holds `{goals, target, iterations:[{n, results:{<goal>:{pass, failures, agentSessionId, tabId, evidenceDir, counts, stop}}, fixers:[...], build, reload}], outcome}`, so anyone can follow a run while it is going. A crash still writes it with `outcome: "error"` and the stack; Ctrl+C writes `outcome: "interrupted"`. The local root comes from `CONDUCTOR_LOCAL_ROOT`, `.local-models/root.json` in the checkout, or `%USERPROFILE%\.conductor\local-root.json`.

## Running it visibly from a wizard tab

The dev target is invisible by design. To watch the swarm in your own Conductor, turn the wand on in a frontier-model tab (Claude Opus or Fable, GPT-6 Astra) and ask it to run the loop with `--target installed`: the worker and fixer tabs then open in the owner's window, the wizard tab answers its coworkers' approvals, and `app.update` plus `--restart-installed` land the fix in the running app. The wizard tab is brought back after that restart and told to continue, so it can read `run.json` and carry on. Start the overseer detached all the same (below), because the tab's own shell dies with the app; the wizard's job is to launch it, watch it, and take over when it stops.

## Starting it from an agent inside Conductor

A Conductor tab dies when the app restarts, and the overseer may restart the app (always with `--restart-installed`, and a dev fixer tab lives in the dev instance). Start it detached from a plain process, never as a foreground command of your own tab:

```powershell
Start-Process node -WorkingDirectory C:\Claude\conductor -WindowStyle Hidden `
  -ArgumentList 'scripts/overseer.mjs','run','--goal','scripts/overseer/goals/local-qwen-faktury.json','--run-dir','artifacts/overseer/runs/faktury-1' `
  -RedirectStandardOutput artifacts\overseer\faktury-1.out.log -RedirectStandardError artifacts\overseer\faktury-1.err.log
```

Then follow `run.json` and the `.out.log`. Pass an explicit `--run-dir` so you know where to look.

## Safety rules

- Never over the owner's screen: the dev instance is always parked (`CONDUCTOR_BACKGROUND_WINDOWS=1`), worker and fixer tabs open with `focus:false`, and nothing here runs `npm run dev`.
- One local model at a time (`docs/machine-profile.md`): goals run one after another, never in parallel, and only one overseer run with local workers at a time.
- Builds and smokes one at a time: the overseer builds once per iteration, after all fixers finish. Do not start a smoke script or another overseer while one is running.
- Fixers never publish. Delivering to the installed app (`--deliver`, `deliver`) is a local `app.update` into the local feed; restarting the installed app only happens with `--restart-installed`.
- The credential is the owner's authority: keep it on this machine, in memory, out of every log and message.
