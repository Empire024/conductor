# Verification without repeated full suites

Each local `git.ship` freezes the requested files as Git blobs and tests that isolated snapshot. It always typechecks and bundles Conductor, running those checks alongside tests. Narrow application changes run Vitest's related import graph plus every touched test file. The graph is computed with Vitest's public specification API without collecting or executing tests. The selected paths and command are recorded in the delivery log.

This applies with or without an explicit `paths` argument. `paths` still matters in a shared checkout: it selects the files to freeze and commit, preserving other agents' edits.

Full Vitest and `test:scripts` run instead when:

- publishing, changing shared types, preload, package/lock/config files, or core main-process wiring, session storage, agent control, delivery, or the updater;
- the graph cannot be computed, returns invalid paths, includes a deleted or renamed test, or finds no tests for changed application code;
- related tests fail. This expanded run diagnoses the failure; an initially failing related test still blocks the commit even if the full rerun passes.

Changes to scripts also run the small `test:scripts` suite, because script tests include filesystem and subprocess contracts that an application import graph cannot capture. Documentation and assets with a valid empty graph need no Vitest run. Explicit project verification commands remain honored. Build/typecheck failures stop verification promptly; no failed check is turned into a success by a fallback.

The earlier pipeline already used related tests for explicitly scoped, non-core changes. Its gaps were unscoped ships always running the full suite, incomplete core coverage, silent empty related sets, and no full fallback or guaranteed touched-test union. This change closes those gaps; it does not promise that graph discovery makes an already scoped related run faster.

## Batch acceptance before installation

The controller calls `app.update({commit, smoke:[...], offer:true})` once after the batch's local commits are ready. The exact clean candidate runs `npm test` (full Vitest plus script tests), then packages and runs the named parked smokes one at a time through `smoke-lock`. `smoke-background-windows` is always included. A cleanup exit 3 is a failed verification, not a passing smoke.

`app.update.status` exposes stage `test`, the full suite's `verificationLog`, per-smoke logs and `verified`. A failure identifies the candidate commit and builder conversation to contact. Failed tests stop before packaging; failed smokes leave a quiet, unverified package. Installed-app local update installation refuses an unverified candidate, including a forced agent install. Automatic installation on quit is enabled for local updates only when they are verified, offered, and idle. Releases retain their existing behavior.

The full suite runs once per candidate build, not once per narrow ship. A retry reruns acceptance; there is no stale verification cache. Builds of the dirty shared checkout remain unverified. The owner or controller offers only the final candidate, so unfinished builds do not interrupt the owner's work.

## Measurements

See `delivery-test-policy-measurements.json` for measured host delivery and recent-commit change-set replays. Replays use a fixed isolated snapshot, not historical revisions, and run tests/typecheck/bundle with the same overlap as `git.ship`. The full baseline is measured once and reused as the comparison rather than wasting two more identical full-suite runs. Preflight, commit, packaging, and smokes are reported separately from per-ship verification.

| Recent change set | Full baseline verification | Related/touched test files | New verification wall time |
| --- | ---: | ---: | ---: |
| `3f475a2` — browser/sidebar close | 344.3 s | 3 + script suite | 26.3 s |
| `31414df` — phone markdown/dictation | 344.3 s | 4 + script suite | 28.9 s |

The baseline is real delivery `680fb1c`: full tests/script suite 344.286 s, parallel typecheck/build 25.752 s, entire ship 352.366 s. Replays include graph discovery (6.1/5.9 s), fresh incremental typecheck caches, and bundling. These observed timings compare the previous unscoped/full route with the new narrow route. Explicitly scoped narrow ships already had related tests, so this table is not a claim of a twelvefold improvement for those ships. Snapshot and machine load differ; core/full fallback still takes the full-suite time.

Reproduce narrow replays with `node scripts/measure-delivery-test-policy.mjs <recent-sha> <recent-sha>` in a clean isolated snapshot. Full logs remain under `.conductor-scratch/policy-measurements/`. Core changes intentionally retain full verification; a fallback increases runtime to preserve confidence.
