# Always-on machines

Feature `always-on-machines`. The owner, 2026-09-25: "we need that machine to be on when we need it
to be on no matter what.. same for this pc", with "a password … as a security failsafe in
Conductor". This page covers this PC (Windows) and Conductor's own part. The Mac mini is an
execution node, and its half is in [mac-node.md](mac-node.md) under "Unattended operation".

## What has to be true

After a reboot or a power cut, with nobody at the PC:

1. The PC powers on again: a **BIOS/UEFI** setting ("Restore on AC power loss", "AC Back" or
   "After power failure", set to *Power On*). Windows cannot report it, so Conductor only shows a
   note about it. Check it once in the firmware setup.
2. Windows gets past its sign-in screen: **automatic sign-in**.
3. Tailscale connects: the Tailscale service starts at boot. Its **Run unattended** option keeps
   the tailnet up with no one signed in. With automatic sign-in it is not needed, but it does no
   harm.
4. Conductor opens: **Start Conductor when I log in**.
5. The PC stays awake: **sleep and hibernate set to Never on AC power**.
6. Remote access still needs a secret: the **6-digit Conductor code** (phone lock, below).

## Where it shows

- **Settings > Machines > Always on** has the toggle and one line per check: green when it is in
  place, amber with the owner's step in words when it is missing, grey when Conductor could not
  tell. *Check again* probes again.
- **`machines.list`** (app control): the entry with `kind: "local"` carries `readiness`:
  `{ platform, ready, checks: [{id, label, ok, detail}], missing: [...], notes: [...], checkedAt }`.
  The check ids are `sleep`, `boot-unlock`, `tailscale`, `conductor` and `failsafe`. A node's
  readiness (`nodes.list`, or the `node` facet of a peer) keeps its own shape and ids.

## Start Conductor when I log in

This is **off until the owner turns it on**, on every install. It is one click in Settings >
Machines. The OS login item is the source of truth:

- Windows: an `HKCU\...\Run` entry for the installed `Conductor.exe` with `--conductor-login-start`,
  written through Electron's `app.setLoginItemSettings`. If the entry is disabled in Task Manager >
  Startup apps, the toggle shows off.
- macOS: a login item (`SMAppService` on macOS 13 and later).

A run started by the login item opens its window **minimized, without focus**. Everything else runs
as usual: agents, schedules, the phone listener, hosting.

Development and test builds (not packaged, or any `CONDUCTOR_TEST_USER_DATA` profile) **never write
the OS login items**. Their choice is kept in the settings table and marked *Development build* in
the UI, so a smoke or a checkout cannot register `electron.exe` or change the owner's login.

## What Conductor reads, and never writes

`src/main/machine-readiness.ts` runs these read-only commands, at most every 30 s:

| Check | Command | Ready when |
|---|---|---|
| sleep | `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` and `HIBERNATEIDLE` | AC index is 0 (never) for both |
| boot-unlock | `reg query HKLM\...\Winlogon /v AutoAdminLogon` and `/v DefaultUserName` | `AutoAdminLogon` is `1` |
| tailscale | `sc.exe query Tailscale`, `sc.exe qc Tailscale`, `tailscale.exe debug prefs` (ForceDaemon) | running, start type automatic, and unattended mode or automatic sign-in |
| conductor | Electron `getLoginItemSettings` | the login item is on and not disabled |
| failsafe | the phone access settings and the lock | phone access is off, or a 6-digit code is set |

The Winlogon key is read **one named value at a time**, never whole, because it can hold a
plain-text `DefaultPassword`. Conductor never changes the power plan, the registry, the sign-in
or Tailscale. Every amber line is a step for the owner.

### Owner steps on this PC (as of 2026-09-25)

On MAIN, sleep is already off on AC and Tailscale runs as an automatic service in unattended mode.
Two steps are left:

1. **Settings > Machines > "Start Conductor when I log in"**: one click in the installed app.
2. **Automatic sign-in.** The simplest route that keeps the password encrypted is Sysinternals
   **Autologon** (`autologon64.exe`, from Microsoft). It stores the password as an LSA secret, not
   in plain text. The built-in alternative is `netplwiz`: untick "Users must enter a user name and
   password to use this computer". If that box is missing, first turn off Settings > Accounts >
   Sign-in options > "For improved security, only allow Windows Hello sign-in for Microsoft
   accounts". A Microsoft-account PC that signs in with a PIN has to use the account password
   here, not the PIN.
3. Once, in the BIOS/UEFI: set "Restore on AC power loss" to Power On.

The trade-off, stated once: with automatic sign-in, anyone with physical access to the PC gets the
owner's desktop. The owner accepted that and chose Conductor's own code as the failsafe for remote
access.

## The failsafe: the Conductor code after an unattended start

The phone lock ([phone-lock-and-terminal.md](phone-lock-and-terminal.md)) is what stands between
a paired phone and this PC. It does not depend on who started Conductor or how:

- The code's hash lives in the OS vault, and a non-secret marker in the settings table makes the
  lock fail closed if the vault stops answering.
- Unlock sessions are **in memory only**. Any restart, including a login start after a power cut,
  locks every phone. A phone that was unlocked before the restart gets `423 Unlock Conductor on this
  phone first` on every route except the lock pad's own, until it sends the code again.
- The failure counter is persisted, so a restart hands out no fresh attempts.

`scripts/smoke-always-on.mjs` proves this in the real app. It pairs a phone over HTTPS, sets a
code, unlocks, and restarts with `--conductor-login-start`. The old unlock token is refused (423),
`/api/lock/state` says `configured: true, unlocked: false`, a wrong code is refused, and only the
right code opens `/api/state` again.

What the code does **not** cover:

- **Phone access with no code set.** A paired phone gets straight in after an unattended start.
  The `failsafe` check goes amber for exactly this case.
- **Paired machines** (Settings > Machines > "Let my other machines control this one", off by
  default). They authenticate with their own pairing, not with the phone code.
- **Physical access**, which automatic sign-in hands over by design.

## Verification

- `src/main/machine-readiness.test.ts` covers the parsers and the assessment on fake powercfg, sc,
  reg and tailscale output, including localized powercfg, a missing Tailscale, unknown tools, and a
  guard that only read commands run and never the whole Winlogon key.
- `src/main/login-item.test.ts`: default off, the Windows arguments, a Task-Manager-disabled entry,
  macOS, and a development build that never touches the OS.
- `node scripts/smoke-lock.mjs -- node scripts/smoke-always-on.mjs` is the parked real-app run
  described above. Artifacts go to `artifacts/always-on/`.
