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

### Local full suite (2026-10-17)

`git.ship` and `app.update` always run Vitest with `CI=1` (`src/main/delivery.ts`): two workers and 60 s test/hook timeouts. A plain local `npm test` used half the logical cores (12 workers on this 24-thread Windows 11 machine) with 5 s/10 s timeouts. The SQLite/fsync fixtures contend the same way on a developer machine once the run fans out, so every test got slower as workers were added. The 5 s limit had no room for that, and timeouts were the only failures. Full-suite runs on the same tree, one after another, machine otherwise in normal use:

| Mode | Workers | Timeouts (test/hook) | Failed tests | Sum of test time | Wall |
| --- | ---: | --- | ---: | ---: | ---: |
| local, before | 12 | 5 s / 10 s | 332 (all timeouts) | 4452 s | 459 s |
| local, `--maxWorkers=6` | 6 | 5 s / 10 s | 74 (all timeouts) | 2949 s | 555 s |
| local, `--maxWorkers=4` | 4 | 5 s / 10 s | 15 (all timeouts) | 1539 s | 422 s |
| `CI=1` (git.ship) | 2 | 60 s / 60 s | 0 | 1068 s | 601 s |
| local, 4 workers, 60 s | 4 | 60 s / 60 s | 1 (`database-wal`) + 4 RPC errors | 2095 s | 558 s |
| + `database-wal` fix | 4 | 60 s / 60 s | 0 + 2 RPC errors (exit 1) | 1557 s | 424 s |
| local, after (`npm test`) | 4 | 60 s / 60 s | 0 (exit 0) | 1433 s | 394 s (399 s with `test:scripts`) |

`structured-store.test.ts` shows the contention: alone it takes 9.8 s for 28 tests, and with 12 workers it took 262 s and 27 of its tests timed out. Even with two workers some fixture-heavy tests run over 5 s (p99 18 s), so a 5 s limit was too tight at any worker count. `vitest.config.ts` now caps local runs at four workers (`min(4, half the logical cores)`), and local runs use the same 60 s test and hook timeouts as CI. CI and `git.ship` keep their settings, so their timings do not change. A test that actually fails still fails on its assertion. Only a slow test gets the extra time.

Two further failures only showed up once the timeouts were gone:

- `database-wal.test.ts` made 3000 separately fsynced commits: 19 s with two workers, 60 s with four, 94 s with six. It now writes the same 12 MB in 300 commits (0.6 s alone) and asserts the same things.
- `[vitest-worker]: Timeout calling "onTaskUpdate"` errors (12 with 12 workers, 2–4 with four) made the run exit 1 even though every test passed. A worker waits at most 60 s for the main process to answer each test report, and Vitest has no setting for that limit. Tagging the forks pool's rethrow traced the errors to `agent-control.test.ts`. Its synchronous SQLite tests chain through resolved promises, so the worker's event loop went 10.8 s without turning even when the file ran alone, and the file runs about 4.6× slower inside the full suite. When the loop finally turned, the expired timer fired before the answer already waiting in the pipe was read. `src/test-event-loop-yield.ts` (a `setupFiles` entry) yields one real macrotask after every test. That cut the file's longest stall from 10.8 s to 0.6 s at no cost: 51.4 s against 52.0 s.

Reproduce narrow replays with `node scripts/measure-delivery-test-policy.mjs <recent-sha> <recent-sha>` in a clean isolated snapshot. Full logs remain under `.conductor-scratch/policy-measurements/`. Core changes intentionally retain full verification; a fallback increases runtime to preserve confidence.
