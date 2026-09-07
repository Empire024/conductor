# Local builds through the installed updater

In the installed Conductor app, **Settings > Updates > Include local test builds** controls the private local feed alongside normal GitHub releases. It is enabled by default for this owner-operated app and can be turned off. **Open local builds folder** opens the feed location. A local build is clearly labeled as a test build; receiving one is not evidence that all provider features passed live acceptance.

For the developer producing a local build, run from the repository:

```powershell
npm.cmd run update:local
```

This runs the production build and creates a real Windows x64 NSIS installer and blockmap. It publishes them to `%APPDATA%\Conductor\local-updates`, replacing the feed descriptor only after both immutable artifacts are present and SHA-512 hashed. The installed app discovers it, shows **Update pending**, and uses its normal download / **Restart to update** flow. The owner does not need to start a development checkout or run an installer manually. An older installed release needs the initial GitHub update that introduces local-feed support; local packaging cannot add that support to an already-running old binary.

Local versions use the next stable patch with a monotonic prerelease suffix, for example `0.1.5-local.1788745961011`. Selection considers the source package, installed executable, existing local feed, and public GitHub latest-release metadata. Another local build increases the suffix, not the patch. Stable `0.1.5` supersedes those `0.1.5-local.*` builds normally. Source `package.json`, the lockfile, Git tags, and GitHub releases are not modified by this command. The regular push-to-main patch release workflow is unchanged.

The developer command supports `--feed-dir <absolute-path>` for isolated testing, `--no-github` for offline version selection, and `--base-version <known-installed-or-stable-version>` when executable metadata cannot be read. A custom feed is developer/test-only: normal installed windows use the default folder, and there is no custom-folder picker. An isolated test app can set `CONDUCTOR_TEST_USER_DATA` and point the packaging command at its matching `local-updates` subfolder. The feed is not a network publishing endpoint. The default command only reads public release metadata; it neither reads credentials nor invokes any coding provider. Build outputs remain under `release/local-builds/<version>`. It does not delete previous packages or terminate the installed app.

## Offline packaging verification

After a real local package exists, `npm.cmd run test:update-download` verifies the real Electron Download update action and native NsisUpdater cached bytes in a disposable profile. It simulates an old installed version and explicitly disables installation; it does not replace or close the owner's installed app. `npm.cmd run test:update-ui` needs no real package and tests discovery/settings with synthetic non-executable metadata. Neither command invokes a coding provider.

```powershell
node --test scripts/local-update-package.test.mjs
```

These tests use explicitly synthetic, non-executable bytes to check version ordering, metadata overrides, hashes, atomic descriptor publication, immutable historical packages, incomplete-build rejection, concurrent/out-of-order publication rejection, and junction rejection. They do not establish that an installer successfully updated a running app; actual packaging and installed-updater evidence belong in the QA report.

Publication takes an exclusive `.conductor-local-publish.lock` in the feed. If a publisher is forcibly killed during its final copy, first verify no local build command is running before removing only that stale lock file. The previous descriptor remains usable; versioned packages are never overwritten or recursively deleted by the script.

The descriptor contract is `conductor-local-build.json`, schema version 1: `version`, `createdAt`, `commit` (or null), optional `dirty`, installer and blockmap basenames, and SHA-512 / byte sizes for both. The backend validates the feed and serves only those exact artifacts over its private read-only loopback update endpoint; transcript content cannot select executables or start an installer.
