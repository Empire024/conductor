# Sidebar themes and installed version visibility

Jump to, selected projects, and selected workspaces retained dark hard-coded surfaces while day mode assigned dark text. Sidebar surfaces, labels, borders, icons, keyboard hints, and hover/selection states now use the selected theme tokens. The status bar and title branding also follow the theme. The previously undefined hover-surface token now resolves to the theme's secondary surface.

Both installed-version badges use legible 10px monospaced digits and cannot shrink. The bottom version stays visible while checking and when the latest-installed acknowledgement is shown; its tooltip also names the installed version.

## Update investigation

On 2026-09-08 the owner's installed executable reported 0.1.15 and the native updater cache named Conductor-Setup-0.1.15.exe. No custom feed was configured. GitHub's latest release was also 0.1.15 with all three updater assets. A transport failure or a ceiling at 0.1.5 was not reproduced. No updater source or version comparison was changed.

`scripts/smoke-release-discovery.mjs` uses the production UpdateManager, native NsisUpdater, Electron HTTP transport, and public GitHub provider in disposable profiles. Its bootstrap simulates current installed-version metadata only, forbids downloads and installation, and isolates the cache. Automatic startup discovery offered 0.1.15 from simulated 0.1.5; simulated 0.1.15 completed a check and returned up to date. Both results require a completed-check timestamp. This does not execute an older application's binary or install an update.

## Validation

- `npm.cmd test`: 397 Vitest tests in 50 files plus 13 Node tests passed.
- `npm.cmd run build`: type checking and production main, preload, and renderer builds passed.
- `node scripts/smoke-theme-sidebar.mjs`: all three themes in both day and night; normal, selected, and hovered project/workspace/search text has at least 4.5:1 contrast against its actual surface. Day controls retain light surfaces. Both version badges are readable, and manual checking preserves the full version. No renderer errors or provider turns.
- `node scripts/smoke-release-discovery.mjs`: two real network discovery checks; no downloads or installation.
- Native Electron screenshot visually inspected. The screenshot's 0.1.15 label is a controlled UI fixture, not a claim that the checkout was packaged at that version.

Evidence: [day theme](evidence/theme-sidebar/night-owl-day.png), [theme checks](evidence/theme-sidebar/results.json), [pre-publication release discovery](evidence/theme-sidebar/release-discovery.json).

The release state was tested in an isolated worktree, preserving unrelated unfinished edits in the shared main checkout.
