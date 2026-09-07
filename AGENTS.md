# Conductor delivery contract

Conductor is a local desktop application for its owner. GitHub is used only as the transport for installed-app updates.

## Definition of done

- A completed task is not done when it only exists in the working tree or in a local build.
- Before reporting completion, run the relevant tests and `npm.cmd run build`, commit the finished change, and push `main` to `origin`.
- Every push to `main` automatically creates the next patch release through `.github/workflows/release.yml`. Do not manually edit the package version or create a release tag for routine task delivery.
- Verify that the release workflow completed and that its GitHub release contains the installer, blockmap, and `latest.yml`. If publishing is blocked, say that the task is not yet delivered.
- Never tell the owner to run a development checkout, preview build, or installer to receive a completed task. The installed app must receive it through its updater.
- Preserve unrelated work in the shared working tree. Only publish a coherent, tested state; coordinate rather than discarding another agent's changes.

## Update experience

- Running installed windows must discover releases automatically and show `Update pending`.
- A newly launched installed app must check shortly after startup and offer the update.
- Users may opt into automatic update downloads; downloaded updates install on normal app exit or via `Restart to update`.
