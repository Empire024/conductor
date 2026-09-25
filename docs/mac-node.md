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
Every JSON write is temp-file + rename.

## 4. Windows-only assumptions that affect a macOS build (from reading the code)

To be confirmed on the Mac in Phase 4. Size: T trivial, S small, M medium, L large.

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

_Phases 2–4, 8 and the live job tests follow once the key is authorized and the user name is known;
the Phase 10 report is appended here._
