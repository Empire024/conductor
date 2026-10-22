# Meta-wizard: the supervisor above Conductor

Owner, 2026-09-30, after a night lost to a silent stall: "I NEED A META WIZARD OVER CONDUCTOR THAT
PREVENTS SHIT LIKE THIS FROM HAPPENING. HE LIVES IN THE WINDOWS SERVICE AND DOESN'T CARE ABOUT
CONDUCTOR UI. HE HAS ALL RIGHTS EVER FOREVER. IF ALL ELSE FUCKS UP, HE BRINGS CONDUCTOR BACK ALIVE
AND ALL MY TASKS ALIVE."

## What failed on 2026-09-29

At 23:44Z the Conductor wizard ended its turn in `agents.await` on the Haftheme wizard with no
deadline. The Haftheme wizard's `send_message` reply was refused by a project-wide durable approval
denial ("A durable approval denial protects this project target"), left by one rejected tool call at
23:29Z. That fence refused every non-read tool in the Haftheme project, the Haftheme tab went
`completed`, and nothing woke anyone until the owner came back at 08:28Z: 8.5 hours.

The app now has its own answers (await deadlines, a quiet-waiter sweep, a refused message is told to
its recipient, messaging passes the denial fence). The meta-wizard is the independent layer above
them: a separate process that watches the app from outside, and catches what the app's own
mechanisms miss, including the app being dead or hung.

## Shape

- `scripts/meta-wizard.mjs` (CLI) and `scripts/meta-wizard/*.mjs` (modules, plain Node ESM, no
  dependencies). Pure decisions (`detect.mjs`, `liveness.mjs`) are separate from effects
  (`service.mjs`), so `node --test scripts/meta-wizard.test.mjs` covers every rule without Electron.
- It runs **outside** Electron as a per-user Windows Scheduled Task (`Conductor Meta-wizard`): at
  logon, plus a repetition every 5 minutes with "ignore new instance", so a dead supervisor is back
  within 5 minutes whatever killed it. It runs in the owner's interactive session (so it can start
  Conductor there and show toasts), hidden: `wscript.exe` runs `run-hidden.vbs`, which runs
  `node.exe` with no window and waits for it. No new software; `node.exe` is the one already
  installed.
- `install` copies the service files into `<userData>/meta-wizard/service/` and runs them from
  there, so other agents' edits to the checkout never change the running supervisor. Re-running
  `install` updates it.
- Authority: the owner credential, `<userData>/control-owner.json` (docs/overseer.md), read fresh
  each tick, kept in memory, never logged. "All rights" means the owner credential over Conductor's
  control API. It never answers approval cards (owner's or anyone's), never pushes, publishes or
  tags, never touches another project's production systems. It only **restarts, resumes, steers
  and alerts**.

## Every tick (default 120 s)

1. **Alive?** The credential's pid is running and `tools.list` answers within 10 s.
   - Not answering: two quick rechecks (20 s apart). A hung process (pid alive, no answer 3 times)
     is killed (`taskkill /T /F`) and started again. A silent main process whose CPU time keeps
     rising between probes is **busy, not hung** (2026-10-21: two kills of a main process busy in a
     launch prune): it gets `busyMaxMs` (4 min) from its first unanswered probe, and a starting
     one gets the same past its starting grace. Before it kills or starts anything it rewrites the
     replaced pid's `armed.json` as `kind: "restart", by: "meta-wizard"`, so the recovery watchdog
     waits for the Conductor started here instead of relaunching its own next to it.
   - Gone: after a crash (the recovery watchdog's `armed.json` still says `running`) or a
     restart/update that did not come back within its window, start the installed exe
     (`armed.json` `launch`, else `%LOCALAPPDATA%\Programs\conductor-desktop\Conductor.exe`). A
     restart or update install the recovery watchdog is still handling (armed within 10 minutes) is
     left to it first. After a clean owner quit, Conductor is started again only when the last
     snapshot had work in progress (a tab mid-turn or waiting): a Windows shutdown in the middle of
     the night is a quit too, and the tasks must come back.
   - Crash-loop guard: at most 3 starts in 30 minutes, then alert the owner and stand down for 30
     minutes (or, on the repair ladder below, start the repair agent).
   - A failed start climbs the **repair ladder** (next section) instead of only restarting.
2. **Resume after any restart** (the pid changed, by us or anyone): 90 s after the new app answers
   (the app's own resume runs 4 s after its windows open), every tab that was mid-turn in the last
   snapshot before the restart and is now settled without activity since the restart is steered:
   `[Meta-wizard] Conductor restarted at … (reason); your turn was cut; continue where you left
   off.` Wizards, coworkers and the owner's own tabs alike. A tab waiting on an approval is left
   alone.
3. **Stalls**, from one owner call, `supervisor.overview()`:
   - an `agents.await` whose deadline passed 3+ minutes ago and is still declared, or whose
     awaited conversations have all been quiet (settled, closed, no background work, no wait of
     their own) for two ticks: steer the waiter with who is idle, each one's phase and last answer
     excerpt, and any refusal text;
   - a `send_message`/`report` whose last tool status is `rejected`: steer the conversation waiting
     on the sender (the named recipient, its awaiter or its controller) with the refusal text;
   - a durable denial fencing a whole project (a rejected tool whose output is the denial fence):
     alert the owner (lifting a denial is the owner's decision) and steer the waiters on that
     project's tabs;
   - a coworker settled while its controller has been settled since before it (the controller has
     not acted since the coworker stopped) for 10 minutes: steer the controller.
4. **Held update**: a local update verified and downloaded (`phase: ready`) that has not been
   installed 20 minutes after the meta-wizard first saw it: steer its builder (from the local offer
   record), else the wizard tabs.
5. **Usage limits**: a tab whose `limitResumeAt` passed 5+ minutes ago and is still settled:
   steer it `continue`.

Each steer is recorded with its fingerprint (the fact it is about). A fact is steered once; if it is
still there 15 minutes later and the tab has not acted since, it is steered once more, and after
that it becomes an owner alert ("… is stuck"). A tab that acted after the steer made its own call and
is not steered about that fact again; a held update is the exception and keeps escalating. Two facts
about one tab in the same tick travel in one message; a tab gets at most one steer per 10 minutes,
and the meta-wizard sends at most 20 per hour (then it alerts the owner once).

Every steer starts with `[Meta-wizard]` and says where it comes from, so the receiving agent knows
this is the owner's supervisor and not a peer.

## The repair ladder

Design and background (the 2026-10-22 outage, boot diagnostics, the owner-scale startup check):
[docs/startup-diagnostics.md](startup-diagnostics.md). Decisions are pure in
`scripts/meta-wizard/escalation.mjs`; the effects are in `service.mjs` (`climb`, `rollback`,
`beginRepair`, `repairTick`) and `repair.mjs`; the detached runner is `repair-run.mjs`.

- **Verdict.** Every failed start reads the boot verdict (`boot.mjs` `readBootVerdict`: the child
  pid, its exit code and the launch log tail), e.g. *died in stage structured-store 4.1 s after
  start: V8 heap out of memory …*. The alert says it instead of a bare exit code; without boot
  diagnostics the exit code and log decide (`fallbackVerdict`: a V8 fatal exit code or "heap out of
  memory" in the log is `oom`).
- **Incident** (`state.json` `incident`): opens at the first failed start the meta-wizard makes
  (or when the crash-loop guard trips) and closes once Conductor has answered for 10 minutes
  (`incidentCloseMs`) with no repair busy. It holds every failure (`rung`, `signature`, `version`,
  `line`), the rungs taken, and `rolledBack`. A start of ours that answered and then died inside
  the incident counts as that rung failing.
- **Rungs.** (1) restart while fewer than `restartAttempts` (2) restarts failed with the latest
  signature on the same version; (2) roll back once to `pickRestorePoint(restore-points.json)`: not
  the failing version, `firstLaunchedAt` set, installer still in `<userData>/local-updates`; pinned
  or known-good first, then without crashes, then newest; run `<installer> /S` and start; (3) the
  repair agent when the rolled-back build fails (same signature: "data or environment, not the
  build"; any other failure: "fails too"), when there is no restore point, or when the crash-loop
  guard trips. After a repair: one plain start, then repair again while the cap allows. When no
  rung is left (`exhausted`), plain restarts under the crash-loop guard as before.
- **Repair gating**: one at a time (`meta-wizard/repair/active.json` names a live runner pid within
  its time limit), at most 2 per 24 hours (`state.json` `repairs`). While a repair runs or has just
  ended (`repairAnswerGraceMs`, 3 minutes for Conductor to answer), the meta-wizard starts and
  kills nothing (`repair-holds` in the journal).
- **The runner** (`node repair-run.mjs <repair>/<id>/request.json`, detached): `git worktree add -b
  repair/<id> <checkout>/../conductor-repairs/<id> HEAD`; `robocopy node_modules /E` (a real copy);
  the agent with the prompt (`prompt.md`) on stdin, cwd the worktree, its environment stripped of
  `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `CONDUCTOR_TEST_*` and control tokens; the whole tree
  killed after 90 minutes. It writes `report.md` (stdout), `result.json` `{id, startedAt,
  finishedAt, exitCode, timedOut, error, branch, worktree, base, commits, report}` (the service adds
  `conductorAnswered`) and `runner.log`, and removes `active.json`. `<id>` is the UTC minute
  `YYYY-MM-DD-HHmm` (`-2`, `-3` when taken).
- **The agent**: `claude -p --model opus --effort high --output-format text --max-turns 300
  --permission-mode acceptEdits --allowedTools Read Edit Write Grep Glob Bash PowerShell
  --disallowedTools …` (git push, gh, npm run dev, git reset/clean/checkout main/switch main/branch
  -D/tag/worktree remove, rm/rmdir/del/rd/Remove-Item, and `Edit`/`Write` under userData). The prompt
  (`repairPrompt`) carries the incident, `boot.json`, `boot-last-failure.json`, `boot-sample.json`,
  launch log tails, the newest recovery report, the paths, the steps and the rules.
- **Afterwards**: "Repaired: …" (Conductor answered; toast and phone push) or "Repair failed: …".
  Once Conductor answers, the wizard tabs (`supervisor.overview` `wizard: true`) are steered once
  with the report path, branch, commits and "ship it to main with git.ship" (`repair-announced`).
- **The recovery watchdog alongside**: while `recovery/watchdog.json` names a live watchdog whose
  `appPid` is the dead pid, a start waits for it, at most 20 minutes (`watchdog-wait`).
- **Checkout**: `--checkout <dir>`, else the checkout `install` recorded in `service/VERSION.json`,
  else the script's own checkout, else (installed profile) `armed.json` `checkout`. A test profile
  only ever uses `--checkout`. With none, the owner is alerted once and restarts go on.

Journal events: `incident-failure`, `rollback`, `repair-start`, `repair-holds`, `repair-finished`,
`repair-outcome`, `repair-announced`, `incident-closed`, `watchdog-wait`.

## Owner alerts

When it cannot fix something itself (Conductor will not come back, the crash-loop guard tripped,
a project is fenced by a denial, a stall survived two steers): a Windows toast (Conductor's
AppUserModelID, never a window) and, when the app answers, a phone push through
`supervisor.alert({title, body, agentSessionId?})`, the paired-phone path (its VAPID key lives in
the OS vault only the running app reads, so a phone push needs the app up). An alert about a tab
names it, so tapping the push on the phone opens that conversation rather than the home screen
(a Conductor older than the argument refuses it, and the push then goes without it). A test
profile writes `meta-wizard/toasts.jsonl` instead of showing a toast.

An alert names one condition and is sent once. While the condition persists it is repeated after
a day (`alertRepeatMs`); once it went away and came back it is a new alert. The owner's phone
received fifteen hourly pushes about one tab on 2026-10-12: a Coordinator that had handed itself
off to a successor, whose stale wait record `supervisor.overview` still reported as a wait, and
whose steers Conductor forwarded to the successor, so the retired tab was never seen to act. The
overview now reports a wait only where `AwaitingResults.fact` sees one and names each tab's
`successor`; the detectors leave a retired tab to its successor (they judge, steer and describe
the newest open successor instead) and never repeat an unchanged alert within the day.

## Journal and status

`<userData>/meta-wizard/`:

- `journal.jsonl`: append-only, one JSON line per event (tick summary when something changed,
  finding, steer, alert, start, restart, resume, error). Rotated at 5 MiB to
  `journal-<stamp>.jsonl` (the newest 5 are kept).
- `state.json`: the last snapshot of working tabs, first-seen times, steer fingerprints, restart
  history.
- `service.json`: the live supervisor (pid, started, version, last tick) — a second copy exits.

`node scripts/meta-wizard.mjs status` prints whether the task is installed and running, the
supervisor's last tick, Conductor's pid and liveness, open findings and the last journal lines.

## Commands

```
node scripts/meta-wizard.mjs install     register and start the scheduled task (per-user, no admin)
node scripts/meta-wizard.mjs uninstall   stop and remove it
node scripts/meta-wizard.mjs status      [--json]
node scripts/meta-wizard.mjs run         the supervisor loop (what the task runs)
node scripts/meta-wizard.mjs tick        one pass [--dry-run]: print findings and planned actions
```

Test knobs (`run`/`tick`): `--user-data <dir>` (a test profile: toasts go to the file),
`--interval-sec`, `--timings <json>`, `--launch <json {exe,args,cwd}>`, `--launch-env <json>`,
`--checkout <dir>` (a scratch repository for repair worktrees). Honoured for a test profile only:
`CONDUCTOR_REPAIR_AGENT_COMMAND` (JSON argv; the claude arguments are appended; with none a test
profile runs no agent and records that) and `CONDUCTOR_META_ROLLBACK_COMMAND` (JSON argv prefix the
installer path is appended to). Ladder timings (`--timings`): `restartAttempts`, `incidentCloseMs`,
`maxRepairsPerDay`, `repairWindowMs`, `repairTimeoutMs`, `repairAnswerGraceMs`, `watchdogWaitMs`,
`rollbackTimeoutMs`, `exitSettleMs` (a start whose process exited is given up on this long after
the exit when nothing answers).

## Tests

- `scripts/meta-wizard.test.mjs`: every detector and the liveness decisions, pure.
- `scripts/meta-wizard-escalation.test.mjs`: every ladder rule (incident, signatures, restore-point
  choice, gating, rungs, watchdog wait, repair argv/prompt/environment) and the service climbing
  the whole ladder with faked effects.
- `scripts/smoke-meta-wizard-repair.mjs` (parked, after `npm run build`): every start dies in stage
  `structured-store` (`CONDUCTOR_TEST_BOOT_FAIL_FILE`); restarts alert the verdict, a fake rollback
  fails the same way, the repair runner makes a worktree of a scratch `--checkout` and a fake agent
  deletes the fail file, starts the app and commits; "Repaired", the wizard summary, the incident
  closes.
- `src/main/agent-control.test.ts`: `supervisor.overview` and `supervisor.alert` answer only the
  owner credential.
- `scripts/smoke-meta-wizard.mjs` (parked, `node scripts/smoke-lock.mjs -- node
  scripts/smoke-meta-wizard.mjs` after `npm run build`): (a) the app killed mid-turn is restarted
  and the cut tab resumed; (b) a waiter on a coworker that completed without messaging is steered.
