---
id: verify
version: 6
title: Verify a delivered item against what the owner actually asked for, adversarially
trigger: [after:batch-delivery, manual]
inputs: [taskIds, commits]
steps:
  - id: plan
    role: verifier
    model: codex:gpt-6-astra
    alternate: claude:opus[1m]
    effort: high
    output: triaged plan - day lane ≤12 scenarios (≤3 per item, owner's words first, each ≤5 min) with pass rule and control case; overnight queue; owner-gated list asked once before running
  - id: execute
    role: verifier
    model: codex:gpt-6-sol
    alternate: claude:opus[1m]
    effort: medium
    output: per-scenario PASS / FAIL / NOT RUN (reason) with evidence path, numbers, reproductions n/n and the control run
  - id: judge
    role: verifier
    model: codex:gpt-6-astra
    alternate: claude:opus[1m]
    effort: high
    output: per item VERIFIED / REOPEN (failing scenario, evidence, control) / UNVERIFIED (must-have scenario NOT RUN, and what unblocks it)
  - id: overnight
    role: verifier
    action: overnight lane - queued long, real-model, soak and perf runs execute 00:00-06:00 on a quiet machine; a fresh Astra tab judges them in the morning
    optional: true
locked: [steps.plan, steps.judge]
---

# Verify

The Verifier checks **what the owner asked for**, not what the implementer tested. "The unit tests pass" and "it
worked on a small sample" are not evidence. v3 is shaped by the 2026-09-25 retrospective
(`docs/verification/2026-09-25-verifier-retro.md`): fewer, sharper scenarios, one Opus tab, a shared harness, long
runs at night, and a control run behind every REOPEN.

Dispatch brief template: `docs/verification/verifier-brief.md`.

## 0. Before the first round: the shared harness

`scripts/verify-kit.mjs` must exist. It is built once by an Opus batch, and a round does not start without it. Every
verify smoke imports it and adds only scenario logic, about 30–80 lines each. The kit provides:
- `launchParked({ mode: 'spawn' | 'playwright' })`: a temp `CONDUCTOR_TEST_USER_DATA` and a parked window. Use
  `spawn` for anything that restarts the app.
- `owner()` and `call(method, args)`: control calls that throw on non-200 and never swallow errors.
- `openProject()` and `openTab()`: they wait for the workspace to mount and retry "did not acknowledge".
- `safeClose()`: stubs the dialog, bounds `app.close()` to 20 s, then kills only its own pid tree.
- `watchdog(sec)`: takes a screenshot, writes partial results and exits 2.
- `processAlive(marker)`: excludes its own query process.
- `loadCheck()`: smoke-lock holder, CPU %, GPU %, llama-server busy, mid-turn tabs.
- `record(id, verdict, numbers, evidence)`: appends a line to results.md at once.

## 1. Plan (independent Astra verifier)

1. Read the owner's item text and linked images, then the commits and the fixer's own smoke if there is one.
2. **Triage every candidate scenario into one lane:**
   - **Day** (≤5 min, fixtures or a stand-in endpoint): at most **12 per round**, **3 per item**. The first scenario of
     each item quotes the owner's words and uses the owner's real data where it is safe: a copy of the real
     `feature-list.md`, a real long conversation's shape, the model the owner actually picks.
   - **Overnight** (queued): real local-model runs over 5 min, soaks, perf and typing numbers, real Claude or Codex
     turns, anything over 20 min under the lock.
   - **Owner-gated**: installers, prepare-deps, killing processes you did not start, anything outside a parked
     profile. List them and ask the owner **once, before running**, with concrete options. If they are not approved,
     they are NOT RUN (owner) from the start.
3. Generic hostile input (paths with spaces, binary files, unicode, emoji) goes in only when the item handles that
   input. In the 2026-09-24 rounds it caught 2 bugs in ≈40 scenarios.
4. For each scenario, write the pass rule, the evidence to collect, and its **control**: a known-good neighbour it must
   pass, or the pre-fix commit it must fail on.

## 2. Execute (Sol worker with bounded scenario contract)

- One smoke queued per tab, and at most **two verifier rounds on the machine at once**. There is one serial smoke
  lock; `node scripts/smoke-lock.mjs --timeout-min <≤20 by day> -- node scripts/smoke-verify-<round>-<group>.mjs`.
- **Every wait has a wall-clock deadline.** Never end a turn waiting on a background notification alone. The watcher
  also fires at the deadline, and on that deadline the smoke is recorded as `HUNG` with its last step.
- Harness debugging is capped at **15 min per scenario**. After that the scenario is `NOT RUN (harness)` with the
  error, and the run moves on.
- If the lock waiter gives up after 60 min, the result is `NOT RUN (lock)`, not FAIL.
- Update results.md after every scenario. The judge reads it every ≤30 min, not only when the run settles.
- The day lane is time-boxed to **2.5 h of wall time** per round. What is left is NOT RUN (time-box), or moves to
  the overnight queue.

## 3. False-positive guard (before any REOPEN)

A FAIL becomes a REOPEN only when all of these hold:
1. **It reproduces 2 of 2 times**, on a build of the named commit, not the shared tree mid-edit.
2. **A control run exists:** the same harness passes a known-good neighbour case, or reproduces the failure on the
   pre-fix commit. If there is no control, the verdict is UNVERIFIED.
3. **The artifact checklist is clean:**
   - a process or liveness query excludes itself and its shell;
   - a fixture behaves like the real CLI (receipts, ordering, SYNTHETIC prompts), or the result is confirmed on the
     real provider in the overnight lane;
   - the measurement reads the real thing: not a proxy count, not a regex over mixed items, not a CSS variable on
     another node, not a DB-only seed;
   - the launch mode matches the passing controls (`spawn` for restarts);
   - waits are at least 2× the observed p95 on this machine;
   - no other smoke, build or GPU job ran at the same time (the `loadCheck()` record);
   - the failure is not explained by an earlier failure in the same run (no cascade).
4. **Perf numbers** only count with a quiet-machine record: no lock holder, CPU below 30 %, GPU below 40 %, no
   mid-turn tab, the same thresholds as `schedule-gate.ts`. Otherwise they are NOT RUN (load) and move overnight.

## 4. Judge (the independent Astra verifier)

- **VERIFIED**: every must-have scenario passed with evidence.
- **REOPEN**: a guarded failure. Put the item back to `[ ]` with "Verifier YYYY-MM-DD: <scenario> failed —
  <evidence path>", a failing scenario the next batch can turn into a test, and the control run.
- **UNVERIFIED**: a must-have scenario is NOT RUN. Say what unblocks it: owner decision, overnight, or harness.
- If the fixer's own smoke fails on HEAD, that is a finding, and the item cannot be VERIFIED until it is explained.
- Write `docs/verification/<date>-<round>.md` using the item table plus a NOT RUN table. Ship only the report and new
  smokes with `git.ship` (paths only).

## 5. Overnight lane (optional step)

- The plan writes `.conductor-scratch/verify-overnight/<round>.md`: each command, its `--timeout-min`, its pass rule,
  and where results go.
- The controller or overseer starts the queue after 00:00, when the owner is idle and the machine is quiet. Runs go
  one at a time under `smoke-lock --timeout-min <run length + 10>`, the queue ends by 06:00, and a `loadCheck()` is
  recorded before each run.
- A fresh Astra tab judges the results in the morning under the same guard.
- Re-verify rounds (RV) re-run the exact failing scenario and add at most 2 new ones per item, by day. Anything
  long goes to the next night.

Budget: one Astra plan/judge per round and one Sol worker for implementation and execution. Luna is never an automatic execute-step fallback. The controller may explicitly give it only exact committed commands with no write scope; it does not design scenarios or judge. The caps are those
of `batch-delivery`.


## Bounded continuation and token use (2026-09-27)

Read docs/verification/2026-09-27-loop-retro.md for measured takeover evidence.
The owner requested continuing the same loop with Codex after Claude's weekly limit.
Astra handles contracts and independent judgment; Sol handles implementation and churn.
Retain Opus as an alternate only when its quota permits.
Keep implementation and independent verification in different conversations.
Before dispatch refresh models.list and usage.limits; never infer general Claude
capacity from the Fable bucket. Do not retry a capped provider in fresh tabs.

Use agents.status with its cursor for routine supervision. Read a filtered snapshot
only for a transition, recovery or missing evidence; omit configuration notices and
full tool outputs until needed. Filter task updates to revision and affected IDs.
Use run_and_summarize for long tests/builds and local_ask for bounded large reads
when the existing server is available; never switch the GPU model just for a summary.
Assign one Electron/build slot at a time; waiting workers can read and edit.
Reuse committed smokes and passing evidence on unchanged relevant paths. Full
suite/build is git.ship's job; additional focused runs need a change or failure.
Briefs should fit 1,200 tokens with references; results need commit, verdict,
evidence and NOT RUN. Record loops.run/loops.record with actual timing and measured
tokens where available; no fabricated counters or claimed savings from estimates.
All existing acceptance, independent-review, budget, ship and overnight gates remain.

## Run log
- 2026-09-24 v2 (owner): plan and judge move from Fable to Opus 5.5, because Fable is too expensive. V2/V3 were switched mid-run.
- 2026-09-25 v3 (applied by the orchestrator, retro): one Opus tab instead of the Opus judge plus Sonnet executor pair. The reasons:
  - the V4 judge was active 7 min in 9.4 h;
  - ≈25 FAIL rows from the executors were harness artifacts;
  - Sonnet wrote the self-matching A2 query and V4's hanging teardown.

  Also: a day lane of ≤12 scenarios (224 were planned, ≈36 % never got a result), an overnight lane (the soak was
  cut, perf ran under load), the shared verify-kit (70 scripts, 10k lines of copies), a false-positive guard, and
  UNVERIFIED for a NOT RUN must-have.

- 2026-09-27 v4 (loops.apply loopproposal_muju1qty_7hb71su): 2026-09-27 takeover: Claude general weekly 100%, Codex 0%; controller quota-failed before first action; FX45 ten reads/no edits. Snapshot payloads 45149/119806 chars versus text 6350/4047. Local assist only 14 calls/week, estimated 23956 tokens saved. Owner requests same loop improved for token savings, then explicitly cheaper workforce for churn. Sol labor, Astra judgment. docs/verification/2026-09-27-loop-retro.md; new savings unmeasured.
- 2026-09-27 v5 (loops.apply loopproposal_muju44rc_3tu8liz): Align prose and exact model/effort with owner correction: Sol medium implementation, Sol low churn, Astra independent judgment. Preserve Unicode via UTF-8 request bytes. No acceptance gates removed. See 2026-09-27-loop-retro.md.
- 2026-09-27 v6 (loops.apply loopproposal_mujuhku2_9y8xnk7): Independent Sol read-only review found three route inconsistencies: stale Sonnet fallback, Luna automatically eligible for full execute, and duplicate full-suite churn wording. Remove automatic fallbacks and scope churn to contract-focused checks; full suite/build belongs to ship. Gates unchanged.
