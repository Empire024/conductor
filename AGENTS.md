# Conductor delivery contract

Conductor is a local desktop application for its owner. GitHub is used only as the transport for installed-app updates.

## Definition of done

- A completed task is not done when it only exists in the working tree or in a local build.
- **Deliver with one call:** app-control `git.ship({message, paths})` (then `git.ship.status({waitSeconds: 100})` until it settles). Conductor runs the tests, build and commit on the host and returns the commit or the exact failure. Pass `paths` for your own files when other agents have work in the tree; it is then verified in an isolated copy. Do not ask to escalate the sandbox for `git`/`gh`, and do not do these steps by hand unless app control is unavailable. The owner can do the same from the Source control panel.
- **A delivery is a local commit.** Routine deliveries do not push and do not build a release: a hosted release build per push was paying for releases nobody installed, four coworkers at a time. `main` is pushed and the GitHub release built only when the owner asks for one, or when a task explicitly targets other devices: `git.ship({message, paths, publish: true})` (or the Source control panel's Publish switch) pushes, starts `.github/workflows/release.yml` (it runs only on request, never on push) and verifies that the release holds the installer, blockmap and `latest.yml`. Do not manually edit the package version or create a release tag.
- **Chain of command for a swarm:** a controller that dispatches coworkers lets each of them test and commit locally; when the batch is done and verified together, the controller (or the owner) publishes once. Four coworkers must never mean four releases.
- **Dispatched Claude and Codex coworkers run in Auto.** `tabs.open` and `router.dispatch` open a native coworker on the highest mode its provider offers; a coworker on ask or edit mode is the owner clicking Allow for every command. Pass `exactPermission: true` with a lower `permission` only for an agent that cannot be trusted at all. A local model has no Auto and keeps its sandbox rules.
- The installed app on this machine receives finished work from the checkout through `app.update` (the local update feed shows `Update pending`), not from GitHub. Never tell the owner to run a development checkout, preview build, or installer to receive a completed task.
- When you do publish, verify that the release workflow completed and that its GitHub release contains the installer, blockmap, and `latest.yml`. If publishing is blocked, say so; the local commit still stands as delivered.
- Preserve unrelated work in the shared working tree. Only publish a coherent, tested state; coordinate rather than discarding another agent's changes.

## Automation must not take the desktop

- Smoke scripts and probes drive a real window, but never over the owner's screen. A launch with
  `CONDUCTOR_TEST_USER_DATA` set parks its window off every display, out of the taskbar, and never
  activates it. `scripts/smoke-background-windows.mjs` is the regression guard.
- Do not tell an agent to run `npm run dev` to look at a change. That opens a normal, focused
  window over whatever the owner is doing. Use the smoke scripts, or set
  `CONDUCTOR_BACKGROUND_WINDOWS=1` to park a dev launch too.
- `CONDUCTOR_BACKGROUND_WINDOWS=0` forces a visible window when someone deliberately wants to watch
  a run.

## Update experience

- Running installed windows must discover releases automatically and show `Update pending`.
- A newly launched installed app must check shortly after startup and offer the update.
- Users may opt into automatic update downloads; downloaded updates install on normal app exit or via `Restart to update`.

## Ask the owner only when asking is the shortest path

- Prefer the obvious equivalent route over a question. A denied scratch write means write the scratch file somewhere else; a missing optional tool means use the one that is installed. Take the detour, say in one line that you took it, and keep going.
- Ask when the answer changes what you do *and* you cannot get it yourself: a credential only the owner holds, a destructive or outward-facing action, a decision between materially different pieces of work.
- Ask *before* the expensive detour, not after it. Reconstructing by inference what one question would have answered is the failure mode, and it usually produces a weaker answer too.
- Never silently downgrade the approach. Switching from "read the real logs" to "guess from the theory I was given" is a change to the task and the owner decides it. Switching scratch directories is not.
- When you do ask, make it cheap to answer: say what you were blocked on, why you need it, and the concrete ways to unblock you.
- A denied call is not a reason to stop with nothing delivered. Finish everything that does not depend on the answer, then ask.

## Machine limits

- `docs/machine-profile.md` records what this computer can carry: 12 GB of VRAM, one llama.cpp server at a time, four native coworkers comfortably, smokes one at a time. Read it before starting a local model, a swarm, or anything that downloads model files.
