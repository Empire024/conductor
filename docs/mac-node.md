# The Mac mini as a Conductor node

Owner's brief: [mac-node-goal-2026-09-25.md](./mac-node-goal-2026-09-25.md). This document is the
map of what already existed, the design that was added, and the state of the Mac itself.

## 1. What Conductor already had for "other machines"

| Piece | Where | What it does |
|---|---|---|
| Machine descriptor | `src/shared/remote-control.ts` (`MachineDescriptor`), `src/main/machines.ts` | `local` plus every **paired Conductor peer**: id, name, `kind: 'local' \| 'peer'`, online/offline/revoked, how it is reached (direct / relay / tailscale), confirmed project grants. |
| Pairing and transport | `remote-control-server/client/host.ts`, `remote-stream-*`, `remote-tunnel-*`, `tailscale.ts` | GitHub device key + single-use ticket → pinned HTTPS + signed RPC; Tailscale exposure binds only the tailnet address ([multi-device.md](./multi-device.md), [remote-control.md](./remote-control.md)). |
| Presence | `RemoteControlService.probeMachines`, `MachineProbeSchedule` (60 s → 15 min backoff) | Keeps peer status live. |
| Placement | `machineId` on `tabs.open` / `router.dispatch`, `inheritMachineId`, `machineRunsProject` | A conversation tab runs on a peer and is mirrored here; children inherit the machine. |
| Run-on picker | `machinePlacementOptions` in `LauncherPane.tsx` | Lists machines per project with the reason one is unavailable. |
| Remote project mapping | `remote-project-adoption.ts`, `ProjectRecord.remote` | A project belongs to one machine; a peer's projects are adopted here as that machine's. |
| Remote terminals / services | `remote-terminals.ts`, `remote-services.ts` | PTYs and preview tunnels on a peer. |
| Durable jobs | `src/main/durable-jobs/**` | *Local-model agent* jobs (stages, checkpoints, watchdog). Not command execution; not reused here beyond its shape. |
| Machine limits | `machine-policy.ts` | This computer's CPU/RAM/GPU sentence for briefings. |

Everything machine-shaped assumes **the other computer runs Conductor** (an Electron app, signed
into GitHub, with pairing approved in its own window). Nothing ran a plain command on another
computer.

## 2. Peer vs. SSH node, and the recommendation

| | Conductor peer on the Mac | SSH execution node |
|---|---|---|
| Needs on the Mac | A working macOS build of Conductor, a logged-in GUI session, GitHub sign-in, approving the pairing there | Remote Login (on) and one authorized key |
| Gives | Conversations, agents, terminals, files on the Mac, mirrored into MAIN's tabs | Bounded commands: build, test, package, probe, with logs kept on MAIN |
| Available | Only after Phase 4 succeeds and the owner signs in on the Mac | Now |

**Recommendation: both, as two facets of one machine, in that order.**

1. **Now: the Mac is an execution node** (`src/main/remote-jobs/**`). It is the only thing that can
   work before Conductor builds on macOS, and bounded jobs are exactly what Phases 6, 7 and 9 ask
   for (build on Apple Silicon, run macOS tests, return logs and results).
2. **After the macOS build works: also pair Conductor on the Mac as a Tailscale peer** through the
   existing multi-device path. That is what "dispatch agents to the Mac" needs, and it already
   exists: no new conversation transport.
3. **One pool, not two systems.** The node record carries `peerMachineId`, so the same computer is
   one machine with two facets: tab placement stays in `MachineDescriptor`/`machines.list`, command
   execution in the node record. The job layer talks to nodes only through `NodeTransport`
   (`exec`, `pushCommit`); SSH is its first implementation, and a paired peer's host API can be a
   second one later without touching jobs, routing or storage.

Nothing is hardcoded to one Mac: nodes are records (`nodes.json`), routing is by capability.

## 3. Remote jobs: the design (Phases 5, 6, 7, 9)

Module: `src/main/remote-jobs/` (types, capabilities, shell, transport, store, service) with
`remote-jobs.test.ts` against an in-memory fake transport (`test-fakes.ts`). Command line:
`node scripts/mac-node.mjs` (header lists the commands). The files use `.ts` import extensions so
the script runs them directly under Node's type stripping, like `scripts/local-models/cli.ts`.

### Machine (node) record

`ExecutionNode`: `id`, `name`, `ssh {host (Tailscale MagicDNS name), user, port?, identityFile}`,
`peerMachineId`, `root` (workspace root under the node's home, default `conductor-node`), `labels`,
`maxConcurrentJobs`, `facts` (last probe), `status` (unknown/online/offline), `lastSeenAt`,
`lastProbeAt`, `lastError`, `registeredAt`. A summary adds `capabilities` and `currentJobs`.

A **probe** is one SSH round trip returning hostname, user, OS name/version/build, kernel, arch,
hardware model, CPU, cores and performance cores, RAM, free disk, shell, developer dir (CLT/Xcode),
Rosetta, `pmset` sleep, and each tool on the job PATH (git, node, npm, npx, brew, gh, python3,
xcodebuild, tailscale) with its version. On a Mac without the Command Line Tools, `/usr/bin/git`,
`python3` and `xcodebuild` are shims that pop an installer dialog on the Mac's screen; the probe
never runs them and reports them as `shims` instead.

**Capabilities** come from the probe plus owner labels: `macos | linux | windows`, `arm64 | x64`,
`apple-silicon`, `rosetta`, `xcode-clt`, `xcode`, each tool, `node@<major>`. Aliases (`mac`,
`darwin`, `aarch64`…) normalise. **Routing** (`selectNode`): online, has every required
capability, then fewest running jobs, then most recently seen. Stale candidates are probed first.
If nothing qualifies the error names each node and why ("mac-mini is offline (…); e-box lacks
macos"): a "requires macOS" job is never run somewhere else.

### A bounded job

`submit({command, nodeId? | requires?, cwd?, timeoutSec? (default 1800, max 86400), checkout?})`
→ `queued → preparing (checkout) → running → succeeded | failed | timed-out | cancelled | lost`.

SSH alone cannot bound a job: a dropped connection does not signal a command that has no
terminal, and killing the local `ssh` leaves the remote command running. So every job runs inside a
small bash wrapper (`shell.ts`, bash 3.2 compatible) that:

- starts the command in **its own process group** (`set -m`), stdin from `/dev/null`;
- watches the **stdin the caller holds open** for the whole run: EOF (cancel, local timeout,
  Conductor quitting, connection lost) → `TERM` to the group, `KILL` 5 s later;
- enforces the **deadline on the node**, so no job outlives its timeout even if MAIN is gone;
- **kills whatever the job left in its group** when it ends (no lingering processes between jobs);
- writes its pid to `~/.conductor-node/jobs/<id>/pid` (removed at the end) so a later process can
  stop it;
- reports `started pid=…`, `reason=timeout|cancelled`, `error=cwd`, `exit=N` as nonce-tagged lines
  on stderr, which Conductor strips from the log.

SSH runs keys-only and bounded: `BatchMode=yes` (never a password prompt that would hang),
`IdentitiesOnly`, `ConnectTimeout=15`, `ServerAliveInterval=15 × 4`, and the host key pinned in
Conductor's own `known_hosts` (`StrictHostKeyChecking=accept-new`: first contact is recorded, a
changed key is refused).

Local side: stdout/stderr are appended to `stdout.log` / `stderr.log`, the last 16 KB of each is
kept in `job.json`, flushed every 2 s. A cancel closes stdin, then drops the connection after a
grace and sends a stop-by-pid-file. A connection that ends without an exit report is `lost` (node
marked offline, stop-by-pid sent); one that never started is `failed` with SSH's reason. After a
restart, `recover()` records jobs the old process ran as lost and asks their node to stop them.

### Repository strategy (Phase 7)

The node keeps **its own checkout**; tasks reference a **commit**. Per repository on the node:
`~/conductor-node/repos/<repo>.git` (bare, receives) and `~/conductor-node/work/<repo>` (checkout).
For a checkout job Conductor resolves the ref locally (`git rev-parse`), **pushes that commit** into
the node's bare repo under `refs/conductor/jobs/<id>` (only missing objects travel), then the node
fetches it into its checkout, `checkout --detach --force`, `git clean -fd` (keeps ignored
`node_modules`/`out`), and drops the ref again. Consequences:

- deliveries are local commits (AGENTS.md) and need not be published for the Mac to test them;
- the Mac needs no GitHub credentials;
- the Mac never commits, so there is nothing to conflict with; its checkout is disposable;
- one job at a time per checkout (a per-node, per-repo lock); other jobs on the node still run.

### Storage

`<userData>/remote-jobs/`: `nodes.json`, `known_hosts`, `jobs/<id>/{job.json,stdout.log,stderr.log}`,
the newest 300 finished jobs kept. Plain files beside (not inside) the multi-gigabyte journal.
Every JSON write is temp-file + rename. The app and `scripts/mac-node.mjs` can use the folder at
the same time: each job records its `runnerPid`, only that process follows, cancels or recovers
it, and the other re-reads records and `nodes.json` from disk.

### App control

`src/main/remote-jobs/control.ts`, wired into `agent-control.ts` with one dispatch line and
plugged in from `index.ts` (`control.setRemoteJobs`):

- reads: `nodes.list`, `nodes.jobs`, `nodes.job({jobId, waitSeconds})`, `nodes.log`;
- `nodes.probe`, `nodes.run`, `nodes.cancel`: the owner, a wizard tab, or a non-local, writable
  conversation (the jobs.create rule); a job can be cancelled by the conversation that started it;
- `nodes.register`, `nodes.remove`: owner or wizard only (they name a host to trust and a key file);
- `machines.list` includes each node: as the `node` facet of its paired peer when
  `peerMachineId` links them, otherwise as `{id: "node:<id>", kind: "node", runsThisProject: false}`
  so tab placement never picks it.

`nodes.run({command, requires: ["macos"], checkout: true})` is "Run on: mac-mini" for a commit of
the caller's project.

## 4. Windows-only assumptions that affect a macOS build (from reading the code)

Read from the code before the Mac was reachable; section 5 lists what the Mac actually showed (Phase 4). Size: T trivial, S small, M medium, L large.

**Build, typecheck, tests**
- `tsc`, `electron-vite build`, vitest config: platform-neutral. The database is `node:sqlite`
  (no native DB module); node-pty 1.1.0 ships `prebuilds/darwin-arm64`.
- package.json `test:remote-relay`, `test:conductor-relay`, `test:relay-settings`,
  `test:multi-device` run `powershell -File scripts/run-smoke-background.ps1` (S).
- Tests likely to fail on POSIX: `local-models/paths.test.ts:38-47` (expects `D:\…` from `join`,
  `driveOf` → `D:`) (S); to check: `agent-collaboration-runtime.test.ts`, `agent-collaboration-store.test.ts`,
  `delivery.test.ts`, `approval-review-gate.test.ts`, `session-archive.test.ts`,
  `update-install-seam.test.ts`, `update-manager.test.ts`, `local-models/*.test.ts`,
  `durable-jobs/handoff.test.ts:117` (drive-letter roots mixed with `path.join`).

**Runtime on macOS**
- `runtime-host/launcher.ts:57-66` (packaged): copies `process.execPath` + `ffmpeg.dll`/`icudtl.dat`;
  a Mac binary needs its `Electron Framework.framework` (M).
- `agent-manager.ts:110-113`, `delivery.ts:53`, `local-update-build.ts:42`: PATH lookups against a
  Finder-launched PATH miss `/opt/homebrew/bin` and `~/.local/bin` (claude, codex, node, git);
  no shell-env import (S).
- `index.ts` `frame:false` + `TitleBar.tsx`: no traffic lights on macOS (S).
- Parked test windows: off-screen x works on macOS, but occlusion throttling may pause rendering;
  set `backgroundThrottling:false` in test mode (S).
- `pane-factory.ts:43-45` default terminal titled/typed `powershell`; `schedule-scripts.ts:61`
  offers PowerShell scripts (S).
- Degrade to "unavailable" (acceptable): process table in `system-metrics.ts`, `nvidia-smi`,
  local-models (llama-server lookup, `resource-guard.ts` throws off win32, drive-letter paths,
  `.ps1` setup) — local models are effectively Windows-only (L, low priority).
- Tree kills are win32-gated with POSIX fallbacks; `transport.ts:199`, `runtime-host/host.ts:252`
  signal only the child, not its group (S).

**Packaging, signing, update**
- No `mac` block in the electron-builder config, no `dist:mac`, icon is `build/icon.svg` only (needs
  `.icns` or a 1024 px PNG) (S).
- No hardened runtime, entitlements or notarization; arm64 needs at least ad-hoc signing to launch;
  a distributable build needs a Developer ID (owner's Apple account) (M).
- `update-manager.ts` hard-codes `NsisUpdater`; `update-install-seam.ts`, `delivery.ts:46` asset list,
  `local-update-feed.ts:29`, `scripts/generate-update-manifest.mjs:8` are `.exe`/`latest.yml` only.
  Squirrel.Mac refuses unsigned apps, so macOS auto-update needs signing (M; L with signing).
- `.github/workflows/release.yml`: one `windows-latest` job, `pwsh` steps (M to add a macos-14 job).
- `scripts/build-local-update.mjs`, `local-update-package.mjs`, `overseer/credentials.mjs`
  (`APPDATA`), `verify-kit.mjs` Windows-only process queries (S each).

## 5. The Mac itself

Discovered 2026-09-25: Tailscale `jurajs-mac-mini` (100.93.223.7), online, direct path, port 22
open, key `%USERPROFILE%\.ssh\conductor_mac_ed25519`.

### Capability report (Phase 2, 2026-09-25, over SSH as `jurajdubovec`)

| | |
|---|---|
| Hostname | `Mac-mini` (Tailscale `jurajs-mac-mini`) |
| macOS | 27.0 (26A428), kernel Darwin 27.0.0 |
| Hardware | Mac mini M1 (`Macmini9,1`), Apple M1, 8 cores (4 performance), 16 GB RAM |
| Disk | 460 GB, 421 GB free |
| Shell | `/bin/zsh`; non-interactive SSH PATH `/usr/bin:/bin:/usr/sbin:/sbin` |
| Architecture | arm64 native, Rosetta not installed (not needed) |
| Security | SIP enabled, Gatekeeper enabled, FileVault on, application firewall off, sudo needs a password |
| Tailscale | 1.102.4, standalone app, network extension enabled; Remote Login on |
| Power (AC) | `sleep 1` (only awake while the display is on), `displaysleep 10`, `womp 1`, `autorestart 0`, `powernap 1` |
| Dev tools | none: no Command Line Tools (git/python3/xcodebuild are installer shims), no Homebrew, no Node |

The record lives in `<userData>/remote-jobs/nodes.json` as node `mac-mini` and shows in
`machines.list` as `node:mac-mini`. It was registered with `scripts/mac-node.mjs register`
because `nodes.register` is owner/wizard-only and the owner's brief asked for this registration.

### Node environment

`~/.conductor-node/env.sh` (loaded by every job and probe, and from `~/.zshenv` so plain
`ssh mac-mini '<cmd>'` sees the same PATH):

```sh
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
if [ -d /opt/homebrew/opt/node@22/bin ]; then PATH="/opt/homebrew/opt/node@22/bin:$PATH"; fi
export PATH
```

### Live remote jobs (Phase 6)

Run through the app's `nodes.run` and through `scripts/mac-node.mjs`, 2026-09-25:

| Job | Result |
|---|---|
| `uname -mrs; sw_vers …; echo … >&2`, requires `macos, apple-silicon` | succeeded, routed to mac-mini, both streams captured, 1.7 s |
| `exit 7` | failed, exit 7 |
| `sleep 601`, timeoutSec 5 | timed-out after 6.0 s, stopped by the node |
| two background sleeps + `wait`, cancelled after 4 s | cancelled, whole process group stopped |
| `nohup sleep 604 &` then exit 0 | succeeded; the left-behind child was killed |
| `sleep … ; wait`, local `ssh.exe` killed mid-run | lost; the Mac saw stdin EOF and stopped the group |
| requires `macos, xcode` | refused: "No online node with macos, xcode. mac-mini lacks xcode." |

After each run, `pgrep` found no leftover processes on the Mac and `~/.conductor-node/jobs` was empty.
The first live run showed bash's `Terminated: 15` notices in job stderr; fixed in e976f9f.

### Bootstrap (Phase 3)

Inspected first; installed only what the repo needs, all native arm64:

- **Command Line Tools 27.0** (Apple Git 2.54) and **Homebrew 7.0.6** at `/opt/homebrew`: installed by
  the owner with the Homebrew installer (it needs the Mac password; sudo is not passwordless, and the
  password was never stored). Homebrew is also on the login-shell PATH through `~/.zprofile`.
- **Node 22.23.3 / npm 10.9.9** (`brew install node@22`, run as a remote job): Node 22 is what
  `release.yml` builds with.
- Not installed: Rosetta, Xcode, `gh` (the node gets commits by push, so it needs no GitHub
  access), any GUI app or background daemon.
- Owner power settings: `sudo pmset -c sleep 0 autorestart 1` (confirmed `sleep 0`, `autorestart 1`).

### Conductor on the Mac (Phase 4)

All run as checkout jobs through `nodes.run`, at e976f9f pushed from MAIN into the Mac's own
checkout `~/conductor-node/work/conductor`:

| Step | Result |
|---|---|
| `npm ci` | PASS, 506 packages in 18 s; node-pty resolves its `darwin-arm64` prebuild |
| `tsc --noEmit` | PASS |
| `electron-vite build` | PASS (12.8 s) |
| `vitest run` | 3701 / 3737 pass, 36 fail in 13 files (whole suite in about 40 s) |
| `npm run test:scripts` | 91 pass, 1 fail, 11 skipped (Windows-only) |
| `electron-builder --mac dir --arm64` (unsigned) | PASS: 411 MB `Conductor.app`, Mach-O arm64, ad-hoc signed; the binary runs (Electron 37.10.3, darwin arm64) |

What failed on macOS, grouped by cause (recorded as tasks below; none was changed here, because each
belongs to another area's files):

1. **Paths compared without resolving symlinks** (about 23 tests): macOS's temp folder is
   `/var/folders/…` and `/var` is a link to `/private/var`. The file-drop move guard reports
   "Symbolic-link file drops are not moved", the local update feed reports "folder is redirected",
   and path-relative listings come back empty. Files: `file-drop-move`, `file-drop-cross-volume`,
   `prompt-context`, `local-update-feed`, `durable-jobs/handoff`, `local-models/context-management`,
   `output-budget`, `bounded-tools`. With `TMPDIR=/private/tmp` all 8 files pass. The product has
   the same fault for any project under a linked folder, so both sides should be resolved with
   `realpath` before comparing.
2. **Windows path forms asserted on POSIX** (12 tests, `remote-control-host.test.ts`): `C:x`,
   `\\server\share` and `..\..` are ordinary file names inside the workspace on POSIX, so the
   host correctly allows them there. These cases should run only on win32, with a POSIX case for `../`.
3. **Local models are Windows-only** (`local-models/paths`, `local-models`, `sandbox-startup`): drive
   letters, `Docker Desktop.exe`, `.ps1` setup.
4. **`scripts/overseer/goals/local-qwen-faktury.json`** holds Windows absolute paths, so
   "shipped goal files are valid" fails on POSIX.
5. **`providers/grok.test.ts`** "Edit allows in-workspace edits itself…" times out on every run on
   the Mac (4 s synthetic-protocol wait). Not diagnosed yet.
6. **Packaging: node-pty's `spawn-helper` has no execute bit** (`-rw-r--r--` after `npm ci` and in the
   package). With it, every terminal fails with `posix_spawnp failed`; after `chmod +x` a pty spawns
   (`pty says: pty-ok`). Fix: `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper` in a
   postinstall and an electron-builder afterPack hook.

Not attempted, needs a decision: a signed/notarized DMG (Developer ID), a `mac` block and icon in
the build config, `MacUpdater`, a macOS job in `release.yml`, and launching the GUI on the Mac (it
would open over whatever is on the Mac's screen; a parked smoke run is the way).

### Tasks from Phase 4 (for the controller to file)

| Id | Task | Size |
|---|---|---|
| mac-realpath | Resolve symlinks (`realpath`) on both sides of project/drop/feed root comparisons; realpath temp fixture roots in tests | S |
| mac-host-path-tests | `remote-control-host.test.ts`: Windows path-form cases win32-only, add POSIX `../` cases | T |
| mac-overseer-goal | Make `local-qwen-faktury.json` portable or skip non-portable goals on POSIX | T |
| mac-grok-test | Diagnose the Grok ACP fixture timeout on macOS | S |
| mac-spawn-helper | `chmod +x` node-pty `spawn-helper` (postinstall + afterPack) | T |
| mac-packaging | `mac` build block (dmg+zip, arm64), `.icns`, entitlements, signing and notarization with the owner's Developer ID, `MacUpdater`, macOS release job | M–L |
| mac-runtime | Section 4's runtime list: runtime-host launcher on darwin, PATH import from the login shell, traffic lights, default terminal and PowerShell schedules | S each |

### Unattended operation (Phase 8)

| Check | State |
|---|---|
| Sleep on AC | `sleep 0` (owner) |
| Restart after power loss | `autorestart 1` (owner); `womp 1` |
| SSH | Remote Login is a launchd system service, so it is up whenever the Mac has booted |
| Dev environment over non-interactive SSH | `~/.zshenv` → `~/.conductor-node/env.sh`: plain `ssh mac 'node -v'` finds Node 22, npm, brew, git |
| No zombies | jobs run in their own process group; timeout, cancel, lost connection and normal exit all kill the group; verified with `pgrep` |
| Security | SIP and Gatekeeper left on; nothing disabled |
| Tailscale after reboot | Tailscale.app (standalone 1.102.4) opens at login through its registered login-item helper, which needs a logged-in session |
| Boot without a person | **not yet**: FileVault is on, so after any reboot the Mac waits at its own password screen, and no SSH or Tailscale comes up until someone types the password |

`nodes.list` reports all of this as `readiness` (checks, `ready`, and `missing` in words) from every
probe, which is the Mac half of feature `always-on-machines`.

#### Owner step: FileVault off and automatic login (owner decision 2026-09-25)

The owner decided the Mac must be on whenever it is needed. That means FileVault off plus
automatic login, so after a power cut the Mac boots straight into the owner's session, and
Tailscale.app (a login item) connects. The trade-off, stated once: anyone with physical access to
the Mac gets a logged-in session and an unencrypted disk. In Windows Terminal on MAIN:

```
ssh -t -i %USERPROFILE%\.ssh\conductor_mac_ed25519 jurajdubovec@jurajs-mac-mini
sudo fdesetup disable
fdesetup status
sudo sysadminctl -autologin set -userName jurajdubovec -password -
sudo shutdown -r now
```

- `fdesetup disable` asks for the Mac password. On Apple silicon it finishes within minutes. Run
  `fdesetup status` until it says `FileVault is Off.` before the next line: macOS refuses automatic
  login while FileVault is on or still changing.
- `sysadminctl -autologin … -password -` asks for the Mac password once more. macOS keeps it for
  automatic login (`/etc/kcpassword`); Conductor never sees or stores it.
- The restart is the test: once the Mac comes back, `nodes.probe` should show it online with
  `boot-unlock` and `tailscale` ok, without anyone touching the Mac.
- Tailscale: the standalone app cannot run before login, but with automatic login it does not need
  to. The open-source `tailscaled` system daemon (`brew install tailscale`, run as root) would come up
  before login, but it replaces the app (both cannot run) and needs its own sign-in. Only worth it
  if automatic login is ever turned off again.

## 6. Phase 10 report (2026-09-25)

**MAC NODE**
- Name: Mac mini (M1), node `mac-mini` (`node:mac-mini` in `machines.list`); hostname `Mac-mini`
- Tailscale hostname: `jurajs-mac-mini` (100.93.223.7, direct path)
- macOS 27.0 (26A428); architecture arm64 (native, no Rosetta)
- Hardware: Macmini9,1, Apple M1, 8 cores (4 performance), 16 GB RAM, 460 GB SSD (420 GB free)

**CONNECTIVITY**
- Tailscale: PASS
- SSH (key only, `jurajdubovec`, host key pinned in Conductor's known_hosts): PASS
- Remote command execution (bounded jobs, timeout, cancel, lost connection, no leftovers): PASS

**DEVELOPMENT**
- Git (Apple Git 2.54, Command Line Tools 27.0): PASS
- Node (22.23.3, Homebrew `node@22`, arm64): PASS
- Conductor dependencies (`npm ci`): PASS
- Build (`tsc`, `electron-vite build`, unsigned arm64 `Conductor.app`): PASS
- Tests: FAIL. 3701 of 3737 vitest tests and 91 of 92 script tests pass; the 37 failures have 6 known causes, filed as tasks in section 5 (mostly the `/var` symlink and Windows-only tests). Packaged terminals need the `spawn-helper` execute-bit fix.

**CONDUCTOR INTEGRATION**
- Machine registered (node record with facts, capabilities, readiness, last seen, current jobs; shown in `machines.list`): PASS
- Remote jobs (`nodes.run` through the app; records and logs in `<userData>/remote-jobs`): PASS
- Result/log collection (exit code, stdout/stderr tails, full logs, `nodes.log`): PASS
- macOS-targeted dispatch (`requires: ["macos"]` → mac-mini; unmet requirements refused by name; commit pushed to the node's own checkout): PASS

**BLOCKERS**
- FileVault off + automatic login (owner decision, needs the Mac password): the command block in section 5. Until then an unplanned reboot leaves the Mac at its password screen, unreachable.
- Signed macOS builds need the owner's Apple Developer ID (not requested yet).
