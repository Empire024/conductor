---
id: verify
version: 3
title: Verify a delivered item against what the owner actually asked for, adversarially
trigger: [after:batch-delivery, manual]
inputs: [taskIds, commits]
steps:
  - id: plan
    role: verifier
    model: claude:opus[1m]           # one Opus tab does plan, execute and judge (v3); no Fable (owner 2026-09-24)
    alternate: codex:gpt-6-astra
    effort: high
    output: triaged plan - day lane ≤12 scenarios (≤3 per item, owner's words first, each ≤5 min) with pass rule and control case; overnight queue; owner-gated list asked once before running
  - id: execute
    role: verifier
    model: claude:opus[1m]           # the same tab: writes scenarios on scripts/verify-kit.mjs and runs them (owner 2026-09-25: Opus implements)
    fallback: claude:sonnet          # runner only: re-runs committed smokes unchanged and collects logs; never writes harness, never gives verdicts
    effort: medium
    output: per-scenario PASS / FAIL / NOT RUN (reason) with evidence path, numbers, reproductions n/n and the control run
  - id: judge
    role: verifier
    model: claude:opus[1m]
    effort: high
    output: per item VERIFIED / REOPEN (failing scenario, evidence, control) / UNVERIFIED (must-have scenario NOT RUN, and what unblocks it)
  - id: overnight
    role: verifier
    action: overnight lane - queued long, real-model, soak and perf runs execute 00:00-06:00 on a quiet machine; a fresh Opus tab judges them in the morning
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

## 1. Plan (Opus, same tab)

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

## 2. Execute (same tab)

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

## 4. Judge (same tab)

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
- A fresh Opus tab judges the results in the morning under the same guard.
- Re-verify rounds (RV) re-run the exact failing scenario and add at most 2 new ones per item, by day. Anything
  long goes to the next night.

Budget: one Opus tab per round, and a runner only when committed smokes need re-running unchanged. The caps are those
of `batch-delivery`.

## Run log
- 2026-09-24 v2 (owner): plan and judge move from Fable to Opus 5.5, because Fable is too expensive. V2/V3 were switched mid-run.
- 2026-09-25 v3 (applied by the orchestrator, retro): one Opus tab instead of the Opus judge plus Sonnet executor pair. The reasons:
  - the V4 judge was active 7 min in 9.4 h;
  - ≈25 FAIL rows from the executors were harness artifacts;
  - Sonnet wrote the self-matching A2 query and V4's hanging teardown.

  Also: a day lane of ≤12 scenarios (224 were planned, ≈36 % never got a result), an overnight lane (the soak was
  cut, perf ran under load), the shared verify-kit (70 scripts, 10k lines of copies), a false-positive guard, and
  UNVERIFIED for a NOT RUN must-have.
