# Local safety repair: implementation report, 2026-09-28

Implementer: `agent_mul0rh1m_4tixc3d` (Claude Opus 5.5). Task: `task_mul0ri57_nxypogo`. Controller: `agent_mukzx5d8_3g3mild`, now succeeded by `agent_mul0uy09_0oxc7kc`. Contract: `2026-09-28-local-safety-review.md`, used as the acceptance criteria. Earlier implementations were not treated as precedent.

**Status: bounded repair ready for independent review. Live gate CLOSED.** No live server, fault, smoke, Electron, build, git or `git.ship` was run. The only verification is focused unit tests with injected processes. Three of those tests also read real Windows process identities (read-only) and check that the kill helper refuses a wrong identity on the test's own child. The quarantined `.conductor-scratch/acceptance-immediate/run.mjs` was read and never run; it is unchanged, as are all historical artifacts.

## Changed paths (owned list only)

| Path | Change |
| --- | --- |
| `src/main/local-models/llama.ts` | One bounded stop path, `stopOwnedServer`, used by `stopServer` (local.stop, CLI, schedules) and by make-room. A launch now persists `generation` and OS `identity` (creation time and image). `processAlive` treats EPERM as alive. |
| `src/main/local-models/llama-stop.test.ts` (new) | 32 tests with injected inventory, kill, port and clock. One read-only real-process test on Windows. |
| `scripts/verify-kit.mjs`, `scripts/verify-kit.test.mjs` | Identity-carrying inventory and `ownedTree`; roots registered at launch and relaunch; `trackDescendants`; `terminateIdentity`; fail-closed `safeClose`; `finish()` fails an unaccounted cleanup. |
| `scripts/lib/stop-durable-smoke-server.mjs`, `.test.mjs` | Numeric parent check replaced by two fresh identity proofs, then an OS-observed exit, then the registry check. |
| `scripts/smoke-durable-jobs.mjs` | Kit-registered roots; identity-bound crash kill (no `taskkill /T`); fault runs require the same job to complete with correct output and exactly one new replacement server; soak uses a measured workload, per-iteration output truth, the full paged ledger, the stage-aware audit and an incremental `soak-ledger.ndjson`. |
| `scripts/lib/durable-attempt-audit.mjs`, `.test.mjs` (new) | Pure ledger auditor, with retained controls for iterations 27, 69, 70 and 77. |
| `scripts/run-local-acceptance.mjs`, `.test.mjs` (new) | Import-safe replacement entry point. It checks the exact grant and admission, owns processes only through the kit's identities, and writes evidence incrementally. |
| `docs/verification/2026-09-28-local-safety-fix.md` | This report. |

## How the termination contract is met

- **Ownership.** Ownership is the run generation plus launch provenance plus the immutable OS identity `(pid, creationTime, executable)`.
  - In `llama.ts`, the identity is read while Node's own child handle pins the pid. If the child cannot be identified, it is killed through that same handle and the start fails, so no server is left running that nothing can stop.
  - In the kit, roots are processes we spawned (pinned) or, for Playwright, a verified descendant of the pinned launcher. A relaunch is accepted only through `registerRelaunch`: same image, created later, and this build on its command line.
  - Descendants are admitted only under identity-verified parents in one snapshot. `trackDescendants` records verified identity triples, never pids.
  - A child created before its parent, a duplicate pid, a missing identity, a reused root, a stale generation, or an instance with only numeric `pids` all get **zero kills** and an `unresolved` entry.
- **Killing.** Kills go through a PowerShell helper that opens **one handle**, reads creation time and image through it, and only then kills and waits **on the same handle**. Holding the handle also stops the pid from being reused while the check runs. There is no `taskkill` and no `/T`.
  - The kit kills leaves first. Depth comes from the verified chain, including for tracked roots; a test caught and fixed a flattening defect here.
  - The helper is bounded. On timeout only the helper itself is killed.
  - POSIX (`llama.ts` only) checks with `ps`, then signals. That leaves a documented **residual race** and is not described as race-free.
- **Truthful and bounded.** `stopOwnedServer` has a hard 20-second ceiling that includes the helper, exit observation and the port check; injected hangs are raced against it.
  - It reports `stopped` only after it observes the process exit **and** the port free. Denied or failed queries count as uncertain, never as absence. An already-exited target needs no kill. A pid now held by another process means ours has exited, and that other process is left alone.
  - Uncertainty keeps the run record, so admission still refuses to start a second server. The record is deleted only if pid, generation and identity are unchanged, so a replacement record survives.
  - Every step goes to `logs/<model>.stop.jsonl` as it happens.
  - `stopServer` **throws** for refused or uncertain stops, so `local.stop` cannot report success.
  - `stopServer` takes the admission lock within the same budget, so a start cannot write a new record mid-stop.
- **Stage-aware audit.** The auditor deduplicates by id, keeps capture order (or seq order), and ignores notice-only "Interrupting" events. It builds per-stage starts, outcomes, credits and charges, and takes the blocked stage from structured `currentStage.id`.
  - A budget block with charged failures below the budget is a violation.
  - An incomplete capture, a gap, a conflict, an unmapped block or a stage budget mismatch is **inconclusive**. A resume that granted new attempts is **excluded**.
  - At soak level the verdict is `FAIL`, `UNVERIFIED` or `PASS`. `EXERCISED` or `NOT EXERCISED` is reported separately.

## Focused evidence (run_and_summarize, logs under `.conductor-scratch/local-assist/`)

| Command | Result | Log |
| --- | --- | --- |
| `npx vitest run src/main/local-models/llama-stop.test.ts src/main/local-models/servers.test.ts` | 35/35 | `2026-09-28T09-10-14-686Z-624d4c.log` |
| `npx tsc --noEmit` | exit 0 | `2026-09-28T09-17-29-473Z-76030e.log` |
| `node --test scripts/verify-kit.test.mjs scripts/lib/durable-attempt-audit.test.mjs scripts/lib/stop-durable-smoke-server.test.mjs` | 78/78 | `2026-09-28T09-25-24-376Z-a30942.log` |
| `node --test scripts/run-local-acceptance.test.mjs scripts/verify-kit.test.mjs` | 55/55 | `2026-09-28T09-26-26-405Z-25fcbc.log` |
| `npx vitest run …llama-stop… …servers… …local-models… …durable-jobs/server-lifecycle…` | 99/100. The **1 expected failure** is below | `2026-09-28T09-26-36-699Z-c8c923.log` |

The contract's required negatives are each asserted with zero kill calls and the record or evidence kept. They include:

- same pid, name and command line with a different creation time
- same pid with a different image
- missing, zero or invalid creation time
- an exited or reused ancestor with a foreign child
- a child older than its parent
- cyclic ancestry
- inventory that fails or is partial at the initial and final checks
- a stale generation
- a null pid, an adopted server, a foreign server, or a server with no identity
- a pid that changes between selection and stop
- a replacement record written during the stop
- a kill helper that fails to spawn, exits nonzero or hangs
- a target that survives
- a port still held after the target exits
- a denied liveness check

Positive controls: the exact owned tree, a delayed successful exit, an already-exited target, a registered same-profile relaunch and tracked orphans.

The audit controls cover:

- the exact retained 27/69/70 cross-stage shapes (their retained fragments are inconclusive, never a violation)
- iteration 77 accepted as 4 starts, 1 credit and 3 charges
- all-uncredited exhaustion accepted
- a premature block after a credit rejected
- a credited rollover followed by completion accepted
- duplicate captures counted once
- truncated, missing or conflicting evidence as inconclusive
- a resume as excluded

The retained fixtures are embedded in the test, because `artifacts/` is gitignored.

## Known consequences and dependencies (controller decisions)

1. **Resolved under the controller's approved expansion (10:00Z).** In `src/main/local-models/local-models.test.ts`, the makeRoom positive case now writes a record with a generation and a probed OS identity for its own sleeper. A new legacy-record test asserts the refusal (`no launch identity … No second server was started`), that the sleeper is still alive, and that the record and port are unchanged.
2. **Resolved under the same expansion.** `src/main/index.ts` local.stop pins the server chosen from `local.servers` (the model, started by Conductor, and the requested pid) and calls `stopServer(target, { expectedPid })`. If that is not exactly one pid, it refuses. `llama-stop.test.ts` covers both the positive case and a record replaced between selection and stop (zero inspections, zero kills, the replacement kept).
3. **Legacy records.** A server started by an older build (no `identity`) can no longer be stopped by Conductor. That is fail-closed by design; the error says to stop it where it was started.
4. **Other smokes** that put pids into `inst.pids` by hand (`smoke-verify-vr2-host`, `-vr2-machine`, `-vr6-recovery`) now get `unresolved` from `safeClose` and a FAIL row from `finish()` instead of pid-based kills. This is intended and those scripts were not edited. Any new kit smoke must register roots through the kit.
5. **Soak scheduling.** The soak needs `--timeout-min >= 390`: a 360-minute measured workload, one last iteration bounded at 20 minutes, and 10 minutes of cleanup. `run-local-acceptance` enforces this, and it conflicts with the plan's `--timeout-min 370`. The controller must reserve the window. The workload is measured on a monotonic clock and never shortened.
6. **Guard scenarios are refused** by `run-local-acceptance`, because `perf-input.mjs` has its own kill paths, which this review did not cover.
7. **Schedules.** `run-local-acceptance` requires schedules to be paused and idle before it starts and records them before and after. Pausing and restoring them stays with the controller.

## Admission reads only the caller's own credential (10:00Z request)

`verify-kit` `loadCheck` no longer reads the installed app's `control-owner.json` and never falls back to it. `midTurnTabs` uses only `suppliedControl()`:

- `CONDUCTOR_CONTROL_ENDPOINT` must be `http://127.0.0.1:<port>/…`.
- `CONDUCTOR_CONTROL_TOKEN` must be present.
- `CONDUCTOR_CONTROL_PROJECT_ID` and `CONDUCTOR_CONTROL_WORKSPACE_ID` are optional and are used as the call scope. A workspace without a project is refused.

These can also be passed as `loadCheck({ control })`. Every project and workspace from `projects.list` must be listed completely. A missing credential, a refused call (for example, cross-project `agents.list` denied to a scoped credential), a malformed list, or an entry without an id or phase makes the tab count **unknown (`null`)**, never zero, so the machine is not quiet. Notes carry the method and status only; the token is redacted.

`judgeLoad` now also refuses when the process inventory is missing or failed, and when the lock holder file is unreadable or has no pid. `listProcesses` is read-only (one CIM query) and fails on a nonzero, empty or malformed answer. No destructive path changed.

A test asserts the kit source contains neither `APPDATA` nor the installed owner-credential path. `run-local-acceptance` already puts the caller's own credential in its own environment, which `loadCheck` reads. Its smoke child gets neither variable, so a smoke's own `loadCheck` reports mid-turn tabs as unknown.

**Unverified for this part:** whether the caller's scoped briefing credential is allowed to list agents in sibling projects. If it is not, admission fails closed and says which call was refused.

Evidence for these changes:

| Command | Result | Log |
| --- | --- | --- |
| `npx vitest run` on llama-stop, servers, local-models, durable-jobs/server-lifecycle and agent-control | 218/218 | `2026-09-28T10-01-12-620Z-a1faab.log` |
| `npx tsc --noEmit` | exit 0 | `2026-09-28T10-01-49-836Z-586ef5.log` |
| `node --test` on verify-kit, the stop helper, the audit and run-local-acceptance | 98/98 | `2026-09-28T10-02-09-027Z-37e9ba.log` |

## Correction round for review blockers S-B1 to S-B6 (10:25Z)

Controller: `agent_mul36oi2_t90a5gk`. Scope: the 14 frozen paths plus `scripts/smoke-lock.mjs` and `scripts/smoke-lock.test.mjs` (authorized expansion for S-B1). No `llama.ts` or `index.ts` change was needed. No build, Electron, smoke, live model, server stop/start, kill or git.

| ID | Fix (fail-closed) | Tests (the reviewer's negatives and controls) |
| --- | --- | --- |
| S-B1 | `smoke-lock` no longer tree-kills by number. The spawned child is registered by OS identity while our handle pins it (`trackRun`), and its descendants are tracked by identity every 5 s. One `createFinisher` serves normal exit, timeout, signal and parent loss: timers are cleared, identity-bound `cleanupRun` (kit `safeClose`) is bounded at 45 s and abandoned if it hangs, the lock is always released, and a code-0 run whose cleanup is unaccounted exits 3. Without a registered identity, only the direct child is stopped, through Node's own handle. `killTree` stays exported, bounded to 15 s, **only** for `perf-input.mjs` (out of scope). | `smoke-lock.test.mjs`: main() and the cleanup path contain no `killTree(`, `taskkill`, `/T` or `process.kill(`. Reused root with a foreign descendant: zero kills, not clean. A live tree at timeout or parent loss is killed leaves first by identity. A tree already gone is clean with no kill. Failed inventory: zero kills. No identity: handle-only stop. `createFinisher` for normal exit, failing run, timeout, signal and parent loss: one cleanup, one release, one exit. A hung cleanup is abandoned at the deadline and still releases and exits 3. An unclean or throwing cleanup never exits 0. |
| S-B2 | Kit exit proof: a member counts as gone only if its pid is absent or held by a valid, different identity. The same pid with an unreadable identity is unknown: the wait continues and the member ends `unresolved`. Exited roots, whether gone or with their pid reused, count as notes only if their subtree was observed alive (`observedTree`, set by `registerRoot` and `trackDescendants`) **and** no possible orphan exists (a row whose parent pid is theirs, created after them). Otherwise they are unresolved and nothing is killed. `launchParked` and the durable smoke start background tracking. The stop helper's exit loop treats a same-pid row with an unreadable identity as unknown. | `verify-kit.test.mjs`: a kill that returns unknown, then a same-pid row with unreadable identity, is unresolved. A valid different identity counts as exited (control). A never-observed exited root cannot close clean. An observed exited root with a possible orphan is unresolved and the orphan is untouched. No orphans means a note only (control). `registerRoot` marks its subtree observed. A tracking failure is counted, never read as "no descendants". `stop-durable-smoke-server.test.mjs`: a same-pid row with unreadable creation or image is not an exit; a valid different identity is an exit (control). |
| S-B3 | `registerRelaunch` requires all of the following: this instance's **own profile** `control-owner.json` names the pid; the process on that pid was **created no later than the credential was written** (a pid reused after our app died was created later and is refused); an earlier root of **this generation** runs the same image; and the build is **one whole argument** (`commandHasArg`, no prefix lookalikes). | A stale credential pid reused by a foreign same-image, same-build app; a credential from another profile; no credential; a credential naming another pid; a build-prefix lookalike; the build path inside another argument; a different image; an unreadable identity; another generation's root. All give zero registrations. The true same-profile relaunch is accepted. |
| S-B4 | The audit validates evidence **before** it declares a violation. Incomplete, conflicting, budget-mismatched, unmapped or gapped evidence, or a blocked stage whose last attempt has no failed outcome, is `inconclusive`. An owner resume grant is `excluded`. Only then can a candidate violate; held-back candidates are reported as `unprovenCandidates`. `auditSoak` returns `UNVERIFIED` with the reason when no credited rollover went on (NOT EXERCISED), and the smoke's soak assertion fails on it. | Each uncertainty added to an otherwise premature block: an incomplete capture (including the reviewer's case of 1 uncredited, then 2 credited, then block), a conflict, a budget mismatch, an unidentified stage, a gap, a missing last outcome, and a resume. None of them is a violation. The complete same-stage premature block is still a violation, and iteration 77 is still accepted. Soak: NOT EXERCISED gives UNVERIFIED; PASS needs EXERCISED. |
| S-B5 | The smoke launches exactly `--app=<path>` and re-hashes it against `--app-sha256` (`assertBuildHash`) immediately before every launch, relaunches included. `run-local-acceptance` requires a canonical absolute build path without spaces, puts `--app`/`--app-sha256` into the exact manifest command, and re-hashes just before spawning. The fault-control manifest carries `--acceptance`, and fault runs and the control share the `acceptanceFailures` gate: same job, completed, output checked and correct. | Build A checked and B present before spawn: NOT RUN, zero spawns. The launcher passes exactly `--app`/`--app-sha256`. `canonicalBuild` refuses relative, non-canonical, spaced and lookalike paths. The manifest includes `--acceptance` for the control. `acceptanceFailures`: blocked, cancelled, wrong-output, unchecked-output and wrong-job controls fail; a correct completed control passes. `assertBuildHash` covers mismatch, unreadable build and a short hash. |
| S-B6 | Child output goes through one `createRedactor` per stream. It decodes UTF-8 across chunks and releases whole lines; lines over 64 KiB are released except for a tail that is at least the longest secret, so a split secret is always seen whole. `evidenceWriter` sanitizes everything it writes (run.json, events), which covers error paths such as track-failed and cleanup errors. `sanitizeText` also removes `--api-key` values and Bearer tokens by shape. `parseProcessList` reports a malformed row by field names and types only. | A synthetic secret split at **every** byte position, including long lines without a newline; UTF-8 split at every byte position is reassembled; `--api-key` and Bearer values by shape; a malformed row containing an API key shows no key; tracking and cleanup errors carrying a token and an API key reach no artifact raw but stay classified. |

Evidence (`.conductor-scratch/local-assist/`):

| Log | Command | Result |
| --- | --- | --- |
| `2026-09-28T10-23-58-237Z-ed2674.log` | `node --test` on smoke-lock, verify-kit, the stop helper, the audit and run-local-acceptance | 181/181 |
| `2026-09-28T10-24-11-542Z-241929.log` | vitest on the same 5 files | 223/223 (agent-control has 121 tests now; the extra tests came from another agent's change) |
| `2026-09-28T10-24-51-223Z-54ed66.log` | `npx tsc --noEmit` | exit code 0 as reported by run_and_summarize (the log itself is empty) |
| `2026-09-28T10-25-07-861Z-1a6113.log`, `2026-09-28T10-25-07-971Z-cb6713.log` | `node --check` on `smoke-durable-jobs.mjs` and `smoke-lock.mjs` | exit 0 |

Residuals, stated honestly:

- A short-lived process spawned and orphaned between two 5-second tracking snapshots, whose parent also died, can be invisible. The possible-orphan check covers direct children of exited tracked members only.
- smoke-lock on POSIX now stops only the direct child, because the identity inventory is Windows-only.
- `perf-input.mjs` still uses `killTree` (out of scope).
- The build hash covers `out/main/index.js` only, not the rest of `out/`.

## Second correction round: S-B6 and S-C1 (10:39Z)

The independent review found S-B1 to S-B5 resolved and asked for changes on S-B6 and a new item, S-C1. Scope was unchanged: no build, Electron, smoke, server, kill or git.

| ID | Fix | Tests and evidence |
| --- | --- | --- |
| S-B6 | `createRedactor` now sanitizes the **whole buffer before choosing any cut**, so a complete secret is replaced wherever the cut falls. The cut then moves back before any `--api-key`/Bearer keyword whose value still reaches the end of the buffer, because the value may continue in the next chunk. A value growing past `hardMax` (1 MiB) is released already redacted, and its continuation in later chunks is dropped. The cut is clamped at 0: a line longer than `maxLine` but shorter than the held tail used to release part of that tail. Found by the new tests: the Bearer shape now matches any non-space value (as `--api-key` already did), so `Bearer [redacted]` followed by the rest of the key from the next chunk is still redacted whole. Also found: `full.log` and the redactor tails are now closed on every error path (`closeLog`). | For each of the literal token, `--api-key` value and Bearer value: every offset across the 64 KiB cut in a single push (the reviewer's case, `'x'*65536 + secret + 'y'*t` for every t), and a two-chunk split at every offset around a small `maxLine` cut, with no 12-character fragment of the secret surviving and the output equal to a one-shot `sanitizeText`. An over-bound `--api-key` value is released redacted with its continuation dropped. An over-`maxLine` line shorter than the held tail releases nothing early. |
| S-C1 | New `registerOwnChild` (kit). It accepts a snapshot only if, **after** the snapshot, the child still has `exitCode === null && signalCode === null` (Node's handle then still pins the pid) and the listed process was created inside the spawn window (±2 s). It is used by smoke-lock `trackRun`, `registerSpawnedRoot` (launch and relaunchParked), `registerPlaywrightRoots` (the launcher `ChildProcess`) and `run-local-acceptance`. A spawned child that cannot be registered but is still running is stopped only through Node's own handle. | Kit: an exited child, a signalled child or no child gives zero registrations. A live child inside the window registers (control). Creation before or after the window is refused. smoke-lock: a child exited before the snapshot, with its pid now foreign, gives zero registrations and zero kills, and cleanup is not clean. A live child registers (control); a stale creation time does not. `run-local-acceptance`: a child exited before its snapshot gives no root, zero kills and `UNVERIFIED (cleanup)`. |
| Exit 3 | Documented in the smoke-lock usage header. Exit 3 means **"the command passed, but cleanup is unaccounted"**: some process could not be proven gone or foreign, so nothing was killed for it. That includes a child that exited before its identity snapshot, any non-Windows host (the identity inventory is Windows-only), and possible orphans. | Covered by the `createFinisher` tests. |

Evidence (`.conductor-scratch/local-assist/`):

| Log | Command | Result |
| --- | --- | --- |
| `2026-09-28T10-38-11-783Z-c4fab2.log` | `node --test` on smoke-lock, verify-kit, the stop helper, the audit and run-local-acceptance | 194/194 |
| `2026-09-28T10-38-24-780Z-9a165a.log` | vitest on the same 5 files | 223/223 |
| `2026-09-28T10-38-54-549Z-f39000.log` | `npx tsc --noEmit` | exit code 0 |
| `2026-09-28T10-39-07-768Z-0c74e5.log`, `2026-09-28T10-39-07-895Z-47b270.log` | `node --check` on the two smoke scripts | exit 0 |

## UNVERIFIED (not run here)

- The full suite and build (`git.ship` preflight).
- Any live `local.stop` against a real llama-server.
- The Electron and Playwright root registration against a real parked app, including whether the Playwright launcher and main pid actually match.
- Whether `$p.MainModule.FileName` and CIM `ExecutablePath` are the same string for llama-server on this machine. They matched for node.exe in the read-only tests.
- A fault, fault-control or soak run.
- POSIX `ps` identity on the Mac node.
- The independent diff review, which is required before any live work.
