# Consolidated overnight execution manifest (prepared 2026-09-27)

**Status: READY, NOT RUN.** This is a handoff, not authorization to start a run. The source queue is `.conductor-scratch/verify-overnight/vr9c.md`; `docs/verification/2026-09-27-durable-fault-harness.md` (01df09c) supersedes its machine-wide kill description. The exact executable queue is below; `.conductor-scratch/verify-overnight/vr10.md` is an ignored working copy. No schedules or background processes were created for this task.

## Admission and ownership

- Only the supervising controller starts a phase while the owner is idle, 00:00–06:00 local. It records UTC start/end, exact commit/build, command, exit, `loadCheck()` result, server owner/PID, evidence path and pass rule after **each** run. One Electron smoke or build holds the machine-wide slot. No concurrent GPU job, smoke or build. CPU <30%, GPU <40%, no mid-turn except the supervising caller. If any check fails, record `NOT RUN (load)` and defer. Never use local assist for this queue: it could start Qwen.
- Built-in **Latest models and CLI compatibility** and **Idea Incubator** schedules are enabled and can start local Qwen churn. Before each exclusive overnight phase, the controller records their original enabled states, pauses them temporarily, verifies they stay quiet, and restores those exact states afterward (including on failure). Scheduled brain turns are read-only, auto-denied for tools and limited to 10 min; they cannot execute this queue.
- Check `local.servers` and the OS process list before any model run. A Dolphin or Qwen run may start only with no llama server running. Do not download a model or start a second server. Do not stop an owner's server. A model absent from `models.list` is `NOT RUN (model/owner)`.
- Every smoke uses a parked `CONDUCTOR_TEST_USER_DATA` profile through `smoke-lock`; no foreground dev launch. Capture the applicable exact commit and built `out/` before interpreting results. A new build consumes the same exclusive slot. Stop scheduling work at the first point where its timeout could extend past 06:00; record the skipped row rather than compressing a test.
- **No machine-wide termination.** The old VR9c prose about `taskkill /IM llama-server.exe /F` is obsolete. In the repaired fault path, the parked app must report exactly one `startedByConductor` server for Qwen, with a positive PID whose Windows parent is that parked Electron main PID. Only then may `local.stop({pid,force:true})` target that PID. Missing/ambiguous/foreign parentage fails closed. Other PID-tree cleanup in the smoke applies only to its own parked instance.

## Phases and judgment

| Phase | Window and cap | Decision rule |
| --- | --- | --- |
| 1. FX45 real Dolphin | First available quiet night; 22 min lock, 21 min watchdog | This is the release blocker. Two real research attempts plus the current question must complete with web use, sources and no draft leakage. **At least one research attempt must actually show the rumination notice and recover**; an answer without observed rumination leaves the blocker `UNVERIFIED`, even if every answer passes. The forced deterministic case is a separate control and does not replace a real occurrence. |
| Controller gate | After phase 1 evidence, outside this worker's authority | Fresh independent Astra judgment of the FX45 projection/answer evidence. Controller alone decides whether the batch is coherent enough to publish once, then offer/install the local update and restart. A failed or unobserved real rumination blocks release. No coworker publishes, updates or restarts. |
| 2. Qwen durable approval and fault | Later quiet night; two serial locks, 100 min cap each, usually 20–40 min each | Use the VR9c real-model commands on the repaired commit. Approval blocks for permission/owner, cloud escalation false. Fault run proves scoped server loss, recovery, same job after app relaunch, reconciliation and completion. No old `taskkill /IM` path. |
| 3. Typing acceptance and controls | After model work, preferably a separate quiet night; serial, cap each command as listed in queue | Pair a before and after measurement of the **same active Claude 10k-event conversation at 4× throttle**. The after build must meet absolute p95 <16 ms at 1/11/26 tabs, including the active owner-scale conversation. Record the before numbers from a named pre-fix build. The same-run empty floor is diagnostic and cannot replace <16 ms. Separately run the under-test-load swarm guard: median load p95 **and p99** must each be no more than quiet median +25 ms over three rounds; the normal-priority pre-fix control should miss the bound. Quiet admission is required even though the command deliberately creates its own load. |
| 4. Six-hour Qwen soak | Its **own following night**, start at 00:00; 6 h watchdog, 375 min lock ceiling | Do not squeeze it after other work. At least two iterations, one completion, `totalRollovers >=2`, no attempt-budget block after a credited rollover, and at least 5 h 45 min elapsed. Preserve all iteration, recovery and stuck-running observations. An early exit is a failure or incomplete run, never a pass. |
| Morning judgment | Fresh independent Astra tab | Per scenario `PASS`, guarded `FAIL`, or `NOT RUN` with exact reason and artifact. Reopen only after 2/2 reproduction, a passing neighbour or pre-fix control, clean load/fixture/launch evidence and no cascade. A missing must-have remains `UNVERIFIED`; never turn it into a pass by substituting an easier test. |

## Exact command queue

Run each command from `C:/Claude/conductor`, serially, only after the admission check above. Build the named commit first under the same exclusive slot; each timeout is a ceiling. Capture logs/results under `artifacts/verification/2026-09-27-overnight/` and retain the scripts' own JSON. The controller records exit, start/end UTC, load and server state, build hash and pass-rule evidence after each run.

**Night 1 — FX45 real Dolphin** (22 min lock; script watchdog 21 min):

```powershell
node scripts/smoke-lock.mjs --timeout-min 22 -- node scripts/smoke-fx45-rumination.mjs
```

Control: the committed forced-rumination case and the current-question answer. Pass requires all three sourced, clean answers **and actual rumination observed in at least one real research attempt**. Without that occurrence, record `NOT RUN (no stochastic rumination)` for the release criterion. Stop for independent judgment and controller-only publish/update/restart decision.

**Later quiet night — durable approval then faults** (serial, each cap 100 min, expected 20–40 min), Qwen present in `models.list`, no existing llama server, repaired script at 01df09c or later:

```powershell
node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b
node scripts/smoke-lock.mjs --timeout-min 100 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --kill-server --restart-app --extras=none
```

Approval pass: exit 0, `approval case blocked` for owner/permission, `report written`, cloud escalation false, no `FAILED`. Fault pass: exit 0; ordered `llama-server killed`, server loss/recovery within 5 min, running again, app closed, same job ID after relaunch, reconciled, completed and report written; no smoke-owned server remains. Control: uninterrupted main flow on the same build. The repaired `--kill-server` path verifies exactly one smoke-owned Qwen PID and parked Electron parent before `local.stop({pid,force:true})`; never run VR9c's obsolete machine-wide kill instruction.

**Later quiet night — original typing gate before and after** (each cap 45 min): build and name the relevant pre-fix and candidate commits, then set `$beforeBuild` and `$candidateBuild` to their absolute `out/main/index.js` paths. Use the same harness for both:

```powershell
node scripts/smoke-lock.mjs --priority normal --timeout-min 45 -- node scripts/perf-input.mjs --provider=claude --events=10000 --tabs=1,11,26 --throttle=4 --label=vr10-before --app=$beforeBuild
node scripts/smoke-lock.mjs --priority normal --timeout-min 45 -- node scripts/perf-input.mjs --provider=claude --events=10000 --tabs=1,11,26 --throttle=4 --label=vr10-after --app=$candidateBuild
```

Record per-tab before/after p95 and p99, max, commits and timeline mutations. Candidate pass: **absolute p95 <16 ms at 4× at each 1/11/26 tab count**, with the 10k-event Claude conversation active. Historical V2 p95 (23.4/29.1/30.9 ms) is reference only. A same-run floor never substitutes for the absolute target. Control: named pre-fix build; if fixture compatibility fails, record `NOT RUN (harness)`.

**Same or next quiet night — under-test-load guard and priority control** (each cap 60 min, about 15 min healthy), no llama server:

```powershell
node scripts/smoke-lock.mjs --priority normal --timeout-min 60 -- node scripts/perf-input.mjs --label=vr10-guard --load=swarm --repeat=3 --throttle=4 --assert
node scripts/smoke-lock.mjs --priority normal --timeout-min 60 -- node scripts/perf-input.mjs --label=vr10-guard-control --load=swarm --repeat=3 --throttle=4 --load-priority=normal
```

Guard pass: exit 0, three-round median swarm p95 **and p99** each ≤ same-run quiet median +25 ms. The normal-priority control should miss (historical p99 +108.6 ms); record its actual numbers. The relative guard is separate from the absolute 16 ms gate.

**Own following night — six-hour durable soak**, begin at 00:00 with Qwen present and no existing llama server:

```powershell
$env:DURABLE_SMOKE_TIMEOUT_MS='21600000'
node scripts/smoke-lock.mjs --timeout-min 375 -- node scripts/smoke-durable-jobs.mjs --real-model=local/qwen3.6-35b-a3b --fixture=crossref --soak
```

Pass: ≥2 iterations, ≥1 completion, `totalRollovers >=2`, elapsed ≥5 h 45 min, no exhausted-attempt block after a credited rollover. Record iteration statuses, recoveries and any `Started from the queue` running >10 min. An early exit is not a six-hour pass. Control: shorter real-model main flow on the same relevant build. The soak needs a supervising caller throughout; no detached, unmonitored run.

## Scheduling gap

Conductor's built-in `night` schedule runs 01:00–06:00 (`docs/schedules.md`), and script timeout is capped at 1,200 seconds (`src/shared/schedules.ts`). It cannot host the 6-hour soak, which needs a 00:00 start and continuous supervision. The controller must arrange a supervising overnight caller with an explicit full-window slot. This manifest does not create a schedule or imply that a 20-minute script task can continue for six hours.

## Source contracts

- `.conductor/loops/verify.md`: overnight load gate, bounded waits, control and morning judgment.
- `.conductor-scratch/verify-overnight/vr9c.md` and `docs/verification/2026-09-27-durable-fault-harness.md`: durable commands, corrected server kill.
- `.conductor-scratch/verify-overnight/vr7.md`, `.conductor-scratch/verify-overnight/vr3.md`, `docs/verification/2026-09-24-v2-conversation-typing.md`, `feature-list.md` (`typing-lag-long-conversation`), `scripts/perf-input.mjs`, `docs/perf/typing-under-load.md`: original absolute typing target, owner-scale shape and separate swarm p99 guard.
- `scripts/smoke-fx45-rumination.mjs`: real Dolphin observation and its explicit `NOT RUN` result when stochastic rumination does not occur.
