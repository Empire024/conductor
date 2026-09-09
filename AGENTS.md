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
