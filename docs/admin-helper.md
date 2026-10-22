# Admin helper: admin actions without UAC clicks

Owner, 2026-10-22: "you should have admin rights each time conductor starts cant we do that
automatically so i never have to click anything".

Conductor does **not** run elevated: every agent command, every coworker's shell and every MCP tool
would then run as administrator. Instead a narrow helper does the few admin jobs Conductor needs,
and the owner clicks UAC once, to install it.

## What it is

- **`C:\ProgramData\ConductorAdmin`**, owned by Administrators; Administrators and SYSTEM have full
  control, Users read and run. No agent can write a script there. The one exception is
  `queue\requests`, where Users may add request files, which are data and never code.
- **The scheduled task `Conductor Admin Helper`**: runs as the owner, with highest privileges, no
  trigger (it runs only when started), hidden (`wscript.exe` → `run-hidden.vbs` →
  `powershell.exe -NoProfile -File runner.ps1`, all from that folder or System32).
- **`runner.ps1`** takes every request file, checks it against **its own** `actions.json` (the
  allowlist copied at install), and runs the action's script from `actions\`. An arg must be one the
  action declares, of its declared type; a boolean arg turns on the switch the action declares.
  Nothing from a request is ever put on a command line as text, a request naming a script is
  ignored, an id that does not match its file name, an oversized or non-JSON request, a link or an
  unknown action are refused. The runner limits `PSModulePath` to the system module folders, so a
  module planted in the owner's Documents is never loaded elevated.
- Results: `queue\results\<id>.json` (`ok`, `exitCode`, last 40 output lines, `log`) and the full
  output in `logs\<id>.log`; both kept 30 days, readable by Users, written only by the runner.

Sources live in the checkout under `scripts/admin-helper/`: `actions.json`, `runner.ps1`,
`actions/*.ps1`, `install.ps1`, `uninstall.ps1`. `src/main/admin-helper.ts` is the Conductor side
and mirrors the allowlist (a test checks both copies agree).

## Actions

| Action | Args | Does |
| --- | --- | --- |
| `firewall-candidate-cleanup` | `dryRun?: boolean` | Removes the **inbound** Windows Firewall rules whose program is an `electron.exe` inside a `conductor-candidates` or `.conductor-scratch` folder (acceptance candidates and smoke worktrees; Windows made a rule pair for each one the owner answered an Allow dialog for). Never the installed `Conductor.exe`, the main checkout's `electron.exe` or any other program. |

Adding an action is a code change (a script in `scripts/admin-helper/actions/`, an entry in both
allowlists) **and a reinstall**: the elevated folder only changes when the owner runs the installer,
so nothing an agent edits in the checkout reaches the elevated side on its own.

## Using it

From app control, owner credential or a wizard tab only:

- `admin.run({action, args?, waitSeconds?})` writes the request, starts the task
  (`schtasks /Run`, which needs no elevation for the owner's own task) and waits up to
  `waitSeconds` (default 40, at most 45) for the result: `{id, pending:false, result}` or
  `{id, pending:true}`.
- `admin.status({})` says whether it is installed (folder, `VERSION.json` and task), what it can do
  and the latest results; `admin.status({id})` returns one result (`null` while it runs).

When the helper is not installed, `admin.run` refuses and names the install command.

## Install (one UAC prompt) and update

From a normal PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\conductor\scripts\admin-helper\install.ps1
```

It asks Windows once to run itself as administrator, then recreates `C:\ProgramData\ConductorAdmin`
from scratch (an existing folder is removed with `rmdir`, which never follows a junction), sets the
access list, copies the runner, the allowlist and only the scripts the allowlist names, registers the
task for the account that ran the command, and as its first job queues
`firewall-candidate-cleanup` and starts the task. The elevated output is kept in
`C:\ProgramData\ConductorAdmin\logs\install.log` and printed when it returns. `-SkipFirstJob` skips
the cleanup. Running it again is how the helper is updated.

## Remove

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Claude\conductor\scripts\admin-helper\uninstall.ps1
```

One UAC prompt; it deletes the task and the folder. By hand, from an elevated PowerShell:
`Unregister-ScheduledTask -TaskName 'Conductor Admin Helper' -Confirm:$false` and
`cmd /c rmdir /s /q C:\ProgramData\ConductorAdmin`.

## Tests

`src/main/admin-helper.test.ts`: the two allowlists agree; arg validation; the queue (not installed,
result, pending, task that cannot start); the real `runner.ps1` run unelevated in a temp folder with
a test allowlist (allowed, unknown action, undeclared arg, wrong type, script named in the request,
id mismatch, bad JSON, bad file name); the firewall action's program matcher (`-Classify`, never
reads the firewall). `src/main/agent-control.test.ts`: `admin.*` only for the owner and wizards.
