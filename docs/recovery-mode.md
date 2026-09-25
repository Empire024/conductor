# Recovery mode: Conductor comes back, or an agent is told why it did not

Owner's item `recovery-mode` (2026-09-25): "Conductor nuked itself! I had to turn it on myself. Add
recovery mode for when that happens - a script automatically tries turning it on, if it doesnt
work, agent is called with error it received".

## What happened on 2026-09-25

The wizard called `app.update.install({force:true})` for `0.1.54-local.1790360055464` at 20:16:02
(+02:00). The evidence says the update and relaunch worked and the window did not come to the front:

- `%LOCALAPPDATA%\conductor-desktop-updater\installer.exe` and `pending\` were written at 20:15:59;
  `quitAndInstall(true, true)` ran the NSIS installer silently with `--force-run`.
- The installer relaunched the app **through Explorer** (NSIS `ExecShellAsUser`): the process
  that ran afterwards was pid 69908, command line `Conductor.exe --updated`, parent `explorer.exe`,
  started 20:16:15, and it was still the running Conductor hours later.
- That process wrote `control-owner.json` at 18:16:18Z and reattached the wizard's kept turn in the
  runtime host at 18:16:20Z (`runtime-host/host.log`: `attached fefb8e41… replayed 113, missing 0`),
  and restored the windows at 18:16:20.588Z (`restoreWindowsAfterUpdate` cleared in the settings).
- No crash or error in the Windows Application or System logs between 20:10 and 20:25.
- The owner's "turn it on" started a second `Conductor.exe`, which found the single-instance lock
  and handed over to pid 69908 (`second-instance` → `show()` + `focus()`), so the same window came up.

The cause: the first window of a relaunch was revealed with `revealWindow(window, false)`, which
shows it without asking for focus. A process started by Explorer on behalf of an installer is not
in the foreground, and Windows refuses foreground activation to such a process, so the maximized
window came back **behind** whatever the owner had in front. The foreground was already gone
because the old Conductor quit. Nothing on screen changed, so to the owner Conductor was gone. This
is inferred: no log records window activation, but it is the only explanation consistent with a
live, answering process whose window the owner could not see.

That exact case would not have woken the watchdog: the app answered app control. The watchdog
covers the harder failures: the installer or the relaunch dying, a hung start, and crashes.

## The fix in the app

`index.ts`: when the previous process armed a restart or update install while one of its windows
had focus, the first window of the relaunch is brought to the front (`bringToFront`: show, focus,
a momentary always-on-top raise, and a flashing taskbar button if Windows still refuses focus).
A restart nobody was watching still comes back without taking the screen.

## The watchdog

- **Where it runs.** `src/main/recovery/watchdog-main.ts`, bundled on its own into
  `out/main/recovery-watchdog.js` (node: imports only). A packaged app copies the bundle to
  `<userData>/recovery/watchdog-<sha>.js` and runs it with the runtime host's Electron copy
  (`<userData>/runtime-host/runtime-*/conductor-runtime-host.exe`, `ELECTRON_RUN_AS_NODE=1`), so
  nothing it uses lives in the install directory the NSIS installer clears and replaces. It is
  started through PowerShell `Start-Process`, holding none of the app's handles
  (`recovery/detached.ts`).
- **When.** Every launch of the installed Windows app starts one watchdog for its own pid as soon
  as `control-owner.json` is written. It is off in a checkout or test profile unless
  `CONDUCTOR_RECOVERY_WATCHDOG=1`; `=0` turns it off anywhere. macOS: not yet (the runtime copy is
  Windows-only).
- **Arming.** `<userData>/recovery/armed.json` holds `{appPid, kind, launch, checkout, foreground,
  fromVersion, toVersion}`. The launch writes `kind: running`. Every stop recorded by
  `recordRestartIntent` rewrites it: `update-install` (app.update.install, Restart to update),
  `restart` (app.restart), `update-on-quit` and `quit`. A Windows logoff or shutdown (`session-end`)
  counts as `quit`.
- **Decision** (`recovery/watchdog.ts`, pure, every effect injected):
  1. Poll the app pid every second.
  2. When it is gone: `quit` / `update-on-quit` means the owner quit; the watchdog exits and
     nothing happens. Install-on-quit installs without relaunching by design.
  3. Otherwise wait for **readiness**: `control-owner.json` names a different pid that is alive
     and answers `tools.list` on app control. The watchdog waits 60 s after a restart, 180 s after
     an update install, extended while the updater's installer process still runs (up to 10 min,
     plus 60 s after it ends), and 10 s after a crash (`running` left behind).
  4. Not ready: start the armed exe itself (the installed `Conductor.exe`, no arguments), up to 2
     attempts with 2 s and 15 s backoff. Each attempt has 60 s to answer. Each records its pid, its
     exit code, and its stdout/stderr (`recovery/launch-*.log`; the newest 10 are kept). A second
     Conductor that exits at once because a hung one holds the single-instance lock shows up here
     as a quick exit.
  5. Still down: call the **recovery agent** with the exact error (below), then wait 60 s more.
  - Crash loop guard: after 3 recovery launches in 15 min it stops relaunching and goes to the agent.
- **Owner notice.** A Windows toast (`io.conductor.desktop`) when a relaunch brought Conductor back,
  when the agent is called, when the agent brought it back, and when it is still down. A test
  profile writes `recovery/toasts.jsonl` instead and never shows one. Phone push is not sent: its
  VAPID private key lives in the OS credential vault that only the running app reads.
- **Report.** `recovery/recovery-<time>.json` and `.md` (the agent's diagnosis followed by the
  watchdog record). `recovery/pending-report.json` is read once by the next launch. Its sentence
  (`recoveryNote`) is appended to FX25's restart line in every brought-back wizard and coworker
  message and to the notice for turns reattached from the runtime host, e.g.
  `… Conductor did not come back by itself after this stop (after app.restart no new Conductor
  answered app control within 8 s of pid 123 exiting); recovery mode relaunched it (attempt 2).
  Recovery report: …\recovery\recovery-….md.`
- **Log.** `recovery/watchdog.log` (rotated at 1 MiB); `recovery/watchdog.json` names the live watchdog.

## The recovery agent

`claude -p` (Claude Code, found on PATH or `%USERPROFILE%\.local\bin\claude.exe`), in the Conductor
checkout among the owner's projects (else userData), prompt on stdin (`recovery/agent.ts`):

- The prompt holds the exact error, the stop record, every relaunch attempt with its exit code and
  output tail, the tails of `runtime-host/host.log` and `recovery/watchdog.log`, and the paths. It
  also has rules: bring Conductor back by starting the installed exe, never commit, push, reset or
  clean, never delete or edit userData, never `npm run dev`.
- Tools: `Read, Grep, Glob, Bash, PowerShell` allowed. Denied: `Edit, Write, NotebookEdit, WebFetch,
  WebSearch`, and `git push/commit/reset/clean/checkout/stash`, `rm/rmdir/del/rd/Remove-Item/format`,
  `npm run dev` in Bash and PowerShell. 40 turns max, killed (whole tree) after 10 minutes.
- Its stdout is the diagnosis, saved to `recovery/recovery-<time>.md`; the prompt itself is kept
  beside it (`.md.prompt.txt`).
- A test profile never reaches the real CLI: it uses `CONDUCTOR_RECOVERY_AGENT_COMMAND` (a JSON argv)
  or runs no agent, unless `CONDUCTOR_RECOVERY_REAL_AGENT=1` says otherwise.

## Tests

- `src/main/recovery/watchdog.test.ts`: ready in time; installer still running; relaunch needed;
  relaunch fails twice, so the agent gets the error; spawn failure, then still down; test exes in
  order; crash; foreign arm record; crash loop; late return; parent gone; clean quit, where nothing
  happens.
- `src/main/recovery/controller.test.ts`: enablement, launch spec, arming, runtime copy and bundle
  copy, the report read once, the recovery note, the agent's command gating, allowlist and prompt.
- `scripts/smoke-recovery-mode.mjs` (parked, `node scripts/smoke-lock.mjs -- node scripts/smoke-recovery-mode.mjs`
  after `npm run build`). The test-only `CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH=1` switches off
  app.restart's own relaunch, so only the watchdog can bring the app back.
  1. The wizard's app.restart. Both attempts use bogus exes and fail with ENOENT, the fake agent
     gets the exact error and starts the real app, and the wizard's continue message carries the
     report.
  2. The wizard's app.restart again. Attempt 1 is bogus and attempt 2 is the real electron, and the
     wizard hears "relaunched it (attempt 2)".
  3. A clean quit. The watchdog logs `done: clean-quit`, and nothing comes back and no toast is
     shown.

Test-only knobs (ignored by a packaged app): `CONDUCTOR_RECOVERY_TIMINGS` (JSON of the waits),
`CONDUCTOR_RECOVERY_TEST_EXES` (JSON array of attempt exes), `CONDUCTOR_RECOVERY_AGENT_COMMAND`,
`CONDUCTOR_RECOVERY_AGENT_TIMEOUT_MS`, `CONDUCTOR_RECOVERY_TEST_SKIP_RELAUNCH`.
