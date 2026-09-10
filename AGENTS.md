# Conductor delivery contract

Conductor is a local desktop application for its owner. GitHub is used only as the transport for installed-app updates.

## Definition of done

- A completed task is not done when it only exists in the working tree or in a local build.
- Before reporting completion, run the relevant tests and `npm.cmd run build`, commit the finished change, and push `main` to `origin`.
- Every push to `main` automatically creates the next patch release through `.github/workflows/release.yml`. Do not manually edit the package version or create a release tag for routine task delivery.
- Verify that the release workflow completed and that its GitHub release contains the installer, blockmap, and `latest.yml`. If publishing is blocked, say that the task is not yet delivered.
- Never tell the owner to run a development checkout, preview build, or installer to receive a completed task. The installed app must receive it through its updater.
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
