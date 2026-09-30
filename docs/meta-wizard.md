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
     is killed (`taskkill /T /F`) and started again.
   - Gone: after a crash (the recovery watchdog's `armed.json` still says `running`) or a
     restart/update that did not come back within its window, start the installed exe
     (`armed.json` `launch`, else `%LOCALAPPDATA%\Programs\conductor-desktop\Conductor.exe`). A
     restart or update install the recovery watchdog is still handling (armed within 10 minutes) is
     left to it first. After a clean owner quit, Conductor is started again only when the last
     snapshot had work in progress (a tab mid-turn or waiting): a Windows shutdown in the middle of
     the night is a quit too, and the tasks must come back.
   - Crash-loop guard: at most 3 starts in 30 minutes, then alert the owner and stand down for 30
     minutes.
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

## Owner alerts

When it cannot fix something itself (Conductor will not come back, the crash-loop guard tripped,
a project is fenced by a denial, a stall survived two steers): a Windows toast (Conductor's
AppUserModelID, never a window) and, when the app answers, a phone push through
`supervisor.alert({title, body})`, the paired-phone path (its VAPID key lives in the OS vault only the
running app reads, so a phone push needs the app up). A test profile writes
`meta-wizard/toasts.jsonl` instead of showing a toast. Alerts are deduplicated for an hour.

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
`--interval-sec`, `--timings <json>`, `--launch <json {exe,args,cwd}>`, `--launch-env <json>`.

## Tests

- `scripts/meta-wizard.test.mjs`: every detector and the liveness decisions, pure.
- `src/main/agent-control.test.ts`: `supervisor.overview` and `supervisor.alert` answer only the
  owner credential.
- `scripts/smoke-meta-wizard.mjs` (parked, `node scripts/smoke-lock.mjs -- node
  scripts/smoke-meta-wizard.mjs` after `npm run build`): (a) the app killed mid-turn is restarted
  and the cut tab resumed; (b) a waiter on a coworker that completed without messaging is steered.
