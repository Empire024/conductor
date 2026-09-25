# Owner goal 2026-09-25: the M1 Mac mini as a Conductor node

(Owner's brief, recorded verbatim in substance; all requirements kept.)

We have a new second-hand **Apple M1 Mac mini**, freshly set up and joined to our existing **Tailscale network**.
macOS **Remote Login / SSH is enabled** for the owner's Mac admin account.

## Goal
Turn this Mac mini into a **first-class remote development, build, and testing machine for Conductor**. The Windows
MAIN machine should use it transparently over Tailscale to: execute commands on macOS; build Conductor on Apple
Silicon; run macOS-specific tests; test cross-platform behavior; run scripts/jobs remotely; inspect logs/results;
eventually dispatch agents/tasks to the Mac; use it as a persistent member of the Conductor machine fleet.
The Mac is not a standalone workstation. It is primarily a **remote Conductor development node**.

## Phase 1 — Discover the Mac
`tailscale status`; identify the Mac node; record Tailscale hostname, IP, OS, connectivity. Don't ask for values that
can be discovered. Verify ping/Tailscale connectivity and SSH. Use the Tailscale hostname, not the 100.x IP.
Do NOT expose SSH to the public internet.

## Phase 2 — Verify remote control
SSH with the existing Mac admin account. Verify hostname, macOS version, architecture (arm64), Apple Silicon model,
disk, RAM, CPU, shell, network and Tailscale connectivity. Create a machine capability report and persist it in
Conductor's machine/device records if such infrastructure exists. If Conductor already has remote-machine
abstractions, use and extend them instead of building a parallel system.

## Phase 3 — Bootstrap the development environment
Inspect before installing. Install only what Conductor development needs: Xcode Command Line Tools, Homebrew (native
Apple Silicon), Git, Node.js matching Conductor's required version, npm/package tooling, GitHub CLI if useful, other
dependencies the repo actually requires. Native arm64; no Rosetta/x86 without a concrete reason. Avoid duplicate
package managers, unnecessary GUI apps, random background daemons, unnecessary cloud services. Document significant
changes.

## Phase 4 — Bring Conductor onto the Mac
Clean checkout/worktree for this machine. Install dependencies; verify tooling; lint/typecheck; unit tests; attempt a
macOS build; identify Windows-only assumptions and Apple Silicon/macOS incompatibilities; fix straightforward
cross-platform problems where safe. No silent large architectural changes to force a build. Record real
incompatibilities as tasks.

## Phase 5 — Integrate the Mac into Conductor's remote-machine system (important)
Not merely "we can SSH into a Mac": the Mac becomes a durable resource inside Conductor. Reuse the existing
remote-machine / Tailscale architecture. Conductor should know, conceptually, a `Machine`: id, name, hostname,
platform, architecture, Tailscale identity/address, online/offline state, capabilities, available compute,
repository/workspace paths, supported task types, last seen, current jobs. The Mac shows up alongside existing
machines. Conductor can decide "this task requires macOS → dispatch it to the Mac mini" (macOS build, Apple Silicon
compatibility check, macOS-specific Electron behavior, packaging, platform-specific automated tests, future
iOS/Xcode work). Don't duplicate systems.

## Phase 6 — Remote execution
Reliable: Windows Conductor → Tailscale → Mac → bounded job → capture stdout/stderr and exit code → return result →
persist logs/results in Conductor. Test with harmless commands, then project commands. Jobs need timeouts,
cancellation, clear failure states, stdout/stderr capture, working-directory awareness, no infinitely hanging SSH
sessions.

## Phase 7 — Repository strategy
Don't copy the whole repo over SSH per task. Inspect the existing Git/worktree architecture; simplest robust approach:
the Mac keeps its own checkout/worktree, tasks reference commits/branches/worktrees, the Mac fetches the Git state it
needs, artifacts/results come back separately. No Git conflicts between Windows and Mac. Jobs/resources durable,
processes disposable.

## Phase 8 — Unattended operation
Doesn't sleep unnecessarily while plugged in; Tailscale reconnects after reboot; SSH stays available; dev environment
survives reboot; required paths available in non-interactive SSH shells; Homebrew/Node work over SSH, not just
Terminal.app; failed jobs leave no zombie processes. Don't weaken macOS security: no disabling SIP, Gatekeeper,
firewall or similar without an extremely strong reason and explicit owner approval.

## Phase 9 — Cross-platform testing
Once Conductor builds on the Mac: from Windows trigger something like `Run on: mac-mini` and receive task status,
logs, result, and build/test artifacts. Architected so additional machines work later; not hardcoded to one Mac.

## Phase 10 — Report
MAC NODE (name, Tailscale hostname, macOS version, architecture, hardware); CONNECTIVITY (Tailscale, SSH, remote
command execution: PASS/FAIL); DEVELOPMENT (Git, Node, Conductor dependencies, build, tests: PASS/FAIL); CONDUCTOR
INTEGRATION (machine registered, remote jobs, result/log collection, macOS-targeted dispatch: PASS/FAIL); BLOCKERS
(only genuine ones needing the owner).

## Autonomy rules
Work autonomously; don't ask what the repo, the machine, Tailscale or safe tests can answer. For a GUI-only
permission dialog, password prompt, Apple ID, GitHub authentication or another step that genuinely needs the owner:
finish everything else first, then name the exact blocked step and exactly what to click/type, and resume once
possible. Don't silently substitute another machine or a cloud service if the Mac fails.

## Architectural principle
"I own several computers. Conductor sees them as one pool of capabilities." Windows stays the primary control
surface; the M1 Mac mini becomes the persistent macOS / Apple Silicon build and test node, reachable privately
through Tailscale.

## Discovered 2026-09-25 (orchestrator)
- Tailscale: `jurajs-mac-mini`, 100.93.223.7, macOS, online; `tailscale ping` 86 ms (direct path). Port 22 open.
- Windows MAIN is `e-box` (100.72.193.87). Other nodes: `empirium` (Windows, offline 2 d), `iphone-13-mini`.
- SSH: the Mac offers publickey, password, keyboard-interactive. The Mac username is not yet known (`juraj` refused
  the new key). Key for Conductor: `%USERPROFILE%\.ssh\conductor_mac_ed25519` (ed25519, comment
  conductor-main@e-box); it must be added to the Mac account's ~/.ssh/authorized_keys once by the owner.
