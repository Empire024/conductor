# Startup diagnostics and the repair ladder

Owner, 2026-10-22, after the morning's outage: "we should realistically have some sort of a car
diagnostic system almost when starting, where the low effort meta wizard is above it in like a
standalone powershell that can't crash at all, and the meta wizard can get a higher effort agent to
fix the release if something happened. Or just restart again, etc. Point is if we have work running
and it ever doesn't turn back on or crashes we need to have it under control."

## What went wrong on 2026-10-22

After the 09:22Z install every launch died about four seconds in with `OOM error in V8 ... JavaScript
heap out of memory` at ~3.9 GB: `StructuredAgentStore` parsed all 1,666 conversation projections
(1.27 GB of JSON) at construction (docs/conversation-residency.md, a4c6427, 350d565).

- The recovery watchdog relaunched twice; both died. Its read-only `claude -p` agent found the
  OOM, rolled back to the previous build (which died the same way: a data-scale problem, not a
  build problem) and wrote a good diagnosis, but it may not edit code, so it stopped there.
- The meta-wizard started Conductor three times, its crash-loop guard stood down for 30 minutes,
  started it three more times, stood down again, for three hours. Each alert said "exited with
  code 4294930435" and nothing about where or why.
- Nothing fixed it until the owner opened a session by hand at 12:00Z.
- Every acceptance smoke runs on a small test profile; none could see a problem that only appears
  at the owner's data size.

Three gaps, three parts:

1. **Where and why** a start failed was only in a V8 trace in a launch log. Conductor now records
   every boot stage as it goes, so any failed start reads as one line: *died in stage
   `structured-store` 4.1 s after start: V8 heap out of memory (heap 3.9 GB of a 4.0 GB limit)*.
2. **Nobody above the read-only agent could fix code.** The meta-wizard climbs a ladder: restart,
   roll back to the previous known-good build, and when the rollback fails the same way (data or
   environment) or the crash-loop guard trips, a high-effort repair agent that may edit, test,
   build and install from its own worktree.
3. **Small profiles hide data-scale failures.** Every `app.update` candidate now boots on an
   owner-scale synthetic profile before it can be offered.

## 1. Boot diagnostics (the app)

`src/main/boot-diagnostics.ts`. The main process records each boot stage synchronously the moment
it begins, so a process that dies inside a stage (an OOM leaves no JavaScript running to say so)
has already named it.

### Files, under `<userData>/diagnostics/`

- **`boot.json`**: this launch's record, rewritten whole at every stage (`writeFileSync` to a
  temporary file, then `renameSync`; a reader never sees half a file). Small and bounded: at most
  40 stages, 5 errors, messages clipped to 500 characters; well under 16 KB.

  ```jsonc
  {
    "schema": 1,
    "pid": 68968,
    "version": "0.1.59-local.1792679313032",
    "packaged": true,
    "exe": "C:\\...\\Conductor.exe",
    "startedAt": "2026-10-22T09:26:00.912Z",   // process start (performance.timeOrigin)
    "heapLimitMb": 4096,                         // v8 heap_size_limit
    "stage": "structured-store",                 // the last stage begun
    "stageAt": "2026-10-22T09:26:01.640Z",
    "outcome": "booting",                        // booting | ready | failed
    "readyMs": null,                             // ms from start to ready, once ready
    "stages": [ { "name": "process-start", "at": "…", "ms": 0, "heapMb": 12, "rssMb": 70 }, … ],
    "peak": { "heapMb": 3905, "rssMb": 4210 },
    "errors": [ { "at": "…", "stage": "settings", "kind": "unhandledRejection", "message": "…" } ],
    "fatal": null                                // { at, stage, kind, message, heapMb, rssMb } when JS saw it
  }
  ```

- **`boot-sample.json`**: written by a small sampler worker thread every 500 ms while the launch
  boots (until ready plus 30 s, at most 5 minutes): `{schema, pid, at, ms, rssMb, heapMb,
  mainBeatAgoMs, stage}`. The main thread publishes its heap use, stage index and a heartbeat into a
  `SharedArrayBuffer` at each stage and every 250 ms, and the worker writes them out. A worker runs
  while the main thread is stuck in one synchronous parse, so a process that is filling its heap
  in a single call still leaves a trace that says so (`mainBeatAgoMs` rising, `heapMb` near the
  limit).
- **`boot-history.jsonl`**: one summary line per launch (`{pid, version, startedAt, outcome, stage,
  ms, peakHeapMb, cause}`), appended when a launch becomes ready, and for a launch that never did,
  by the next launch when it finds the previous `boot.json` still `booting` with a dead pid.
  Trimmed to the newest 50 lines whenever it passes 100.
- **`boot-last-failure.json`**: a copy of the last `boot.json` that never reached ready (written by
  the next launch), so a crash loop keeps the first failure's evidence.

Only a launch that holds the single-instance lock writes these. A second `Conductor.exe` that hands
over to a running one and exits never touches them.

### Stages

Each name is recorded when that stage **begins**; "died in stage X" means X began and nothing after
it did.

| stage | where |
| --- | --- |
| `process-start` | module load (recorded retroactively when the lock is held, `ms` from `performance.timeOrigin`) |
| `single-instance` | the lock is held |
| `app-ready` | `app.whenReady()` resolved |
| `db-open` | `new ConductorDatabase` opens `conductor.db` |
| `db-migrations` | schema migrations |
| `structured-store` | `new StructuredAgentStore` (the 2026-10-22 failure) |
| `settings` | approval policy, settings, login item, interrupted runtimes, stores |
| `services` | source control, agents, browser, phone, schedules, production |
| `control-api` | `AgentControlServer.start()` |
| `control-ready` | `control-owner.json` written, app control answers |
| `runtime-reattach` | kept runtimes are rebound |
| `runtime-host` | the runtime host is started |
| `windows` | windows are created |
| `ready` | the first window finished loading after `control-ready`: `outcome: "ready"` |

### Errors and fatal

- `uncaughtException` and `unhandledRejection` during boot are recorded in `errors` with the stage
  (the installed app keeps running after one, `main-error-log.ts`, so such a launch is *stalled*,
  not dead; the record says which stage stalled and after what error).
- `process.on('exit')` before ready records `fatal: {kind: 'exit', message: 'exit code N'}`.
- A V8 out-of-memory abort runs no JavaScript. The reader infers it: the record is `booting`, the
  pid is gone, and the launch log says `JavaScript heap out of memory` / `OOM error in V8`, or the
  exit code is a V8 fatal (`0xE0000008` = 3758096392, `4294930435`), or the last sample's heap was
  past 90% of the limit.

### The verdict (one line)

`bootVerdict({record, sample, alive, exitCode, log})` (pure; one copy in TypeScript for the
watchdog, `src/main/recovery/boot-verdict.ts`, and one in plain Node for the meta-wizard,
`scripts/meta-wizard/boot.mjs`, both tested against the same cases) returns:

```js
{ state: 'ready' | 'booting' | 'stalled' | 'died' | 'unknown',
  stage, cause: 'oom' | 'exception' | 'exit' | 'hang' | 'crash' | null,
  signature: 'died:structured-store:oom',   // compared across launches (part 2)
  line: "died in stage structured-store 4.1 s after start: V8 heap out of memory (heap 3.9 GB of a 4.0 GB limit, RSS 4.2 GB); Conductor 0.1.59-local.1792679313032, pid 68968" }
```

- `died`: the pid is gone and the record never reached ready.
- `stalled`: the pid is alive, not ready, and either a boot error was recorded or the stage has
  not changed for 2 minutes (`hang`; `mainBeatAgoMs` tells a blocked main thread from an idle one).
- No record for that pid: `unknown`, "died before writing boot diagnostics" (before the lock, or an
  older build), and the cause still comes from the exit code and log.

### Who reads it

- **Recovery watchdog** (`watchdog-main.ts`): after every relaunch attempt that fails, the attempt
  carries `boot` (the verdict line); the error, the report, the toast and the recovery agent's
  prompt (with `boot.json` and the last sample) carry it.
- **Meta-wizard**: every failed start's alert says the verdict instead of a bare exit code, and
  the ladder (part 2) compares signatures.
- **Smokes**: the owner-scale startup check (part 3) reads `readyMs` and `peak.heapMb`.

### Test knob

`CONDUCTOR_TEST_BOOT_FAIL=<stage>:<kind>` (or `CONDUCTOR_TEST_BOOT_FAIL_FILE=<path>` whose content is
`<stage>:<kind>`, read at each stage, so a smoke can "repair" the app by deleting the file), honoured
only with `CONDUCTOR_TEST_USER_DATA`. Kinds: `throw` (an uncaught exception in that stage), `exit`
(exit code 70), `hang` (the main thread blocks), `oom` (allocate until V8 aborts).

## 2. The meta-wizard's ladder

The meta-wizard stays plain, dependency-free Node under the scheduled task (docs/meta-wizard.md);
every effect is wrapped so nothing it does can end the loop, and the task starts it again within 5
minutes if anything does.

### Rungs

An **incident** opens when a start the meta-wizard makes fails (and on the crash-loop guard), and
closes when Conductor has answered for 10 minutes. Within one incident:

1. **Restart.** As today: start the installed exe, at most `restartAttempts` (2) times with the same
   failure signature on the same version (two failures without a signature count as the same).
   Each failure's verdict is recorded in the incident. A start whose process exited is given up
   `exitSettleMs` (10 s) after the exit instead of waiting the whole start window.
2. **Roll back** to the previous known-good restore point (`<userData>/local-updates/
   restore-points.json`): the newest point whose version is not the failing one, that ran on this
   machine (`firstLaunchedAt`), whose installer is still there, preferring `pinned`/`knownGood` and
   points without `crashCount`. Its installer runs silently (`/S`), then the exe is started. Skipped
   (straight to rung 3) when there is no such point.
3. **Repair agent** when:
   - the rolled-back build fails with the **same signature** (stage and cause), which says data or
     environment, not the build; or it fails again in any way;
   - or no restore point exists after the restarts;
   - or the crash-loop guard trips (in any incident).

   At most one repair at a time (`meta-wizard/repair/active.json` names the live runner), at most 2
   per 24 hours. While a repair runs, and for `repairAnswerGraceMs` (3 min) after the agent exits,
   the meta-wizard starts and kills nothing: the agent owns the app. After a repair: one plain
   start, then the repair rung again while the cap allows; with no rung left (`exhausted`), plain
   restarts go on under the crash-loop guard.
4. **No checkout** to repair from (`--checkout`, else the checkout `install` recorded in
   `service/VERSION.json`, else the script's own, else `armed.json` `checkout`; a test profile
   only ever uses `--checkout`): the owner gets one alert and restarts go on.

Each rung alerts the owner once (toast; phone push once the app answers), titled "Conductor did not
start" (body "Conductor did not start: <verdict>. Restarting (1 of 2)"), "Conductor: rolling back",
"Conductor: repair agent started", "Conductor repaired" ("Repaired: …") or "Conductor repair
failed" ("Repair failed: …").

### The repair agent

`scripts/meta-wizard/repair-run.mjs`, started detached by the meta-wizard so a 90-minute repair never
blocks a tick and survives a restart of the meta-wizard itself:

1. `git worktree add -b repair/<id> <checkout>/../conductor-repairs/<id> HEAD`, `<id>` the UTC
   minute `YYYY-MM-DD-HHmm` (`-2`, `-3` when taken)
   (a fresh worktree, never the shared main tree).
2. `robocopy` the checkout's `node_modules` into it, a real copy (a junction makes electron-builder
   drop dependencies, docs: local-update-from-worktree).
3. `claude -p --model opus --effort high --max-turns 300 --permission-mode acceptEdits`, cwd the
   worktree, prompt on stdin: the incident (every verdict, the ladder so far), `boot.json`,
   `boot-last-failure.json`, the last sample, launch log tails, the recovery report, the paths, and
   the rules below. Killed (whole tree) after 90 minutes.
4. Its stdout is the report, `meta-wizard/repair/<id>/report.md`; `result.json` records exit,
   timeout, branch, base, worktree, command, report path and the commits on the branch; the
   meta-wizard adds `conductorAnswered` (the pid, or null).

Rules in its prompt, and denied tools where Claude Code can enforce them: edit code only in the
worktree; run the related tests and the owner-scale startup check; build a local update from the
worktree (`node scripts/build-local-update.mjs`), install it silently and start Conductor; confirm
it answers on the owner's real profile (`node scripts/meta-wizard.mjs status --json`) and that the
cut work resumes (the meta-wizard resumes it; its journal shows `restart-seen` and the steers);
commit on its branch. Never push, publish, tag or touch `main`; never delete or edit anything in
userData except installing through the local feed; never `npm run dev`; never install software.
Denied: `git push`, `gh`, `npm run dev`, `git reset/clean`, checking out or switching to `main`,
`git branch -d/-D`, `git tag`, `git worktree remove`, `git stash drop`, `Remove-Item`/`rm`/`rmdir`/
`del`/`rd`, `NotebookEdit`, `WebFetch`, `WebSearch`, and `Edit`/`Write` under userData (Claude
Code's POSIX path form, `//c/Users/…/Conductor/**`).

When Conductor answers again after a repair, the meta-wizard steers the wizard tabs once with the
summary (report path, branch, commits, "ship the fix to main with git.ship after review") and sends
the owner a phone push.

Test knobs (test profiles only): `CONDUCTOR_REPAIR_AGENT_COMMAND` (JSON argv the claude arguments
are appended to; never the real CLI in a test), `CONDUCTOR_META_ROLLBACK_COMMAND` (JSON argv prefix
the installer path is appended to; without it a test profile runs no installer at all),
`--checkout <dir>` (a scratch repository for the worktree). If `boot.mjs` cannot be loaded, a
fallback verdict from the exit code and log keeps the supervisor running.

Tests: `scripts/meta-wizard-escalation.test.mjs` (every rule, and the service climbing the whole
ladder with faked effects); parked smoke `scripts/smoke-meta-wizard-repair.mjs` (the real app dies
in `structured-store`, a fake rollback fails the same way, a fake repair agent in a scratch
repository's worktree deletes the fail file, starts the app and commits; "Conductor repaired" goes
out and the scratch `main` is unchanged).

### The watchdog alongside

The recovery watchdog keeps its first minutes (two relaunches and its read-only diagnosis agent).
While its lock (`recovery/watchdog.json`) names a live watchdog for the dead pid, the meta-wizard
waits for it (at most 20 minutes) instead of starting a Conductor next to it.

## 3. Owner-scale startup check

`scripts/smoke-owner-scale-startup.mjs` boots the candidate (parked) on a synthetic profile the size
of the owner's: thousands of conversations, more than 1 GB of projection JSON, a multi-GB
`structured_events` journal. The profile is generated once and cached under
`.conductor-scratch/owner-scale-profile/` (keyed by the generator's version and the schema), and
each run copies the cached database into a fresh test profile. It fails when `boot.json` does not
reach `ready` within the time budget, or when the heap at ready or at its peak passes the heap
budget, and prints the verdict.

`app.update` runs it for every candidate, after `smoke-background-windows`, whenever the commit has
the script (`src/main/local-update-build.ts`).

The profile (`scripts/owner-scale-profile.mjs`) has 3,000 conversations in 20 projects, 1.45 GB of
projection JSON with non-ASCII text as the owner's has it (V8 stores those strings at two bytes per
character, which is what made 1.27 GB of JSON fill a 4 GB heap), a 3.4 GB journal and 120 open tabs.
The candidate creates the schema by booting once on an empty profile; the cache key covers the
generator version, the sizing and the schema of the tables it fills, so a commit that changes those
tables regenerates it (about 1-2 minutes). Budgets: ready within 60 s and a peak heap within 40% of
the V8 limit, staying up 20 s more with the first window painted (`--budget-ms`,
`--heap-budget-mb` override them). On 2026-10-22 HEAD was ready in 1.5-1.7 s with a peak of about
300 MB, and 0db4b53 (a4c6427^, the build installed during the outage) died 10 s in with the V8
out-of-memory error and exit code 4294930435. The mandatory smokes do not count toward the 12
requested ones; this one may run 45 minutes (a regeneration).
